import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

export interface CreatePaymentOptions {
  contactPhone: string
  amount: number
  currency?: string
  description: string
  gateway?: 'wompi' | 'mercadopago' | 'stripe' | 'simulator'
}

export interface PaymentTransaction {
  id: string
  contactPhone: string
  amount: number
  currency: string
  description: string
  gateway: string
  paymentLink: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  createdAt: number
  updatedAt: number
}

/**
 * Evento de webhook de pasarela (contrato v2 — reparación integral 2026-11-06):
 *  - eventId: identificador ÚNICO del evento de la pasarela (idempotencia durable).
 *  - amount/currency/reference: validación contra la transacción si la pasarela
 *    los envía (mismatch → rechazo sin cambio de estado).
 */
export interface PaymentWebhookEvent {
  eventId: string
  transactionId: string
  status: 'APPROVED' | 'REJECTED'
  amount?: number
  currency?: string
  reference?: string
}

export type PaymentWebhookResult =
  | { ok: true; transaction: PaymentTransaction; idempotent?: boolean }
  | { ok: false; code: 'TXN_NOT_FOUND' | 'ILLEGAL_TRANSITION' | 'VALIDATION_MISMATCH' | 'INVALID_EVENT'; message: string }

/** Transiciones legales: solo PENDING es origen; APPROVED/REJECTED son terminales. */
const LEGAL_TRANSITIONS: Record<string, string[]> = {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: [],
  REJECTED: [],
}

export class PaymentGatewayManager {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  createPaymentLink(opts: CreatePaymentOptions): PaymentTransaction {
    // (reparación integral) Validación server-side antes de tocar la BD:
    const amount = Number(opts.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('VALIDATION: amount debe ser un número positivo')
    }
    if (opts.currency && !/^[A-Za-z]{3}$/.test(String(opts.currency))) {
      throw new Error('VALIDATION: currency debe ser un código ISO-4217 de 3 letras')
    }
    if (!opts.contactPhone || String(opts.contactPhone).replace(/\D/g, '').length < 7) {
      throw new Error('VALIDATION: contactPhone inválido')
    }
    const id = `tx_${randomUUID().substring(0, 8)}`
    const now = Math.floor(Date.now() / 1000)
    const currency = opts.currency || 'COP'
    const gateway = opts.gateway || 'simulator'

    // Distinción explícita simulator/sandbox/production (orden §5):
    // el simulador queda bloqueado en producción salvo decisión explícita y audible.
    if (gateway === 'simulator' && process.env.NODE_ENV === 'production' && process.env.PAYMENTS_ALLOW_SIMULATOR !== 'true') {
      throw new Error('PAYMENTS_SIMULATOR_BLOCKED: pasarela simulator rechazada en producción (usa una pasarela real o define PAYMENTS_ALLOW_SIMULATOR=true como decisión explícita)')
    }

    // Generar URL de checkout según pasarela
    let paymentLink = ''
    if (gateway === 'simulator') {
      paymentLink = `https://checkout.albra.co/pay/${id}?amount=${opts.amount}&currency=${currency}`
    } else if (gateway === 'wompi') {
      paymentLink = `https://checkout.wompi.co/p/?public-key=${process.env.WOMPI_PUBLIC_KEY || 'pub_test_123'}&currency=${currency}&amount-in-cents=${opts.amount * 100}&reference=${id}`
    } else if (gateway === 'mercadopago') {
      paymentLink = `https://mpago.la/pos/${id}`
    } else if (gateway === 'stripe') {
      paymentLink = `https://buy.stripe.com/test_${id}`
    }

    this.db.prepare(`
      INSERT INTO payment_transactions (id, contact_phone, amount, currency, description, gateway, payment_link, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
    `).run(id, opts.contactPhone, opts.amount, currency, opts.description, gateway, paymentLink, now, now)

    this.audit(id, null, 'PENDING', 'PAYMENT_LINK_CREATED', null)

