/**
 * payments-qr-hardening.test.ts — Reparación integral 2026-11-06
 *
 *  - PAY-xx: contrato duro del webhook de pagos (eventId, validación, estados).
 *  - PAYNEG-01..07: las 7 pruebas negativas obligatorias del contrato HMAC de pagos.
 *  - QR-xx: /qr y /qr/data NUNCA entregan QR a anónimos.
 *  - REPLAY-DUR-xx: anti-replay durable sobrevive reinicios.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createHmac } from 'node:crypto'
import { createAgenticServer } from '../src/server.ts'
import { MockTransportSender } from '../src/adapters/transport.ts'
import { MockCrmClient } from '../src/adapters/crm-client.ts'
import { DurableReplayCache } from '../src/security.ts'

process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'wp_sec_test_internal_min24chars_000'
const SECRET = process.env.INTERNAL_API_SECRET!
const AUTH = { 'Authorization': `Bearer ${SECRET}` }
const PAY_SECRET = 'wp_sec_test_payments_secret_min24chars'

async function listenEphemeral(server: any): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}

function boot() {
  const built = createAgenticServer({
    dbPath: ':memory:',
    transport: new MockTransportSender(),
    crm: new MockCrmClient(),
    webhookSecret: 'wp_sec_test_webhook_secret_min24chars',
  })
  return built
}

/** Firma canonical v2: hex(HMAC-SHA256(secret, `${ts}.${body}`)) */
const signP = (ts: string, body: string, secret: string = PAY_SECRET) =>
  createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')

async function createTx(built: ReturnType<typeof boot>, amount = 150000, currency = 'COP') {
  const tx = built.paymentManager.createPaymentLink({
    orgId: 'org_pay_test',
    contactPhone: '573000001234',
    amount,
    currency,
    description: 'Test reparación integral',
  })
  return tx
}

async function postPaymentsWebhook(base: string, body: string, headers: Record<string, string>) {
  return fetch(`${base}/api/payments/webhook`, { method: 'POST', headers, body })
}

