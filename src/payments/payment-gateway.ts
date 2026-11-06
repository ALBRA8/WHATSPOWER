import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

export type PaymentsMode = 'simulator' | 'sandbox' | 'production'

export interface CreatePaymentOptions {
  contactPhone: string
  amount: number
  currency?: string
  description: string
  gateway?: 'wompi' | 'mercadopago' | 'stripe' | 'simulator'
}

export interface PaymentTransaction {
  id: string
  organizationId: string
  contactPhone: string
  amount: number
  currency: string
  description: string
  gateway: string
  paymentLink: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  /** Modo de pagos vigente: el simulador JAMÁS se presenta como cobro real (contrato §6). */
  mode: PaymentsMode
  createdAt: number
  updatedAt: number
}

/** Errores tipificados para mapear a códigos HTTP sin filtrar internos. */
export class PaymentError extends Error {
  public code: 'INVALID_STATUS' | 'NOT_FOUND' | 'ILLEGAL_TRANSITION' | 'GATEWAY_NOT_CONFIGURED'

  constructor(code: 'INVALID_STATUS' | 'NOT_FOUND' | 'ILLEGAL_TRANSITION' | 'GATEWAY_NOT_CONFIGURED', message: string) {
    super(message)
    this.code = code
  }
}

const VALID_STATUSES = ['APPROVED', 'REJECTED'] as const
export type WebhookPaymentStatus = (typeof VALID_STATUSES)[number]

/**
 * PaymentGatewayManager (contrato v1.1.0 §6):
 *  - PAYMENTS_MODE=simulator|sandbox|production (obligatoria en producción).
 *  - Transiciones SOLO PENDING → APPROVED | REJECTED (terminales). Otro cambio → 409.
 *  - status fuera de whitelist → 400. Auditoría en payment_audit.
 *  - En modo simulator la pasarela es SIEMPRE el simulador, etiquetado como tal;
 *    en production una pasarela sin credenciales reales configuradas es 503 (fail-closed).
 */
export class PaymentGatewayManager {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  private currentMode(): PaymentsMode {
    const mode = process.env.PAYMENTS_MODE as PaymentsMode | undefined
    if (mode === 'sandbox' || mode === 'production') return mode
    return 'simulator' // por defecto y en desarrollo: simulador explícito
  }

  createPaymentLink(opts: CreatePaymentOptions, orgId: string): PaymentTransaction {
    const id = `tx_${randomUUID().substring(0, 8)}`
    const now = Math.floor(Date.now() / 1000)
    const currency = opts.currency || 'COP'
    const mode = this.currentMode()
    let gateway: CreatePaymentOptions['gateway'] = opts.gateway || 'simulator'

    // Modo SIMULADOR: jamás se generan enlaces de pasarelas reales (ni de prueba
    // presentados como cobros). Todo pasa por el simulador etiquetado.
    if (mode === 'simulator') {
      gateway = 'simulator'
    }

    // Generar URL de checkout según pasarela y modo
    let paymentLink = ''
    if (gateway === 'simulator') {
      paymentLink = `https://checkout.albra.co/simulator/pay/${id}?amount=${opts.amount}&currency=${currency}`
    } else if (gateway === 'wompi') {
      // Clave pública REAL obligatoria en modo production (fail-closed: sin ella, 503).
      const publicKey = process.env.WOMPI_PUBLIC_KEY
      if (mode === 'production' && !publicKey) {
        throw new PaymentError('GATEWAY_NOT_CONFIGURED', 'Pasarela wompi no configurada para modo production (fail-closed)')
      }
      const keyPrefix = mode === 'production' ? 'pub_prod' : 'pub_test'
      paymentLink = `https://checkout.wompi.co/p/?public-key=${publicKey || `${keyPrefix}_sandbox_not_configured`}&currency=${currency}&amount-in-cents=${opts.amount * 100}&reference=${id}`
    } else if (gateway === 'mercadopago') {
      if (mode === 'production' && !process.env.MERCADOPAGO_ACCESS_TOKEN) {
        throw new PaymentError('GATEWAY_NOT_CONFIGURED', 'Pasarela mercadopago no configurada para modo production (fail-closed)')
      }
      paymentLink = `https://mpago.la/pos/${id}`
    } else if (gateway === 'stripe') {
      if (mode === 'production' && !process.env.STRIPE_SECRET_KEY) {
        throw new PaymentError('GATEWAY_NOT_CONFIGURED', 'Pasarela stripe no configurada para modo production (fail-closed)')
      }
      const prefix = mode === 'production' ? 'live' : 'test'
      paymentLink = `https://buy.stripe.com/${prefix}_${id}`
    }

    this.db.prepare(`
      INSERT INTO payment_transactions (id, organization_id, contact_phone, amount, currency, description, gateway, payment_link, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
    `).run(id, orgId, opts.contactPhone, opts.amount, currency, opts.description, gateway, paymentLink, now, now)

    return {
      id,
      organizationId: orgId,
      contactPhone: opts.contactPhone,
      amount: opts.amount,
      currency,
      description: opts.description,
      gateway,
      paymentLink,
      status: 'PENDING',
      mode,
      createdAt: now,
      updatedAt: now,
    }
  }

