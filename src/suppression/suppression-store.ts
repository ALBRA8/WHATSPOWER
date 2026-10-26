import { DatabaseSync } from 'node:sqlite'

const OPT_OUT_KEYWORDS = ['baja', 'salir', 'stop', 'cancelar', 'no deseo mas mensajes', 'no enviar mas']

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
   * Registra un contacto en la lista de supresión permanente.
   */
  addSuppression(phone: string, reason: string): void {
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(`
      INSERT INTO suppression_list (phone, reason, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        reason = excluded.reason,
        created_at = excluded.created_at
    `).run(phone, reason, now)
  }

  /**
   * Comprueba si un teléfono se encuentra revocado/suprimido.
   */
  isSuppressed(phone: string): boolean {
    const row = this.db.prepare('SELECT phone FROM suppression_list WHERE phone = ?').get(phone)
    return Boolean(row)
  }

  /**
   * Permite re-activar a un contacto si éste solicita explícitamente volver a recibir información.
   */
  removeSuppression(phone: string): void {
    this.db.prepare('DELETE FROM suppression_list WHERE phone = ?').run(phone)
  }
}
