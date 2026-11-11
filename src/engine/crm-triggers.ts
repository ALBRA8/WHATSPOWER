/**
 * crm-triggers.ts — EJECUTORES DE AUTOMATIZACIONES POR ORGANIZACIÓN
 * (OLEADA 2 — decisión de negocio Meta/WhatsApp 2026-11-11, puntos 4, 6 y 8).
 *
 * v2 (esta versión) corrige tres defectos del ejecutor original:
 *
 *   1. DESPACHO REAL: `send_message` ya no solo "registra en la bandeja":
 *      envía por el transporte POR ORGANIZACIÓN (Meta Cloud con las
 *      credenciales de ESA organización — decisión 2026-11-11 #6). El
 *      registro en inbox_messages se conserva como auditoría del mensaje
 *      generado, y `automation_events` guarda el resultado REAL.
 *
 *   2. IDEMPOTENCIA: cada evento stage-change tiene una clave de evento
 *      (eventId explícito del CRM, o clave derivada determinista) guardada en
 *      stage_change_dedup POR ORGANIZACIÓN. Un replay del mismo evento NO
 *      vuelve a disparar la automatización ni reenvía el mensaje.
 *
 *   3. REGLAS POR ORGANIZACIÓN: cada empresa define sus disparadores
 *      (automation_rules, tabla propia). Los defaults internos son SOLO
 *      fallback para organizaciones sin regla propia — nunca pisan la
 *      configuración de la org (punto 6: cada org opera con lo suyo).
 *
 * Honestidad de resultados (prohibido el éxito fingido):
 *   SENT | UNCERTAIN | REJECTED_NO_CONNECTION | REJECTED |
 *   RECORDED_NO_TRANSPORT | FLOW_STARTED | FLOW_UNAVAILABLE |
 *   SEQUENCE_ENROLLED | SEQUENCE_UNAVAILABLE | SKIPPED_NO_RULE
 */
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { FlowEngine } from './flow-engine.ts'

/** Resultado mínimo del transporte (compatible con TransportSender). */
export interface AutomationTransportResult {
  ok: boolean
  messageId?: string
  error?: string
  outcome?: 'SENT' | 'REJECTED' | 'UNCERTAIN'
}

/** Interfaz mínima del transporte POR ORGANIZACIÓN (MetaCloudOrgTransport). */
export interface AutomationTransportSender {
  sendMessage(
    to: string,
    text: string,
    correlationId: string,
    idempotencyKey?: string,
    orgId?: string
  ): Promise<AutomationTransportResult>
}

export interface StageChangeEvent {
  /** (segunda reparación §3.A) Organización propietaria del pipeline — obligatoria. */
  orgId: string
  clientId: string
  clientPhone: string
  clientName?: string
  opportunityId: string
  fromStage: string
  toStage: string
  dealValue?: number
  /** (v2) Identidad del evento que entrega el CRM: hace la ejecución idempotente. */
  eventId?: string
}

export interface StageTriggerRule {
  targetStage: string
  action: 'send_message' | 'start_flow' | 'enroll_sequence'
  templateMessage?: string
  targetFlowId?: string
  targetSequenceId?: string
}

/** Estados de ejecución auditables (honestidad: nada de éxito fingido). */
export type AutomationStatus =
  | 'SENT'
  | 'UNCERTAIN'
  | 'REJECTED_NO_CONNECTION'
  | 'REJECTED'
  | 'RECORDED_NO_TRANSPORT'
  | 'FLOW_STARTED'
  | 'FLOW_UNAVAILABLE'
  | 'SEQUENCE_ENROLLED'
  | 'SEQUENCE_UNAVAILABLE'
  | 'SKIPPED_NO_RULE'
  | 'SKIPPED_NO_PHONE'

export interface AutomationExecutionResult {
  triggered: boolean
  /** (v2) true si el evento ya había sido procesado (idempotencia). */
  duplicate?: boolean
  action?: string
  /** (v2) Resultado REAL de la ejecución (auditoría y observabilidad). */
  status?: AutomationStatus
  messageSent?: string
  messageId?: string
  detail?: string
  /** Clave de idempotencia usada (eventId o derivada determinista). */
  eventKey: string
}