  getTransaction(id: string, orgId: string): PaymentTransaction | null {
    const row = this.db.prepare('SELECT * FROM payment_transactions WHERE id = ? AND organization_id = ?').get(id, orgId) as any
    if (!row) return null
    return {
      id: row.id,
      organizationId: row.organization_id,
      contactPhone: row.contact_phone,
      amount: row.amount,
      currency: row.currency,
      description: row.description,
      gateway: row.gateway,
      paymentLink: row.payment_link,
      status: row.status,
      mode: this.currentMode(),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Webhook de la pasarela. Máquina de estados estricta:
   *  - status fuera de {APPROVED, REJECTED} → PaymentError INVALID_STATUS (400).
   *  - Transacción inexistente PARA la organización → PaymentError NOT_FOUND (404, sin oráculo).
   *  - Transición desde estado terminal (o repetida) → PaymentError ILLEGAL_TRANSITION (409).
   *  - Transición válida protegida con guard condicional WHERE status='PENDING' (changes check).
   *  - Toda transición queda registrada en payment_audit.
   */
  handlePaymentWebhook(transactionId: string, status: string, orgId: string): PaymentTransaction {
    if (!VALID_STATUSES.includes(status as WebhookPaymentStatus)) {
      throw new PaymentError('INVALID_STATUS', 'status fuera de la whitelist de transiciones válidas')
    }

    const tx = this.getTransaction(transactionId, orgId)
    if (!tx) throw new PaymentError('NOT_FOUND', 'transacción no encontrada')

    if (tx.status !== 'PENDING') {
      // PENDING → APPROVED|REJECTED son las únicas transiciones; los terminales son intocables.
      throw new PaymentError('ILLEGAL_TRANSITION', `transición ilegal: ${tx.status} → ${status}`)
    }

    const now = Math.floor(Date.now() / 1000)
    const res = this.db.prepare(`
      UPDATE payment_transactions
      SET status = ?, updated_at = ?
      WHERE id = ? AND organization_id = ? AND status = 'PENDING'
    `).run(status, now, transactionId, orgId)

    if (res.changes === 0) {
      // Otro webhook concurrente completó la transición.
      throw new PaymentError('ILLEGAL_TRANSITION', 'transición ilegal: la transacción ya no está PENDING')
    }

    // Auditoría de la transición (sin datos sensibles)
    this.db.prepare(`
      INSERT INTO payment_audit (id, transaction_id, organization_id, from_status, to_status, created_at)
      VALUES (?, ?, ?, 'PENDING', ?, ?)
    `).run(`aud_${randomUUID().substring(0, 12)}`, transactionId, orgId, status, now)

    if (status === 'APPROVED') {
      // Etiquetar contacto como CLIENTE_PAGADO (scoped por organización)
      this.db.prepare(`
        INSERT OR IGNORE INTO contact_tags (organization_id, contact_phone, tag_name, created_at)
        VALUES (?, ?, 'CLIENTE_PAGADO', ?)
      `).run(orgId, tx.contactPhone, Date.now())
    }

    return this.getTransaction(transactionId, orgId)!
  }

  /** Entradas de auditoría de una transacción (uso interno/operador). */
  getAudit(transactionId: string, orgId: string): Array<{ id: string; from_status: string | null; to_status: string; created_at: number }> {
    return this.db.prepare('SELECT id, from_status, to_status, created_at FROM payment_audit WHERE transaction_id = ? AND organization_id = ? ORDER BY created_at ASC').all(transactionId, orgId) as any[]
  }
}
