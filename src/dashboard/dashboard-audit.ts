/**
 * dashboard-audit.ts — rastro de auditoría de las acciones del panel.
 *
 * Por qué existe: el resto del sistema audita por consola (supresión, reenvíos),
 * pero el panel mueve cosas delicadas (responder a un cliente, difundir a cientos,
 * sacar a alguien de la lista de bajas, tomar el control de una conversación).
 * Sin registro no hay forma de saber quién hizo qué ni cuándo.
 *
 * Reglas:
 *   - Cada fila lleva organización, actor (operador central o credencial de
 *     organización + rol), acción, sujeto (teléfono ENMASCARADO), resultado e IP.
 *   - Nunca guarda el cuerpo del mensaje: solo su longitud y, si procede, un
 *     recorte para las difusiones (que ya se guardaba en automation_events).
 *   - Escribir auditoría NUNCA puede tumbar la petición: cualquier fallo se
 *     registra por consola y se sigue adelante.
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { clientIp, maskPhone } from '../security.ts'
import type { IncomingMessage } from 'node:http'

export type AuditRole = 'admin' | 'agent'

export interface AuditActor {
  /** Etiqueta legible: "operador" o la organización de la credencial. */
  label: string
  role: AuditRole
}

export interface AuditEntry {
  action: string
  subject?: string | null
  outcome?: 'ok' | 'rejected' | 'denied' | 'error' | 'dry-run'
  detail?: unknown
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS dashboard_audit (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    action TEXT NOT NULL,
    subject TEXT,
    outcome TEXT NOT NULL,
    detail TEXT,
    ip TEXT,
    created_at INTEGER NOT NULL
  )
`

const CREATE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_dashboard_audit_org
  ON dashboard_audit (organization_id, created_at DESC)
`

/** Se prepara una vez por CADA base de datos (las pruebas usan varias en memoria). */
const prepared = new WeakSet<object>()

/** Crea la tabla una sola vez por base. Idempotente y silenciosa. */
export function ensureDashboardAuditTable(db: DatabaseSync): void {
  if (prepared.has(db)) return
  try {
    db.exec(CREATE_TABLE)
    db.exec(CREATE_INDEX)
    prepared.add(db)
  } catch (e: any) {
    console.warn(`[Panel AUDIT] No se pudo preparar la tabla de auditoría: ${e?.message || e}`)
  }
}

/** El sujeto se guarda enmascarado: la auditoría no es un listado de teléfonos. */
function subjectOf(subject: string | null | undefined): string | null {
  if (!subject) return null
  return /^\+?\d{6,}$/.test(subject) ? maskPhone(subject) : String(subject).slice(0, 120)
}

/**
 * Anota una acción del panel. Devuelve el id de la fila (o null si falló),
 * pero nunca lanza: la auditoría es un testigo, no un peaje.
 */
export function recordDashboardAudit(
  db: DatabaseSync,
  req: IncomingMessage,
  orgId: string,
  actor: AuditActor,
  entry: AuditEntry,
): string | null {
  try {
    ensureDashboardAuditTable(db)
    const id = `aud_${randomUUID()}`
    db.prepare(`
      INSERT INTO dashboard_audit
        (id, organization_id, actor, actor_role, action, subject, outcome, detail, ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      orgId,
      actor.label,
      actor.role,
      entry.action,
      subjectOf(entry.subject),
      entry.outcome || 'ok',
      entry.detail === undefined ? null : JSON.stringify(entry.detail).slice(0, 4000),
      clientIp(req),
      Date.now(),
    )
    return id
  } catch (e: any) {
    console.warn(`[Panel AUDIT] No se pudo anotar "${entry.action}": ${e?.message || e}`)
    return null
  }
}

export interface AuditRow {
  id: string
  actor: string
  actor_role: string
  action: string
  subject: string | null
  outcome: string
  detail: string | null
  ip: string | null
  created_at: number
}

/** Últimas acciones de la organización, más recientes primero. */
export function listDashboardAudit(
  db: DatabaseSync,
  orgId: string,
  limit = 50,
  offset = 0,
): { entries: AuditRow[]; total: number } {
  ensureDashboardAuditTable(db)
  const rows = db.prepare(`
    SELECT id, actor, actor_role, action, subject, outcome, detail, ip, created_at
    FROM dashboard_audit
    WHERE organization_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(orgId, limit, offset) as unknown as AuditRow[]
  const totalRow = db.prepare('SELECT COUNT(*) AS n FROM dashboard_audit WHERE organization_id = ?').get(orgId) as { n?: number } | undefined
  return { entries: rows, total: Number(totalRow?.n || 0) }
}
