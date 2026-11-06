import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { InboundEvent, InboundContact, ExecutionResult, TransportSender, CrmClientInterface } from '../types.ts'
import { TransportAmbiguousError } from '../adapters/transport.ts'
import { LockManager } from '../state/lock-manager.ts'
import { SuppressionStore } from '../suppression/suppression-store.ts'
import { evaluateDeterministicRules } from './rules.ts'
import { FlowEngine } from './flow-engine.ts'

/** Lease de reserva de idempotencia: si un proceso muere a mitad, su reserva
 * expira y un evento de re-entrega puede tomar posesión (recuperación controlada).
 * (Parametrizable por env SOLO para pruebas de laboratorio; producción usa 120s.) */
export const IDEMPOTENCY_LEASE_SECONDS = Number(process.env.IDEMPOTENCY_LEASE_SECONDS || 120)
/** Renovación del lease mientras el proceso ejecutador está VIVO (tercera reparación 4.C):
 * se renueva periódicamente; si el proceso muere, el lease caduca en ≤120 s y otro toma
 * posesión. (Intervalo parametrizable por env SOLO para pruebas.) */
const LEASE_RENEWAL_INTERVAL_MS = Number(process.env.LEASE_RENEWAL_INTERVAL_MS || 30_000)

/** Error interno: la ejecución pierde la posesión del lease (otro proceso tomó el evento). */
class LeaseLostError extends Error {
  constructor() {
    super('LEASE_LOST: otro proceso tomó posesión del evento (lease vencido y re-adquirido); abortando para evitar efectos duplicados')
  }
}

/**
 * CUARTA FASE CORRECTIVA: un efecto con resultado DESCONOCIDO (quedó IN_FLIGHT
 * por un crash tras la aceptación del proveedor, o UNCERTAIN por ambigüedad)
 * JAMÁS se re-ejecuta automáticamente: exige resolución explícita del operador.
 */
export class EffectUnresolvedError extends Error {
  constructor(effectKeys: string[]) {
    super(`EFFECT_UNRESOLVED: efectos con resultado desconocido (${effectKeys.join(', ')}) — el proveedor pudo aceptarlos; resuélvalos con POST /api/internal/idempotency/effects/resolve antes de reintentar o reconciliar`)
  }
}

/**
 * CUARTA FASE CORRECTIVA: el proveedor NO aceptó el envío (ok:false definitivo,
 * PREFLIGHT). El efecto vuelve a PENDING (reintento seguro); el evento falla
 * limpio — jamás se registra un envío no realizado como completado.
 */
export class EffectNotCompletedError extends Error {
  constructor(effectKey: string, detail: string) {
    super(`SEND_NOT_COMPLETED: el proveedor NO aceptó el envío (${effectKey}): ${detail}`)
  }
}

