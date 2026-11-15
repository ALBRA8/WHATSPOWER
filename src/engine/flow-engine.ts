import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  FlowDefinition,
  FlowSession,
  FlowEvaluationResult,
  FlowNode,
  FlowEdge,
  SequenceDefinition,
  ConditionRule,
} from './flow-types.ts'
import { resolveAiProvider, type AiCompletionProvider } from './ai-provider.ts'

/**
 * (hallazgo 3, auditoría funcional 2026-11-12) Aviso EXPLÍCITO de indisponibilidad
 * del nodo AI_RESPONSE. NUNCA aparenta ser una respuesta generada por IA: el
 * fallback honesto es la política del proyecto (no sustituir fallos en silencio
 * por texto que parezca generado).
 */
export const AI_UNAVAILABLE_FALLBACK =
  '⚙️ El asistente automático no está disponible en este momento. Un asesor de nuestro equipo continuará la conversación en breve.'

/**
 * (ronda 20) UNA SOLA FORMA DE TELÉFONO para toda la tabla de inscripciones.
 *
 * El mensaje entrante, la lista de bajas y la sesión de diálogo ya usaban esta
 * forma: sólo dígitos, y un móvil colombiano de 10 dígitos con el 57 delante.
 * El panel, en cambio, guardaba lo que tecleara el asesor («300 123 4567»), de
 * modo que la MISMA persona quedaba como dos contactos distintos: la secuencia
 * se inscribía en un teléfono que nunca recibía un mensaje y sacarla de la
 * secuencia no la encontraba. Ahora inscribir y sacar pasan por aquí.
 */
export function canonicalPhone(raw: unknown): string {
  const digitos = String(raw ?? '').replace(/\D/g, '')
  return digitos.length === 10 && digitos.startsWith('3') ? `57${digitos}` : digitos
}

/**
 * (ronda 21) Un paso de secuencia que ya toca enviar.
 * `current_step` es el número (1, 2, 3…) del SIGUIENTE paso a enviar.
 */
export interface DueSequenceWork {
  enrollmentId: string
  organizationId: string
  sequenceId: string
  phone: string
  stepOrder: number
  messageText: string
}

/**
 * (ronda 22) Una espera de flujo que ya vence: a quién despertar, en qué flujo y
 * por qué nodo seguir. La crea el propio motor cuando el flujo llega a un nodo
 * «Espera»; la lee el planificador (src/engine/scheduler.ts).
 */
export interface DueFlowWait {
  id: string
  organizationId: string
  contactPhone: string
  flowId: string
  /** Nodo de espera en el que quedó aparcado (para rastrear y para no duplicar). */
  waitNodeId: string
  /** Nodo por el que hay que SEGUIR cuando llegue la hora. */
  nextNodeId: string
  dueAt: number
  attempts: number
  context: Record<string, string>
}

/** (ronda 22) Qué pasó al reanudar una espera. */
export interface FlowWaitResume {
  status: 'resumed' | 'flow_missing' | 'node_missing' | 'session_busy'
  flowId?: string
  result?: FlowEvaluationResult
}

export class FlowEngine {
  private db: DatabaseSync
  private aiProvider: AiCompletionProvider

  constructor(db: DatabaseSync, aiProvider?: AiCompletionProvider) {
    this.db = db
    // (tercera reparación 4.B) La seed del flujo demo ya NO es global: cada
    // organización recibe SU copia la primera vez que consulta/evalúa flujos
    // (ensureDefaultFlowForOrg). En el constructor no hay contexto de org.
    // (hallazgo 3) Proveedor de IA inyectable (pruebas) o resuelto por entorno
    // (fail-closed: sin AI_API_KEY el nodo lo reporta honestamente).
    this.aiProvider = aiProvider ?? resolveAiProvider()
  }

  // =========================================================================
  // 1. GESTIÓN DE FLUJOS (CRUD) — TODO ESTRICTAMENTE POR ORGANIZACIÓN (4.B)
  // La PK es (organization_id, id): un flujo de la org A es INVISIBLE e
  // INALCANZABLE para la org B (listado, lectura, edición, borrado y
  // ejecución incluidos).
  // =========================================================================

  saveFlow(orgId: string, flow: FlowDefinition): void {
    if (!orgId || typeof orgId !== 'string') {
      throw new Error('VALIDATION: saveFlow exige organizationId (aislamiento multi-organización)')
    }
    const now = Date.now()
    const stmt = this.db.prepare(`
      INSERT INTO flows (id, organization_id, name, trigger_keywords, is_active, graph_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, id) DO UPDATE SET
        name = excluded.name,
        trigger_keywords = excluded.trigger_keywords,
        is_active = excluded.is_active,
        graph_json = excluded.graph_json,
        updated_at = excluded.updated_at
    `)

    stmt.run(
      flow.id,
      orgId,
      flow.name,
      JSON.stringify(flow.triggerKeywords.map((k) => k.toLowerCase().trim())),
      flow.isActive ? 1 : 0,
      JSON.stringify({ nodes: flow.nodes, edges: flow.edges }),
      flow.createdAt || now,
      now
    )
  }

