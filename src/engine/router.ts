import { DatabaseSync } from 'node:sqlite'
import type { InboundEvent, InboundContact, ExecutionResult, TransportSender, CrmClientInterface } from '../types.ts'
import { LockManager } from '../state/lock-manager.ts'
import { SuppressionStore } from '../suppression/suppression-store.ts'
import { evaluateDeterministicRules } from './rules.ts'
import { FlowEngine } from './flow-engine.ts'

/** Lease de reserva de idempotencia: si un proceso muere a mitad, su reserva
 * expira y un evento de re-entrega puede tomar posesión (recuperación controlada). */
const IDEMPOTENCY_LEASE_SECONDS = 120

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
    // Idempotencia SCOPED POR ORGANIZACIÓN (orden de cierre): un eventId repetido entre
    // orgs distintas NO colisiona — la clave incluye la organización emisora.
    const idemKey = `${orgId}::${eventId}`

    // 1. RESERVA ATÓMICA DE IDEMPOTENCIA (segunda reparación §3.C)
    // Causa raíz corregida: antes se CONSULTABA la clave, se ejecutaban efectos
    // externos (mensajes/CRM) y la clave se guardaba AL FINAL — dos eventos
    // concurrentes pasaban el SELECT y duplicaban efectos.
    // Ahora: el INSERT de la reserva es la operación atómica. Solo UNA llamada
    // obtiene 'RESERVED'; las demás reciben el resultado persistido
    // (COMPLETED) o 'IN_FLIGHT' sin ejecutar NINGÚN efecto externo.
    const reservation = this.reserveIdempotency(idemKey)
    if (reservation.startsWith('COMPLETED:')) {
      try {
        const parsed = JSON.parse(reservation.slice('COMPLETED:'.length)) as ExecutionResult
        return { ...parsed, actionTaken: 'deduplicated' }
      } catch {
        // JSON corrupto en la respuesta persistida: tratar como en vuelo (no duplicar efectos)
        return { handled: false, actionTaken: 'in_flight', error: 'Evento ya procesado', correlationId }
      }
    }
    if (reservation === 'IN_FLIGHT') {
      return {
        handled: false,
        actionTaken: 'in_flight',
        error: 'Evento idéntico en procesamiento por otra operación (reserva atómica activa)',
        correlationId,
      }
    }
    // reservation === 'RESERVED': esta llamada es la ÚNICA ejecutora.
    try {
      return await this.runInboundEffects(event, idemKey, correlationId)
    } catch (err) {
      // Fallo de la ejecución: liberar la reserva en estado FAILED para permitir
      // el reintento de la pasarela/remitente (la clave NO queda consumida).
      this.failIdempotency(idemKey)
      throw err
    }
  }

  /**
   * Reserva ATÓMICA de la clave de idempotencia (segunda reparación §3.C).
   *  - INSERT único: si gana, 'RESERVED' (esta llamada ejecuta los efectos).
   *  - Si la clave ya estaba COMPLETED, devuelve su resultado persistido.
   *  - PROCESSING con lease vivo → 'IN_FLIGHT' (otro proceso está ejecutando).
   *  - PROCESSING con lease VENCIDO (proceso interrumpido) → toma de posesión
   *    atómica por UPDATE condicional → 'RESERVED'.
   *  - FAILED (intento anterior falló) → toma de posesión → 'RESERVED'
   *    (un evento inválido NO consume la clave de uno válido posterior).
   */
  private reserveIdempotency(idemKey: string): 'RESERVED' | 'IN_FLIGHT' | `COMPLETED:${string}` {
    const now = Math.floor(Date.now() / 1000)
    const lease = now + IDEMPOTENCY_LEASE_SECONDS
    try {
      this.db.prepare(`
        INSERT INTO idempotency_keys (key, status, response_json, created_at, lease_expires_at)
        VALUES (?, 'PROCESSING', NULL, ?, ?)
      `).run(idemKey, now, lease)
      return 'RESERVED'
    } catch {
      const row = this.db.prepare('SELECT status, response_json, lease_expires_at FROM idempotency_keys WHERE key = ?').get(idemKey) as
        | { status: string; response_json: string | null; lease_expires_at: number }
        | undefined
      if (!row) return 'IN_FLIGHT'
      if (row.status === 'COMPLETED') return `COMPLETED:${row.response_json ?? ''}`
      if (row.status === 'PROCESSING' && row.lease_expires_at > now) return 'IN_FLIGHT'
      // PROCESSING vencido (crash) o FAILED (intento fallido): toma de posesión atómica
      const takeover = this.db.prepare(`
        UPDATE idempotency_keys SET status = 'PROCESSING', response_json = NULL, lease_expires_at = ?, created_at = ?
        WHERE key = ? AND (status = 'FAILED' OR (status = 'PROCESSING' AND lease_expires_at <= ?))
      `).run(lease, now, idemKey, now)
      return Number(takeover.changes) === 1 ? 'RESERVED' : 'IN_FLIGHT'
    }
  }

  /** Persiste el resultado final del evento (estado COMPLETED, legible por réplicas). */
  private completeIdempotency(idemKey: string, result: ExecutionResult): void {
    this.db.prepare(`
      UPDATE idempotency_keys SET status = 'COMPLETED', response_json = ?, lease_expires_at = (SELECT created_at FROM idempotency_keys WHERE key = ?)
      WHERE key = ? AND status = 'PROCESSING'
    `).run(JSON.stringify(result), idemKey, idemKey)
  }

  /** Marca la reserva como FALLIDA: la clave queda reutilizable por un reintento. */
  private failIdempotency(idemKey: string): void {
    this.db.prepare("UPDATE idempotency_keys SET status = 'FAILED' WHERE key = ? AND status = 'PROCESSING'").run(idemKey)
  }

  /** Ejecuta los efectos del inbound (SOLO se invoca con reserva atómica ganada). */
  private async runInboundEffects(event: InboundEvent, idemKey: string, correlationId: string): Promise<ExecutionResult> {
    const { orgId, contact, message } = event
    const phone = contact.phone
    const complete = (result: ExecutionResult): ExecutionResult => {
      this.completeIdempotency(idemKey, result)
      return result
    }

    // 2. VERIFICACIÓN DE BAJA / SUPRESIÓN
    // Si el contacto solicita baja explícita en este mensaje
    if (this.suppressionStore.isOptOutKeyword(message.text)) {
      this.suppressionStore.addSuppression(orgId, phone, 'Solicitud voluntaria de baja')
      this.lockManager.releaseLock(phone, orgId)

      const farewell = '🚫 Has sido dado de baja correctamente. No volverás a recibir mensajes automáticos de nuestra parte.'
      await this.transport.sendMessage(phone, farewell, correlationId)

      if (contact.clientId) {
        await this.crm.addNote(orgId, contact.clientId, '🚫 [Baja Voluntaria]: El cliente solicitó no recibir más comunicaciones.', correlationId)
      }

      return complete({
        handled: true,
        actionTaken: 'suppression_opt_out',
        replyText: farewell,
        crmSynced: Boolean(contact.clientId),
        correlationId,
      })
    }

    // Si ya estaba en la lista de supresión, se descarta en silencio
    if (this.suppressionStore.isSuppressed(orgId, phone)) {
      return complete({
        handled: false,
        actionTaken: 'ignored',
        error: 'Contacto suprimido por política de baja',
        correlationId,
      })
    }

    // 3. ADQUISICIÓN ATÓMICA DE LOCK
    const lockAcquisition = this.lockManager.acquireLock(phone, orgId, correlationId)
    if (!lockAcquisition.acquired) {
      return complete({
        handled: false,
        actionTaken: 'locked_busy',
        error: lockAcquisition.reason || 'Contacto ocupado en otra conversación',
        correlationId,
      })
    }

    // 4. EVALUACIÓN DE FLUJOS VISUALES (FLOW ENGINE ESTILO MANYCHAT)
    const flowStep = await this.flowEngine.evaluateStep(orgId, phone, message.text, contact)
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
        return complete({
          handled: true,
          actionTaken: 'handoff_human',
          replyText: lastReplyText,
          crmSynced,
          correlationId,
          flowId: flowStep.flowId,
        })
      }

      return complete({
        handled: true,
        actionTaken: 'visual_flow_execution',
        replyText: lastReplyText,
        crmSynced,
        correlationId,
        flowId: flowStep.flowId,
      })
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

      return complete({
        handled: true,
        actionTaken: 'handoff_human',
        replyText: reply,
        crmSynced,
        correlationId,
      })
    }

    // Caso B: Regla determinista de palabra clave (Precios / Catálogo)
    if (ruleMatch.matched && ruleMatch.responseTemplate) {
      const reply = ruleMatch.responseTemplate
      await this.transport.sendMessage(phone, reply, correlationId)

      return complete({
        handled: true,
        actionTaken: 'keyword_rule',
        replyText: reply,
        crmSynced: false,
        correlationId,
      })
    }

    // Caso C: Lead nuevo sin cliente registrado en ALBRA
    if (!contact.clientId) {
      const clientName = contact.name || `Prospecto ${phone.slice(-4)}`
      const crmRes = await this.crm.createClient(orgId, clientName, phone, correlationId)
      const newClientId = crmRes.clientId

      const welcome = `👋 ¡Hola! Gracias por comunicarte con nosotros. Hemos registrado tu consulta. ¿En qué podemos ayudarte hoy? Escribe "PRECIO" para conocer nuestros planes o "ASESOR" para hablar con alguien del equipo.`
      await this.transport.sendMessage(phone, welcome, correlationId)

      return complete({
        handled: true,
        actionTaken: 'new_lead_welcome',
        replyText: welcome,
        crmSynced: crmRes.ok,
        correlationId,
      })
    }

    // Caso D: Mensaje genérico de cliente ya existente
    const genericHelp = '👋 Hemos recibido tu mensaje. Para ver nuestro catálogo escribe "CATALOGO", para precios escribe "PRECIO", o si prefieres hablar con un asesor escribe "ASESOR".'
    await this.transport.sendMessage(phone, genericHelp, correlationId)

    return complete({
      handled: true,
      actionTaken: 'keyword_rule',
      replyText: genericHelp,
      crmSynced: true,
      correlationId,
    })
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
}
