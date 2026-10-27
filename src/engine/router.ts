import { DatabaseSync } from 'node:sqlite'
import type { InboundEvent, InboundContact, ExecutionResult, TransportSender, CrmClientInterface } from '../types.ts'
import { LockManager } from '../state/lock-manager.ts'
import { SuppressionStore } from '../suppression/suppression-store.ts'
import { evaluateDeterministicRules } from './rules.ts'
import { FlowEngine } from './flow-engine.ts'

export class ConversationRouter {
  db: DatabaseSync
  transport: TransportSender
  crm: CrmClientInterface
  private lockManager: LockManager
  private suppressionStore: SuppressionStore
  private flowEngine: FlowEngine

  constructor(
    db: DatabaseSync,
    transport: TransportSender,
    crm: CrmClientInterface
  ) {
    this.db = db
    this.transport = transport
    this.crm = crm
    this.lockManager = new LockManager(db)
    this.suppressionStore = new SuppressionStore(db)
    this.flowEngine = new FlowEngine(db)
  }

  getLockManager(): LockManager {
    return this.lockManager
  }

  getSuppressionStore(): SuppressionStore {
    return this.suppressionStore
  }

  getFlowEngine(): FlowEngine {
    return this.flowEngine
  }

  /**
   * Procesa un evento de mensaje entrante de forma determinista y segura.
   */
  async processInbound(event: InboundEvent): Promise<ExecutionResult> {
    // correlationId es opcional en el contrato inbound: si no llega, se usa el eventId
    // (evita binds SQLite con undefined → 500 en POST /api/inbound).
    const { eventId, orgId, contact, message } = event
    const correlationId = event.correlationId || eventId
    const phone = contact.phone

    // 1. DEDUPLICACIÓN E IDEMPOTENCIA
    const cached = this.db.prepare('SELECT response_json FROM idempotency_keys WHERE key = ?').get(eventId) as { response_json: string } | undefined
    if (cached) {
      try {
        const parsed = JSON.parse(cached.response_json) as ExecutionResult
        return { ...parsed, actionTaken: 'deduplicated' }
      } catch {
        // Fallback si el json estuviera corrupto
      }
    }

    // 2. VERIFICACIÓN DE BAJA / SUPRESIÓN
    // Si el contacto solicita baja explícita en este mensaje
    if (this.suppressionStore.isOptOutKeyword(message.text)) {
      this.suppressionStore.addSuppression(phone, 'Solicitud voluntaria de baja')
      this.lockManager.releaseLock(phone)

      const farewell = '🚫 Has sido dado de baja correctamente. No volverás a recibir mensajes automáticos de nuestra parte.'
      await this.transport.sendMessage(phone, farewell, correlationId)

      if (contact.clientId) {
        await this.crm.addNote(orgId, contact.clientId, '🚫 [Baja Voluntaria]: El cliente solicitó no recibir más comunicaciones.', correlationId)
      }

      const result: ExecutionResult = {
        handled: true,
        actionTaken: 'suppression_opt_out',
        replyText: farewell,
        crmSynced: Boolean(contact.clientId),
        correlationId,
      }
      this.saveIdempotency(eventId, result)
      return result
    }

    // Si ya estaba en la lista de supresión, se descarta en silencio
    if (this.suppressionStore.isSuppressed(phone)) {
      const result: ExecutionResult = {
        handled: false,
        actionTaken: 'ignored',
        error: 'Contacto suprimido por política de baja',
        correlationId,
      }
      this.saveIdempotency(eventId, result)
      return result
    }

    // 3. ADQUISICIÓN ATÓMICA DE LOCK
    const lockAcquisition = this.lockManager.acquireLock(phone, orgId, correlationId)
    if (!lockAcquisition.acquired) {
      const result: ExecutionResult = {
        handled: false,
        actionTaken: 'locked_busy',
        error: lockAcquisition.reason || 'Contacto ocupado en otra conversación',
        correlationId,
      }
      this.saveIdempotency(eventId, result)
      return result
    }

    // 4. EVALUACIÓN DE FLUJOS VISUALES (FLOW ENGINE ESTILO MANYCHAT)
    const flowStep = await this.flowEngine.evaluateStep(phone, message.text, contact)
    if (flowStep.handled) {
      let crmSynced = false

      // A. Ejecutar acciones de negocio en CRM ALBRA si el nodo lo requiere
      for (const act of flowStep.actionsToExecute) {
        if (act.action === 'create_opportunity') {
          const clientId = contact.clientId || (await this.ensureClient(orgId, contact, correlationId))
          if (clientId) {
            const title = (act.params.title as string) || 'Oportunidad desde Flujo'
            const amount = Number(act.params.amount) || 100
            const crmRes = await this.crm.createOpportunity(orgId, clientId, title, amount, correlationId)
            crmSynced = crmSynced || crmRes.ok
          }
        } else if (act.action === 'add_note') {
          const clientId = contact.clientId || (await this.ensureClient(orgId, contact, correlationId))
          if (clientId) {
            const noteContent = (act.params.content as string) || `🤖 Nota de flujo: ${message.text}`
            const crmRes = await this.crm.addNote(orgId, clientId, noteContent, correlationId)
            crmSynced = crmSynced || crmRes.ok
          }
        }
      }

      // B. Enviar mensajes generados por el flujo
      let lastReplyText = ''
      for (const msg of flowStep.messagesToSend) {
        const text = typeof msg === 'string' ? msg : msg.text
        await this.transport.sendMessage(phone, text, correlationId)
        lastReplyText = text
      }

      // C. Manejo de Handoff a humano si el nodo lo requiere
      if (flowStep.isHandoff) {
        this.lockManager.setHandoff(phone, orgId, correlationId)
        if (contact.clientId) {
          await this.crm.addNote(
            orgId,
            contact.clientId,
            `🤖 [Handoff ManyChat]: ${flowStep.handoffReason || 'Transferencia solicitada en flujo'}`,
            correlationId
          )
        }
        const result: ExecutionResult = {
          handled: true,
          actionTaken: 'handoff_human',
          replyText: lastReplyText,
          crmSynced,
          correlationId,
          flowId: flowStep.flowId,
        }
        this.saveIdempotency(eventId, result)
        return result
      }

      const result: ExecutionResult = {
        handled: true,
        actionTaken: 'visual_flow_execution',
        replyText: lastReplyText,
        crmSynced,
        correlationId,
        flowId: flowStep.flowId,
      }
      this.saveIdempotency(eventId, result)
      return result
    }

    // 5. EVALUACIÓN DETERMINISTA DE REGLAS (FALLBACK)
    const ruleMatch = evaluateDeterministicRules(message.text)

    // Caso A: Handoff a humano
    if (ruleMatch.matched && ruleMatch.intent === 'handoff') {
      this.lockManager.setHandoff(phone, orgId, correlationId)
      const reply = ruleMatch.responseTemplate!
      await this.transport.sendMessage(phone, reply, correlationId)

      let crmSynced = false
      if (contact.clientId) {
        const noteContent = `🤖 [Handoff IA]: El cliente solicitó asesor humano. Último mensaje: "${message.text}".`
        const crmRes = await this.crm.addNote(orgId, contact.clientId, noteContent, correlationId)
        crmSynced = crmRes.ok
      }

      const result: ExecutionResult = {
        handled: true,
        actionTaken: 'handoff_human',
        replyText: reply,
        crmSynced,
        correlationId,
      }
      this.saveIdempotency(eventId, result)
      return result
    }

    // Caso B: Regla determinista de palabra clave (Precios / Catálogo)
    if (ruleMatch.matched && ruleMatch.responseTemplate) {
      const reply = ruleMatch.responseTemplate
      await this.transport.sendMessage(phone, reply, correlationId)

      const result: ExecutionResult = {
        handled: true,
        actionTaken: 'keyword_rule',
        replyText: reply,
        crmSynced: false,
        correlationId,
      }
      this.saveIdempotency(eventId, result)
      return result
    }

    // Caso C: Lead nuevo sin cliente registrado en ALBRA
    if (!contact.clientId) {
      const clientName = contact.name || `Prospecto ${phone.slice(-4)}`
      const crmRes = await this.crm.createClient(orgId, clientName, phone, correlationId)
      const newClientId = crmRes.clientId

      const welcome = `👋 ¡Hola! Gracias por comunicarte con nosotros. Hemos registrado tu consulta. ¿En qué podemos ayudarte hoy? Escribe "PRECIO" para conocer nuestros planes o "ASESOR" para hablar con alguien del equipo.`
      await this.transport.sendMessage(phone, welcome, correlationId)

      const result: ExecutionResult = {
        handled: true,
        actionTaken: 'new_lead_welcome',
        replyText: welcome,
        crmSynced: crmRes.ok,
        correlationId,
      }
      this.saveIdempotency(eventId, result)
      return result
    }

    // Caso D: Mensaje genérico de cliente ya existente
    const genericHelp = '👋 Hemos recibido tu mensaje. Para ver nuestro catálogo escribe "CATALOGO", para precios escribe "PRECIO", o si prefieres hablar con un asesor escribe "ASESOR".'
    await this.transport.sendMessage(phone, genericHelp, correlationId)

    const result: ExecutionResult = {
      handled: true,
      actionTaken: 'keyword_rule',
      replyText: genericHelp,
      crmSynced: true,
      correlationId,
    }
    this.saveIdempotency(eventId, result)
    return result
  }

  private async ensureClient(orgId: string, contact: InboundContact, correlationId: string): Promise<string | undefined> {
    if (contact.clientId) return contact.clientId
    const name = contact.name || `Prospecto ${contact.phone.slice(-4)}`
    const res = await this.crm.createClient(orgId, name, contact.phone, correlationId)
    if (res.ok && res.clientId) {
      contact.clientId = res.clientId
      return res.clientId
    }
    return undefined
  }

  private saveIdempotency(key: string, result: ExecutionResult): void {
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare('INSERT OR REPLACE INTO idempotency_keys (key, processed_at, response_json) VALUES (?, ?, ?)').run(key, now, JSON.stringify(result))
  }
}