describe('PAY: contrato duro del webhook de pagos', () => {
  it('PAY-01: PENDING→APPROVED (evento legal) → 200 + etiqueta CLIENTE_PAGADO', async () => {
    process.env.PAYMENTS_WEBHOOK_SECRET = PAY_SECRET
    try {
      const built = boot()
      const base = await listenEphemeral(built.server)
      try {
        const tx = await createTx(built)
        const body = JSON.stringify({ eventId: 'evt_pay_01', transactionId: tx.id, status: 'APPROVED' })
        const ts = String(Date.now())
        const res = await postPaymentsWebhook(base, body, {
          'Content-Type': 'application/json',
          'X-Signature-SHA256': signP(ts, body),
          'X-Timestamp': ts,
        })
        assert.strictEqual(res.status, 200)
        const data = await res.json() as any
        assert.strictEqual(data.ok, true)
        assert.strictEqual(data.transaction.status, 'APPROVED')
        const tag = built.db.prepare('SELECT * FROM contact_tags WHERE contact_phone = ? AND tag_name = ?').get('573000001234', 'CLIENTE_PAGADO')
        assert.ok(tag, 'CLIENTE_PAGADO etiquetado')
      } finally { built.server.close() }
    } finally { delete process.env.PAYMENTS_WEBHOOK_SECRET }
  })

  it('PAY-02: APPROVED→REJECTED → 409 ILLEGAL_TRANSITION (terminal inmutable)', async () => {
    process.env.PAYMENTS_WEBHOOK_SECRET = PAY_SECRET
    try {
      const built = boot()
      const base = await listenEphemeral(built.server)
      try {
        const tx = await createTx(built)
        built.paymentManager.handlePaymentWebhook({ eventId: 'evt_pay_02a', transactionId: tx.id, status: 'APPROVED' })
        const body = JSON.stringify({ eventId: 'evt_pay_02b', transactionId: tx.id, status: 'REJECTED' })
        const ts = String(Date.now())
        const res = await postPaymentsWebhook(base, body, {
          'Content-Type': 'application/json',
          'X-Signature-SHA256': signP(ts, body),
          'X-Timestamp': ts,
        })
        assert.strictEqual(res.status, 409)
        const data = await res.json() as any
        assert.strictEqual(data.code, 'ILLEGAL_TRANSITION')
        assert.strictEqual(built.paymentManager.getTransaction(tx.id)!.status, 'APPROVED')
      } finally { built.server.close() }
    } finally { delete process.env.PAYMENTS_WEBHOOK_SECRET }
  })

  it('PAY-03: re-aprobación de transacción APPROVED → 409 (sin doble etiquetado)', async () => {
    process.env.PAYMENTS_WEBHOOK_SECRET = PAY_SECRET
    try {
      const built = boot()
      const base = await listenEphemeral(built.server)
      try {
        const tx = await createTx(built)
        built.paymentManager.handlePaymentWebhook({ eventId: 'evt_pay_03a', transactionId: tx.id, status: 'APPROVED' })
        const body = JSON.stringify({ eventId: 'evt_pay_03b', transactionId: tx.id, status: 'APPROVED' })
        const ts = String(Date.now())
        const res = await postPaymentsWebhook(base, body, {
          'Content-Type': 'application/json',
          'X-Signature-SHA256': signP(ts, body),
          'X-Timestamp': ts,
        })
        assert.strictEqual(res.status, 409)
        const tags = built.db.prepare('SELECT COUNT(*) AS n FROM contact_tags WHERE contact_phone = ? AND tag_name = ?').get('573000001234', 'CLIENTE_PAGADO') as any
        assert.strictEqual(tags.n, 1, 'etiqueta aplicada una sola vez')
      } finally { built.server.close() }
    } finally { delete process.env.PAYMENTS_WEBHOOK_SECRET }
  })

  it('PAY-04: amount que no coincide → 409 VALIDATION_MISMATCH y estado intacto', async () => {
    process.env.PAYMENTS_WEBHOOK_SECRET = PAY_SECRET
    try {
      const built = boot()
      const base = await listenEphemeral(built.server)
      try {
        const tx = await createTx(built, 150000)
        const body = JSON.stringify({ eventId: 'evt_pay_04', transactionId: tx.id, status: 'APPROVED', amount: 999 })
        const ts = String(Date.now())
        const res = await postPaymentsWebhook(base, body, {
          'Content-Type': 'application/json',
          'X-Signature-SHA256': signP(ts, body),
          'X-Timestamp': ts,
        })
        assert.strictEqual(res.status, 409)
        const data = await res.json() as any
        assert.strictEqual(data.code, 'VALIDATION_MISMATCH')
        assert.strictEqual(built.paymentManager.getTransaction(tx.id)!.status, 'PENDING')
      } finally { built.server.close() }
    } finally { delete process.env.PAYMENTS_WEBHOOK_SECRET }
  })

  it('PAY-05: re-entrega del MISMO eventId → 200 idempotent sin re-efectos', async () => {
    process.env.PAYMENTS_WEBHOOK_SECRET = PAY_SECRET
    try {
      const built = boot()
      const base = await listenEphemeral(built.server)
      try {
        const tx = await createTx(built)
        const body = JSON.stringify({ eventId: 'evt_pay_05', transactionId: tx.id, status: 'APPROVED' })
        const ts = String(Date.now())
        const headers = {
          'Content-Type': 'application/json',
          'X-Signature-SHA256': signP(ts, body),
          'X-Timestamp': ts,
        }
        const r1 = await postPaymentsWebhook(base, body, headers)
        assert.strictEqual(r1.status, 200)
        // Re-entrega real de la pasarela: timestamp NUEVO re-firmado, MISMO eventId
        const ts2 = String(Date.now() + 1)
        const r2 = await postPaymentsWebhook(base, body, {
          'Content-Type': 'application/json',
          'X-Signature-SHA256': signP(ts2, body),
          'X-Timestamp': ts2,
        })
        assert.strictEqual(r2.status, 200)
        const data = await r2.json() as any
        assert.strictEqual(data.idempotent, true, 're-entrega reconocida como idempotente')
        const events = built.paymentManager.listWebhookEvents(tx.id)
        assert.strictEqual(events.length, 1, 'un solo registro de evento')
        const tags = built.db.prepare('SELECT COUNT(*) AS n FROM contact_tags WHERE contact_phone = ? AND tag_name = ?').get('573000001234', 'CLIENTE_PAGADO') as any
        assert.strictEqual(tags.n, 1)
      } finally { built.server.close() }
    } finally { delete process.env.PAYMENTS_WEBHOOK_SECRET }
  })

  it('PAY-06: eventId repetido con payload DISTINTO → rechazo (antifraude)', async () => {
    process.env.PAYMENTS_WEBHOOK_SECRET = PAY_SECRET
    try {
      const built = boot()
      const base = await listenEphemeral(built.server)
      try {
        const txA = await createTx(built)
        const txB = await createTx(built)
        const b1 = JSON.stringify({ eventId: 'evt_pay_06', transactionId: txA.id, status: 'APPROVED' })
        const ts = String(Date.now())
        await postPaymentsWebhook(base, b1, {
          'Content-Type': 'application/json',
          'X-Signature-SHA256': signP(ts, b1),
          'X-Timestamp': ts,
        })
        const b2 = JSON.stringify({ eventId: 'evt_pay_06', transactionId: txB.id, status: 'APPROVED' })
        const ts2 = String(Date.now() + 1)
        const res = await postPaymentsWebhook(base, b2, {
          'Content-Type': 'application/json',
          'X-Signature-SHA256': signP(ts2, b2),
          'X-Timestamp': ts2,
        })
        assert.strictEqual(res.status, 400)
        assert.strictEqual(built.paymentManager.getTransaction(txB.id)!.status, 'PENDING')
      } finally { built.server.close() }
    } finally { delete process.env.PAYMENTS_WEBHOOK_SECRET }
  })

  it('PAY-07: auditoría registra creaciones, transiciones e intentos ilegales', async () => {
    process.env.PAYMENTS_WEBHOOK_SECRET = PAY_SECRET
    try {
      const built = boot()
      const base = await listenEphemeral(built.server)
      try {
        const tx = await createTx(built)
        built.paymentManager.handlePaymentWebhook({ eventId: 'evt_pay_07a', transactionId: tx.id, status: 'APPROVED' })
        const b = JSON.stringify({ eventId: 'evt_pay_07b', transactionId: tx.id, status: 'REJECTED' })
        const ts = String(Date.now())
        await postPaymentsWebhook(base, b, {
          'Content-Type': 'application/json',
          'X-Signature-SHA256': signP(ts, b),
          'X-Timestamp': ts,
        })
        const audit = built.paymentManager.listAudit(tx.id).map((a) => a.action)
        assert.ok(audit.includes('PAYMENT_LINK_CREATED'))
        assert.ok(audit.includes('WEBHOOK_TRANSITION_TO_APPROVED'))
        assert.ok(audit.includes('WEBHOOK_ILLEGAL_TRANSITION_TO_REJECTED'))
      } finally { built.server.close() }
    } finally { delete process.env.PAYMENTS_WEBHOOK_SECRET }
  })
})