    return {
      id,
      contactPhone: opts.contactPhone,
      amount: opts.amount,
      currency,
      description: opts.description,
      gateway,
      paymentLink,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    }
  }

  getTransaction(id: string): PaymentTransaction | null {
    const row = this.db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(id) as any
    if (!row) return null
    return {
      id: row.id,
      contactPhone: row.contact_phone,
      amount: row.amount,
      currency: row.currency,
      description: row.description,
      gateway: row.gateway,
      paymentLink: row.payment_link,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private audit(txId: string | null, fromStatus: string | null, toStatus: string, action: string, eventId: string | null): void {
    this.db.prepare(`
      INSERT INTO payment_audit (id, transaction_id, from_status, to_status, action, event_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`aud_${randomUUID().substring(0, 12)}`, txId, fromStatus, toStatus, action, eventId, Math.floor(Date.now() / 1000))
  }

  /**
   * Procesa un evento de webhook de pasarela con contrato duro (reparación integral):
   *  - Idempotencia DURABLE por eventId (payment_webhook_events UNIQUE) — repele
   *    re-entregas y sobrevive reinicios; eventos repetidos no re-ejecutan efectos.
   *  - Validación amount/currency/reference contra la transacción (mismatch → rechazo).
   *  - Máquina de estados legal (solo PENDING→APPROVED|REJECTED; terminales inmutables).
   *  - Auditoría de cada intento y cada transición.
   */
  handlePaymentWebhook(event: PaymentWebhookEvent): PaymentWebhookResult {
    if (!event || typeof event.transactionId !== 'string' || !event.transactionId
      || (event.status !== 'APPROVED' && event.status !== 'REJECTED')
      || typeof event.eventId !== 'string' || !event.eventId) {
      return { ok: false, code: 'INVALID_EVENT', message: 'El evento exige eventId, transactionId y status APPROVED|REJECTED' }
    }

    const tx = this.getTransaction(event.transactionId)
    if (!tx) {
      this.audit(null, null, 'UNKNOWN', 'WEBHOOK_TXN_NOT_FOUND', event.eventId)
      return { ok: false, code: 'TXN_NOT_FOUND', message: 'Transacción no encontrada' }
    }

    // Idempotencia durable por eventId: re-entrega del MISMO evento → éxito sin efectos.
    try {
      this.db.prepare(`
        INSERT INTO payment_webhook_events (event_id, transaction_id, status, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(event.eventId, event.transactionId, event.status, JSON.stringify(event), Math.floor(Date.now() / 1000))
    } catch {
      const seen = this.db.prepare('SELECT transaction_id, status FROM payment_webhook_events WHERE event_id = ?').get(event.eventId) as any
      const sameEvent = seen && seen.transaction_id === event.transactionId && seen.status === event.status
      this.audit(event.transactionId, tx.status, tx.status, sameEvent ? 'WEBHOOK_DUPLICATE_IGNORED' : 'WEBHOOK_EVENT_ID_COLLISION', event.eventId)
      if (sameEvent) {
        return { ok: true, transaction: tx, idempotent: true }
      }
      return { ok: false, code: 'INVALID_EVENT', message: 'eventId ya registrado para otra transacción/estado (posible fraude)' }
    }

    // Validación de monto/moneda/referencia contra la transacción almacenada
    if (event.amount !== undefined && Number(event.amount) !== tx.amount) {
      this.audit(tx.id, tx.status, tx.status, 'WEBHOOK_AMOUNT_MISMATCH', event.eventId)
      return { ok: false, code: 'VALIDATION_MISMATCH', message: `amount ${event.amount} no coincide con la transacción (${tx.amount})` }
    }
    if (event.currency !== undefined && String(event.currency).toUpperCase() !== tx.currency.toUpperCase()) {
      this.audit(tx.id, tx.status, tx.status, 'WEBHOOK_CURRENCY_MISMATCH', event.eventId)
      return { ok: false, code: 'VALIDATION_MISMATCH', message: `currency ${event.currency} no coincide con la transacción (${tx.currency})` }
    }
    if (event.reference !== undefined && String(event.reference) !== tx.id) {
      this.audit(tx.id, tx.status, tx.status, 'WEBHOOK_REFERENCE_MISMATCH', event.eventId)
      return { ok: false, code: 'VALIDATION_MISMATCH', message: 'reference no corresponde a esta transacción' }
    }

    // Máquina de estados legal
    const allowed = LEGAL_TRANSITIONS[tx.status] || []
    if (!allowed.includes(event.status)) {
      this.audit(tx.id, tx.status, tx.status, `WEBHOOK_ILLEGAL_TRANSITION_TO_${event.status}`, event.eventId)
      return { ok: false, code: 'ILLEGAL_TRANSITION', message: `transición ${tx.status} → ${event.status} no permitida (estado terminal o ilegal)` }
    }

    // (reparación integral) Transición ATÓMICA: transacción explícita + verificación
    // de changes. Si otra réplica ganó la carrera, se relee el estado y se responde 409
    // (la traza de dinero jamás miente).
    const now = Math.floor(Date.now() / 1000)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const upd = this.db.prepare(`
        UPDATE payment_transactions
        SET status = ?, updated_at = ?
        WHERE id = ? AND status = 'PENDING'
      `).run(event.status, now, event.transactionId)

      if (Number(upd.changes) !== 1) {
        this.db.exec('ROLLBACK')
        const current = this.getTransaction(event.transactionId)!
        this.audit(tx.id, tx.status, current.status, 'WEBHOOK_RACE_LOST', event.eventId)
        return { ok: false, code: 'ILLEGAL_TRANSITION', message: `transición ${tx.status} → ${event.status} no aplicada (estado actual: ${current.status})` }
      }

      this.audit(tx.id, 'PENDING', event.status, `WEBHOOK_TRANSITION_TO_${event.status}`, event.eventId)

      if (event.status === 'APPROVED') {
        // Etiquetar contacto como CLIENTE_PAGADO
        this.db.prepare(`
          INSERT OR REPLACE INTO contact_tags (contact_phone, tag_name, created_at)
          VALUES (?, 'CLIENTE_PAGADO', ?)
        `).run(tx.contactPhone, now)
      }

      this.db.exec('COMMIT')
    } catch (e) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw e
    }

    return { ok: true, transaction: this.getTransaction(event.transactionId)! }
  }

  /** Eventos de webhook procesados (trazabilidad de idempotencia). */
  listWebhookEvents(transactionId?: string): Array<{ eventId: string; transactionId: string; status: string; createdAt: number }> {
    const rows = (transactionId
      ? this.db.prepare('SELECT * FROM payment_webhook_events WHERE transaction_id = ? ORDER BY created_at ASC').all(transactionId)
      : this.db.prepare('SELECT * FROM payment_webhook_events ORDER BY created_at ASC').all()) as any[]
    return rows.map((r) => ({ eventId: r.event_id, transactionId: r.transaction_id, status: r.status, createdAt: r.created_at }))
  }

  /** Pistas de auditoría de pagos. */
  listAudit(transactionId?: string): Array<{ id: string; transactionId: string | null; fromStatus: string | null; toStatus: string; action: string; eventId: string | null; createdAt: number }> {
    const rows = (transactionId
      ? this.db.prepare('SELECT * FROM payment_audit WHERE transaction_id = ? ORDER BY created_at ASC').all(transactionId)
      : this.db.prepare('SELECT * FROM payment_audit ORDER BY created_at ASC').all()) as any[]
    return rows.map((r) => ({ id: r.id, transactionId: r.transaction_id, fromStatus: r.from_status, toStatus: r.to_status, action: r.action, eventId: r.event_id, createdAt: r.created_at }))
  }
}