  getFlow(orgId: string, id: string): FlowDefinition | null {
    const row = this.db.prepare('SELECT * FROM flows WHERE organization_id = ? AND id = ?').get(orgId, id) as
      | {
          id: string
          name: string
          trigger_keywords: string
          is_active: number
          graph_json: string
          created_at: number
          updated_at: number
        }
      | undefined

    if (!row) return null

    const graph = JSON.parse(row.graph_json) as { nodes: FlowNode[]; edges: FlowEdge[] }
    return {
      id: row.id,
      name: row.name,
      triggerKeywords: JSON.parse(row.trigger_keywords),
      isActive: row.is_active === 1,
      nodes: graph.nodes || [],
      edges: graph.edges || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  listFlows(orgId: string): FlowDefinition[] {
    // (tercera reparación 4.B) La consulta de una org SIN flujos recibe SU copia
    // del flujo demo (seed perezosa por organización; jamás comparte la ajena).
    this.ensureDefaultFlowForOrg(orgId)
    const rows = this.db.prepare('SELECT * FROM flows WHERE organization_id = ? ORDER BY updated_at DESC').all(orgId) as Array<{
      id: string
      name: string
      trigger_keywords: string
      is_active: number
      graph_json: string
      created_at: number
      updated_at: number
    }>

    return rows.map((row) => {
      const graph = JSON.parse(row.graph_json) as { nodes: FlowNode[]; edges: FlowEdge[] }
      return {
        id: row.id,
        name: row.name,
        triggerKeywords: JSON.parse(row.trigger_keywords),
        isActive: row.is_active === 1,
        nodes: graph.nodes || [],
        edges: graph.edges || [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    })
  }

  deleteFlow(orgId: string, id: string): boolean {
    const res = this.db.prepare('DELETE FROM flows WHERE organization_id = ? AND id = ?').run(orgId, id)
    return res.changes > 0
  }

  // =========================================================================
  // 2. ETIQUETAS (TAGS) Y CAMPOS PERSONALIZADOS (CUSTOM FIELDS)
  // =========================================================================

  addTag(orgId: string, phone: string, tag: string): void {
    const cleanTag = tag.trim().toLowerCase()
    this.db.prepare('INSERT OR IGNORE INTO contact_tags (organization_id, contact_phone, tag_name, created_at) VALUES (?, ?, ?, ?)').run(
      orgId,
      phone,
      cleanTag,
      Date.now()
    )
  }

  removeTag(orgId: string, phone: string, tag: string): void {
    const cleanTag = tag.trim().toLowerCase()
    this.db.prepare('DELETE FROM contact_tags WHERE organization_id = ? AND contact_phone = ? AND tag_name = ?').run(orgId, phone, cleanTag)
  }

  getTags(orgId: string, phone: string): string[] {
    const rows = this.db.prepare('SELECT tag_name FROM contact_tags WHERE organization_id = ? AND contact_phone = ? ORDER BY created_at ASC').all(orgId, phone) as Array<{
      tag_name: string
    }>
    return rows.map((r) => r.tag_name)
  }

  hasTag(orgId: string, phone: string, tag: string): boolean {
    const cleanTag = tag.trim().toLowerCase()
    const row = this.db.prepare('SELECT 1 FROM contact_tags WHERE organization_id = ? AND contact_phone = ? AND tag_name = ?').get(orgId, phone, cleanTag)
    return Boolean(row)
  }

  setCustomField(orgId: string, phone: string, key: string, value: string): void {
    const cleanKey = key.trim().toLowerCase()
    this.db.prepare(`
      INSERT INTO contact_custom_fields (organization_id, contact_phone, field_key, field_value, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, contact_phone, field_key) DO UPDATE SET
        field_value = excluded.field_value,
        updated_at = excluded.updated_at
    `).run(orgId, phone, cleanKey, String(value), Date.now())
  }

  getCustomField(orgId: string, phone: string, key: string): string | null {
    const cleanKey = key.trim().toLowerCase()
    const row = this.db.prepare('SELECT field_value FROM contact_custom_fields WHERE organization_id = ? AND contact_phone = ? AND field_key = ?').get(
      orgId,
      phone,
      cleanKey
    ) as { field_value: string } | undefined
    return row ? row.field_value : null
  }

  getAllCustomFields(orgId: string, phone: string): Record<string, string> {
    const rows = this.db.prepare('SELECT field_key, field_value FROM contact_custom_fields WHERE organization_id = ? AND contact_phone = ?').all(
      orgId,
      phone
    ) as Array<{ field_key: string; field_value: string }>
    const map: Record<string, string> = {}
    for (const r of rows) {
      map[r.field_key] = r.field_value
    }
    return map
  }

  // =========================================================================
  // 3. SECUENCIAS Y DRIP CAMPAIGNS (CAMPAÑAS DE GOTEO)
  // =========================================================================

  saveSequence(orgId: string, seq: SequenceDefinition): void {
    if (!orgId || typeof orgId !== 'string') {
      throw new Error('VALIDATION: saveSequence exige organizationId (aislamiento multi-organización)')
    }
    this.db.prepare('INSERT OR REPLACE INTO sequences (id, organization_id, name, is_active, created_at) VALUES (?, ?, ?, ?, ?)').run(
      seq.id,
      orgId,
      seq.name,
      seq.isActive ? 1 : 0,
      Date.now()
    )

    this.db.prepare('DELETE FROM sequence_steps WHERE organization_id = ? AND sequence_id = ?').run(orgId, seq.id)
    const stepStmt = this.db.prepare(`
      INSERT INTO sequence_steps (id, organization_id, sequence_id, step_order, delay_minutes, message_text, flow_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    for (const step of seq.steps) {
      stepStmt.run(step.id, orgId, seq.id, step.stepOrder, step.delayMinutes, step.messageText, step.flowId || null)
    }
  }

  /** La secuencia debe existir EN LA ORGANIZACIÓN para poder inscribir contactos en ella (4.B). */
  getSequence(orgId: string, sequenceId: string): { id: string; name: string; isActive: boolean } | null {
    const row = this.db.prepare('SELECT id, name, is_active FROM sequences WHERE organization_id = ? AND id = ?').get(orgId, sequenceId) as
      | { id: string; name: string; is_active: number }
      | undefined
    if (!row) return null
    return { id: row.id, name: row.name, isActive: row.is_active === 1 }
  }

  enrollContactInSequence(orgId: string, phone: string, sequenceId: string): void {
    // (tercera reparación 4.B) Una organización NO puede inscribir contactos en
    // secuencias de otra: si la secuencia no existe EN SU org, no se inscribe.
    if (!this.getSequence(orgId, sequenceId)) return
    // (ronda 20) Se guarda siempre en la forma canónica, venga el teléfono del
    // nodo «inscribir en secuencia», del panel o de donde sea.
    const tel = canonicalPhone(phone)
    if (!tel) return
    const enrollmentId = `enr_${orgId}_${sequenceId}_${tel}`
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO sequence_enrollments (id, organization_id, sequence_id, contact_phone, current_step, next_run_at, status)
      VALUES (?, ?, ?, ?, 1, ?, 'ACTIVE')
      ON CONFLICT(organization_id, sequence_id, contact_phone) DO UPDATE SET
        current_step = 1,
        next_run_at = excluded.next_run_at,
        status = 'ACTIVE'
    `).run(enrollmentId, orgId, sequenceId, tel, now)
  }

  /**
   * (ronda 19) Saca a un contacto de una secuencia y devuelve CUÁNTAS
   * inscripciones se cancelaron de verdad. Antes devolvía nada y el endpoint
   * respondía «ok» aunque el teléfono no coincidiera con ninguna fila (por
   * ejemplo si llegaba con adornos: «+57 300 123 4567» frente a «573001234567»).
   * Ahora se prueban las dos formas —tal cual y sólo dígitos— y se suman las
   * filas tocadas, así quien llama puede decir la verdad.
   */
  cancelSequenceEnrollment(orgId: string, phone: string, sequenceId?: string): number {
    const crudo = String(phone ?? '').trim()
    const digitos = crudo.replace(/\D/g, '')
    // (ronda 20) También la forma canónica, para las filas que ya estén
    // guardadas así y para las que grabó el panel antes de este arreglo.
    const candidatos = [...new Set([crudo, digitos, canonicalPhone(phone)])].filter(Boolean)
    let cancelled = 0
    for (const candidato of candidatos) {
      if (!candidato) continue
      const result = sequenceId
        ? this.db.prepare("UPDATE sequence_enrollments SET status = 'CANCELLED' WHERE organization_id = ? AND contact_phone = ? AND sequence_id = ? AND status = 'ACTIVE'").run(orgId, candidato, sequenceId)
        : this.db.prepare("UPDATE sequence_enrollments SET status = 'CANCELLED' WHERE organization_id = ? AND contact_phone = ? AND status = 'ACTIVE'").run(orgId, candidato)
      cancelled += Number(result.changes ?? 0)
    }
    return cancelled
  }

  /**
   * (ronda 21) TRABAJO PENDIENTE de las secuencias.
   *
   * Hasta esta ronda NADIE leía `next_run_at`: inscribir a alguien dejaba una
   * fila ACTIVE que se quedaba ahí para siempre, porque ningún código miraba
   * la hora ni el paso. Esto devuelve los que ya toca enviar, con el texto del
   * paso que corresponde a `current_step`. NO envía nada: sólo dice qué hay.
   *
   * Sólo cuenta secuencias ACTIVAS de la MISMA organización (nada de mezclar
   * clientes) y cierra las inscripciones cuyo paso ya no existe (la secuencia
   * se acortó o se editó), en vez de dejarlas girando para siempre.
   */
  dueSequenceWork(now: number = Date.now(), limit = 50): DueSequenceWork[] {
    const tope = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)))
    const rows = this.db.prepare(`
      SELECT e.id AS enrollment_id, e.organization_id AS organization_id, e.sequence_id AS sequence_id,
             e.contact_phone AS phone, e.current_step AS step_order
      FROM sequence_enrollments e
      JOIN sequences s ON s.organization_id = e.organization_id AND s.id = e.sequence_id
      WHERE e.status = 'ACTIVE' AND s.is_active = 1 AND e.next_run_at <= ?
      ORDER BY e.next_run_at ASC
      LIMIT ?
    `).all(now, tope) as Array<{
      enrollment_id: string
      organization_id: string
      sequence_id: string
      phone: string
      step_order: number
    }>

    const pasoStmt = this.db.prepare(
      'SELECT message_text FROM sequence_steps WHERE organization_id = ? AND sequence_id = ? AND step_order = ?'
    )
    const work: DueSequenceWork[] = []
    for (const row of rows) {
      const paso = pasoStmt.get(row.organization_id, row.sequence_id, row.step_order) as { message_text: string } | undefined
      if (!paso) {
        // La secuencia ya no tiene ese paso: se cierra, no se deja colgada.
        this.closeSequenceEnrollment(row.organization_id, row.enrollment_id, 'COMPLETED')
        continue
      }
      work.push({
        enrollmentId: row.enrollment_id,
        organizationId: row.organization_id,
        sequenceId: row.sequence_id,
        phone: row.phone,
        stepOrder: row.step_order,
        messageText: paso.message_text,
      })
    }
    return work
  }

  /**
   * (ronda 21) Da por enviado el paso actual y deja la hora del siguiente.
   * El retardo que se aplica es el del paso SIGUIENTE (`delay_minutes`), que
   * es como se lee una secuencia: «5 minutos después del anterior».
   * Si no queda ningún paso, la inscripción se cierra como COMPLETED.
   */
  advanceSequenceEnrollment(
    orgId: string,
    enrollmentId: string,
    now: number = Date.now()
  ): { status: 'ACTIVE' | 'COMPLETED' | 'MISSING'; nextRunAt: number | null; nextStepOrder: number | null } {
    const row = this.db.prepare(
      'SELECT sequence_id, current_step FROM sequence_enrollments WHERE organization_id = ? AND id = ?',
    ).get(orgId, enrollmentId) as { sequence_id: string; current_step: number } | undefined
    if (!row) return { status: 'MISSING', nextRunAt: null, nextStepOrder: null }

    const siguiente = row.current_step + 1
    const paso = this.db.prepare(
      'SELECT delay_minutes FROM sequence_steps WHERE organization_id = ? AND sequence_id = ? AND step_order = ?',
    ).get(orgId, row.sequence_id, siguiente) as { delay_minutes: number } | undefined

    if (!paso) {
      this.closeSequenceEnrollment(orgId, enrollmentId, 'COMPLETED')
      return { status: 'COMPLETED', nextRunAt: null, nextStepOrder: null }
    }
    const retardo = Math.max(0, Math.floor(Number(paso.delay_minutes) || 0))
    const nextRunAt = now + retardo * 60000
    this.db.prepare(
      'UPDATE sequence_enrollments SET current_step = ?, next_run_at = ? WHERE organization_id = ? AND id = ?',
    ).run(siguiente, nextRunAt, orgId, enrollmentId)
    return { status: 'ACTIVE', nextRunAt, nextStepOrder: siguiente }
  }

  /**
   * (ronda 21) Cierra una inscripción (COMPLETED al terminar, CANCELLED cuando
   * el contacto pidió la baja). Devuelve si de verdad cambió algo, para no
   * contar dos veces la misma fila.
   */
  closeSequenceEnrollment(orgId: string, enrollmentId: string, status: 'COMPLETED' | 'CANCELLED' = 'COMPLETED'): boolean {
    const result = this.db.prepare(
      "UPDATE sequence_enrollments SET status = ? WHERE organization_id = ? AND id = ? AND status = 'ACTIVE'",
    ).run(status, orgId, enrollmentId)
    return Number(result.changes ?? 0) > 0
  }

  /**
   * (ronda 21) Deja el mensaje de un paso en la bandeja de la organización, que
   * es lo que el asesor ve. No decide nada: sólo registra lo que ya se envió.
   */
  recordSequenceOutboundMessage(orgId: string, phone: string, text: string): boolean {
    return this.recordOutboundMessage(orgId, canonicalPhone(phone), text)
  }

  // =========================================================================
  // 4.b ESPERAS DE FLUJO (ronda 22) — el planificador que faltaba
  // =========================================================================
  //
  // Hasta la ronda 21 un nodo «Espera» (delay / smart_delay) NO esperaba: el motor
  // atendía el mensaje de forma síncrona, lo avisaba por consola y seguía de
  // inmediato. Ahora la espera se guarda en la base (tabla flow_waits: qué
  // contacto, qué flujo, por qué nodo seguir y a qué hora) y la sesión se cierra,
  // así que un mensaje durante la espera no se salta el nodo. Quien despierta el
  // flujo es src/engine/scheduler.ts, que llama a resumeFlowWait() a su hora.
  //
  // Reglas (todas nacen de algo que ya dolió):
  //  1. Una espera pendiente del mismo contacto y nodo NO se duplica.
  //  2. Sólo una pasada puede reanudarla (claimFlowWait: UPDATE condicional).
  //  3. Si el flujo ya no existe, está apagado o el nodo desapareció, la espera se
  //     ABANDONA y se dice: nadie se queda esperando para siempre.
  //  4. Si el contacto ya está metido en otro flujo, la espera se CANCELA: es peor
  //     pisarle la conversación que perder un aviso.

  private waitStoreReady = false

  /** Crea la tabla de esperas una sola vez (idempotente, como dashboard_audit). */
  private ensureWaitStore(): void {
    if (this.waitStoreReady) return
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS flow_waits (' +
        'id TEXT PRIMARY KEY, ' +
        'organization_id TEXT NOT NULL, ' +
        'contact_phone TEXT NOT NULL, ' +
        'flow_id TEXT NOT NULL, ' +
        'wait_node_id TEXT NOT NULL, ' +
        'next_node_id TEXT NOT NULL, ' +
        'due_at INTEGER NOT NULL, ' +
        "status TEXT NOT NULL DEFAULT 'PENDING', " +
        'attempts INTEGER NOT NULL DEFAULT 0, ' +
        'context_json TEXT NOT NULL DEFAULT \'{}\', ' +
        'created_at INTEGER NOT NULL, ' +
        'settled_at INTEGER' +
      ')'
    )
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_flow_waits_due ON flow_waits (status, due_at)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_flow_waits_contact ON flow_waits (organization_id, contact_phone)')
    this.waitStoreReady = true
  }

  /**
   * Aparca el flujo en un nodo de espera: guarda la hora de vuelta y el nodo por el
   * que hay que seguir. Devuelve el id de la espera, o null si ya había una
   * pendiente del mismo contacto y nodo (no se duplica).
   */
  parkFlowWait(input: {
    organizationId: string
    contactPhone: string
    flowId: string
    waitNodeId: string
    nextNodeId: string
    dueAt: number
    context?: Record<string, string>
  }): string | null {
    this.ensureWaitStore()
    const phone = canonicalPhone(input.contactPhone)
    const previa = this.db.prepare(
      "SELECT id FROM flow_waits WHERE organization_id = ? AND contact_phone = ? AND flow_id = ? AND wait_node_id = ? AND status = 'PENDING' LIMIT 1"
    ).get(input.organizationId, phone, input.flowId, input.waitNodeId) as { id?: string } | undefined
    if (previa && previa.id) return null
    const id = 'wait_' + randomUUID()
    this.db.prepare(
      'INSERT INTO flow_waits (id, organization_id, contact_phone, flow_id, wait_node_id, next_node_id, due_at, status, attempts, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
    ).run(id, input.organizationId, phone, input.flowId, input.waitNodeId, input.nextNodeId, input.dueAt, 'PENDING', JSON.stringify(input.context || {}), Date.now())
    return id
  }

  /** Esperas ya vencidas a la hora `now` (de cualquier organización), con tope. */
  dueFlowWaits(now = Date.now(), limit = 50): DueFlowWait[] {
    this.ensureWaitStore()
    const tope = Math.max(1, Math.min(500, Math.trunc(limit) || 1))
    const filas = this.db.prepare(
      "SELECT id, organization_id, contact_phone, flow_id, wait_node_id, next_node_id, due_at, attempts, context_json FROM flow_waits WHERE status = 'PENDING' AND due_at <= ? ORDER BY due_at ASC LIMIT ?"
    ).all(now, tope) as Array<Record<string, unknown>>
    return filas.map((f) => this.filaEspera(f))
  }

  /** Las esperas de un contacto (las últimas 20), para el panel y las pruebas. */
  flowWaitsFor(organizationId: string, contactPhone: string): DueFlowWait[] {
    this.ensureWaitStore()
    const filas = this.db.prepare(
      "SELECT id, organization_id, contact_phone, flow_id, wait_node_id, next_node_id, due_at, attempts, context_json FROM flow_waits WHERE organization_id = ? AND contact_phone = ? ORDER BY created_at DESC LIMIT 20"
    ).all(organizationId, canonicalPhone(contactPhone)) as Array<Record<string, unknown>>
    return filas.map((f) => this.filaEspera(f))
  }

  /**
   * (ronda 23) Las esperas PENDIENTES de una organización, la más próxima primero:
   * es lo que el panel necesita para decir «N contactos esperando, el próximo a las
   * HH:MM» sin tener que abrir la base por su cuenta.
   */
  pendingFlowWaits(organizationId: string, limit = 20): DueFlowWait[] {
    this.ensureWaitStore()
    const tope = Math.max(1, Math.min(200, Math.trunc(limit) || 1))
    const filas = this.db.prepare(
      "SELECT id, organization_id, contact_phone, flow_id, wait_node_id, next_node_id, due_at, attempts, context_json FROM flow_waits WHERE organization_id = ? AND status = 'PENDING' ORDER BY due_at ASC LIMIT ?"
    ).all(organizationId, tope) as Array<Record<string, unknown>>
    return filas.map((f) => this.filaEspera(f))
  }

  /** Cuántas esperas pendientes tiene una organización y cuándo toca la siguiente. */
  flowWaitStats(organizationId: string): { pending: number; nextAt: number | null } {
    this.ensureWaitStore()
    const fila = this.db.prepare(
      "SELECT COUNT(*) AS n, MIN(due_at) AS next FROM flow_waits WHERE organization_id = ? AND status = 'PENDING'"
    ).get(organizationId) as { n?: number; next?: number | null } | undefined
    const pending = Number(fila?.n ?? 0)
    const nextAt = fila && fila.next !== null && fila.next !== undefined ? Number(fila.next) : null
    return { pending: Number.isFinite(pending) ? pending : 0, nextAt: Number.isFinite(nextAt as number) ? nextAt : null }
  }

  private filaEspera(f: Record<string, unknown>): DueFlowWait {
    return {
      id: String(f.id),
      organizationId: String(f.organization_id),
      contactPhone: String(f.contact_phone),
      flowId: String(f.flow_id),
      waitNodeId: String(f.wait_node_id),
      nextNodeId: String(f.next_node_id),
      dueAt: Number(f.due_at),
      attempts: Number(f.attempts ?? 0),
      context: this.parseWaitContext(f.context_json),
    }
  }

  private parseWaitContext(raw: unknown): Record<string, string> {
    if (typeof raw !== 'string') return {}
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        out[k] = typeof v === 'string' ? v : String(v ?? '')
      }
      return out
    } catch {
      return {}
    }
  }

  /** Toma la espera para sí: sólo la pasada que la toma puede reanudarla. */
  claimFlowWait(waitId: string): boolean {
    this.ensureWaitStore()
    const r = this.db.prepare(
      "UPDATE flow_waits SET status = 'RUNNING', attempts = attempts + 1 WHERE id = ? AND status = 'PENDING'"
    ).run(waitId)
    return Number(r.changes ?? 0) > 0
  }

  /**
   * Cierra la espera con su resultado final. Con status PENDING la deja para otra
   * pasada (se usa cuando falla algo temporal, para no perder el aviso).
   */
  settleFlowWait(waitId: string, status: 'DONE' | 'CANCELLED' | 'ABANDONED' | 'PENDING', now = Date.now()): boolean {
    this.ensureWaitStore()
    const settled = status === 'PENDING' ? null : now
    const r = this.db.prepare(
      'UPDATE flow_waits SET status = ?, settled_at = ? WHERE id = ?'
    ).run(status, settled, waitId)
    return Number(r.changes ?? 0) > 0
  }

  /**
   * Reanuda un flujo dormido: recrea la sesión en el nodo siguiente a la espera y
   * sigue ejecutando nodos por el MISMO bucle que un mensaje entrante. No inventa
   * nada: si el flujo ya no existe o el nodo desapareció lo dice, y quien llama
   * cierra la espera en vez de dejar al contacto colgado.
   */
  async resumeFlowWait(wait: DueFlowWait, now = Date.now()): Promise<FlowWaitResume> {
    const flow = this.getFlow(wait.organizationId, wait.flowId)
    if (!flow || !flow.isActive) return { status: 'flow_missing' }
    const destino = flow.nodes.find((n) => n.id === wait.nextNodeId)
    if (!destino) return { status: 'node_missing' }
    if (this.getSession(wait.organizationId, wait.contactPhone)) return { status: 'session_busy' }
    const session: FlowSession = {
      contactPhone: wait.contactPhone,
      flowId: flow.id,
      currentNodeId: wait.nextNodeId,
      waitingForInput: false,
      context: wait.context || {},
      lastActivity: now,
    }
    this.saveSession(wait.organizationId, session)
    const result = await this.runNodeLoop(wait.organizationId, wait.contactPhone, flow, session, undefined)
    return { status: 'resumed', flowId: flow.id, result }
  }


  // =========================================================================
  // 4. SESIONES DE DIÁLOGO
  // =========================================================================

  getSession(orgId: string, contactPhone: string): FlowSession | null {
    const row = this.db.prepare('SELECT * FROM flow_sessions WHERE organization_id = ? AND contact_phone = ?').get(orgId, contactPhone) as
      | {
          contact_phone: string
          flow_id: string
          current_node_id: string
          waiting_for_input: number
          context_json: string
          last_activity: number
        }
      | undefined

    if (!row) return null

    if (Date.now() - row.last_activity > 2 * 60 * 60 * 1000) {
      this.clearSession(orgId, contactPhone)
      return null
    }

    const parsedContext = JSON.parse(row.context_json || '{}')
    return {
      contactPhone: row.contact_phone,
      flowId: row.flow_id,
      currentNodeId: row.current_node_id,
      waitingForInput: row.waiting_for_input === 1,
      inputTargetField: parsedContext._inputTargetField,
      context: parsedContext,
      lastActivity: row.last_activity,
    }
  }

  saveSession(orgId: string, session: FlowSession): void {
    const stmt = this.db.prepare(`
      INSERT INTO flow_sessions (organization_id, contact_phone, flow_id, current_node_id, waiting_for_input, context_json, last_activity)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, contact_phone) DO UPDATE SET
        flow_id = excluded.flow_id,
        current_node_id = excluded.current_node_id,
        waiting_for_input = excluded.waiting_for_input,
        context_json = excluded.context_json,
        last_activity = excluded.last_activity
    `)

    const ctx = { ...session.context }
    if (session.inputTargetField) {
      ctx._inputTargetField = session.inputTargetField
    }

    stmt.run(
      orgId,
      session.contactPhone,
      session.flowId,
      session.currentNodeId,
      session.waitingForInput ? 1 : 0,
      JSON.stringify(ctx),
      Date.now()
    )
  }

  clearSession(orgId: string, contactPhone: string): void {
    this.db.prepare('DELETE FROM flow_sessions WHERE organization_id = ? AND contact_phone = ?').run(orgId, contactPhone)
  }

  findMatchingFlow(orgId: string, messageText: string, contactPhone?: string): FlowDefinition | null {
    // (tercera reparación 4.B) SOLO flujos de ESTA organización pueden dispararse:
    // un mensaje de la org A jamás ejecuta un flujo de la org B, aunque los
    // identificadores o palabras clave coincidan.
    this.ensureDefaultFlowForOrg(orgId)
    const clean = messageText.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    const flows = this.listFlows(orgId).filter((f) => f.isActive)

    // (ronda 17, paso 2) Trigger isFirstContact: si un flujo tiene un nodo
    // 'trigger' con data.isFirstContact === true Y este es el primer mensaje
    // del contacto (inbox_messages count == 1, ya insertado por evaluateStep),
    // dispara PRIORITARIO (antes que keywords). El "primer mensaje" de un
    // contacto nuevo no debería quedar atrapado por un keyword accidental.
    if (contactPhone) {
      const cnt = (this.db.prepare('SELECT COUNT(*) AS n FROM inbox_messages WHERE organization_id = ? AND contact_phone = ?').get(orgId, contactPhone) as { n: number }).n
      if (cnt <= 1) {
        for (const flow of flows) {
          const trigger = flow.nodes.find((n) => n.type === 'trigger')
          if (trigger?.data?.isFirstContact === true) return flow
        }
      }
    }

    for (const flow of flows) {
      for (const kw of flow.triggerKeywords) {
        if (clean.includes(kw.toLowerCase().trim())) {
          return flow
        }
      }
    }
    return null
  }

  // =========================================================================
  // 5. EVALUACIÓN Y MOTOR DE EJECUCIÓN (FLOW EVALUATOR)
  // =========================================================================

  async evaluateStep(
    orgId: string,
    contactPhone: string,
    messageText: string,
    contactInfo?: { name?: string; clientId?: string | null }
  ): Promise<FlowEvaluationResult> {
    const cleanInput = messageText.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    let session = this.getSession(orgId, contactPhone)
    let flow: FlowDefinition | null = null

    // Registrar mensaje en bandeja de entrada (Inbox) — con organización
    this.db.prepare(`
      INSERT INTO inbox_messages (id, organization_id, contact_phone, direction, text, created_at)
      VALUES (?, ?, ?, 'inbound', ?, ?)
    `).run(`in_${Date.now()}_${Math.random().toString(36).substring(7)}`, orgId, contactPhone, messageText, Date.now())

    // CASO 1: Continuar flujo existente (el flujo debe pertenecer a ESTA org)
    if (session) {
      flow = this.getFlow(orgId, session.flowId)
      if (!flow || !flow.isActive) {
        this.clearSession(orgId, contactPhone)
        session = null
      }
    }

    // CASO 2: Iniciar nuevo flujo por trigger (búsqueda CONFINADA a la org)
    if (!session) {
      flow = this.findMatchingFlow(orgId, messageText, contactPhone)
      if (!flow) {
        return { handled: false, messagesToSend: [], actionsToExecute: [] }
      }

      const triggerNode = flow.nodes.find((n) => n.type === 'trigger') || flow.nodes[0]
      if (!triggerNode) {
        return { handled: false, messagesToSend: [], actionsToExecute: [] }
      }

      const firstEdge = flow.edges.find((e) => e.source === triggerNode.id)
      if (!firstEdge) {
        return { handled: false, messagesToSend: [], actionsToExecute: [] }
      }

      const customFields = this.getAllCustomFields(orgId, contactPhone)
      session = {
        contactPhone,
        flowId: flow.id,
        currentNodeId: firstEdge.target,
        waitingForInput: false,
        context: {
          nombre: contactInfo?.name || customFields.nombre || 'Cliente',
          telefono: contactPhone,
          ultimo_mensaje: messageText,
          ...customFields,
        },
        lastActivity: Date.now(),
      }
    } else {
      // Avanzar en el flujo existente
      const currentNode = flow!.nodes.find((n) => n.id === session!.currentNodeId)
      if (!currentNode) {
        this.clearSession(orgId, contactPhone)
        return { handled: false, messagesToSend: [], actionsToExecute: [] }
      }

      // Si estábamos esperando User Input (captura de dato a custom field)
      if (currentNode.type === 'user_input' && session.inputTargetField) {
        this.setCustomField(orgId, contactPhone, session.inputTargetField, messageText.trim())
        session.context[session.inputTargetField] = messageText.trim()
        session.inputTargetField = undefined
      }

      session.context.ultimo_mensaje = messageText

      // Evaluar aristas salientes
      const outgoingEdges = flow!.edges.filter((e) => e.source === currentNode.id)
      let nextEdge: FlowEdge | undefined

      if (outgoingEdges.length === 1 && !outgoingEdges[0].sourceHandle) {
        nextEdge = outgoingEdges[0]
      } else {
        // Coincidencia por opción/botón
        nextEdge = outgoingEdges.find((e) => {
          if (!e.sourceHandle) return false
          const h = e.sourceHandle.toLowerCase()
          return cleanInput === h || cleanInput.includes(h)
        })

        if (!nextEdge) {
          nextEdge = outgoingEdges.find((e) => e.sourceHandle === 'default' || !e.sourceHandle)
        }
      }

      if (!nextEdge) {
        this.clearSession(orgId, contactPhone)
        return {
          handled: true,
          flowId: flow!.id,
          messagesToSend: [],
          actionsToExecute: [],
          flowCompleted: true,
        }
      }

      session.currentNodeId = nextEdge.target
      session.waitingForInput = false
    }

    return await this.runNodeLoop(orgId, contactPhone, flow!, session!, contactInfo)
  }

  /**
   * (ronda 22) Bucle de ejecución de nodos, sacado de evaluateStep para poderlo
   * reanudar cuando vence una espera: así el camino «mensaje entrante» y el camino
   * «despierta el planificador» ejecutan EL MISMO código, sin dos copias que se
   * separen con el tiempo.
   */
  private async runNodeLoop(
    orgId: string,
    contactPhone: string,
    flowIn: FlowDefinition,
    session: FlowSession,
    contactInfo?: { name?: string; clientId?: string | null },
  ): Promise<FlowEvaluationResult> {
    let flow: FlowDefinition = flowIn
    // EJECUCIÓN EN BUCLE DE NODOS SECUENCIALES
    const messagesToSend: FlowEvaluationResult['messagesToSend'] = []
    const actionsToExecute: FlowEvaluationResult['actionsToExecute'] = []
    const tagsToAdd: string[] = []
    const tagsToRemove: string[] = []
    const customFieldsToSet: Record<string, string> = {}
    let isHandoff = false
    let handoffReason: string | undefined
    let webhookToCall: FlowEvaluationResult['webhookToCall']
    let sequenceToEnroll: string | undefined
    /** (ronda 22) Hasta cuándo quedó aparcado el flujo y en qué nodo de espera. */
    let parkedUntil: number | undefined
    let waitNodeId: string | undefined

    let currentNode: FlowNode | undefined = flow.nodes.find((n) => n.id === session.currentNodeId)

    while (currentNode) {
      // --- NODO: SEND_MESSAGE ---
      if (currentNode.type === 'send_message') {
        let text = currentNode.data.messageText || ''
        text = this.interpolateVariables(text, session.context, contactPhone)

        const buttons = currentNode.data.buttons?.map((b) => ({ title: b.title, url: b.url }))
        messagesToSend.push({
          text,
          mediaUrl: currentNode.data.mediaUrl,
          mediaType: currentNode.data.mediaType,
          buttons,
        })

        this.recordOutboundMessage(orgId, contactPhone, text, currentNode.data.mediaUrl)

        session.waitingForInput = true
        this.saveSession(orgId, session)
        break // Pausar esperando respuesta
      }

      // --- NODO: USER_INPUT (Captura interactiva de datos) ---
      else if (currentNode.type === 'user_input') {
        let prompt = currentNode.data.inputPrompt || 'Por favor ingresa la información solicitada:'
        prompt = this.interpolateVariables(prompt, session.context, contactPhone)

        messagesToSend.push({ text: prompt })
        this.recordOutboundMessage(orgId, contactPhone, prompt)

        session.waitingForInput = true
        session.inputTargetField = currentNode.data.saveToCustomField || 'dato_capturado'
        this.saveSession(orgId, session)
        break // Pausar esperando el dato del usuario
      }

      // --- NODO: CONDITION (Bifurcación lógica) ---
      else if (currentNode.type === 'condition') {
        const rules = currentNode.data.rules || []
        const logic = currentNode.data.conditionLogic || 'AND'
        const isMatch = this.evaluateConditionRules(orgId, contactPhone, rules, logic, session.context)

        const targetHandle = isMatch ? 'yes' : 'no'
        const nextEdge = flow.edges.find((e) => e.source === currentNode!.id && e.sourceHandle === targetHandle)

        if (nextEdge) {
          session.currentNodeId = nextEdge.target
          currentNode = flow.nodes.find((n) => n.id === nextEdge.target)
        } else {
          currentNode = undefined
        }
      }

      // --- NODO: ACTION (ManyChat Actions & ALBRA CRM) ---
      else if (currentNode.type === 'action' || currentNode.type === 'crm_action') {
        const actType = currentNode.data.actionType || (currentNode.data.crmAction ? 'crm_opportunity' : 'add_tag')

        // 1. Tagging
        if (actType === 'add_tag' && currentNode.data.tag) {
          this.addTag(orgId, contactPhone, currentNode.data.tag)
          tagsToAdd.push(currentNode.data.tag)
        } else if (actType === 'remove_tag' && currentNode.data.tag) {
          this.removeTag(orgId, contactPhone, currentNode.data.tag)
          tagsToRemove.push(currentNode.data.tag)
        }

        // 2. Custom Field
        else if (actType === 'set_custom_field' && currentNode.data.customFieldKey && currentNode.data.customFieldValue) {
          const val = this.interpolateVariables(currentNode.data.customFieldValue, session.context, contactPhone)
          this.setCustomField(orgId, contactPhone, currentNode.data.customFieldKey, val)
          customFieldsToSet[currentNode.data.customFieldKey] = val
          session.context[currentNode.data.customFieldKey] = val
        }

        // 3. Drip Sequence
        else if (actType === 'enroll_sequence' && currentNode.data.sequenceId) {
          this.enrollContactInSequence(orgId, contactPhone, currentNode.data.sequenceId)
          sequenceToEnroll = currentNode.data.sequenceId
        }

        // 4. Webhook saliente — (hallazgo 5) las cabeceras configuradas del nodo
        //    viajan al ejecutor del router (que valida, limita y journaliza).
        else if (actType === 'http_webhook' && currentNode.data.webhookUrl) {
          webhookToCall = {
            url: currentNode.data.webhookUrl,
            headers: currentNode.data.webhookHeaders,
            body: { contactPhone, context: session.context, timestamp: Date.now() },
          }
        }

        // 5. CRM ALBRA Action
        else {
          const action = currentNode.data.crmAction || (actType === 'crm_opportunity' ? 'create_opportunity' : 'add_note')
          const params = { ...(currentNode.data.crmParams || {}) }
          if (contactInfo?.clientId && !params.clientId) params.clientId = contactInfo.clientId
          if (!params.phone) params.phone = contactPhone
          if (!params.title) params.title = `Lead desde ManyChat: ${flow.name}`

          actionsToExecute.push({ action, params })
        }

        // Avanzar al siguiente nodo
        const nextEdge = flow.edges.find((e) => e.source === currentNode!.id)
        if (nextEdge) {
          session.currentNodeId = nextEdge.target
          currentNode = flow.nodes.find((n) => n.id === nextEdge.target)
        } else {
          currentNode = undefined
        }
      }

      // --- NODO: AB_SPLIT (División de tráfico A/B) ---
      else if (currentNode.type === 'ab_split') {
        const ratio = currentNode.data.splitRatio ?? 50
        const rand = Math.random() * 100
        const chosenHandle = rand < ratio ? 'a' : 'b'

        const nextEdge = flow.edges.find((e) => e.source === currentNode!.id && e.sourceHandle === chosenHandle)
        if (nextEdge) {
          session.currentNodeId = nextEdge.target
          currentNode = flow.nodes.find((n) => n.id === nextEdge.target)
        } else {
          currentNode = undefined
        }
      }

      // --- NODO: GOTO_FLOW (Sub-flujo) — el sub-flujo debe pertenecer a ESTA org (4.B) ---
      else if (currentNode.type === 'goto_flow' && currentNode.data.targetFlowId) {
        const targetFlow = this.getFlow(orgId, currentNode.data.targetFlowId)
        if (targetFlow) {
          flow = targetFlow
          session.flowId = targetFlow.id
          const startNode = targetFlow.nodes.find((n) => n.type === 'trigger') || targetFlow.nodes[0]
          const firstEdge = targetFlow.edges.find((e) => e.source === startNode?.id)
          if (firstEdge) {
            session.currentNodeId = firstEdge.target
            currentNode = targetFlow.nodes.find((n) => n.id === firstEdge.target)
            continue
          }
        }
        currentNode = undefined
      }

      // --- NODO: HANDOFF (Human Takeover) ---
      else if (currentNode.type === 'handoff') {
        isHandoff = true
        handoffReason = currentNode.data.handoffReason || `Transferencia activada en ManyChat: ${flow.name}`
        const farewell = '👤 Te estamos comunicando con un asesor de nuestro equipo comercial. El bot se ha pausado.'
        messagesToSend.push({ text: farewell })
        this.recordOutboundMessage(orgId, contactPhone, farewell)
        this.clearSession(orgId, contactPhone)
        break
      }

      // --- NODO: AI_RESPONSE ---
      else if (currentNode.type === 'ai_response') {
        // (hallazgo 3) El nodo ejecuta el motor REAL de IA: envía el prompt
        // interpolado + contexto al proveedor configurado (inyectable/entorno),
        // con timeout y clasificación de errores. Sin IA configurada o con
        // fallo: aviso EXPLÍCITO de indisponibilidad (jamás texto fingido de IA).
        const promptTemplate = currentNode.data.aiPrompt || currentNode.data.promptOverride || 'Responde de forma concisa como asistente de ventas.'
        const prompt = this.interpolateVariables(promptTemplate, session.context, contactPhone)
        let aiText: string
        try {
          const aiRes = await this.aiProvider.complete(prompt, session.context, { model: currentNode.data.aiModel })
          if (aiRes.ok && aiRes.text && aiRes.text.trim().length > 0) {
            aiText = aiRes.text
          } else {
            console.error(`[flow-engine] AI_RESPONSE sin resultado usable (fallback=${aiRes.fallback ?? false}): ${aiRes.error || 'respuesta vacía'} — se continúa con aviso explícito, no simulamos IA`)
            aiText = AI_UNAVAILABLE_FALLBACK
          }
        } catch (err) {
          console.error(`[flow-engine] AI_RESPONSE falló: ${err instanceof Error ? err.message : String(err)} — se continúa con aviso explícito, no simulamos IA`)
          aiText = AI_UNAVAILABLE_FALLBACK
        }
        messagesToSend.push({ text: aiText })
        this.recordOutboundMessage(orgId, contactPhone, aiText)

        const nextEdge = flow.edges.find((e) => e.source === currentNode!.id)
        if (nextEdge) {
          session.currentNodeId = nextEdge.target
          currentNode = flow.nodes.find((n) => n.id === nextEdge.target)
        } else {
          currentNode = undefined
        }
      } else if (currentNode.type === 'delay' || currentNode.type === 'smart_delay') {
        // (ronda 22) La espera es REAL: se guarda en la base a qué hora hay que
        // volver y por qué nodo seguir, y la sesión se cierra para que un mensaje
        // del contacto durante la espera no se salte el nodo (antes lo saltaba en
        // silencio). Quien despierta el flujo es el planificador
        // (src/engine/scheduler.ts), que llama a resumeFlowWait() a su hora.
        const nodoEspera = currentNode
        const minutosPedidos = nodoEspera.type === 'smart_delay'
          ? (nodoEspera.data.smartDelayHours ?? 0) * 60 + (nodoEspera.data.delayMinutes ?? 0)
          : (nodoEspera.data.delayMinutes ?? (nodoEspera.data.delaySeconds ?? 0) / 60)
        const nextEdge = flow.edges.find((e) => e.source === nodoEspera.id)
        if (!nextEdge) {
          // Sin salida: el flujo termina aquí, no hay nada que esperar.
          currentNode = undefined
        } else if (!(minutosPedidos > 0)) {
          // Espera de cero minutos: no se aparca nada, se sigue (y se dice).
          console.warn('[flow-engine] Nodo ' + nodoEspera.type + ' ("' + nodoEspera.title + '") sin minutos de espera: el flujo sigue ya.')
          session.currentNodeId = nextEdge.target
          currentNode = flow.nodes.find((n) => n.id === nextEdge.target)
        } else {
          const dueAt = Date.now() + Math.round(minutosPedidos * 60000)
          parkedUntil = dueAt
          waitNodeId = nodoEspera.id
          const esperaId = this.parkFlowWait({
            organizationId: orgId,
            contactPhone,
            flowId: flow.id,
            waitNodeId: nodoEspera.id,
            nextNodeId: nextEdge.target,
            dueAt,
            context: session.context,
          })
          this.clearSession(orgId, contactPhone)
          console.log('[flow-engine] Flujo aparcado en "' + nodoEspera.title + '" hasta ' + new Date(dueAt).toISOString() + ' (' + Math.round(minutosPedidos) + ' min, espera ' + (esperaId || 'ya pendiente') + ')')
          break
        }
      }
    }

    if (!currentNode && !session.waitingForInput) {
      this.clearSession(orgId, contactPhone)
    }

    return {
      handled: true,
      flowId: flow.id,
      currentNodeId: session?.currentNodeId,
      messagesToSend,
      actionsToExecute,
      tagsToAdd,
      tagsToRemove,
      customFieldsToSet,
      sequenceToEnroll,
      webhookToCall,
      isHandoff,
      handoffReason,
      flowCompleted: !currentNode,
      parkedUntil,
      waitNodeId,
    }
  }

  // =========================================================================
  // 6. UTILIDADES AUXILIARES
  // =========================================================================

  /**
   * (hallazgo 1, auditoría funcional 2026-11-12) Interpolación LITERAL por
   * split/join en lugar de RegExp dinámicas:
   *  - los nombres de campos son DATOS, no patrones: un nombre como "cliente[",
   *    "cliente.nombre" o "precio+iva" jamás construye una expresión inválida
   *    ni coincide por accidente;
   *  - split/join no sufre la semántica especial de "$" ("$&", "$1") en el
   *    reemplazo de String.replace, que corrompía valores que la contuvieran;
   *  - se preserva el formato {{nombre}} y la sustitución existente.
   */
  private interpolateVariables(text: string, context: Record<string, string>, phone: string): string {
    let res = text
    res = res.split('{{nombre}}').join(context.nombre || 'amigo(a)')
    res = res.split('{{telefono}}').join(phone)
    for (const [k, v] of Object.entries(context)) {
      res = res.split(`{{${k}}}`).join(String(v))
    }
    return res
  }

  private evaluateConditionRules(
    orgId: string,
    phone: string,
    rules: ConditionRule[],
    logic: 'AND' | 'OR',
    context: Record<string, string>
  ): boolean {
    if (rules.length === 0) return true

    const results = rules.map((r) => {
      if (r.type === 'has_tag') {
        return this.hasTag(orgId, phone, r.value)
      } else if (r.type === 'does_not_have_tag') {
        return !this.hasTag(orgId, phone, r.value)
      } else if (r.type === 'field_equals' && r.field) {
        const val = this.getCustomField(orgId, phone, r.field) || context[r.field] || ''
        return val.toLowerCase() === r.value.toLowerCase()
      } else if (r.type === 'field_contains' && r.field) {
        const val = this.getCustomField(orgId, phone, r.field) || context[r.field] || ''
        return val.toLowerCase().includes(r.value.toLowerCase())
      } else if (r.type === 'field_greater_than' && r.field) {
        // (hallazgo 2) Comparación numérica REAL con validación: vacío, NaN o
        // no numérico → false definido (comportamiento documentado y probado).
        const val = this.getCustomField(orgId, phone, r.field) || context[r.field] || ''
        const cmp = compareNumericValues(val, r.value)
        return cmp !== null && cmp > 0
      } else if (r.type === 'field_less_than' && r.field) {
        const val = this.getCustomField(orgId, phone, r.field) || context[r.field] || ''
        const cmp = compareNumericValues(val, r.value)
        return cmp !== null && cmp < 0
      } else if (r.type === 'message_contains') {
        const msg = context.ultimo_mensaje || ''
        return msg.toLowerCase().includes(r.value.toLowerCase())
      } else if (r.type === 'message_equals') {
        // (hallazgo 2) Comparación EXACTA de mensajes respetando la normalización
        // del motor (trim + minúsculas + des-acento NFD, la misma del trigger).
        const msg = context.ultimo_mensaje || ''
        return normalizeForEngineCompare(msg) === normalizeForEngineCompare(r.value)
      }
      return false
    })

    return logic === 'AND' ? results.every(Boolean) : results.some(Boolean)
  }

  /**
   * (hallazgo 4, auditoría funcional 2026-11-12) Persistencia del registro
   * outbound con POLÍTICA EXPLÍCITA (definida y probada, no silenciosa):
   *  - El mensaje ya está en messagesToSend: el envío NO se revierte ni se
   *    reintenta desde aquí (un reintento duplicaría el WhatsApp real).
   *  - La idempotencia del envío vive en el router (daemon_send_idempotency)
   *    y NO depende de este registro: inbox_messages es auditoría de bandeja.
   *  - Un fallo de BD se REGISTRA en el log de operación con contexto mínimo
   *    (org e id del registro, sin datos sensibles) y devuelve false.
   *  - SIN reintento automático: evita duplicados en la bandeja.
   * @returns true si el registro quedó persistido.
   */
  private recordOutboundMessage(orgId: string, phone: string, text: string, mediaUrl?: string): boolean {
    const recordId = `out_${Date.now()}_${Math.random().toString(36).substring(7)}`
    try {
      this.db.prepare(`
        INSERT INTO inbox_messages (id, organization_id, contact_phone, direction, text, media_url, created_at)
        VALUES (?, ?, ?, 'outbound', ?, ?, ?)
      `).run(recordId, orgId, phone, text, mediaUrl || null, Date.now())
      return true
    } catch (err) {
      console.error(
        `[flow-engine] OUTBOUND_NOT_PERSISTED: no se pudo registrar el mensaje saliente en inbox_messages (org=${orgId}, registro=${recordId}) — el envío continúa y la idempotencia de envío no depende de este registro; sin reintento para no duplicar. error=${err instanceof Error ? err.message : String(err)}`
      )
      return false
    }
  }

  /**
   * (tercera reparación 4.B) Seed POR ORGANIZACIÓN del flujo demo: cada org
   * recibe SU PROPIA copia la primera vez que evalúa/consulta flujos. Las
   * organizaciones existentes jamás ven flujos ajenos.
   */
  private ensureDefaultFlowForOrg(orgId: string): void {
    if (!orgId || typeof orgId !== 'string') return
    const count = this.db.prepare('SELECT count(*) as total FROM flows WHERE organization_id = ?').get(orgId) as { total: number }
    if (count && count.total > 0) return

    const defaultFlow: FlowDefinition = {
      id: 'flow_ventas_manychat_01',
      name: 'Flujo Completo de Calificación ManyChat',
      triggerKeywords: ['precio', 'precios', 'planes', 'info', 'informacion', 'demo'],
      isActive: true,
      nodes: [
        {
          id: 'n_trigger',
          type: 'trigger',
          title: 'Trigger: Palabras Clave',
          position: { x: 50, y: 150 },
          data: { keywords: ['precio', 'planes', 'info', 'demo'] },
        },
        {
          id: 'n_welcome',
          type: 'send_message',
          title: 'Mensaje de Bienvenida y Menú',
          position: { x: 300, y: 150 },
          data: {
            messageText: '¡Hola {{nombre}}! 👋 Qué gusto saludarte.\nPara darte la información exacta, ¿cuántos asesores o vendedores tiene tu equipo?\n\n1️⃣ 1 a 3 asesores (Plan Emprendedor)\n2️⃣ Más de 4 asesores (Plan Corporativo)\n3️⃣ Quiero hablar con un asesor',
          },
        },
        {
          id: 'n_tag_emprendedor',
          type: 'action',
          title: 'Etiquetar: Lead Emprendedor',
          position: { x: 650, y: 50 },
          data: { actionType: 'add_tag', tag: 'lead_emprendedor' },
        },
        {
          id: 'n_plan_emprendedor',
          type: 'send_message',
          title: 'Respuesta Plan Emprendedor',
          position: { x: 950, y: 50 },
          data: {
            messageText: '🚀 El Plan Emprendedor incluye gestión de WhatsApp, CRM Kanban y plantillas por $29/mes.\n¿Te gustaría activar tu prueba gratis de 7 días? Escribe "SI" para empezar.',
          },
        },
        {
          id: 'n_tag_corporativo',
          type: 'action',
          title: 'Etiquetar: Lead Corporativo',
          position: { x: 650, y: 250 },
          data: { actionType: 'add_tag', tag: 'lead_corporativo' },
        },
        {
          id: 'n_crm_deal',
          type: 'crm_action',
          title: 'Crear Oportunidad en CRM ALBRA',
          position: { x: 950, y: 250 },
          data: {
            crmAction: 'create_opportunity',
            crmParams: { title: 'Lead Corporativo (+4 asesores)', amount: 150 },
          },
        },
        {
          id: 'n_msg_corporativo',
          type: 'send_message',
          title: 'Mensaje Lead Corporativo',
          position: { x: 1250, y: 250 },
          data: {
            messageText: '🏢 Excelente. Para equipos grandes tenemos el Plan Corporativo con WhatsApp multi-agente y automatizaciones avanzadas. Un especialista comercial te atenderá en este instante.',
          },
        },
        {
          id: 'n_handoff',
          type: 'handoff',
          title: 'Handoff a Asesor Comercial',
          position: { x: 650, y: 450 },
          data: { handoffReason: 'Cliente solicitó asesor humano desde menú ManyChat' },
        },
      ],
      edges: [
        { id: 'e1', source: 'n_trigger', target: 'n_welcome' },
        { id: 'e2', source: 'n_welcome', target: 'n_tag_emprendedor', sourceHandle: '1' },
        { id: 'e3', source: 'n_welcome', target: 'n_tag_corporativo', sourceHandle: '2' },
        { id: 'e4', source: 'n_welcome', target: 'n_handoff', sourceHandle: '3' },
        { id: 'e5', source: 'n_tag_emprendedor', target: 'n_plan_emprendedor' },
        { id: 'e6', source: 'n_tag_corporativo', target: 'n_crm_deal' },
        { id: 'e7', source: 'n_crm_deal', target: 'n_msg_corporativo' },
      ],
    }

    this.saveFlow(orgId, defaultFlow)
  }
}

/**
 * (hallazgo 2, auditoría funcional 2026-11-12) Normalización de comparación de
 * mensajes: la MISMA que usa el motor para triggers (trim + minúsculas +
 * des-acento NFD). message_equals respeta exactamente esta normalización.
 */
export function normalizeForEngineCompare(s: string): string {
  return s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * (hallazgo 2) Validación numérica estricta: vacío o no-numérico → null
 * (sin comparación: la condición evalúa false definido, no excepción).
 */
export function parseNumericValue(s: string): number | null {
  if (s === null || s === undefined) return null
  const t = String(s).trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** (hallazgo 2) Comparación numérica segura: null si algún lado no es numérico. */
export function compareNumericValues(a: string, b: string): number | null {
  const na = parseNumericValue(a)
  const nb = parseNumericValue(b)
  if (na === null || nb === null) return null
  return na === nb ? 0 : na < nb ? -1 : 1
}
