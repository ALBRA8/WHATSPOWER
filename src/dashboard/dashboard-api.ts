/**
 * dashboard-api.ts — API del panel de control (paridad operativa ManyChat).
 *
 * Qué añade sobre la API existente (sin tocar lo que ya funcionaba):
 *   - Vista general (métricas reales de la base: contactos, mensajes, flujos…)
 *   - Contactos derivados (teléfonos que aparecen en etiquetas, campos,
 *     sesiones de flujo, bandeja, secuencias, asignaciones o supresión)
 *     con etiquetas, campos personalizados, estado y última actividad.
 *   - Bandeja (conversaciones + hilo + respuesta manual + handoff/liberar).
 *   - Automatizaciones: activar/desactivar, duplicar y borrar flujos.
 *   - Secuencias (goteo): alta, pasos, inscripción y cancelación.
 *   - Difusiones (broadcast) por etiqueta o audiencia completa, con registro
 *     honesto del resultado real de cada envío.
 *   - Reglas de automatización por etapa del CRM (lectura y edición).
 *   - Ajustes: canal/transporte, equipo, respuestas guardadas, enlaces.
 *
 * Honestidad: cada envío reporta SENT / REJECTED / UNCERTAIN tal como lo
 * devuelve el transporte; nada se marca como entregado si no lo fue.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { readBody, SlidingRateLimiter } from '../security.ts'
import type { FlowEngine } from '../engine/flow-engine.ts'
import type { LockManager } from '../state/lock-manager.ts'
import type { TeamManager } from '../state/team-manager.ts'
import type { CannedResponseManager } from '../engine/canned-responses.ts'
import type { GrowthToolsManager } from '../engine/growth-tools.ts'
import type { SuppressionStore } from '../suppression/suppression-store.ts'
import type { TransportSender } from '../types.ts'
import type { FlowDefinition, SequenceDefinition } from '../engine/flow-types.ts'
import {
  ensureDashboardAuditTable,
  listDashboardAudit,
  recordDashboardAudit,
  type AuditActor,
  type AuditEntry,
} from './dashboard-audit.ts'

export interface DashboardContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  orgId: string
  /** Quién llama: operador central (admin) o credencial de organización con su rol. */
  actor: AuditActor
  db: DatabaseSync
  engine: FlowEngine
  locks: LockManager
  team: TeamManager
  canned: CannedResponseManager
  growth: GrowthToolsManager
  suppression: SuppressionStore
  transport: TransportSender
}

const DAY = 86_400_000

/**
 * Límites de la capa nueva: están para que un descuido no se convierta en un
 * envío masivo. Son holgados para el trabajo normal de una jornada.
 */
export const DASHBOARD_LIMITS = {
  /** respuestas manuales por organización y minuto */
  repliesPerMinute: 120,
  /** difusiones reales por organización y hora */
  broadcastsPerHour: 6,
  /** destinatarios por difusión */
  maxRecipients: 500,
  /** filas por página del registro de auditoría */
  auditPage: 100,
}

const replyLimiter = new SlidingRateLimiter()
const broadcastLimiter = new SlidingRateLimiter()

/** Teléfono utilizable: entre 8 y 15 dígitos, sin adornos. */
function normalizePhone(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const digits = String(raw).replace(/\D/g, '')
  return digits.length >= 8 && digits.length <= 15 ? digits : null
}

/** Anota en la auditoría; nunca puede tumbar la respuesta. */
function audit(ctx: DashboardContext, entry: AuditEntry): void {
  recordDashboardAudit(ctx.db, ctx.req, ctx.orgId, ctx.actor, entry)
}


function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Todas las subconsultas comparten el mismo parámetro (organización). */
const PHONES_UNION = `
  SELECT contact_phone AS phone FROM contact_tags WHERE organization_id = ?
  UNION SELECT contact_phone FROM contact_custom_fields WHERE organization_id = ?
  UNION SELECT contact_phone FROM flow_sessions WHERE organization_id = ?
  UNION SELECT contact_phone FROM inbox_messages WHERE organization_id = ?
  UNION SELECT contact_phone FROM sequence_enrollments WHERE organization_id = ?
  UNION SELECT contact_phone FROM agent_assignments WHERE organization_id = ?
  UNION SELECT phone FROM suppression_list WHERE organization_id = ?
  UNION SELECT contact_phone FROM conversation_locks WHERE organization_id = ?
`

function listPhones(db: DatabaseSync, orgId: string): string[] {
  const rows = db.prepare(`WITH phones(phone) AS (${PHONES_UNION}) SELECT phone FROM phones`).all(
    orgId, orgId, orgId, orgId, orgId, orgId, orgId, orgId
  ) as Array<{ phone: string }>
  return rows.map((r) => r.phone)
}

function count(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as { n?: number } | undefined
  return Number(row?.n ?? 0)
}

