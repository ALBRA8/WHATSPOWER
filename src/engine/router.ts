import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { InboundEvent, InboundContact, ExecutionResult, TransportSender, CrmClientInterface } from '../types.ts'
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
 * B2 — Resultado AMBIGUO del transporte (5xx/timeout/conexión cortada/respuesta
 * ilegible): el mensaje PUDO haberse aceptado por el daemon antes del fallo.
 * El efecto de envío queda PENDING en el journal y la clave de idempotencia
 * UNCERTAIN: prohibido el reintento ciego; exige reconciliación explícita.
 */
export class AmbiguousDispatchError extends Error {
  constructor(reason: string) {
    super(`AMBIGUOUS_DISPATCH: resultado incierto del transporte (${reason}); el mensaje pudo haberse enviado — requiere reconciliación, no reintento ciego`)
  }
}

/**
 * B2 (fase final) — Evidencia durable de un envío externo registrada ANTES de
 * llamar a Baileys (tabla daemon_send_idempotency, única por
 * (organization_id, idempotency_key)). El daemon Baileys de Capa 1 no consume
 * ni persiste la clave (hallazgo B2), así que la deduplicación fiable vive
 * AQUÍ: una clave repetida en IN_FLIGHT/SENT/UNCERTAIN devuelve su estado y
 * NUNCA re-despacha el mensaje.
 */
export interface SendAttemptRecord {
  organization_id: string
  idempotency_key: string
  status: 'IN_FLIGHT' | 'SENT' | 'UNCERTAIN' | 'REJECTED'
  to_phone: string
  message_text: string
  correlation_id: string
  daemon_message_id: string | null
  attempt_count: number
  resend_authorized_at: number | null
  created_at: number
  updated_at: number
}

/** Informe de reconciliación con EVIDENCIA (B2: resolución documentada, no a ciegas). */
export interface ReconcileReport {
  key: string
  /** true sólo si la clave terminó COMPLETED. */
  resolved: boolean
  /** true si quedan efectos/envíos sin confirmar: exige decisión humana con evidencia. */
  requiresManualResolution: boolean
  /** Autorización explícita de reenvío aplicada en esta reconciliación. */
  resendAuthorized: boolean
  /** Evidencia de envíos cuyo resultado sigue desconocido (registry UNCERTAIN/IN_FLIGHT). */
  uncertainSends: Array<{
    idempotencyKey: string
    status: string
    to: string
    textPreview: string
    attempts: number
    correlationId: string
    updatedAt: number
  }>
  /** Efectos del journal que siguen sin confirmar (PENDING/UNCERTAIN). */
  pendingEffects: Array<{ effectKey: string; effectType: string; status: string }>
  note?: string
}

/**
 * B2 — Rechazo DEFINITIVO con evidencia fiable de NO aceptación
 * (4xx a nivel API antes del despacho, o guard local). El efecto se marca
 * REJECTED en el journal y la clave queda FAILED: el reintento limpio está
 * permitido porque hay certeza de que el mensaje NO salió.
 */
/**
 * B2 (hardening de reconciliación) — La clave de idempotencia pertenece a OTRA
 * organización: la reconciliación se niega (fail-closed, sin filtrar de qué org
 * es la clave). El guard se evalúa ANTES de tomar posesión de la clave.
 */
export class ReconcileForbiddenOrgError extends Error {
  constructor(requestingOrg: string) {
    super(`RECONCILE_FORBIDDEN_ORG: la clave de idempotencia no pertenece a la organización autenticada (org solicitante: ${requestingOrg})`)
    this.name = 'ReconcileForbiddenOrgError'
  }
}

