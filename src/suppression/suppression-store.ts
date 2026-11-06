import { DatabaseSync } from 'node:sqlite'

const OPT_OUT_KEYWORDS = ['baja', 'salir', 'stop', 'cancelar', 'no deseo mas mensajes', 'no enviar mas']

/**
 * SuppressionStore multi-organización (contrato v1.1.0 §9): la lista de supresión
 * es propiedad de la organización. Un teléfono suprimido en la org A puede estar
 * activo en la org B (dos negocios distintos pueden legítimamente contactarle).
 */
export class SuppressionStore {
  db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
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
   * Registra un contacto en la lista de supresión permanente de la organización.
   */
  addSuppression(phone: string, reason: string, orgId: string): void {
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(`
      INSERT INTO suppression_list (organization_id, phone, reason, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(organization_id, phone) DO UPDATE SET
        reason = excluded.reason,
        created_at = excluded.created_at
    `).run(orgId, phone, reason, now)
  }

  /**
   * Comprueba si un teléfono se encuentra revocado/suprimido PARA la organización.
   */
  isSuppressed(phone: string, orgId: string): boolean {
    const row = this.db.prepare('SELECT phone FROM suppression_list WHERE organization_id = ? AND phone = ?').get(orgId, phone)
    return Boolean(row)
  }

  /**
   * Permite re-activar a un contacto si éste solicita explícitamente volver a recibir información.
   * Solo afecta a la organización propietaria de la supresión.
   */
  removeSuppression(phone: string, orgId: string): void {
    this.db.prepare('DELETE FROM suppression_list WHERE organization_id = ? AND phone = ?').run(orgId, phone)
  }
}