/** Ficha resumida de cada contacto, montada en memoria (audiencias pequeñas). */
function buildContactIndex(db: DatabaseSync, orgId: string) {
  const phones = listPhones(db, orgId)
  const tags = new Map<string, string[]>()
  for (const r of db.prepare('SELECT contact_phone, tag_name FROM contact_tags WHERE organization_id = ? ORDER BY tag_name').all(orgId) as Array<{ contact_phone: string; tag_name: string }>) {
    const list = tags.get(r.contact_phone) || []
    list.push(r.tag_name)
    tags.set(r.contact_phone, list)
  }
  const fields = new Map<string, Record<string, string>>()
  for (const r of db.prepare('SELECT contact_phone, field_key, field_value FROM contact_custom_fields WHERE organization_id = ?').all(orgId) as Array<{ contact_phone: string; field_key: string; field_value: string }>) {
    const bag = fields.get(r.contact_phone) || {}
    bag[r.field_key] = r.field_value
    fields.set(r.contact_phone, bag)
  }
  const last: Record<string, { at: number; count: number; inbound: number; outbound: number }> = {}
  for (const r of db.prepare(`
    SELECT contact_phone, MAX(created_at) AS at, COUNT(*) AS c,
           SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
           SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound
    FROM inbox_messages WHERE organization_id = ? GROUP BY contact_phone
  `).all(orgId) as Array<{ contact_phone: string; at: number; c: number; inbound: number; outbound: number }>) {
    last[r.contact_phone] = { at: Number(r.at), count: Number(r.c), inbound: Number(r.inbound), outbound: Number(r.outbound) }
  }
  const sessions = new Map<string, { flowId: string; at: number }>()
  for (const r of db.prepare('SELECT contact_phone, flow_id, last_activity FROM flow_sessions WHERE organization_id = ?').all(orgId) as Array<{ contact_phone: string; flow_id: string; last_activity: number }>) {
    sessions.set(r.contact_phone, { flowId: r.flow_id, at: Number(r.last_activity) })
  }
  const suppressed = new Set(
    (db.prepare('SELECT phone FROM suppression_list WHERE organization_id = ?').all(orgId) as Array<{ phone: string }>).map((r) => r.phone)
  )
  const locks = new Map<string, { state: string; expiresAt: number }>()
  for (const r of db.prepare('SELECT contact_phone, current_state, expires_at FROM conversation_locks WHERE organization_id = ?').all(orgId) as Array<{ contact_phone: string; current_state: string; expires_at: number }>) {
    locks.set(r.contact_phone, { state: r.current_state, expiresAt: Number(r.expires_at) })
  }
  const assignments = new Map<string, string>()
  for (const r of db.prepare("SELECT contact_phone, agent_id FROM agent_assignments WHERE organization_id = ? AND status = 'OPEN'").all(orgId) as Array<{ contact_phone: string; agent_id: string }>) {
    assignments.set(r.contact_phone, r.agent_id)
  }
  const enrollments = new Map<string, Array<{ sequenceId: string; status: string; nextRunAt: number }>>()
  for (const r of db.prepare('SELECT contact_phone, sequence_id, status, next_run_at FROM sequence_enrollments WHERE organization_id = ?').all(orgId) as Array<{ contact_phone: string; sequence_id: string; status: string; next_run_at: number }>) {
    const list = enrollments.get(r.contact_phone) || []
    list.push({ sequenceId: r.sequence_id, status: r.status, nextRunAt: Number(r.next_run_at) })
    enrollments.set(r.contact_phone, list)
  }

  return phones.map((phone) => {
    const stats = last[phone]
    const lock = locks.get(phone)
    const nowSeconds = Math.floor(Date.now() / 1000)
    const liveLock = lock && (lock.state === 'HANDOFF_HUMAN' || lock.expiresAt > nowSeconds) ? lock : undefined
    return {
      phone,
      tags: tags.get(phone) || [],
      fields: fields.get(phone) || {},
      lastMessageAt: stats?.at ?? null,
      messageCount: stats?.count ?? 0,
      inboundCount: stats?.inbound ?? 0,
      outboundCount: stats?.outbound ?? 0,
      flowId: sessions.get(phone)?.flowId ?? null,
      lastFlowActivity: sessions.get(phone)?.at ?? null,
      suppressed: suppressed.has(phone),
      lockState: liveLock?.state ?? 'IDLE',
      agentId: assignments.get(phone) ?? null,
      enrollments: enrollments.get(phone) || [],
    }
  })
}

async function readJson(ctx: DashboardContext): Promise<{ ok: true; data: any } | { ok: false }> {
  const rb = await readBody(ctx.req)
  if (!rb.ok) {
    json(ctx.res, 413, { error: 'Payload demasiado grande' })
    return { ok: false }
  }
  try {
    return { ok: true, data: rb.body ? JSON.parse(rb.body) : {} }
  } catch {
    json(ctx.res, 400, { error: 'JSON inválido' })
    return { ok: false }
  }
}

function clampLimit(value: string | null, fallback = 50, max = 200): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