export interface InboundProcessingMeta {
  idemKey: string
}

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
   *
   * MODELO DE ENTREGA REAL (tercera reparación 4.C — documentado, no prometido):
   *  - La entrega externa es AT LEAST ONCE: la reserva atómica + lease evita
   *    duplicados en operación normal y bajo doble evento concurrente.
   *  - Los EFECTOS externos (mensajes, acciones CRM) quedan en un JOURNAL
   *    duradero: un reingreso tras crash/lease vencido SÓLO ejecuta los efectos
   *    que no alcanzaron a completarse — un mensaje ya enviado JAMÁS se reenvía
   *    por un fallo posterior ("external effect done ⇒ no re-send").
   *  - Si un evento falla DESPUÉS de completar al menos un efecto externo, la
   *    clave queda UNCERTAIN (no FAILED): un reintento ciego está BLOQUEADO y
   *    exige reconciliación explícita (reconcileEvent), que completa sólo los
   *    efectos pendientes del journal.
   */
  async processInbound(event: InboundEvent): Promise<ExecutionResult> {
    // correlationId es opcional en el contrato inbound: si no llega, se usa el eventId
    const { eventId, orgId, contact, message } = event
    const correlationId = event.correlationId || eventId
    const phone = contact.phone
    // Idempotencia SCOPED POR ORGANIZACIÓN: la clave incluye la organización emisora
    // (dos orgs con el mismo eventId NO colisionan).
    const idemKey = `${orgId}::${eventId}`

    // 1. RESERVA ATÓMICA DE IDEMPOTENCIA
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
    if (reservation === 'UNCERTAIN') {
      // Resultado incierto de un intento anterior (efectos externos ya realizados):
      // NO se reintenta a ciegas — exige reconciliación (reconcileEvent).
      return {
        handled: false,
        actionTaken: 'uncertain_needs_reconciliation',
        error: 'El evento tiene resultado INCIERTO de un intento previo; requiere reconciliación antes de reintentar',
        correlationId,
      }
    }
    // reservation === 'RESERVED': esta llamada es la ÚNICA ejecutora.
    // Persistimos el evento original para que la reconciliación pueda re-ejecutarlo.
    try {
      this.persistEventPayload(idemKey, event)
    } catch {}
    const heartbeat = this.startLeaseHeartbeat(idemKey)
    try {
      return await this.runInboundEffects(event, idemKey, correlationId, heartbeat)
    } catch (err) {
      if (err instanceof LeaseLostError) {
        // Perdimos la posesión: NO tocamos la fila (el nuevo dueño gestiona su ciclo)
        throw err
      }
      // Fallo de la ejecución: si ya hay efectos externos COMPLETADOS o EN VUELO
      // (resultado desconocido), la clave queda UNCERTAIN (prohibido el reintento
      // ciego); si no hay ninguno, FAILED permite el reintento limpio.
      this.deferIdempotency(idemKey)
      if (err instanceof EffectUnresolvedError) {
        // CUARTA FASE: la re-entrega de un evento con efectos sin resolver NO
        // lanza — responde el mismo contrato que una reserva UNCERTAIN.
        return {
          handled: false,
          actionTaken: 'uncertain_needs_reconciliation',
          error: err.message,
          correlationId,
        }
      }
      throw err
    } finally {
      heartbeat.stop()
    }
  }

  /**
   * Reserva ATÓMICA de la clave de idempotencia.
   *  - INSERT único: si gana, 'RESERVED'.
   *  - COMPLETED → resultado persistido.
   *  - PROCESSING con lease vivo → 'IN_FLIGHT'.
   *  - PROCESSING con lease VENCIDO (crash) → toma de posesión atómica → 'RESERVED'.
   *  - FAILED (sin efectos externos realizados) → toma de posesión → 'RESERVED'.
   *  - UNCERTAIN (efectos externos ya realizados + resultado desconocido) →
   *    'UNCERTAIN': BLOQUEADO hasta reconciliación explícita.
   */
  private reserveIdempotency(idemKey: string): 'RESERVED' | 'IN_FLIGHT' | 'UNCERTAIN' | `COMPLETED:${string}` {
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
      if (row.status === 'UNCERTAIN') return 'UNCERTAIN'
      if (row.status === 'PROCESSING' && row.lease_expires_at > now) return 'IN_FLIGHT'
      // PROCESSING vencido (crash) o FAILED (intento fallido sin efectos): toma de posesión atómica
      const takeover = this.db.prepare(`
        UPDATE idempotency_keys SET status = 'PROCESSING', response_json = NULL, lease_expires_at = ?, created_at = ?
        WHERE key = ? AND (status = 'FAILED' OR (status = 'PROCESSING' AND lease_expires_at <= ?))
      `).run(lease, now, idemKey, now)
      return Number(takeover.changes) === 1 ? 'RESERVED' : 'IN_FLIGHT'
    }
  }

  /**
   * Renovación del lease mientras ESTE proceso sigue vivo (4.C).
   * Cada 30 s extiende el lease 120 s más. Si la renovación falla (otro proceso
   * tomó posesión), marca `lost` — el siguiente efecto externo aborta con
   * LeaseLostError en lugar de duplicar efectos.
   */
  private startLeaseHeartbeat(idemKey: string): { lost: () => boolean; stop: () => void } {
    let lost = false
    const renew = () => {
      if (lost) return
      const now = Math.floor(Date.now() / 1000)
      const res = this.db.prepare(`
        UPDATE idempotency_keys SET lease_expires_at = ?
        WHERE key = ? AND status = 'PROCESSING'
      `).run(now + IDEMPOTENCY_LEASE_SECONDS, idemKey)
      if (Number(res.changes) !== 1) lost = true
    }
    const timer = setInterval(renew, LEASE_RENEWAL_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return {
      lost: () => lost,
      stop: () => clearInterval(timer),
    }
  }

  /**
   * Ejecuta un efecto externo con JOURNAL duradero (4.C, endurecido en cuarta fase):
   *  - DONE → se salta (jamás se repite un mensaje/escritura ya realizada) y se
   *    devuelve el resultado registrado.
   *  - IN_FLIGHT / UNCERTAIN (resultado DESCONOCIDO de un intento anterior) →
   *    EffectUnresolvedError: JAMÁS se re-ejecuta automáticamente (ventana de
   *    duplicación cerrada); exige resolución explícita por efecto.
   *  - PENDING nuevo → se marca IN_FLIGHT ANTES de llamar al proveedor y DONE
   *    apenas termina; si el proceso muere entre ambos puntos, el reingreso ve
   *    IN_FLIGHT y NO reenvía (ésta era la ventana de duplicación).
   *  - Envío no aceptado (ok:false definitivo, PREFLIGHT) → vuelve a PENDING y
   *    el evento falla limpio (nunca un envío no realizado marcado DONE).
   *  - Error ambiguo (TransportAmbiguousError) → el efecto queda IN_FLIGHT y el
   *    evento UNCERTAIN (resultado externo desconocido ⇒ reconciliación).
   */
  private async journaledEffect<T>(
    idemKey: string,
    heartbeat: { lost: () => boolean },
    effectKey: string,
    effectType: string,
    fn: () => Promise<T>
  ): Promise<T> {
    if (heartbeat.lost()) throw new LeaseLostError()
    const now = Math.floor(Date.now() / 1000)
    const existing = this.db.prepare('SELECT status, result_json FROM inbound_effect_journal WHERE key = ? AND effect_key = ?').get(idemKey, effectKey) as
      | { status: string; result_json: string | null }
      | undefined
    if (existing && existing.status === 'DONE') {
      return (existing.result_json ? JSON.parse(existing.result_json) : undefined) as T
    }
    if (existing && (existing.status === 'IN_FLIGHT' || existing.status === 'UNCERTAIN')) {
      // CUARTA FASE: el proveedor PUDO aceptar este efecto en un intento anterior
      // (crash antes de DONE / ambigüedad). Re-ejecutarlo duplicaría el efecto.
      throw new EffectUnresolvedError([`${effectKey}:${existing.status}`])
    }
    this.db.prepare(`
      INSERT INTO inbound_effect_journal (key, effect_key, effect_type, status, result_json, created_at, updated_at)
      VALUES (?, ?, ?, 'PENDING', NULL, ?, ?)
      ON CONFLICT(key, effect_key) DO NOTHING
    `).run(idemKey, effectKey, effectType, now, now)
    // Marca el INTENTO antes de invocar al proveedor (transición atómica
    // PENDING → IN_FLIGHT): si el proceso muere durante fn(), el journal queda
    // en el estado exacto post-crash y el reingreso NUNCA re-envía a ciegas.
    this.db.prepare(`
      UPDATE inbound_effect_journal SET status = 'IN_FLIGHT', attempt_at = ?, updated_at = ?
      WHERE key = ? AND effect_key = ? AND status = 'PENDING'
    `).run(now, now, idemKey, effectKey)
    try {
      const result = await fn()
      if (effectType === 'send_message') {
        const r = result as { ok?: boolean; error?: string } | null | undefined
        if (r && r.ok === false) {
          // No-aceptación DEFINITIVA: el mensaje NO salió. El efecto vuelve a
          // PENDING (reintento seguro) y el evento falla limpio — corregido el
          // defecto de registrar un envío no realizado como DONE (pérdida).
          this.db.prepare(`
            UPDATE inbound_effect_journal SET status = 'PENDING', attempt_at = NULL, updated_at = ?
            WHERE key = ? AND effect_key = ? AND status = 'IN_FLIGHT'
          `).run(Math.floor(Date.now() / 1000), idemKey, effectKey)
          throw new EffectNotCompletedError(effectKey, String(r.error || 'sin detalle'))
        }
      }
      this.db.prepare(`
        UPDATE inbound_effect_journal SET status = 'DONE', result_json = ?, updated_at = ?
        WHERE key = ? AND effect_key = ?
      `).run(JSON.stringify(result ?? null), Math.floor(Date.now() / 1000), idemKey, effectKey)
      return result
    } catch (err) {
      if (err instanceof EffectNotCompletedError || err instanceof EffectUnresolvedError) throw err
      if (err instanceof LeaseLostError) {
        // Perdió la posesión ANTES de llamar al proveedor: el efecto no inició —
        // vuelve a PENDING para el nuevo dueño.
        this.db.prepare(`
          UPDATE inbound_effect_journal SET status = 'PENDING', attempt_at = NULL, updated_at = ?
          WHERE key = ? AND effect_key = ? AND status = 'IN_FLIGHT'
        `).run(Math.floor(Date.now() / 1000), idemKey, effectKey)
        throw err
      }
      if (err instanceof TransportAmbiguousError) {
        // Resultado EXTERNO DESCONOCIDO: el efecto queda IN_FLIGHT y el evento
        // UNCERTAIN — la reconciliación exige resolución explícita.
        throw err
      }
      // Error local DEFINITIVO (validación, rechazo sincrónico sin contacto con
      // el proveedor): vuelve a PENDING — semántica de fase 3 conservada.
      this.db.prepare(`
        UPDATE inbound_effect_journal SET status = 'PENDING', attempt_at = NULL, updated_at = ?
        WHERE key = ? AND effect_key = ? AND status = 'IN_FLIGHT'
      `).run(Math.floor(Date.now() / 1000), idemKey, effectKey)
      throw err
    }
  }

  /** Huella estable para claves de efecto (evita claves kilométricas con contenido variable). */
  private effectHash(...parts: string[]): string {
    return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24)
  }

  /** Persiste el resultado final del evento (estado COMPLETED, legible por réplicas). */
  private completeIdempotency(idemKey: string, result: ExecutionResult): void {
    this.db.prepare(`
      UPDATE idempotency_keys SET status = 'COMPLETED', response_json = ?, lease_expires_at = 0
      WHERE key = ? AND status = 'PROCESSING'
    `).run(JSON.stringify(result), idemKey)
  }

  /**
   * Marca la reserva tras un fallo: FAILED si no hubo efectos externos con
   * efectos externos realizados o EN VUELO (reintento limpio permitido);
   * UNCERTAIN si ya hubo al menos un efecto DONE/IN_FLIGHT/UNCERTAIN (reintento
   * ciego PROHIBIDO hasta reconciliación y resolución de efectos).
   */
  private deferIdempotency(idemKey: string): void {
    const done = this.db.prepare("SELECT COUNT(*) AS n FROM inbound_effect_journal WHERE key = ? AND status IN ('DONE', 'IN_FLIGHT', 'UNCERTAIN')").get(idemKey) as { n: number }
    const target = done.n > 0 ? 'UNCERTAIN' : 'FAILED'
    this.db.prepare("UPDATE idempotency_keys SET status = ? WHERE key = ? AND status = 'PROCESSING'").run(target, idemKey)
  }

  /** Ejecuta los efectos del inbound (SOLO se invoca con reserva atómica ganada). */
  private async runInboundEffects(
    event: InboundEvent,
    idemKey: string,
    correlationId: string,
    heartbeat: { lost: () => boolean },
    opts: { skipLock?: boolean } = {}
  ): Promise<ExecutionResult> {
    const { orgId, contact, message } = event
    const phone = contact.phone
    const complete = (result: ExecutionResult): ExecutionResult => {
      this.completeIdempotency(idemKey, result)
      return result
    }
    // CUARTA FASE: un efecto con resultado DESCONOCIDO de un intento anterior
    // (crash tras aceptación del proveedor / ambigüedad) BLOQUEA todo el ciclo
    // antes de tocar locks o enviar nada: exige resolución explícita.
    const unresolved = this.db.prepare(
      "SELECT effect_key, status FROM inbound_effect_journal WHERE key = ? AND status IN ('IN_FLIGHT', 'UNCERTAIN') ORDER BY effect_key"
    ).all(idemKey) as Array<{ effect_key: string; status: string }>
    if (unresolved.length > 0) {
      throw new EffectUnresolvedError(unresolved.map((u) => `${u.effect_key}:${u.status}`))
    }

    /** Envío externo journaleado: un mensaje ya enviado NO se reenvía nunca (4.C).
     * CUARTA FASE: transmite la clave de idempotencia EXTERNA determinista
     * (wpfx_hash(evento, efecto)) para que el daemon pueda deduplicar. */
    const send = (effectKey: string, text: string) =>
      this.journaledEffect(idemKey, heartbeat, `send:${effectKey}`, 'send_message', () =>
        this.transport.sendMessage(phone, text, correlationId, `wpfx_${this.effectHash(idemKey, `send:${effectKey}`)}`)
      )
    /** Acción CRM journaleada. */
    const crmEffect = <T>(effectKey: string, fn: () => Promise<T>) =>
      this.journaledEffect(idemKey, heartbeat, `crm:${effectKey}`, 'crm_action', fn)

    // 2. VERIFICACIÓN DE BAJA / SUPRESIÓN
    if (this.suppressionStore.isOptOutKeyword(message.text)) {
      this.suppressionStore.addSuppression(orgId, phone, 'Solicitud voluntaria de baja')
      this.lockManager.releaseLock(phone, orgId)

      const farewell = '🚫 Has sido dado de baja correctamente. No volverás a recibir mensajes automáticos de nuestra parte.'
      await send('optout_farewell', farewell)

      if (contact.clientId) {
        await crmEffect('optout_note', () =>
          this.crm.addNote(orgId, contact.clientId as string, '🚫 [Baja Voluntaria]: El cliente solicitó no recibir más comunicaciones.', correlationId)
        )
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
    // (4.C) La RECONCILIACIÓN re-procesa el MISMO evento ya reservado: su lock
    // pudo quedar en HANDOFF_HUMAN por el intento original; re-adquirirlo
    // bloquearía la re-ejecución con "locked_busy" sin completar los efectos
    // pendientes. La exclusión mutua ya la da la reserva de idempotencia.
    if (!opts.skipLock) {
      const lockAcquisition = this.lockManager.acquireLock(phone, orgId, correlationId)
      if (!lockAcquisition.acquired) {
        return complete({
          handled: false,
          actionTaken: 'locked_busy',
          error: lockAcquisition.reason || 'Contacto ocupado en otra conversación',
          correlationId,
        })
      }
    }

    // 4. EVALUACIÓN DE FLUJOS VISUALES (FLOW ENGINE ESTILO MANYCHAT)
    const flowStep = await this.flowEngine.evaluateStep(orgId, phone, message.text, contact)
    if (flowStep.handled) {
      let crmSynced = false

      // A. Ejecutar acciones de negocio en CRM ALBRA si el nodo lo requiere (con journal)
      let actionIndex = 0
      for (const act of flowStep.actionsToExecute) {
        if (act.action === 'create_opportunity') {
          const clientId = contact.clientId || (await this.ensureClient(orgId, contact, correlationId, idemKey, heartbeat, actionIndex))
          if (clientId) {
            const title = (act.params.title as string) || 'Oportunidad desde Flujo'
            const amount = Number(act.params.amount) || 100
            const crmRes = await crmEffect(`opp_${actionIndex}`, () => this.crm.createOpportunity(orgId, clientId, title, amount, correlationId))
            crmSynced = crmSynced || crmRes.ok
          }
        } else if (act.action === 'add_note') {
          const clientId = contact.clientId || (await this.ensureClient(orgId, contact, correlationId, idemKey, heartbeat, actionIndex))
          if (clientId) {
            const noteContent = (act.params.content as string) || `🤖 Nota de flujo: ${message.text}`
            const crmRes = await crmEffect(`note_${actionIndex}`, () => this.crm.addNote(orgId, clientId, noteContent, correlationId))
            crmSynced = crmSynced || crmRes.ok
          }
        }
        actionIndex++
      }

      // B. Enviar mensajes generados por el flujo (cada uno journaleado)
      let lastReplyText = ''
      let msgIndex = 0
      for (const msg of flowStep.messagesToSend) {
        const text = typeof msg === 'string' ? msg : msg.text
        await send(`flow_${msgIndex}:${this.effectHash(phone, text)}`, text)
        lastReplyText = text
        msgIndex++
      }

      // C. Manejo de Handoff a humano si el nodo lo requiere
      if (flowStep.isHandoff) {
        this.lockManager.setHandoff(phone, orgId, correlationId)
        if (contact.clientId) {
          await crmEffect('handoff_note', () =>
            this.crm.addNote(
              orgId,
              contact.clientId as string,
              `🤖 [Handoff ManyChat]: ${flowStep.handoffReason || 'Transferencia solicitada en flujo'}`,
              correlationId
            )
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
      await send('rule_handoff_reply', reply)

      let crmSynced = false
      if (contact.clientId) {
        const noteContent = `🤖 [Handoff IA]: El cliente solicitó asesor humano. Último mensaje: "${message.text}".`
        const crmRes = await crmEffect('rule_handoff_note', () => this.crm.addNote(orgId, contact.clientId as string, noteContent, correlationId))
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
      await send('rule_keyword_reply', reply)

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
      const crmRes = await crmEffect('lead_create_client', () => this.crm.createClient(orgId, clientName, phone, correlationId))
      const newClientId = crmRes.clientId

      const welcome = `👋 ¡Hola! Gracias por comunicarte con nosotros. Hemos registrado tu consulta. ¿En qué podemos ayudarte hoy? Escribe "PRECIO" para conocer nuestros planes o "ASESOR" para hablar con alguien del equipo.`
      await send('lead_welcome', welcome)

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
    await send('generic_help', genericHelp)

    return complete({
      handled: true,
      actionTaken: 'keyword_rule',
      replyText: genericHelp,
      crmSynced: true,
      correlationId,
    })
  }

  private async ensureClient(
    orgId: string,
    contact: InboundContact,
    correlationId: string,
    idemKey: string,
    heartbeat: { lost: () => boolean },
    actionIndex: number
  ): Promise<string | undefined> {
    if (contact.clientId) return contact.clientId
    const name = contact.name || `Prospecto ${contact.phone.slice(-4)}`
    const res = await this.journaledEffect(idemKey, heartbeat, `ensure_client_${actionIndex}`, 'crm_action', () =>
      this.crm.createClient(orgId, name, contact.phone, correlationId)
    )
    if (res.ok && res.clientId) {
      contact.clientId = res.clientId
      return res.clientId
    }
    return undefined
  }

  // ===========================================================================
  // RECONCILIACIÓN DE EVENTOS UNCERTAIN (tercera reparación 4.C; resolutión
  // por efecto añadida en la cuarta fase correctiva)
  // ===========================================================================

  /** Lista eventos con resultado incierto (para operación/auditoría), con sus
   * efectos sin resolver (IN_FLIGHT/UNCERTAIN) que exigen decisión del operador. */
  listUncertainEvents(limit: number = 50): Array<{ key: string; createdAt: number; leaseExpiresAt: number; unresolvedEffects: Array<{ effectKey: string; effectType: string; status: string; attemptedAt: number | null }> }> {
    const rows = this.db.prepare(
      "SELECT key, created_at, lease_expires_at FROM idempotency_keys WHERE status IN ('UNCERTAIN') ORDER BY created_at ASC LIMIT ?"
    ).all(limit) as Array<{ key: string; created_at: number; lease_expires_at: number }>
    return rows.map((r) => {
      const fx = this.db.prepare(
        "SELECT effect_key, effect_type, status, attempt_at FROM inbound_effect_journal WHERE key = ? AND status IN ('IN_FLIGHT', 'UNCERTAIN') ORDER BY effect_key"
      ).all(r.key) as Array<{ effect_key: string; effect_type: string; status: string; attempt_at: number | null }>
      return {
        key: r.key,
        createdAt: r.created_at,
        leaseExpiresAt: r.lease_expires_at,
        unresolvedEffects: fx.map((f) => ({ effectKey: f.effect_key, effectType: f.effect_type, status: f.status, attemptedAt: f.attempt_at })),
      }
    })
  }

  /**
   * CUARTA FASE: resolución EXPLÍCITA de un efecto con resultado desconocido.
   *  - 'delivered': el operador CONFIRMA el efecto externo (visto en el daemon/
   *    proveedor) → DONE con marca de reconciliación; jamás se re-ejecuta.
   *  - 'not_delivered': el operador CONFIRMA que NO ocurrió → PENDiente
   *    re-ejecutable por reconciliación/reintento.
   * Solo aplica a efectos IN_FLIGHT o UNCERTAIN (jamás a DONE/PENDING).
   */
  resolveEffect(idemKey: string, effectKey: string, resolution: 'delivered' | 'not_delivered', note?: string): { ok: boolean; effectKey: string; status: string } {
    const now = Math.floor(Date.now() / 1000)
    const row = this.db.prepare('SELECT status, effect_type FROM inbound_effect_journal WHERE key = ? AND effect_key = ?').get(idemKey, effectKey) as
      | { status: string; effect_type: string } | undefined
    if (!row) throw new Error(`EFFECT_NOT_FOUND: ${idemKey}/${effectKey}`)
    if (row.status !== 'IN_FLIGHT' && row.status !== 'UNCERTAIN') {
      throw new Error(`EFFECT_NOT_RESOLVABLE: el efecto ${effectKey} está ${row.status} (solo IN_FLIGHT/UNCERTAIN requieren resolución)`)
    }
    if (resolution === 'delivered') {
      this.db.prepare(`
        UPDATE inbound_effect_journal SET status = 'DONE', result_json = ?, updated_at = ?
        WHERE key = ? AND effect_key = ?
      `).run(JSON.stringify({ reconciled: true, resolution: 'delivered', note: note || null }), now, idemKey, effectKey)
      console.warn(`[Auditoría 2A] efecto RESUELTO delivered key=${idemKey} effect=${effectKey} tipo=${row.effect_type} (sin datos sensibles)`)
      return { ok: true, effectKey, status: 'DONE' }
    }
    this.db.prepare(`
      UPDATE inbound_effect_journal SET status = 'PENDING', attempt_at = NULL, result_json = NULL, updated_at = ?
      WHERE key = ? AND effect_key = ?
    `).run(now, idemKey, effectKey)
    console.warn(`[Auditoría 2A] efecto RESUELTO not_delivered key=${idemKey} effect=${effectKey} tipo=${row.effect_type} (sin datos sensibles)`)
    return { ok: true, effectKey, status: 'PENDING' }
  }

  /** Efectos sin resolver de una clave (usado por la puerta de reconciliación). */
  private listUnresolvedEffects(idemKey: string): Array<{ effect_key: string; status: string }> {
    return this.db.prepare(
      "SELECT effect_key, status FROM inbound_effect_journal WHERE key = ? AND status IN ('IN_FLIGHT', 'UNCERTAIN') ORDER BY effect_key"
    ).all(idemKey) as Array<{ effect_key: string; status: string }>
  }

  /**
   * Reconcilia UN evento UNCERTAIN (nunca un reintento ciego):
   * re-ejecuta el ciclo del evento reutilizando el journal — los efectos DONE
   * se saltan (ningún mensaje se reenvía), los PENDING se completan y la clave
   * termina COMPLETED con su resultado. Devuelve el resultado o null si la
   * clave no estaba UNCERTAIN.
   */
  async reconcileEvent(idemKey: string): Promise<ExecutionResult | null> {
    const now = Math.floor(Date.now() / 1000)
    // CUARTA FASE (fail-closed): con efectos de resultado DESCONOCIDO, la
    // reconciliación está BLOQUEADA — el operador debe resolver cada efecto
    // (delivered/not_delivered) ANTES; jamás se re-ejecuta a ciegas.
    const unresolved = this.listUnresolvedEffects(idemKey)
    if (unresolved.length > 0) {
      throw new Error(`RECONCILE_BLOCKED_UNRESOLVED_EFFECTS: resuelva primero ${unresolved.map((u) => `${u.effect_key}:${u.status}`).join(', ')} vía POST /api/internal/idempotency/effects/resolve`)
    }
    const claim = this.db.prepare(`
      UPDATE idempotency_keys SET status = 'PROCESSING', response_json = NULL, lease_expires_at = ?
      WHERE key = ? AND status = 'UNCERTAIN'
    `).run(now + IDEMPOTENCY_LEASE_SECONDS, idemKey)
    if (Number(claim.changes) !== 1) return null

    // Re-construye el evento original desde el journal + contexto persistido.
    // El journal guarda las huellas de los efectos; el EVENTO completo se
    // necesita para re-ejecutar: se persiste en el primer intento.
    const raw = this.db.prepare('SELECT payload_json FROM idempotency_event_payloads WHERE key = ?').get(idemKey) as { payload_json: string } | undefined
    if (!raw) {
      // Sin payload persistido no hay reintento seguro: deja constancia y queda UNCERTAIN.
      this.db.prepare("UPDATE idempotency_keys SET status = 'UNCERTAIN' WHERE key = ?").run(idemKey)
      throw new Error(`RECONCILE_IMPOSSIBLE: sin payload persistido para ${idemKey} (resolución manual requerida)`)
    }
    const event = JSON.parse(raw.payload_json) as InboundEvent
    const heartbeat = this.startLeaseHeartbeat(idemKey)
    try {
      return await this.runInboundEffects(event, idemKey, event.correlationId || event.eventId, heartbeat, { skipLock: true })
    } catch (err) {
      this.deferIdempotency(idemKey)
      throw err
    } finally {
      heartbeat.stop()
    }
  }

  /** Guarda el payload del evento para reconciliación posterior (4.C). */
  private persistEventPayload(idemKey: string, event: InboundEvent): void {
    this.db.prepare(`
      INSERT INTO idempotency_event_payloads (key, payload_json, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO NOTHING
    `).run(idemKey, JSON.stringify(event), Math.floor(Date.now() / 1000))
  }
}