export class CrmTriggerListener {
  private db: DatabaseSync
  private flowEngine: FlowEngine
  /** Transporte POR ORGANIZACIÓN (v2). Opcional: sin él se registra el mensaje
   *  (modo legacy) con status RECORDED_NO_TRANSPORT — jamás se finge envío. */
  private transport: AutomationTransportSender | null
  private rules: Map<string, StageTriggerRule> = new Map()

  constructor(db: DatabaseSync, flowEngine: FlowEngine, transport?: AutomationTransportSender) {
    this.db = db
    this.flowEngine = flowEngine
    this.transport = transport ?? null
    this.ensureSchema()
    this.registerDefaultRules()
  }

  /** Esquema idempotente (db.ts lo crea en producción; necesario para :memory:). */
  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stage_change_dedup (
        organization_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        processed_at INTEGER NOT NULL,
        result_json TEXT,
        PRIMARY KEY (organization_id, event_key)
      );
      CREATE TABLE IF NOT EXISTS automation_rules (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        action TEXT NOT NULL,
        template_message TEXT,
        target_flow_id TEXT,
        target_sequence_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        UNIQUE (organization_id, stage)
      );
      CREATE TABLE IF NOT EXISTS automation_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        stage TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        message_id TEXT,
        created_at INTEGER NOT NULL
      );
    `)
  }

  /** Regla default (fallback) — mantenida por compatibilidad; NO pisa las de la org. */
  registerRule(stage: string, rule: StageTriggerRule) {
    this.rules.set(stage.toUpperCase(), rule)
  }

  /** Defaults internos: SOLO fallback para organizaciones sin regla propia. */
  private registerDefaultRules() {
    // Regla 1: Cotización / Propuesta enviada -> Mensaje de seguimiento automático
    this.rules.set('PROPUESTA_ENVIADA', {
      targetStage: 'PROPUESTA_ENVIADA',
      action: 'send_message',
      templateMessage: 'Hola {{nombre}}, te confirmamos que tu propuesta ya fue generada. ¿Deseas revisarla juntos?',
    })

    // Regla 2: Cita no asistida -> Flujo de reprogramación
    this.rules.set('NO_SHOW', {
      targetStage: 'NO_SHOW',
      action: 'start_flow',
      targetFlowId: 'flow_reprogramar_cita',
    })

    // Regla 3: Ganado / Cliente cerrado -> Secuencia de onboarding
    this.rules.set('GANADO', {
      targetStage: 'GANADO',
      action: 'send_message',
      templateMessage: '¡Bienvenido a bordo {{nombre}}! Estamos felices de iniciar este proyecto contigo.',
    })
  }

  /** (v2) Regla de automatización DE UNA ORGANIZACIÓN, persistente y prioritaria. */
  registerOrgRule(orgId: string, rule: StageTriggerRule & { enabled?: boolean }): void {
    const stage = rule.targetStage.toUpperCase()
    this.db.prepare(`
      INSERT INTO automation_rules (id, organization_id, stage, action, template_message, target_flow_id, target_sequence_id, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (organization_id, stage) DO UPDATE SET
        action = excluded.action,
        template_message = excluded.template_message,
        target_flow_id = excluded.target_flow_id,
        target_sequence_id = excluded.target_sequence_id,
        enabled = excluded.enabled
    `).run(
      `arule_${randomUUID()}`,
      orgId,
      stage,
      rule.action,
      rule.templateMessage ?? null,
      rule.targetFlowId ?? null,
      rule.targetSequenceId ?? null,
      rule.enabled === false ? 0 : 1,
      Math.floor(Date.now() / 1000)
    )
  }

  /** (v2) Resolución de regla: primero la DE LA ORGANIZACIÓN, luego el fallback. */
  private resolveRule(orgId: string, stage: string): StageTriggerRule | null {
    const row = this.db.prepare(`
      SELECT stage, action, template_message, target_flow_id, target_sequence_id
      FROM automation_rules
      WHERE organization_id = ? AND stage = ? AND enabled = 1
      LIMIT 1
    `).get(orgId, stage) as
      | { stage: string; action: string; template_message: string | null; target_flow_id: string | null; target_sequence_id: string | null }
      | undefined

    if (row) {
      return {
        targetStage: row.stage,
        action: row.action as StageTriggerRule['action'],
        templateMessage: row.template_message ?? undefined,
        targetFlowId: row.target_flow_id ?? undefined,
        targetSequenceId: row.target_sequence_id ?? undefined,
      }
    }
    return this.rules.get(stage) ?? null
  }

  /**
   * (v2) Clave de idempotencia del evento:
   *  - eventId explícito del CRM (contrato v2) → tal cual (sanitizado);
   *  - sin eventId → derivada determinista por (org, oportunidad, transición).
   */
  private eventKeyFor(event: StageChangeEvent): string {
    if (event.eventId && typeof event.eventId === 'string') {
      const clean = event.eventId.trim()
      if (clean.length >= 1 && clean.length <= 128) return clean
    }
    const basis = `${event.orgId}|${event.opportunityId}|${event.fromStage}|${event.toStage}`
    return `auto_${createHash('sha256').update(basis).digest('hex').slice(0, 32)}`
  }

  private recordAutomationEvent(params: {
    orgId: string
    eventKey: string
    stage: string
    action: string
    status: AutomationStatus
    detail?: string
    messageId?: string
  }): void {
    this.db.prepare(`
      INSERT INTO automation_events (id, organization_id, event_key, stage, action, status, detail, message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `aev_${randomUUID()}`,
      params.orgId,
      params.eventKey,
      params.stage,
      params.action,
      params.status,
      params.detail ?? null,
      params.messageId ?? null,
      Math.floor(Date.now() / 1000)
    )
  }

  async handleStageChange(event: StageChangeEvent): Promise<AutomationExecutionResult> {
    const stageKey = String(event.toStage || '').toUpperCase()
    const eventKey = this.eventKeyFor(event)
    const orgId = event.orgId

    // ---- IDEMPOTENCIA (v2): replay del mismo evento → NO re-ejecuta. ----
    const now = Math.floor(Date.now() / 1000)
    try {
      this.db.prepare(`
        INSERT INTO stage_change_dedup (organization_id, event_key, processed_at)
        VALUES (?, ?, ?)
      `).run(orgId, eventKey, now)
    } catch (err) {
      // (A1-03, auditoría 2026-11-11) SOLO una violación de unicidad significa
      // "ya procesado". Cualquier otro error (SQLite BUSY, readonly, disco...)
      // es un error REAL: se propaga → el endpoint responde 500 y el CRM
      // reintenta; JAMÁS se descarta el evento como duplicado sin ejecutarlo.
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('UNIQUE constraint failed')) throw err
      // Violación de PK (organization_id, event_key): el evento YA fue procesado.
      const previous = this.db.prepare(`
        SELECT result_json FROM stage_change_dedup WHERE organization_id = ? AND event_key = ?
      `).get(orgId, eventKey) as { result_json: string | null } | undefined
      return {
        triggered: false,
        duplicate: true,
        eventKey,
        detail: previous?.result_json ? `ya procesado: ${previous.result_json.slice(0, 200)}` : 'evento ya procesado',
      }
    }

    // (A4-06) Purga periódica del dedup: retiene 24 h de historia (ventana de
    // replay legítimo) — sin esto crece sin techo y, con eventIds con ventana
    // temporal (CRM deriveStageEventId, A4-01), el replay posterior es válido.
    this.maybePurgeDedup()

    // (A1-05) Validación honesta del teléfono del cliente: el CRM omite la
    // clave cuando el cliente no tiene teléfono. Antes, un binding undefined
    // reventaba en node:sqlite y el evento terminaba en 400; ahora se
    // registra un estado auditable SKIPPED_NO_PHONE y el evento se cierra.
    const phone = typeof event.clientPhone === 'string' ? event.clientPhone.trim() : ''
    if (!/^\+?[0-9]{6,20}$/.test(phone)) {
      this.recordAutomationEvent({
        orgId, eventKey, stage: stageKey, action: 'none', status: 'SKIPPED_NO_PHONE',
        detail: 'evento sin teléfono de cliente válido: nada que despachar (auditoría A1-05)',
      })
      const result: AutomationExecutionResult = { triggered: false, action: 'send_message_skipped', status: 'SKIPPED_NO_PHONE', eventKey }
      this.storeDedupResult(orgId, eventKey, result)
      return result
    }

    try {
      const rule = this.resolveRule(orgId, stageKey)
      if (!rule) {
        this.recordAutomationEvent({
          orgId, eventKey, stage: stageKey, action: 'none', status: 'SKIPPED_NO_RULE',
          detail: 'sin regla de organización ni fallback para la etapa',
        })
        const result = { triggered: false, eventKey }
        this.storeDedupResult(orgId, eventKey, result)
        return result
      }

      const contactName = event.clientName || 'Cliente'

      if (rule.action === 'send_message' && rule.templateMessage) {
        const text = rule.templateMessage.replace(/\{\{nombre\}\}/g, contactName)
        // El mensaje generado SIEMPRE queda registrado (auditoría del ejecutor).
        this.db.prepare(`
          INSERT INTO inbox_messages (id, organization_id, contact_phone, direction, text, created_at)
          VALUES (?, ?, ?, 'outbound', ?, ?)
        `).run(`msg_trig_${randomUUID()}`, orgId, phone, text, Math.floor(Date.now() / 1000))

        // ---- DESPACHO REAL POR ORGANIZACIÓN (v2, decisión 2026-11-11 #6) ----
        if (!this.transport) {
          this.recordAutomationEvent({
            orgId, eventKey, stage: stageKey, action: 'send_message',
            status: 'RECORDED_NO_TRANSPORT',
            detail: 'sin transporte conectado: mensaje registrado, NO enviado (sin éxito fingido)',
          })
          const result = { triggered: true, action: 'send_message', status: 'RECORDED_NO_TRANSPORT' as const, messageSent: text, eventKey }
          this.storeDedupResult(orgId, eventKey, result)
          return result
        }

        // La clave de idempotencia POR MENSAJE viaja al transporte: aunque un
        // upstream replique, Meta Cloud no creará dos mensajes (doble cerradura).
        // (A4-06) Si el transporte lanza ANTES de clasificar (envío no iniciado),
        // dispatchWithRelease libera la clave de dedup para el reintento.
        const transport = this.transport
        const sendRes = await this.dispatchWithRelease(orgId, eventKey, () =>
          transport.sendMessage(phone, text, `stage_change:${eventKey}`, `stage:${eventKey}`, orgId)
        )

        let status: AutomationStatus
        let detail: string | undefined
        if (sendRes.ok && sendRes.outcome === 'SENT') {
          status = 'SENT'
        } else if (sendRes.outcome === 'UNCERTAIN' || (!sendRes.ok && !sendRes.outcome)) {
          // Fail-safe (B2): sin clasificación se asume incierto — puede haberse enviado.
          status = 'UNCERTAIN'
          detail = sendRes.error || 'resultado incierto del despacho (pudo aceptarse)'
        } else {
          const err = sendRes.error || 'despacho rechazado'
          status = err.startsWith('NO_CONNECTED_NUMBER') ? 'REJECTED_NO_CONNECTION' : 'REJECTED'
          detail = err
        }

        this.recordAutomationEvent({
          orgId, eventKey, stage: stageKey, action: 'send_message',
          status, detail, messageId: sendRes.messageId,
        })
        const result: AutomationExecutionResult = {
          triggered: true,
          action: 'send_message',
          status,
          messageSent: text,
          messageId: sendRes.messageId,
          detail,
          eventKey,
        }
        this.storeDedupResult(orgId, eventKey, result)
        return result
      }

      if (rule.action === 'start_flow' && rule.targetFlowId) {
        // (tercera reparación 4.B) El flujo debe existir EN LA ORGANIZACIÓN del
        // evento: nunca se arranca un flujo global/de otra org por coincidencia de id.
        const flowInOrg = this.flowEngine.getFlow(orgId, rule.targetFlowId)
        if (!flowInOrg) {
          this.recordAutomationEvent({
            orgId, eventKey, stage: stageKey, action: 'start_flow',
            status: 'FLOW_UNAVAILABLE',
            detail: `flujo ${rule.targetFlowId} inexistente en la organización (no se arranca uno ajeno)`,
          })
          const result: AutomationExecutionResult = {
            triggered: false, action: `start_flow_unavailable_in_org:${rule.targetFlowId}`,
            status: 'FLOW_UNAVAILABLE', eventKey,
          }
          this.storeDedupResult(orgId, eventKey, result)
          return result
        }

        // (v2) EJECUCIÓN REAL del arranque: se abre sesión de flujo para el
        // contacto EN LA ORGANIZACIÓN del evento, y si el primer nodo envía un
        // mensaje, se entrega por el transporte de ESA organización.
        const firstNode = flowInOrg.nodes?.[0]
        const startNodeId = firstNode?.id ?? 'start'
        this.flowEngine.saveSession(orgId, {
          contactPhone: phone,
          flowId: flowInOrg.id,
          currentNodeId: startNodeId,
          waitingForInput: false,
          context: { origin: 'crm_stage_trigger', stage: stageKey, opportunityId: event.opportunityId },
          lastActivity: Math.floor(Date.now() / 1000),
        })

        let status: AutomationStatus = 'FLOW_STARTED'
        let detail: string | undefined = `sesión abierta en nodo ${startNodeId}`
        let messageId: string | undefined

        const firstMessage = firstNode?.data?.messageText
        if (firstMessage) {
          const text = firstMessage.replace(/\{\{nombre\}\}/g, contactName)
          this.db.prepare(`
            INSERT INTO inbox_messages (id, organization_id, contact_phone, direction, text, created_at)
            VALUES (?, ?, ?, 'outbound', ?, ?)
          `).run(`msg_flow_${randomUUID()}`, orgId, phone, text, Math.floor(Date.now() / 1000))

          if (!this.transport) {
            status = 'RECORDED_NO_TRANSPORT'
            detail = `sesión abierta; mensaje del nodo registrado sin envío (sin transporte)`
          } else {
            const transport = this.transport
            const sendRes = await this.dispatchWithRelease(orgId, eventKey, () =>
              transport.sendMessage(phone, text, `stage_change:${eventKey}`, `stage:${eventKey}`, orgId)
            )
            if (sendRes.ok && sendRes.outcome === 'SENT') {
              messageId = sendRes.messageId
            } else if (sendRes.outcome === 'UNCERTAIN' || (!sendRes.ok && !sendRes.outcome)) {
              status = 'UNCERTAIN'
              detail = `sesión abierta; envío incierto del mensaje inicial: ${sendRes.error || 'sin clasificación'}`
            } else {
              const err = sendRes.error || 'despacho rechazado'
              status = err.startsWith('NO_CONNECTED_NUMBER') ? 'REJECTED_NO_CONNECTION' : 'REJECTED'
              detail = `sesión abierta; mensaje inicial NO entregado: ${err}`
            }
          }
        }

        this.recordAutomationEvent({
          orgId, eventKey, stage: stageKey, action: 'start_flow',
          status, detail, messageId,
        })
        const result: AutomationExecutionResult = {
          triggered: true, action: `start_flow:${flowInOrg.id}`, status, detail, messageId, eventKey,
        }
        this.storeDedupResult(orgId, eventKey, result)
        return result
      }

      if (rule.action === 'enroll_sequence' && rule.targetSequenceId) {
        const seq = this.flowEngine.getSequence(orgId, rule.targetSequenceId)
        if (!seq) {
          this.recordAutomationEvent({
            orgId, eventKey, stage: stageKey, action: 'enroll_sequence',
            status: 'SEQUENCE_UNAVAILABLE',
            detail: `secuencia ${rule.targetSequenceId} inexistente en la organización`,
          })
          const result: AutomationExecutionResult = {
            triggered: false, action: `enroll_sequence_unavailable_in_org:${rule.targetSequenceId}`,
            status: 'SEQUENCE_UNAVAILABLE', eventKey,
          }
          this.storeDedupResult(orgId, eventKey, result)
          return result
        }
        // (v2) Ejecución real: inscripción en la secuencia DE LA ORGANIZACIÓN.
        this.flowEngine.enrollContactInSequence(orgId, event.clientPhone, rule.targetSequenceId)
        this.recordAutomationEvent({
          orgId, eventKey, stage: stageKey, action: 'enroll_sequence',
          status: 'SEQUENCE_ENROLLED',
          detail: `contacto inscrito en la secuencia ${rule.targetSequenceId}`,
        })
        const result: AutomationExecutionResult = {
          triggered: true, action: `enroll_sequence:${rule.targetSequenceId}`,
          status: 'SEQUENCE_ENROLLED', eventKey,
        }
        this.storeDedupResult(orgId, eventKey, result)
        return result
      }

      const result: AutomationExecutionResult = { triggered: true, action: rule.action, eventKey }
      this.storeDedupResult(orgId, eventKey, result)
    return result
    } catch (err) {
      // (reauditoría ciclo 2, A4-06b) Si la ejecución falla DESPUÉS de insertar
      // la clave de dedup (INSERT de inbox_messages, saveSession,
      // recordAutomationEvent...), el evento quedaría "ya procesado" SIN
      // resultado: el replay respondería duplicate:true y el mensaje se
      // PERDÍA hasta la purga de 24 h. Se libera la clave para que el reintento
      // del CRM re-ejecute (ni pérdida ni duplicado, esta vez de verdad).
      try {
        this.db.prepare('DELETE FROM stage_change_dedup WHERE organization_id = ? AND event_key = ?').run(orgId, eventKey)
      } catch { /* la liberación es best-effort; el error original manda */ }
      throw err
    }
  }

  /**
   * (A4-06) Despacho con liberación de dedup: si el transporte lanza una
   * excepción ANTES de clasificar el resultado (el mensaje no llegó a
   * iniciarse), se libera la clave de idempotencia para que el reintento del
   * CRM re-ejecute el evento — ni pérdida ni duplicado. Los resultados
   * clasificados (SENT/REJECTED/UNCERTAIN) vuelven como valor y conservan
   * el dedup (UNCERTAIN jamás se reenvía a ciegas — clasificación B2).
   */
  private async dispatchWithRelease<T>(orgId: string, eventKey: string, send: () => Promise<T>): Promise<T> {
    try {
      return await send()
    } catch (err) {
      this.releaseDedup(orgId, eventKey)
      throw err
    }
  }

  private lastDedupPurgeAt = 0

  /**
   * (A4-06) Purga del dedup: retiene 24 h de historia (ventana de replay),
   * ejecutada como máximo una vez cada 10 min por proceso. Sin purga la
   * tabla crece sin techo (auditoría A4-06).
   */
  private maybePurgeDedup(): void {
    const now = Date.now()
    if (now - this.lastDedupPurgeAt < 10 * 60 * 1000) return
    this.lastDedupPurgeAt = now
    try {
      this.db.prepare(`DELETE FROM stage_change_dedup WHERE processed_at < ?`)
        .run(Math.floor(now / 1000) - 24 * 60 * 60)
    } catch { /* la purga nunca rompe la ejecución */ }
  }

  private releaseDedup(orgId: string, eventKey: string): void {
    try {
      this.db.prepare(`DELETE FROM stage_change_dedup WHERE organization_id = ? AND event_key = ?`).run(orgId, eventKey)
    } catch { /* la liberación nunca rompe el error original */ }
  }

  private storeDedupResult(orgId: string, eventKey: string, result: AutomationExecutionResult): void {
    try {
      this.db.prepare(`
        UPDATE stage_change_dedup SET result_json = ? WHERE organization_id = ? AND event_key = ?
      `).run(JSON.stringify({ triggered: result.triggered, action: result.action, status: result.status }), orgId, eventKey)
    } catch { /* la auditoría del resultado nunca rompe la ejecución */ }
  }
}