describe('PAYNEG: 7 pruebas negativas del contrato HMAC de pagos', () => {
  const setup = async () => {
    process.env.PAYMENTS_WEBHOOK_SECRET = PAY_SECRET
    const built = boot()
    const base = await listenEphemeral(built.server)
    const tx = await createTx(built)
    return { built, base, tx }
  }
  const teardown = (built: ReturnType<typeof boot>) => {
    built.server.close()
    delete process.env.PAYMENTS_WEBHOOK_SECRET
  }
  const legalBody = (txId: string) => JSON.stringify({ eventId: `evt_neg_${Math.random().toString(36).slice(2)}`, transactionId: txId, status: 'APPROVED' })

  it('NEG-P1: cuerpo alterado con firma original → 401', async () => {
    const { built, base, tx } = await setup()
    try {
      const good = legalBody(tx.id)
      const ts = String(Date.now())
      const tampered = legalBody(tx.id) // otro cuerpo
      const res = await postPaymentsWebhook(base, tampered, {
        'Content-Type': 'application/json',
        'X-Signature-SHA256': signP(ts, good),
        'X-Timestamp': ts,
      })
      assert.strictEqual(res.status, 401)
    } finally { teardown(built) }
  })

  it('NEG-P2: firma con secreto equivocado → 401', async () => {
    const { built, base, tx } = await setup()
    try {
      const body = legalBody(tx.id)
      const ts = String(Date.now())
      const res = await postPaymentsWebhook(base, body, {
        'Content-Type': 'application/json',
        'X-Signature-SHA256': signP(ts, body, 'secreto_incorrecto_para_pagos_00000'),
        'X-Timestamp': ts,
      })
      assert.strictEqual(res.status, 401)
    } finally { teardown(built) }
  })

  it('NEG-P3: timestamp expirado → 401', async () => {
    const { built, base, tx } = await setup()
    try {
      const body = legalBody(tx.id)
      const oldTs = String(Date.now() - 6 * 60 * 1000)
      const res = await postPaymentsWebhook(base, body, {
        'Content-Type': 'application/json',
        'X-Signature-SHA256': signP(oldTs, body),
        'X-Timestamp': oldTs,
      })
      assert.strictEqual(res.status, 401)
    } finally { teardown(built) }
  })

  it('NEG-P4: sin secreto configurado → 503 fail-closed', async () => {
    delete process.env.PAYMENTS_WEBHOOK_SECRET
    const built = boot()
    const base = await listenEphemeral(built.server)
    try {
      const body = legalBody('tx_cualquiera')
      const ts = String(Date.now())
      const res = await postPaymentsWebhook(base, body, {
        'Content-Type': 'application/json',
        'X-Signature-SHA256': signP(ts, body, 'secreto_no_configurado_000000'),
        'X-Timestamp': ts,
      })
      assert.strictEqual(res.status, 503)
    } finally { teardown(built) }
  })

  it('NEG-P5: timestamp sustituido con la misma firma → 401 (canonical v2)', async () => {
    const { built, base, tx } = await setup()
    try {
      const body = legalBody(tx.id)
      const ts1 = String(Date.now())
      const sig = signP(ts1, body)
      await postPaymentsWebhook(base, body, { 'Content-Type': 'application/json', 'X-Signature-SHA256': sig, 'X-Timestamp': ts1 })
      const ts2 = String(Date.now() + 1000)
      const res = await postPaymentsWebhook(base, body, { 'Content-Type': 'application/json', 'X-Signature-SHA256': sig, 'X-Timestamp': ts2 })
      assert.strictEqual(res.status, 401, 'la firma no valida con otro timestamp')
    } finally { teardown(built) }
  })

  it('NEG-P6: evento idéntico concurrente ×8 → exactamente 1 aceptado', async () => {
    const { built, base, tx } = await setup()
    try {
      const body = JSON.stringify({ eventId: 'evt_neg_conc', transactionId: tx.id, status: 'APPROVED' })
      const ts = String(Date.now())
      const headers = { 'Content-Type': 'application/json', 'X-Signature-SHA256': signP(ts, body), 'X-Timestamp': ts }
      const results = await Promise.all(Array.from({ length: 8 }, () => postPaymentsWebhook(base, body, { ...headers })))
      const ok = results.filter((r) => [200, 409].includes(r.status)).length // 1 aplica; los demás replay
      const replayed = results.filter((r) => r.status === 401).length
      assert.strictEqual(ok, 1, 'solo una ejecución efectiva del evento')
      assert.strictEqual(replayed, 7)
      assert.strictEqual(built.paymentManager.getTransaction(tx.id)!.status, 'APPROVED')
    } finally { teardown(built) }
  })

  it('NEG-P7: sin firma ni timestamp → 401 (nada se ejecuta sin credencial completa)', async () => {
    const { built, base, tx } = await setup()
    try {
      const body = legalBody(tx.id)
      const res = await postPaymentsWebhook(base, body, { 'Content-Type': 'application/json' })
      assert.strictEqual(res.status, 401)
      assert.strictEqual(built.paymentManager.getTransaction(tx.id)!.status, 'PENDING')
    } finally { teardown(built) }
  })
})

