import { DatabaseSync } from 'node:sqlite'
import type { ConsentStore } from '../safety/consent-store.ts'

const OPT_OUT_KEYWORDS = ['baja', 'salir', 'stop', 'cancelar', 'no deseo mas mensajes', 'no enviar mas']

/**
 * SuppressionStore — lista de supresión POR ORGANIZACIÓN.
 * (segunda reparación §3.A) La PK es (organization_id, phone): la baja de un
 * contacto en una organización NO silencia ese número en otra organización
 * (son relaciones comerciales independientes).
 */
export class SuppressionStore {
  db: DatabaseSync
  consentStore?: ConsentStore
  constructor(db: DatabaseSync, consentStore?: ConsentStore) {
    this.db = db
    this.consentStore = consentStore
  }

  /**
   * Evalúa si el texto contiene una palabra clave formal de baja/opt-out.
   */
  isOptOutKeyword(text: string): boolean {
    const clean = text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    return OPT_OUT_KEYWORDS.some((kw) => {
      const regex = new RegExp(`(^|\\s|\\b)${kw}(\\b|\\s|$)`, 'i')
      return regex.test(clean)
    })
  }

  /**
   * Registra un contacto en la lista de supresión permanente DE SU ORGANIZACIÓN.
   * Revoca el consentimiento activo y registra la auditoría (Ley 1581 / Habeas Data).
   */
  addSuppression(orgId: string, phone: string, reason: string): void {
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(`
      INSERT INTO suppression_list (organization_id, phone, reason, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(organization_id, phone) DO UPDATE SET
        reason = excluded.reason,
        created_at = excluded.created_at
    `).run(orgId, phone, reason, now)

    if (this.consentStore) {
      try {
        this.consentStore.revokeConsent(orgId, phone, `Baja / Opt-out: ${reason}`, 'suppression_service')
      } catch (err) {
        console.warn('[SuppressionStore] No se pudo revocar consentimiento al procesar baja:', err)
      }
    }
  }

  /**
   * Comprueba si un teléfono está suprimido PARA una organización concreta.
   */
  isSuppressed(orgId: string, phone: string): boolean {
    const row = this.db.prepare('SELECT phone FROM suppression_list WHERE organization_id = ? AND phone = ?').get(orgId, phone)
    return Boolean(row)
  }

  /**
   * Re-activa a un contacto SOLO para la organización que lo pide.
   */
  removeSuppression(orgId: string, phone: string): void {
    this.db.prepare('DELETE FROM suppression_list WHERE organization_id = ? AND phone = ?').run(orgId, phone)
  }
}
