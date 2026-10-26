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

export class PaymentGatewayManager {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  createPaymentLink(opts: CreatePaymentOptions): PaymentTransaction {
    const id = `tx_${randomUUID().substring(0, 8)}`
    const now = Math.floor(Date.now() / 1000)
    const currency = opts.currency || 'COP'
    const gateway = opts.gateway || 'simulator'

    // Generar URL de checkout según pasarela
    let paymentLink = ''
    if (gateway === 'simulator') {
      paymentLink = `https://checkout.albra.co/pay/${id}?amount=${opts.amount}&currency=${currency}`
    } else if (gateway === 'wompi') {
      paymentLink = `https://checkout.wompi.co/p/?public-key=pub_test_123&currency=${currency}&amount-in-cents=${opts.amount * 100}&reference=${id}`
    } else if (gateway === 'mercadopago') {
      paymentLink = `https://mpago.la/pos/${id}`
    } else if (gateway === 'stripe') {
      paymentLink = `https://buy.stripe.com/test_${id}`
    }

    this.db.prepare(`
      INSERT INTO payment_transactions (id, contact_phone, amount, currency, description, gateway, payment_link, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
    `).run(id, opts.contactPhone, opts.amount, currency, opts.description, gateway, paymentLink, now, now)

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

  handlePaymentWebhook(transactionId: string, status: 'APPROVED' | 'REJECTED'): PaymentTransaction | null {
    const tx = this.getTransaction(transactionId)
    if (!tx) return null

    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(`
      UPDATE payment_transactions
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(status, now, transactionId)

    if (status === 'APPROVED') {
      // Etiquetar contacto como CLIENTE_PAGADO
      this.db.prepare(`
        INSERT OR REPLACE INTO contact_tags (contact_phone, tag_name, created_at)
        VALUES (?, 'CLIENTE_PAGADO', ?)
      `).run(tx.contactPhone, now)
    }

    return this.getTransaction(transactionId)
  }
}
