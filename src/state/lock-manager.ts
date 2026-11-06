import { DatabaseSync } from 'node:sqlite'
import type { ConversationLock, ConversationState } from '../types.ts'

export const LOCK_TTL_SECONDS = 900 // 15 minutos de inactividad

/**
 * LockManager multi-organización (contrato v1.1.0 §9): el lock es propiedad de la
 * organización. Un teléfono compartido entre dos organizaciones NO comparte estado:
 * cada org gestiona su propio lock (fila independiente por (organization_id, phone)).
 */
export class LockManager {
  db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
  }

  /**
   * Adquisición atómica de lock con verificación de TTL, scoped por organización.
   */
  acquireLock(phone: string, orgId: string, correlationId: string): { acquired: boolean; state: ConversationState; reason?: string } {
    const now = Math.floor(Date.now() / 1000)
    const expiresAt = now + LOCK_TTL_SECONDS

    const stmtSelect = this.db.prepare('SELECT contact_phone, organization_id, current_state, locked_at, expires_at, correlation_id FROM conversation_locks WHERE organization_id = ? AND contact_phone = ?')
    const existing = stmtSelect.get(orgId, phone) as {
      contact_phone: string
      organization_id: string
      current_state: string
      locked_at: number
      expires_at: number
      correlation_id: string
    } | undefined

    if (existing) {
      // Si el contacto está en handoff humano, el lock está bloqueado estrictamente
      if (existing.current_state === 'HANDOFF_HUMAN') {
        return { acquired: false, state: 'HANDOFF_HUMAN', reason: 'Contacto en atención humana exclusiva' }
      }

      // Si el lock aún está activo y no ha expirado
      if (existing.expires_at > now) {
        // Mismo flujo activo: extendemos el TTL
        this.db.prepare('UPDATE conversation_locks SET expires_at = ?, correlation_id = ? WHERE organization_id = ? AND contact_phone = ?').run(expiresAt, correlationId, orgId, phone)
        return { acquired: true, state: 'IN_FLOW_2A' }
      }

      // Si el lock expiró por TTL, lo reasigna atómicamente
      this.db.prepare('UPDATE conversation_locks SET organization_id = ?, current_state = ?, locked_at = ?, expires_at = ?, correlation_id = ? WHERE organization_id = ? AND contact_phone = ?').run(orgId, 'IN_FLOW_2A', now, expiresAt, correlationId, orgId, phone)
      return { acquired: true, state: 'IN_FLOW_2A' }
    }

    // Nuevo lock (independiente por organización)
    this.db.prepare('INSERT INTO conversation_locks (organization_id, contact_phone, current_state, locked_at, expires_at, correlation_id) VALUES (?, ?, ?, ?, ?, ?)').run(orgId, phone, 'IN_FLOW_2A', now, expiresAt, correlationId)
    return { acquired: true, state: 'IN_FLOW_2A' }
  }

  /**
   * Pasa el lock a estado de atención humana exclusiva.
   */
  setHandoff(phone: string, orgId: string, correlationId: string): void {
    const now = Math.floor(Date.now() / 1000)
    // En handoff el TTL es prolongado (24 horas) o indefinido hasta que el asesor cierre la conversación en el CRM
    const expiresAt = now + 86400
    this.db.prepare(`
      INSERT INTO conversation_locks (organization_id, contact_phone, current_state, locked_at, expires_at, correlation_id)
      VALUES (?, ?, ?, 'HANDOFF_HUMAN', ?, ?)
      ON CONFLICT(organization_id, contact_phone) DO UPDATE SET
        current_state = 'HANDOFF_HUMAN',
        locked_at = excluded.locked_at,
        expires_at = excluded.expires_at,
        correlation_id = excluded.correlation_id
    `).run(orgId, phone, now, expiresAt, correlationId)
  }

  /**
   * Libera el lock de un contacto tras finalizar el flujo o resolución del asesor.
   * Solo afecta a la organización propietaria.
   */
  releaseLock(phone: string, orgId: string): void {
    this.db.prepare('DELETE FROM conversation_locks WHERE organization_id = ? AND contact_phone = ?').run(orgId, phone)
  }

  /**
   * Consulta el lock de un teléfono para una organización (coordinación con Capa 2B).
   * Un lock de OTRA organización es invisible (sin oráculo: responde como libre).
   */
  getLock(phone: string, orgId: string): ConversationLock | null {
    const now = Math.floor(Date.now() / 1000)
    const row = this.db.prepare('SELECT contact_phone, organization_id, current_state, locked_at, expires_at, correlation_id FROM conversation_locks WHERE organization_id = ? AND contact_phone = ?').get(orgId, phone) as any

    if (!row) return null

    // Si expiró por TTL y no es HANDOFF_HUMAN, se considera libre
    if (row.current_state !== 'HANDOFF_HUMAN' && row.expires_at <= now) {
      this.releaseLock(phone, orgId)
      return null
    }

    return {
      contactPhone: row.contact_phone,
      organizationId: row.organization_id,
      currentState: row.current_state as ConversationState,
      lockedAt: row.locked_at,
      expiresAt: row.expires_at,
      correlationId: row.correlation_id,
    }
  }
}