describe('QR: el QR de WhatsApp jamás se sirve a anónimos', () => {
  it('QR-01: /qr/data anónimo → 401 (antes devolvía el QR a cualquiera)', async () => {
    process.env.INTERNAL_API_SECRET = SECRET
    const built = boot()
    const base = await listenEphemeral(built.server)
    try {
      const res = await fetch(`${base}/qr/data`)
      assert.strictEqual(res.status, 401)
      const data = await res.json() as any
      assert.ok(data.error)
      assert.ok(!('qr' in data), 'sin clave NUNCA hay campo qr')
    } finally { built.server.close() }
  })

  it('QR-02: /qr anónimo → HTML de puerta, sin datos de QR ni imagen', async () => {
    process.env.INTERNAL_API_SECRET = SECRET
    const built = boot()
    const base = await listenEphemeral(built.server)
    try {
      const res = await fetch(`${base}/qr`)
      assert.ok([401, 200].includes(res.status))
      const html = await res.text()
      assert.ok(!html.includes('data:image'), 'el HTML anónimo no contiene QR')
      assert.ok(!html.includes("fetch('/qr/data')") || html.includes('Bearer'), 'cualquier fetch incluye Bearer')
    } finally { built.server.close() }
  })

  it('QR-03: /qr/data con Bearer válido → ya no es 401/403 (acceso autorizado)', async () => {
    process.env.INTERNAL_API_SECRET = SECRET
    const built = boot()
    const base = await listenEphemeral(built.server)
    try {
      const res = await fetch(`${base}/qr/data`, { headers: AUTH })
      assert.ok(res.status !== 401 && res.status !== 403, `con credencial válida no debe rechazarse (obtenido ${res.status})`)
    } finally { built.server.close() }
  })
})

describe('REPLAY-DUR: anti-replay persistente', () => {
  it('REPLAY-DUR-01: la huella sobrevive al reinicio del proceso', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'wp-replay-durable-'))
    try {
      const dbPath = join(dir, 'replay.db')
      const c1 = new DurableReplayCache(dbPath)
      assert.strictEqual(c1.register('huella_wp_reinicio'), true)
      c1.close()
      const c2 = new DurableReplayCache(dbPath)
      assert.strictEqual(c2.register('huella_wp_reinicio'), false, 'replay detectado tras reinicio')
      assert.strictEqual(c2.register('huella_wp_nueva'), true)
      c2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