export async function handleDashboardApi(ctx: DashboardContext): Promise<boolean> {
  const { req, res, url, orgId, db } = ctx
  const path = url.pathname
  if (!path.startsWith('/api/dashboard')) return false
  const route = path.slice('/api/dashboard'.length) || '/'
  const method = req.method || 'GET'

  // La tabla de auditoría se prepara al entrar; si falla, avisa y se sigue.
  ensureDashboardAuditTable(db)
  const isAdmin = ctx.actor.role === 'admin'

  /**
   * Separación de poderes del panel: un asesor atiende conversaciones, responde
   * y etiqueta; difundir, borrar flujos, cambiar bajas o editar reglas es de
   * administración. Cada negativa se anota, para que quede constancia del intento.
   */
  const denied = (reason: string): true => {
    audit(ctx, { action: `denied ${method} ${route}`, outcome: 'denied', detail: { reason, role: ctx.actor.role } })
    json(res, 403, { error: `Solo administración: ${reason}`, code: 'FORBIDDEN_ROLE' })
    return true
  }

  // ---------------------------------------------------------------- auditoría
  if (route === '/audit' && method === 'GET') {
    if (!isAdmin) return denied('ver el registro de actividad')
    const limit = Math.min(clampLimit(url.searchParams.get('limit'), 50), DASHBOARD_LIMITS.auditPage)
    const offset = Math.min(Math.max(Number(url.searchParams.get('offset') || 0) || 0, 0), 5000)
    const page = listDashboardAudit(db, orgId, limit, offset)
    json(res, 200, { ...page, role: ctx.actor.role, actor: ctx.actor.label })
    return true
  }

  // ---------------------------------------------------------------- resumen
  if (route === '/overview' && method === 'GET') {
    const now = Date.now()
    const todayStart = new Date(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z').getTime()
    const contacts = buildContactIndex(db, orgId)
    const flows = ctx.engine.listFlows(orgId)
    const activeConversations = contacts.filter((c) => c.lastMessageAt && now - c.lastMessageAt < DAY).length
    const handoffs = contacts.filter((c) => c.lockState === 'HANDOFF_HUMAN').length

    const messagesToday = count(db, "SELECT COUNT(*) AS n FROM inbox_messages WHERE organization_id = ? AND created_at >= ?", orgId, todayStart)
    const inboundToday = count(db, "SELECT COUNT(*) AS n FROM inbox_messages WHERE organization_id = ? AND direction = 'inbound' AND created_at >= ?", orgId, todayStart)
    const outboundToday = count(db, "SELECT COUNT(*) AS n FROM inbox_messages WHERE organization_id = ? AND direction = 'outbound' AND created_at >= ?", orgId, todayStart)

    const series: Array<{ day: string; inbound: number; outbound: number }> = []
    for (let i = 13; i >= 0; i--) {
      const from = todayStart - i * DAY
      const to = from + DAY
      series.push({
        day: new Date(from).toISOString().slice(0, 10),
        inbound: count(db, "SELECT COUNT(*) AS n FROM inbox_messages WHERE organization_id = ? AND direction = 'inbound' AND created_at >= ? AND created_at < ?", orgId, from, to),
        outbound: count(db, "SELECT COUNT(*) AS n FROM inbox_messages WHERE organization_id = ? AND direction = 'outbound' AND created_at >= ? AND created_at < ?", orgId, from, to),
      })
    }

    const recent = (db.prepare(`
      SELECT contact_phone, direction, text, created_at FROM inbox_messages
      WHERE organization_id = ? ORDER BY created_at DESC LIMIT 12
    `).all(orgId) as Array<{ contact_phone: string; direction: string; text: string; created_at: number }>)

    const tagTop = (db.prepare(`
      SELECT tag_name AS tag, COUNT(*) AS n FROM contact_tags WHERE organization_id = ?
      GROUP BY tag_name ORDER BY n DESC LIMIT 8
    `).all(orgId) as Array<{ tag: string; n: number }>)

    // Los pagos son un extra del panel: si la base es antigua y no trae la tabla,
    // el resumen se sirve igual en vez de caerse entero.
    let payments: Array<{ status: string; n: number; total: number }> = []
    try {
      payments = db.prepare(`
        SELECT status, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM payment_transactions
        WHERE organization_id = ? GROUP BY status
      `).all(orgId) as Array<{ status: string; n: number; total: number }>
    } catch { payments = [] }

    json(res, 200, {
      org: orgId,
      generatedAt: now,
      kpis: {
        contacts: contacts.length,
        activeConversations,
        handoffs,
        messagesToday,
        inboundToday,
        outboundToday,
        flows: flows.length,
        activeFlows: flows.filter((f) => f.isActive).length,
        suppressed: contacts.filter((c) => c.suppressed).length,
        scheduledSequences: count(db, "SELECT COUNT(*) AS n FROM sequence_enrollments WHERE organization_id = ? AND status = 'ACTIVE'", orgId),
        growthLinks: count(db, 'SELECT COUNT(*) AS n FROM growth_links WHERE organization_id = ?', orgId),
      },
      payments: payments.map((p) => ({ status: p.status, count: Number(p.n), total: Number(p.total) })),
      series,
      recent,
      topTags: tagTop.map((t) => ({ tag: t.tag, count: Number(t.n) })),
      flows: flows.map((f) => ({ id: f.id, name: f.name, isActive: f.isActive, nodes: f.nodes.length, triggerKeywords: f.triggerKeywords })),
    })
    return true
  }

  // ---------------------------------------------------------------- flujos
  if (route === '/flows' && method === 'GET') {
    const flows = ctx.engine.listFlows(orgId)
    json(res, 200, flows.map((f) => ({
      id: f.id,
      name: f.name,
      isActive: f.isActive,
      triggerKeywords: f.triggerKeywords,
      nodeCount: f.nodes.length,
      edgeCount: f.edges.length,
      nodes: f.nodes.map((n) => ({ id: n.id, type: n.type, title: n.title })),
    })))
    return true
  }

  const flowAction = route.match(/^\/flows\/([^/]+)\/(toggle|duplicate)$/)
  if (flowAction && method === 'POST') {
    if (!isAdmin) return denied('activar o duplicar flujos')
    const id = decodeURIComponent(flowAction[1])
    const flow = ctx.engine.getFlow(orgId, id)
    if (!flow) {
      json(res, 404, { error: 'Flujo no encontrado' })
      return true
    }
    if (flowAction[2] === 'toggle') {
      const next: FlowDefinition = { ...flow, isActive: !flow.isActive }
      ctx.engine.saveFlow(orgId, next)
      audit(ctx, { action: 'flow.toggle', subject: id, detail: { isActive: next.isActive } })
      json(res, 200, { ok: true, id, isActive: next.isActive })
      return true
    }
    const clone: FlowDefinition = {
      ...flow,
      id: `${flow.id}_copy_${Math.random().toString(36).slice(2, 7)}`,
      name: `${flow.name} (copia)`,
      isActive: false,
    }
    ctx.engine.saveFlow(orgId, clone)
    audit(ctx, { action: 'flow.duplicate', subject: id, detail: { newId: clone.id } })
    json(res, 200, { ok: true, id: clone.id })
    return true
  }

  const flowDelete = route.match(/^\/flows\/([^/]+)$/)
  if (flowDelete && method === 'DELETE') {
    if (!isAdmin) return denied('borrar flujos')
    const flowId = decodeURIComponent(flowDelete[1])
    const removed = ctx.engine.deleteFlow(orgId, flowId)
    audit(ctx, { action: 'flow.delete', subject: flowId, outcome: removed ? 'ok' : 'rejected' })
    json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'Flujo no encontrado' })
    return true
  }

  // ---------------------------------------------------------------- contactos
  if (route === '/contacts' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase()
    const tag = (url.searchParams.get('tag') || '').trim()
    const limit = clampLimit(url.searchParams.get('limit'), 50)
    const offset = Number(url.searchParams.get('offset') || 0) || 0
    const all = buildContactIndex(db, orgId)
    const filtered = all
      .filter((c) => (!tag || c.tags.includes(tag)) && (!q || c.phone.toLowerCase().includes(q) || Object.values(c.fields).some((v) => String(v).toLowerCase().includes(q)) || c.tags.some((t) => t.toLowerCase().includes(q))))
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) || a.phone.localeCompare(b.phone))
    json(res, 200, {
      total: filtered.length,
      contacts: filtered.slice(offset, offset + limit),
      tags: [...new Set(all.flatMap((c) => c.tags))].sort(),
    })
    return true
  }

  const contactMatch = route.match(/^\/contacts\/([^/]+)(?:\/(tags|fields|suppression|enroll))?$/)
  if (contactMatch) {
    const phone = normalizePhone(decodeURIComponent(contactMatch[1]))
    if (!phone) {
      json(res, 400, { error: 'Teléfono no válido (se esperan entre 8 y 15 dígitos)' })
      return true
    }
    const sub = contactMatch[2]

    if (!sub && method === 'GET') {
      const contact = buildContactIndex(db, orgId).find((c) => c.phone === phone)
      if (!contact) {
        json(res, 404, { error: 'Contacto no encontrado' })
        return true
      }
      const messages = db.prepare(`
        SELECT id, direction, text, media_url, created_at FROM inbox_messages
        WHERE organization_id = ? AND contact_phone = ? ORDER BY created_at ASC LIMIT 300
      `).all(orgId, phone)
      const session = ctx.engine.getSession(orgId, phone)
      const assignment = ctx.team.getAssignment(orgId, phone)
      const agents = ctx.team.getActiveAgents(orgId)
      json(res, 200, {
        contact,
        messages,
        session: session ? { flowId: session.flowId, currentNodeId: session.currentNodeId, waitingForInput: session.waitingForInput, lastActivity: session.lastActivity } : null,
        assignment: assignment ? { ...assignment, agentName: agents.find((a) => a.id === assignment.agentId)?.name || null } : null,
        agent: assignment ? agents.find((a) => a.id === assignment.agentId) || null : null,
      })
      return true
    }

    if (sub === 'tags' && method === 'POST') {
      const parsed = await readJson(ctx)
      if (!parsed.ok) return true
      const tag = String(parsed.data.tag || '').trim()
      if (!tag) {
        json(res, 400, { error: 'tag es obligatorio' })
        return true
      }
      if (parsed.data.op === 'remove') ctx.engine.removeTag(orgId, phone, tag)
      else ctx.engine.addTag(orgId, phone, tag)
      audit(ctx, { action: parsed.data.op === 'remove' ? 'contact.tag.remove' : 'contact.tag.add', subject: phone, detail: { tag } })
      json(res, 200, { ok: true, tags: ctx.engine.getTags(orgId, phone) })
      return true
    }

    if (sub === 'fields' && method === 'POST') {
      const parsed = await readJson(ctx)
      if (!parsed.ok) return true
      const key = String(parsed.data.key || '').trim()
      if (!key) {
        json(res, 400, { error: 'key es obligatoria' })
        return true
      }
      ctx.engine.setCustomField(orgId, phone, key, String(parsed.data.value ?? ''))
      audit(ctx, { action: 'contact.field.set', subject: phone, detail: { key } })
      json(res, 200, { ok: true, fields: ctx.engine.getAllCustomFields(orgId, phone) })
      return true
    }

    if (sub === 'suppression' && method === 'POST') {
      // Sacar a alguien de la lista de bajas es la acción más delicada del panel:
      // solo administración, y queda anotada con el motivo.
      if (!isAdmin) return denied('cambiar la lista de bajas')
      const parsed = await readJson(ctx)
      if (!parsed.ok) return true
      if (parsed.data.suppressed === false) {
        ctx.suppression.removeSuppression(orgId, phone)
        audit(ctx, { action: 'suppression.remove', subject: phone, detail: { reason: parsed.data.reason || null } })
        json(res, 200, { ok: true, suppressed: false })
      } else {
        const reason = String(parsed.data.reason || 'Baja manual desde el panel').slice(0, 200)
        ctx.suppression.addSuppression(orgId, phone, reason)
        audit(ctx, { action: 'suppression.add', subject: phone, detail: { reason } })
        json(res, 200, { ok: true, suppressed: true })
      }
      return true
    }

    if (sub === 'enroll' && method === 'POST') {
      const parsed = await readJson(ctx)
      if (!parsed.ok) return true
      const sequenceId = String(parsed.data.sequenceId || '')
      if (!sequenceId) {
        json(res, 400, { error: 'sequenceId es obligatorio' })
        return true
      }
      if (parsed.data.op === 'cancel') {
        ctx.engine.cancelSequenceEnrollment(orgId, phone, sequenceId)
        audit(ctx, { action: 'sequence.cancel', subject: phone, detail: { sequenceId } })
        json(res, 200, { ok: true, status: 'CANCELLED' })
      } else {
        if (ctx.suppression.isSuppressed(orgId, phone)) {
          audit(ctx, { action: 'sequence.enroll', subject: phone, outcome: 'rejected', detail: { sequenceId, reason: 'suppressed' } })
          json(res, 409, { error: 'El contacto está dado de baja: no se inscribe en secuencias.' })
          return true
        }
        ctx.engine.enrollContactInSequence(orgId, phone, sequenceId)
        audit(ctx, { action: 'sequence.enroll', subject: phone, detail: { sequenceId } })
        json(res, 200, { ok: true, status: 'ACTIVE' })
      }
      return true
    }

    json(res, 405, { error: 'Método no permitido' })
    return true
  }

  // ---------------------------------------------------------------- bandeja
  if (route === '/inbox' && method === 'GET') {
    const filter = url.searchParams.get('filter') || 'all'
    const q = (url.searchParams.get('q') || '').trim().toLowerCase()
    const contacts = buildContactIndex(db, orgId)
    let conversations = contacts
      .filter((c) => c.messageCount > 0 || c.lockState === 'HANDOFF_HUMAN')
      .filter((c) => (filter === 'open' ? c.lockState === 'HANDOFF_HUMAN' || (c.lastMessageAt && Date.now() - c.lastMessageAt < DAY) : true))
      .filter((c) => !q || c.phone.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q)))
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))

    conversations = conversations.slice(0, 100)
    const withPreview = conversations.map((c) => {
      const row = db.prepare(`
        SELECT text, direction FROM inbox_messages WHERE organization_id = ? AND contact_phone = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(orgId, c.phone) as { text: string; direction: string } | undefined
      return { ...c, lastMessage: row?.text || '', lastDirection: row?.direction || '' }
    })
    const agents = ctx.team.getActiveAgents(orgId)
    json(res, 200, {
      conversations: withPreview.map((c) => ({ ...c, agentName: agents.find((a) => a.id === c.agentId)?.name || null })),
      totals: {
        all: contacts.filter((c) => c.messageCount > 0).length,
        open: contacts.filter((c) => c.lockState === 'HANDOFF_HUMAN').length,
        suppressed: contacts.filter((c) => c.suppressed).length,
      },
    })
    return true
  }

  const inboxMatch = route.match(/^\/inbox\/([^/]+)(?:\/(reply|handoff|release|assign))?$/)
  if (inboxMatch) {
    const phone = normalizePhone(decodeURIComponent(inboxMatch[1]))
    if (!phone) {
      json(res, 400, { error: 'Teléfono no válido (se esperan entre 8 y 15 dígitos)' })
      return true
    }
    const action = inboxMatch[2]

    if (!action && method === 'GET') {
      const contact = buildContactIndex(db, orgId).find((c) => c.phone === phone)
      const messages = db.prepare(`
        SELECT id, direction, text, media_url, created_at FROM inbox_messages
        WHERE organization_id = ? AND contact_phone = ? ORDER BY created_at ASC LIMIT 300
      `).all(orgId, phone)
      const lock = ctx.locks.getLock(phone, orgId)
      const assignment = ctx.team.getAssignment(orgId, phone)
      const agents = ctx.team.getActiveAgents(orgId)
      json(res, 200, {
        phone,
        contact,
        messages,
        lock: lock ? { state: lock.currentState, expiresAt: lock.expiresAt } : null,
        assignment: assignment ? { ...assignment, agentName: agents.find((a) => a.id === assignment.agentId)?.name || null } : null,
        agents,
      })
      return true
    }

    if (action === 'reply' && method === 'POST') {
      const parsed = await readJson(ctx)
      if (!parsed.ok) return true
      const text = String(parsed.data.text || '').trim()
      if (!text) {
        json(res, 400, { error: 'El mensaje está vacío' })
        return true
      }
      if (text.length > 4096) {
        json(res, 400, { error: 'Mensaje demasiado largo (máx. 4096)' })
        return true
      }
      if (ctx.suppression.isSuppressed(orgId, phone)) {
        audit(ctx, { action: 'inbox.reply', subject: phone, outcome: 'rejected', detail: { reason: 'suppressed', length: text.length } })
        json(res, 409, { error: 'El contacto está dado de baja (supresión): no se puede enviar.' })
        return true
      }
      // Freno por organización: un bucle en la interfaz no puede inundar el canal.
      const gate = replyLimiter.check(`reply:${orgId}`, DASHBOARD_LIMITS.repliesPerMinute)
      if (!gate.allowed) {
        audit(ctx, { action: 'inbox.reply', subject: phone, outcome: 'rejected', detail: { reason: 'rate_limited' } })
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(gate.retryAfterSec) })
        res.end(JSON.stringify({ error: `Demasiadas respuestas seguidas. Espera ${gate.retryAfterSec} s.` }))
        return true
      }
      const correlationId = `dashboard_reply_${randomUUID()}`
      const result = await ctx.transport.sendMessage(phone, text, correlationId, `reply:${correlationId}`, orgId)
      if (result.ok) {
        db.prepare(`
          INSERT INTO inbox_messages (id, organization_id, contact_phone, direction, text, created_at)
          VALUES (?, ?, ?, 'outbound', ?, ?)
        `).run(`out_${randomUUID()}`, orgId, phone, text, Date.now())
      }
      audit(ctx, {
        action: 'inbox.reply',
        subject: phone,
        outcome: result.ok ? 'ok' : 'error',
        detail: { length: text.length, transportOutcome: result.outcome || null, error: result.error || null },
      })
      json(res, result.ok ? 200 : 502, {
        ok: result.ok,
        outcome: result.outcome || (result.ok ? 'SENT' : 'UNCERTAIN'),
        messageId: result.messageId || null,
        error: result.error || null,
        degraded: result.degraded || [],
      })
      return true
    }

    if (action === 'handoff' && method === 'POST') {
      const correlationId = `dashboard_handoff_${randomUUID()}`
      ctx.locks.setHandoff(phone, orgId, correlationId)
      const parsed = await readJson(ctx).catch(() => ({ ok: false as const }))
      let agent = null
      if (parsed.ok && parsed.data.assign !== false) {
        agent = ctx.team.assignRoundRobin(orgId, phone)
      }
      audit(ctx, { action: 'inbox.handoff', subject: phone, detail: { agentId: agent?.id || null } })
      json(res, 200, { ok: true, lockState: 'HANDOFF_HUMAN', assignedAgent: agent })
      return true
    }

    if (action === 'release' && method === 'POST') {
      ctx.locks.releaseLock(phone, orgId)
      ctx.team.resolveAssignment(orgId, phone)
      const resumeBot = url.searchParams.get('resumeBot') !== 'false'
      if (resumeBot) ctx.engine.clearSession(orgId, phone)
      audit(ctx, { action: 'inbox.release', subject: phone, detail: { resumeBot } })
      json(res, 200, { ok: true, lockState: 'IDLE' })
      return true
    }

    if (action === 'assign' && method === 'POST') {
      const parsed = await readJson(ctx)
      if (!parsed.ok) return true
      const strategy = parsed.data.strategy === 'least_loaded' ? 'least_loaded' : parsed.data.strategy === 'agent' ? 'agent' : 'round_robin'
      if (strategy === 'agent') {
        const agentId = String(parsed.data.agentId || '')
        const agents = ctx.team.getActiveAgents(orgId)
        if (!agents.some((a) => a.id === agentId)) {
          json(res, 404, { error: 'Asesor no encontrado en esta organización' })
          return true
        }
        db.prepare(`
          INSERT INTO agent_assignments (organization_id, contact_phone, agent_id, assigned_at, status)
          VALUES (?, ?, ?, ?, 'OPEN')
          ON CONFLICT(organization_id, contact_phone) DO UPDATE SET agent_id = excluded.agent_id, assigned_at = excluded.assigned_at, status = 'OPEN'
        `).run(orgId, phone, agentId, Math.floor(Date.now() / 1000))
        audit(ctx, { action: 'inbox.assign', subject: phone, detail: { agentId, strategy: 'agent' } })
        json(res, 200, { ok: true, agentId })
        return true
      }
      const agent = strategy === 'least_loaded' ? ctx.team.assignLeastLoaded(orgId, phone) : ctx.team.assignRoundRobin(orgId, phone)
      audit(ctx, { action: 'inbox.assign', subject: phone, detail: { agentId: agent?.id || null, strategy } })
      json(res, 200, { ok: true, agentId: agent?.id || null, agentName: agent?.name || null })
      return true
    }
  }

  // ---------------------------------------------------------------- secuencias
  if (route === '/sequences' && method === 'GET') {
    const rows = db.prepare('SELECT id, name, is_active, created_at FROM sequences WHERE organization_id = ? ORDER BY created_at DESC').all(orgId) as Array<{ id: string; name: string; is_active: number; created_at: number }>
    const sequences = rows.map((s) => {
      const steps = db.prepare('SELECT id, step_order, delay_minutes, message_text, flow_id FROM sequence_steps WHERE organization_id = ? AND sequence_id = ? ORDER BY step_order').all(orgId, s.id)
      const enrolled = count(db, "SELECT COUNT(*) AS n FROM sequence_enrollments WHERE organization_id = ? AND sequence_id = ? AND status = 'ACTIVE'", orgId, s.id)
      return { id: s.id, name: s.name, isActive: Boolean(s.is_active), createdAt: Number(s.created_at), steps, enrolled }
    })
    json(res, 200, { sequences })
    return true
  }

  if (route === '/sequences' && method === 'POST') {
    if (!isAdmin) return denied('crear o editar secuencias')
    const parsed = await readJson(ctx)
    if (!parsed.ok) return true
    const data = parsed.data
    const name = String(data.name || '').trim()
    const stepsIn = Array.isArray(data.steps) ? data.steps : []
    if (!name) {
      json(res, 400, { error: 'El nombre de la secuencia es obligatorio' })
      return true
    }
    if (stepsIn.length === 0) {
      json(res, 400, { error: 'Añade al menos un paso' })
      return true
    }
    const id = String(data.id || `seq_${randomUUID().slice(0, 8)}`)
    const seq: SequenceDefinition = {
      id,
      name,
      isActive: data.isActive !== false,
      steps: stepsIn.map((s: any, index: number) => ({
        id: String(s.id || `step_${index + 1}_${randomUUID().slice(0, 6)}`),
        stepOrder: index + 1,
        delayMinutes: Math.max(0, Math.floor(Number(s.delayMinutes) || 0)),
        messageText: String(s.messageText || '').slice(0, 4096),
        ...(s.flowId ? { flowId: String(s.flowId) } : {}),
      })),
    }
    ctx.engine.saveSequence(orgId, seq)
    audit(ctx, { action: 'sequence.save', subject: id, detail: { name, steps: seq.steps.length, isActive: seq.isActive } })
    json(res, 200, { ok: true, id, name, steps: seq.steps.length })
    return true
  }

  const seqStart = route.match(/^\/sequences\/([^/]+)\/(enroll|cancel|toggle)$/)
  if (seqStart && method === 'POST') {
    const sequenceId = decodeURIComponent(seqStart[1])
    const action = seqStart[2]
    if (action === 'toggle' && !isAdmin) return denied('activar o desactivar secuencias')
    const seq = ctx.engine.getSequence(orgId, sequenceId)
    if (!seq) {
      json(res, 404, { error: 'Secuencia no encontrada' })
      return true
    }
    if (action === 'toggle') {
      db.prepare('UPDATE sequences SET is_active = ? WHERE organization_id = ? AND id = ?').run(seq.isActive ? 0 : 1, orgId, sequenceId)
      audit(ctx, { action: 'sequence.toggle', subject: sequenceId, detail: { isActive: !seq.isActive } })
      json(res, 200, { ok: true, isActive: !seq.isActive })
      return true
    }
    const parsed = await readJson(ctx)
    if (!parsed.ok) return true
    const phone = normalizePhone(parsed.data.phone)
    if (!phone) {
      json(res, 400, { error: 'phone es obligatorio (8 a 15 dígitos)' })
      return true
    }
    if (action === 'cancel') {
      ctx.engine.cancelSequenceEnrollment(orgId, phone, sequenceId)
      audit(ctx, { action: 'sequence.cancel', subject: phone, detail: { sequenceId } })
      json(res, 200, { ok: true, status: 'CANCELLED' })
    } else {
      if (ctx.suppression.isSuppressed(orgId, phone)) {
        audit(ctx, { action: 'sequence.enroll', subject: phone, outcome: 'rejected', detail: { sequenceId, reason: 'suppressed' } })
        json(res, 409, { error: 'El contacto está dado de baja: no se inscribe en secuencias.' })
        return true
      }
      ctx.engine.enrollContactInSequence(orgId, phone, sequenceId)
      audit(ctx, { action: 'sequence.enroll', subject: phone, detail: { sequenceId } })
      json(res, 200, { ok: true, status: 'ACTIVE' })
    }
    return true
  }

  // ---------------------------------------------------------------- difusiones
  if (route === '/broadcasts' && method === 'GET') {
    const rows = db.prepare(`
      SELECT id, event_key, action, status, detail, created_at FROM automation_events
      WHERE organization_id = ? AND stage = 'broadcast' ORDER BY created_at DESC LIMIT 50
    `).all(orgId)
    json(res, 200, { broadcasts: rows })
    return true
  }

  if (route === '/broadcast' && method === 'POST') {
    if (!isAdmin) return denied('enviar difusiones')
    const parsed = await readJson(ctx)
    if (!parsed.ok) return true
    const text = String(parsed.data.text || '').trim()
    const tag = String(parsed.data.tag || '').trim()
    if (!text) {
      json(res, 400, { error: 'El mensaje está vacío' })
      return true
    }
    if (text.length > 1024) {
      json(res, 400, { error: 'Mensaje demasiado largo (máx. 1024)' })
      return true
    }
    const audience = buildContactIndex(db, orgId).filter((c) => (tag ? c.tags.includes(tag) : true))
    const skippedSuppressed = audience.filter((c) => c.suppressed).length
    const recipients = audience.filter((c) => !c.suppressed).slice(0, DASHBOARD_LIMITS.maxRecipients)
    if (parsed.data.dryRun === true) {
      audit(ctx, { action: 'broadcast.preview', outcome: 'dry-run', detail: { tag: tag || null, audience: audience.length, recipients: recipients.length } })
      json(res, 200, { ok: true, dryRun: true, audience: audience.length, recipients: recipients.length, skippedSuppressed })
      return true
    }
    // Un envío masivo se confirma a propósito: sin `confirm: true` no sale nada.
    if (parsed.data.confirm !== true) {
      audit(ctx, { action: 'broadcast.send', outcome: 'rejected', detail: { reason: 'sin confirmación', tag: tag || null } })
      json(res, 400, {
        error: 'Falta la confirmación: repite la petición con confirm: true y el resultado del cálculo de audiencia.',
        code: 'CONFIRM_REQUIRED',
        audience: audience.length,
        recipients: recipients.length,
      })
      return true
    }
    const gate = broadcastLimiter.check(`broadcast:${orgId}`, DASHBOARD_LIMITS.broadcastsPerHour, 3_600_000)
    if (!gate.allowed) {
      audit(ctx, { action: 'broadcast.send', outcome: 'rejected', detail: { reason: 'rate_limited' } })
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(gate.retryAfterSec) })
      res.end(JSON.stringify({ error: `Demasiadas difusiones por hora. Espera ${Math.ceil(gate.retryAfterSec / 60)} min.` }))
      return true
    }
    const eventId = `broadcast_${randomUUID()}`
    let sent = 0
    let rejected = 0
    let uncertain = 0
    const failures: Array<{ phone: string; error: string }> = []
    for (const contact of recipients) {
      const correlationId = `${eventId}:${contact.phone}`
      try {
        const result = await ctx.transport.sendMessage(contact.phone, text, correlationId, correlationId, orgId)
        if (result.ok) {
          sent++
          db.prepare(`
            INSERT INTO inbox_messages (id, organization_id, contact_phone, direction, text, created_at)
            VALUES (?, ?, ?, 'outbound', ?, ?)
          `).run(`out_${randomUUID()}`, orgId, contact.phone, text, Date.now())
        } else if ((result.outcome || 'UNCERTAIN') === 'REJECTED') {
          rejected++
          if (failures.length < 10) failures.push({ phone: contact.phone, error: result.error || 'REJECTED' })
        } else {
          uncertain++
          if (failures.length < 10) failures.push({ phone: contact.phone, error: result.error || 'UNCERTAIN' })
        }
      } catch (e: any) {
        uncertain++
        if (failures.length < 10) failures.push({ phone: contact.phone, error: e?.message || 'error de transporte' })
      }
    }
    const status = sent === recipients.length && recipients.length > 0 ? 'SENT' : sent > 0 ? 'PARTIAL' : 'REJECTED'
    db.prepare(`
      INSERT INTO automation_events (id, organization_id, event_key, stage, action, status, detail, message_id, created_at)
      VALUES (?, ?, ?, 'broadcast', 'send_message', ?, ?, ?, ?)
    `).run(
      `evt_${randomUUID()}`,
      orgId,
      eventId,
      status,
      JSON.stringify({ text: text.slice(0, 500), tag: tag || null, audience: audience.length, recipients: recipients.length, sent, rejected, uncertain, skippedSuppressed, failures }),
      null,
      Date.now()
    )
    audit(ctx, {
      action: 'broadcast.send',
      outcome: status === 'REJECTED' ? 'rejected' : 'ok',
      detail: { eventId, tag: tag || null, audience: audience.length, recipients: recipients.length, sent, rejected, uncertain, skippedSuppressed },
    })
    json(res, 200, { ok: true, eventId, status, audience: audience.length, recipients: recipients.length, sent, rejected, uncertain, skippedSuppressed, failures })
    return true
  }

  // ---------------------------------------------------------------- reglas
  if (route === '/rules' && (method === 'GET' || method === 'POST')) {
    if (method === 'GET') {
      const rows = db.prepare('SELECT * FROM automation_rules WHERE organization_id = ? ORDER BY created_at').all(orgId)
      json(res, 200, { rules: rows })
      return true
    }
    const parsed = await readJson(ctx)
    if (!parsed.ok) return true
    if (!isAdmin) return denied('editar reglas de automatización')
    const { stage, action, templateMessage, targetFlowId, targetSequenceId } = parsed.data
    if (!stage || !action) {
      json(res, 400, { error: 'stage y action son obligatorios' })
      return true
    }
    if (!['send_message', 'start_flow', 'enroll_sequence'].includes(String(action))) {
      json(res, 400, { error: 'action debe ser send_message, start_flow o enroll_sequence' })
      return true
    }
    const enabled = parsed.data.enabled === false ? 0 : 1
    db.prepare(`
      INSERT INTO automation_rules (id, organization_id, stage, action, template_message, target_flow_id, target_sequence_id, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, stage) DO UPDATE SET
        action = excluded.action,
        template_message = excluded.template_message,
        target_flow_id = excluded.target_flow_id,
        target_sequence_id = excluded.target_sequence_id,
        enabled = excluded.enabled
    `).run(
      `rule_${randomUUID().slice(0, 10)}`, orgId, String(stage), String(action),
      templateMessage ? String(templateMessage) : null,
      targetFlowId ? String(targetFlowId) : null,
      targetSequenceId ? String(targetSequenceId) : null,
      enabled, Math.floor(Date.now() / 1000)
    )
    audit(ctx, { action: 'rule.save', subject: String(stage), detail: { action: String(action), enabled: Boolean(enabled) } })
    json(res, 200, { ok: true })
    return true
  }

  const ruleMatch = route.match(/^\/rules\/([^/]+)$/)
  if (ruleMatch && method === 'DELETE') {
    if (!isAdmin) return denied('borrar reglas de automatización')
    db.prepare('DELETE FROM automation_rules WHERE organization_id = ? AND id = ?').run(orgId, decodeURIComponent(ruleMatch[1]))
    audit(ctx, { action: 'rule.delete', subject: decodeURIComponent(ruleMatch[1]) })
    json(res, 200, { ok: true })
    return true
  }

  // ---------------------------------------------------------------- ajustes
  if (route === '/settings' && method === 'GET') {
    const flowList = ctx.engine.listFlows(orgId).map((f) => ({ id: f.id, name: f.name, isActive: f.isActive }))
    const transports = {
      mode: process.env.TRANSPORT || 'mock',
      realDispatch: process.env.ALLOW_REAL_DISPATCH === 'true',
      paymentsMode: process.env.PAYMENTS_MODE || 'simulator',
      webhookConfigured: Boolean(process.env.AGENTIC_2A_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET),
      qrAvailable: true,
    }
    json(res, 200, {
      org: orgId,
      transports,
      agents: ctx.team.getActiveAgents(orgId),
      canned: ctx.canned.listAll(orgId),
      flows: flowList,
      counts: {
        contacts: buildContactIndex(db, orgId).length,
        suppressed: count(db, 'SELECT COUNT(*) AS n FROM suppression_list WHERE organization_id = ?', orgId),
        sequences: count(db, 'SELECT COUNT(*) AS n FROM sequences WHERE organization_id = ?', orgId),
      },
    })
    return true
  }

  if (route === '/growth' && method === 'GET') {
    const rows = db.prepare('SELECT * FROM growth_links WHERE organization_id = ? ORDER BY created_at DESC').all(orgId)
    json(res, 200, { links: rows })
    return true
  }

  if (route === '/growth' && method === 'POST') {
    if (!isAdmin) return denied('crear enlaces de crecimiento')
    const parsed = await readJson(ctx)
    if (!parsed.ok) return true
    try {
      const link = ctx.growth.createGrowthLink(orgId, {
        slug: String(parsed.data.slug || ''),
        targetFlowId: parsed.data.targetFlowId ? String(parsed.data.targetFlowId) : undefined,
        initialTag: parsed.data.initialTag ? String(parsed.data.initialTag) : undefined,
        prefilledText: String(parsed.data.prefilledText || 'Hola, vengo de un enlace'),
      })
      audit(ctx, { action: 'growth.link.create', subject: String((link as any)?.slug || parsed.data.slug || '') })
      json(res, 200, { ok: true, link })
    } catch (e: any) {
      json(res, 400, { error: 'No se pudo crear el enlace (revisa el slug)' })
    }
    return true
  }

  json(res, 404, { error: 'Ruta del panel no encontrada' })
  return true
}