export class TransportRejectedError extends Error {
  constructor(reason: string) {
    super(`TRANSPORT_REJECTED: envío no aceptado por el transporte (${reason}); evidencia fiable de no aceptación`)
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
    const reservation = this.reserveIdempotency(idemKey, orgId)
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
    if (reservation === 'UNCERTAIN' || reservation === 'UNCERTAIN_RECOVERED') {
      // Resultado incierto de un intento anterior (efectos externos ya realizados):
      // NO se reintenta a ciegas — exige reconciliación (reconcileEvent).
      // UNCERTAIN_RECOVERED: la ejecución previa MURIÓ (lease vencido) dejando
      // efectos PENDING/UNCERTAIN — el reingreso los convirtió a UNCERTAIN con
      // evidencia (B2: jamás se re-ejecutan automáticamente tras una caída).
      return {
        handled: false,
        actionTaken: 'uncertain_needs_reconciliation',
        error: reservation === 'UNCERTAIN'
          ? 'El evento tiene resultado INCIERTO de un intento previo; requiere reconciliación antes de reintentar'
          : 'Evento interrumpido (caída o lease vencido) con efectos no confirmados: marcados UNCERTAIN con evidencia; requiere reconciliación antes de reintentar',
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
      // Fallo de la ejecución: si ya hay efectos externos COMPLETADOS, la clave
      // queda UNCERTAIN (prohibido el reintento ciego); si no hay ninguno,
      // FAILED permite el reintento limpio de la pasarela/remitente.
      this.deferIdempotency(idemKey)
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
   *  - PROCESSING con lease VENCIDO (crash) → toma de posesión atómica:
   *      · si el journal NO tiene efectos sin confirmar → 'RESERVED' (la caída
   *        fue previa a cualquier efecto: re-ejecución segura).
   *      · si hay efectos PENDING/UNCERTAIN → 'UNCERTAIN_RECOVERED' (B2): los
   *        PENDING pasan a UNCERTAIN con evidencia y JAMÁS se re-ejecutan
   *        automáticamente tras una caída o vencimiento del lease.
   *  - FAILED (sin efectos externos sin confirmar) → toma de posesión → 'RESERVED'.
   *  - UNCERTAIN (efectos externos ya realizados + resultado desconocido) →
   *    'UNCERTAIN': BLOQUEADO hasta reconciliación explícita.
   */
  private reserveIdempotency(
    idemKey: string,
    orgId: string
  ): 'RESERVED' | 'IN_FLIGHT' | 'UNCERTAIN' | 'UNCERTAIN_RECOVERED' | `COMPLETED:${string}` {
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
      // B2: la distincción importa — FAILED implica que la ejecución previa
      // TERMINÓ con manejo de error (los PENDING son efectos fallidos con
      // error conocido → reintento limpio); PROCESSING vencido implica CAÍDA
      // (los PENDING tienen resultado DESCONOCIDO → jamás se re-ejecutan).
      const crashed = row.status === 'PROCESSING'
      const takeover = this.db.prepare(`
        UPDATE idempotency_keys SET status = 'PROCESSING', response_json = NULL, lease_expires_at = ?, created_at = ?
        WHERE key = ? AND (status = 'FAILED' OR (status = 'PROCESSING' AND lease_expires_at <= ?))
      `).run(lease, now, idemKey, now)
      if (Number(takeover.changes) !== 1) return 'IN_FLIGHT'

      // ============================================================
      // B2 (requisito 4) — TRAS UNA CAÍDA O VENCIMIENTO DEL LEASE los efectos
      // PENDING del journal JAMÁS se re-ejecutan automáticamente: el efecto
      // pudo haber llegado al daemon antes del crash (el daemon de Capa 1 no
      // deduplica). Pasan a UNCERTAIN (con evidencia) y exigen reconciliación.
      // Sólo una ejecución sin efectos sin confirmar (caída previa a todo
      // efecto) se re-ejecuta de forma segura.
      // ============================================================
      if (crashed) {
        const stale = this.db.prepare(
          "SELECT effect_key, effect_type FROM inbound_effect_journal WHERE key = ? AND status IN ('PENDING','UNCERTAIN')"
        ).all(idemKey) as Array<{ effect_key: string; effect_type: string }>
        if (stale.length > 0) {
          this.db.prepare(
            "UPDATE inbound_effect_journal SET status = 'UNCERTAIN', updated_at = ? WHERE key = ? AND status = 'PENDING'"
          ).run(now, idemKey)
          // Envíos huérfanos IN_FLIGHT en el registro durable → UNCERTAIN
          // (la ejecución dueña murió sin registrar resultado: estado desconocido).
          const corr = this.resolveCorrelationId(idemKey, orgId)
          for (const s of stale) {
            if (s.effect_type !== 'send_message') continue
            const effectKey = s.effect_key.startsWith('send:') ? s.effect_key.slice('send:'.length) : s.effect_key
            this.db.prepare(`
              UPDATE daemon_send_idempotency SET status = 'UNCERTAIN', updated_at = ?
              WHERE organization_id = ? AND idempotency_key = ? AND status = 'IN_FLIGHT'
            `).run(now, orgId, `${corr}#${effectKey}`)
          }
          this.db.prepare("UPDATE idempotency_keys SET status = 'UNCERTAIN' WHERE key = ?").run(idemKey)
          return 'UNCERTAIN_RECOVERED'
        }
      }
      return 'RESERVED'
    }
  }

  /** correlationId del evento persistido (fallback: parte del idemKey tras `org::`). */
  private resolveCorrelationId(idemKey: string, orgId: string): string {
    const raw = this.db.prepare('SELECT payload_json FROM idempotency_event_payloads WHERE key = ?').get(idemKey) as { payload_json: string } | undefined
    if (raw) {
      try {
        const ev = JSON.parse(raw.payload_json) as InboundEvent
        return ev.correlationId || ev.eventId
      } catch {}
    }
    return idemKey.slice(orgId.length + 2)
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
   * B2 (fase final) — Reclama el intento de envío en el registro durable
   * daemon_send_idempotency, ANTES de llamar a Baileys (requisito 2).
   *  - Sin fila previa → INSERT IN_FLIGHT (la llamada es la dueña del intento).
   *  - Fila previa REJECTED (evidencia fiable de no aceptación) o UNCERTAIN
   *    con autorización EXPLÍCITA de reenvío (resend_authorized_at, sólo la
   *    establece reconcileEvent con confirmResend) → un único reintento:
   *    IN_FLIGHT + attempt_count+1 + autorización consumida.
   *  - Cualquier otro estado previo (IN_FLIGHT/SENT/UNCERTAIN sin autorizar) →
   *    { owned: false, prior }: el llamador devuelve el estado SIN reenviar
   *    (requisito 3).
   */
  private claimSendAttempt(
    orgId: string,
    sendIdemKey: string,
    phone: string,
    text: string,
    correlationId: string
  ): { owned: boolean; prior?: string; messageId?: string | null } {
    const now = Math.floor(Date.now() / 1000)
    try {
      this.db.prepare(`
        INSERT INTO daemon_send_idempotency
          (organization_id, idempotency_key, status, to_phone, message_text, correlation_id, attempt_token, attempt_count, created_at, updated_at)
        VALUES (?, ?, 'IN_FLIGHT', ?, ?, ?, ?, 1, ?, ?)
      `).run(orgId, sendIdemKey, phone, text, correlationId, randomUUID(), now, now)
      return { owned: true }
    } catch {
      const row = this.db.prepare(
        'SELECT status, daemon_message_id, resend_authorized_at FROM daemon_send_idempotency WHERE organization_id = ? AND idempotency_key = ?'
      ).get(orgId, sendIdemKey) as { status: string; daemon_message_id: string | null; resend_authorized_at: number | null } | undefined
      if (!row) return { owned: false, prior: undefined }
      if (row.status === 'REJECTED' || (row.status === 'UNCERTAIN' && row.resend_authorized_at != null)) {
        const retry = this.db.prepare(`
          UPDATE daemon_send_idempotency
          SET status = 'IN_FLIGHT', attempt_token = ?, attempt_count = attempt_count + 1, resend_authorized_at = NULL, updated_at = ?
          WHERE organization_id = ? AND idempotency_key = ?
            AND (status = 'REJECTED' OR (status = 'UNCERTAIN' AND resend_authorized_at IS NOT NULL))
        `).run(randomUUID(), now, orgId, sendIdemKey)
        if (Number(retry.changes) === 1) return { owned: true }
        // Otro ejecutor ganó el reintento: devolver el estado actualizado.
        const winner = this.db.prepare(
          'SELECT status, daemon_message_id FROM daemon_send_idempotency WHERE organization_id = ? AND idempotency_key = ?'
        ).get(orgId, sendIdemKey) as { status: string; daemon_message_id: string | null } | undefined
        return { owned: false, prior: winner?.status, messageId: winner?.daemon_message_id }
      }
      return { owned: false, prior: row.status, messageId: row.daemon_message_id }
    }
  }

  /** Registra el resultado del intento de envío (evidencia durable). */
  private recordSendOutcome(orgId: string, sendIdemKey: string, status: 'SENT' | 'UNCERTAIN' | 'REJECTED', daemonMessageId?: string): void {
    this.db.prepare(`
      UPDATE daemon_send_idempotency
      SET status = ?, daemon_message_id = COALESCE(?, daemon_message_id), updated_at = ?
      WHERE organization_id = ? AND idempotency_key = ?
    `).run(status, daemonMessageId ?? null, Math.floor(Date.now() / 1000), orgId, sendIdemKey)
  }

  /**
   * Ejecuta un efecto externo con JOURNAL duradero (4.C):
   *  - DONE → se salta (jamás se repite un mensaje/escritura ya realizada) y se
   *    devuelve el resultado registrado.
   *  - PENDING nuevo → ejecuta fn; al éxito marca DONE con el resultado.
   *  - Si fn lanza, el efecto queda PENDING (la reconciliación sólo re-ejecuta
   *    los pendientes).
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
    this.db.prepare(`
      INSERT INTO inbound_effect_journal (key, effect_key, effect_type, status, result_json, created_at, updated_at)
      VALUES (?, ?, ?, 'PENDING', NULL, ?, ?)
      ON CONFLICT(key, effect_key) DO NOTHING
    `).run(idemKey, effectKey, effectType, now, now)
    const result = await fn()
    this.db.prepare(`
      UPDATE inbound_effect_journal SET status = 'DONE', result_json = ?, updated_at = ?
      WHERE key = ? AND effect_key = ?
    `).run(JSON.stringify(result ?? null), Math.floor(Date.now() / 1000), idemKey, effectKey)
    return result
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
   * Marca la reserva tras un fallo: FAILED si no hubo efectos externos
   * completados NI envíos en estado ambiguo (reintento limpio permitido);
   * UNCERTAIN si ya hubo al menos un efecto externo DONE o si queda algún
   * envío sin confirmar (PENDING o UNCERTAIN — B2: un envío ambiguo pudo
   * llegar al daemon aunque esta ejecución no lo sepa — reintento ciego
   * PROHIBIDO hasta reconciliación).
   */
  private deferIdempotency(idemKey: string): void {
    const done = this.db.prepare("SELECT COUNT(*) AS n FROM inbound_effect_journal WHERE key = ? AND status = 'DONE'").get(idemKey) as { n: number }
    const pendingSends = this.db.prepare("SELECT COUNT(*) AS n FROM inbound_effect_journal WHERE key = ? AND status IN ('PENDING','UNCERTAIN') AND effect_type = 'send_message'").get(idemKey) as { n: number }
    const target = done.n > 0 || pendingSends.n > 0 ? 'UNCERTAIN' : 'FAILED'
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
    /** Envío externo journaleado: un mensaje ya enviado NO se reenvía nunca (4.C).
     * B2 (fase final): el envío queda registrado ANTES de llamar a Baileys en
     * daemon_send_idempotency (única (organization_id, idempotency_key)). Una
     * clave repetida en IN_FLIGHT/SENT/UNCERTAIN devuelve su estado registrada
     * y NO vuelve a invocar al transporte; sólo un REJECTED previo (evidencia
     * fiable de no aceptación) permite el reintento limpio. El resultado del
     * transporte se CLASIFICA — ambiguo lanza AmbiguousDispatchError (efecto
     * PENDING + clave UNCERTAIN, sin reintentos ciegos); rechazo definitivo
     * (4xx) lanza TransportRejectedError y marca el efecto REJECTED. Un
     * resultado sin clasificar y fallido se asume ambiguo (fail-safe). */
    const send = (effectKey: string, text: string) =>
      this.journaledEffect(idemKey, heartbeat, `send:${effectKey}`, 'send_message', async () => {
        const sendIdemKey = `${correlationId}#${effectKey}`
        const claim = this.claimSendAttempt(orgId, sendIdemKey, phone, text, correlationId)
        if (!claim.owned) {
          // Repetición de una clave ya registrada (reingreso, reconciliación o
          // toma de posesión tras lease vencido): se devuelve el estado
          // registrada y JAMÁS se vuelve a despachar el mensaje.
          if (claim.prior === 'SENT') {
            return { ok: true, messageId: claim.messageId ?? undefined, outcome: 'SENT' as const, sendDeduplicated: true }
          }
          throw new AmbiguousDispatchError(
            `SEND_ALREADY_ATTEMPTED: clave de envío ${sendIdemKey} en estado ${claim.prior ?? 'DESCONOCIDO'} — estado devuelto sin reenvío (B2)`
          )
        }
        let res: Awaited<ReturnType<typeof this.transport.sendMessage>>
        try {
          // OLEADA 2 (decisión 2026-11-11 #6): el orgId acompaña al envío para
          // que los transportes por organización (Meta Cloud) usen SIEMPRE las
          // credenciales de ESA organización. Los transportes legacy lo ignoran.
          res = await this.transport.sendMessage(phone, text, correlationId, sendIdemKey, orgId)
        } catch (err) {
          // Un throw del transporte (red cortada a mitad) NO prueba que el daemon
          // no aceptara: ambiguo, jamás rechazo definitivo.
          this.recordSendOutcome(orgId, sendIdemKey, 'UNCERTAIN')
          throw new AmbiguousDispatchError(err instanceof Error ? err.message : String(err))
        }
        if (!res.ok) {
          if (res.outcome === 'REJECTED') {
            // Evidencia fiable de no aceptación: el efecto queda REJECTED
            // (terminal) para no forzar UNCERTAIN ni bloquear el reintento limpio.
            this.recordSendOutcome(orgId, sendIdemKey, 'REJECTED')
            this.db.prepare(
              "UPDATE inbound_effect_journal SET status = 'REJECTED', result_json = ?, updated_at = ? WHERE key = ? AND effect_key = ? AND status = 'PENDING'"
            ).run(JSON.stringify(res), Math.floor(Date.now() / 1000), idemKey, `send:${effectKey}`)
            throw new TransportRejectedError(res.error || 'rechazo sin detalle')
          }
          this.recordSendOutcome(orgId, sendIdemKey, 'UNCERTAIN')
          throw new AmbiguousDispatchError(res.error || 'fallo sin clasificación del transporte')
        }
        this.recordSendOutcome(orgId, sendIdemKey, 'SENT', res.messageId)
        return res
      })
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
  // RECONCILIACIÓN DE EVENTOS UNCERTAIN (tercera reparación 4.C)
  // ===========================================================================

  /**
   * Lista eventos con resultado incierto (para operación/auditoría).
   * B2 (hardening): con `orgId` SOLO devuelve eventos de ESA organización —
   * las claves ajenas no se exponen ni se procesan. El prefijo se compara de
   * forma exacta (`orgId::`, longitud fija) para no confundir organizaciones
   * cuyos ids compartan prefijo.
   */
  listUncertainEvents(limit: number = 50, orgId?: string): Array<{ key: string; createdAt: number; leaseExpiresAt: number }> {
    if (orgId !== undefined) {
      if (!orgId || !/^[a-zA-Z0-9_-]{1,64}$/.test(orgId)) return []
      const rows = this.db.prepare(
        "SELECT key, created_at, lease_expires_at FROM idempotency_keys WHERE status = 'UNCERTAIN' AND substr(key, 1, ?) = ? ORDER BY created_at ASC LIMIT ?"
      ).all(orgId.length + 2, `${orgId}::`, limit) as Array<{ key: string; created_at: number; lease_expires_at: number }>
      return rows.map((r) => ({ key: r.key, createdAt: r.created_at, leaseExpiresAt: r.lease_expires_at }))
    }
    const rows = this.db.prepare(
      "SELECT key, created_at, lease_expires_at FROM idempotency_keys WHERE status = 'UNCERTAIN' ORDER BY created_at ASC LIMIT ?"
    ).all(limit) as Array<{ key: string; created_at: number; lease_expires_at: number }>
    return rows.map((r) => ({ key: r.key, createdAt: r.created_at, leaseExpiresAt: r.lease_expires_at }))
  }

  /** Deriva las claves de envío (registry) de un evento desde su journal. */
  private sendIdempotencyKeysOf(idemKey: string, orgId: string): string[] {
    const corr = this.resolveCorrelationId(idemKey, orgId)
    const rows = this.db.prepare(
      "SELECT effect_key FROM inbound_effect_journal WHERE key = ? AND effect_type = 'send_message'"
    ).all(idemKey) as Array<{ effect_key: string }>
    return rows.map((r) => `${corr}#${r.effect_key.startsWith('send:') ? r.effect_key.slice('send:'.length) : r.effect_key}`)
  }

  /**
   * Evidencia de envíos externos de un evento (registro durable de envíos).
   * Para auditoría y para la resolución con evidencia de claves UNCERTAIN.
   */
  describeUncertainEvent(idemKey: string): {
    sends: Array<SendAttemptRecord>
    pendingEffects: Array<{ effectKey: string; effectType: string; status: string }>
  } {
    const at = idemKey.indexOf('::')
    const orgId = at > 0 ? idemKey.slice(0, at) : ''
    const keys = this.sendIdempotencyKeysOf(idemKey, orgId)
    const sends: SendAttemptRecord[] = []
    for (const k of keys) {
      const row = this.db.prepare(
        'SELECT * FROM daemon_send_idempotency WHERE organization_id = ? AND idempotency_key = ?'
      ).get(orgId, k) as SendAttemptRecord | undefined
      if (row) sends.push(row)
    }
    const pendingEffects = (this.db.prepare(
      "SELECT effect_key, effect_type, status FROM inbound_effect_journal WHERE key = ? AND status IN ('PENDING','UNCERTAIN')"
    ).all(idemKey) as Array<{ effect_key: string; effect_type: string; status: string }>).map((r) => ({
      effectKey: r.effect_key,
      effectType: r.effect_type,
      status: r.status,
    }))
    return { sends, pendingEffects }
  }

  /**
   * B2 (fase final) — Reconcilia UN evento UNCERTAIN con EVIDENCIA (nunca un
   * reintento ciego). Re-ejecuta el ciclo reutilizando el journal:
   *  - Efectos DONE se saltan (ningún mensaje ya enviado se reenvía).
   *  - Efectos CRM PENDING se completan (acción explícita del operador).
   *  - Envíos con resultado desconocido (registry IN_FLIGHT/UNCERTAIN) JAMÁS
   *    se re-despachan automáticamente: la clave vuelve a UNCERTAIN y el
   *    informe lista la evidencia (requisito 3 y 7).
   *  - Sólo con `confirmResend: true` (afirmación EXPLÍCITA del operador, tras
   *    verificar externamente que el mensaje NO llegó) se autoriza UN reenvío
   *    por envío incierto; el registro queda auditado (attempt_count) y el
   *    modelo sigue siendo at-least-once (requisito 7: sin exactly-once).
   * Devuelve null si la clave no estaba UNCERTAIN.
   */
  async reconcileEvent(idemKey: string, opts: { confirmResend?: boolean; requestingOrgId?: string } = {}): Promise<ReconcileReport | null> {
    // B2 (hardening): si se declara la organización solicitante, la clave DEBE
    // pertenecerle. Se verifica ANTES del claim (tomar posesión muta estado:
    // un acceso cruzado no puede dejar la clave en PROCESSING).
    if (opts.requestingOrgId !== undefined) {
      const sep = idemKey.indexOf('::')
      const keyOrg = sep > 0 ? idemKey.slice(0, sep) : ''
      if (keyOrg !== opts.requestingOrgId) throw new ReconcileForbiddenOrgError(opts.requestingOrgId)
    }
    const now = Math.floor(Date.now() / 1000)
    const claim = this.db.prepare(`
      UPDATE idempotency_keys SET status = 'PROCESSING', response_json = NULL, lease_expires_at = ?
      WHERE key = ? AND status = 'UNCERTAIN'
    `).run(now + IDEMPOTENCY_LEASE_SECONDS, idemKey)
    if (Number(claim.changes) !== 1) return null

    const at = idemKey.indexOf('::')
    const orgId = at > 0 ? idemKey.slice(0, at) : ''
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
    const correlationId = event.correlationId || event.eventId

    // Autorización EXPLÍCITA de reenvío (resolución con evidencia, requisito 4):
    // marca los envíos UNCERTAIN de ESTE evento para UN solo reintento.
    let resendAuthorized = false
    if (opts.confirmResend === true) {
      const keys = this.sendIdempotencyKeysOf(idemKey, orgId)
      for (const k of keys) {
        const res = this.db.prepare(`
          UPDATE daemon_send_idempotency SET resend_authorized_at = ?, updated_at = ?
          WHERE organization_id = ? AND idempotency_key = ? AND status = 'UNCERTAIN'
        `).run(now, now, orgId, k)
        if (Number(res.changes) === 1) resendAuthorized = true
      }
    }

    const heartbeat = this.startLeaseHeartbeat(idemKey)
    try {
      await this.runInboundEffects(event, idemKey, correlationId, heartbeat, { skipLock: true })
    } catch {
      // El ciclo no pudo completarse (p.ej. envío incierto bloqueado por el
      // registro durable): la clave vuelve a UNCERTAIN y se entrega la
      // evidencia — NUNCA se reintenta a ciegas.
      this.deferIdempotency(idemKey)
    } finally {
      heartbeat.stop()
    }

    const finalStatus = (this.db.prepare('SELECT status FROM idempotency_keys WHERE key = ?').get(idemKey) as { status: string } | undefined)?.status
    const evidence = this.describeUncertainEvent(idemKey)
    const report: ReconcileReport = {
      key: idemKey,
      resolved: finalStatus === 'COMPLETED',
      requiresManualResolution: finalStatus !== 'COMPLETED',
      resendAuthorized,
      uncertainSends: evidence.sends
        .filter((s) => s.status === 'UNCERTAIN' || s.status === 'IN_FLIGHT')
        .map((s) => ({
          idempotencyKey: s.idempotency_key,
          status: s.status,
          to: s.to_phone,
          textPreview: s.message_text.slice(0, 80),
          attempts: s.attempt_count,
          correlationId: s.correlation_id,
          updatedAt: s.updated_at,
        })),
      pendingEffects: evidence.pendingEffects,
    }
    if (report.resolved && resendAuthorized) {
      report.note = 'Reenvío autorizado explícitamente aplicado: la entrega sigue siendo at-least-once (sin garantía exactly-once del proveedor).'
    } else if (!report.resolved) {
      report.note = 'Sin confirmación de entrega: requiere verificación humana (p.ej. en la bandeja del negocio) antes de cualquier reenvío; use confirmResend:true SÓLO con evidencia externa de no llegada.'
    }
    return report
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
