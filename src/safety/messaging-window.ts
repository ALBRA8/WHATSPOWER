/**
 * messaging-window.ts — Gestión y verificación de la ventana de servicio de 24 horas de WhatsApp.
 * Fuera de la ventana de 24h, Meta prohíbe el envío de mensajes libres (solo plantillas aprobadas).
 */
import type { Database } from 'node:sqlite'

export class MessagingWindowStore {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.ensureSchema()
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customer_messaging_windows (
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        last_inbound_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, contact_phone)
      );
    `)
  }

  /**
   * Registra un mensaje entrante de un contacto (cliente), abriendo la ventana de 24 horas.
   */
  recordCustomerInbound(organizationId: string, contactPhone: string, timestamp: number = Date.now()): void {
    const cleanPhone = contactPhone.replace(/\D/g, '')
    const stmt = this.db.prepare(`
      INSERT INTO customer_messaging_windows (organization_id, contact_phone, last_inbound_at)
      VALUES (?, ?, ?)
      ON CONFLICT(organization_id, contact_phone) DO UPDATE SET
        last_inbound_at = excluded.last_inbound_at
    `)
    stmt.run(organizationId, cleanPhone, timestamp)
  }

  /**
   * Devuelve el timestamp del último mensaje entrante del contacto, o null si nunca ha escrito.
   */
  getLastInboundAt(organizationId: string, contactPhone: string): number | null {
    const cleanPhone = contactPhone.replace(/\D/g, '')
    const stmt = this.db.prepare(`
      SELECT last_inbound_at FROM customer_messaging_windows
      WHERE organization_id = ? AND contact_phone = ?
    `)
    const row = stmt.get(organizationId, cleanPhone) as { last_inbound_at: number } | undefined
    return row ? row.last_inbound_at : null
  }

  /**
   * Determina si la conversación se encuentra dentro de la ventana de 24 horas (Meta Customer Care Window).
   * Meta exige: <= 24 horas desde el último mensaje del cliente.
   */
  isInside24hWindow(organizationId: string, contactPhone: string, now: number = Date.now()): boolean {
    const lastInbound = this.getLastInboundAt(organizationId, contactPhone)
    if (!lastInbound) return false
    const diff = now - lastInbound
    return diff >= 0 && diff <= 24 * 60 * 60 * 1000
  }
}
