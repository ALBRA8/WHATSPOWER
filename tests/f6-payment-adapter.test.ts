import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPaymentAdapter, PaymentAdapterError, PROVIDERS } from '../src/payments/payment-adapter.mjs'

/**
 * Kit F6 (WP) — adaptador de cobro fail-closed: el simulador es EXPLÍCITO,
 * el proveedor real sin credenciales falla con error claro (jamás degrada en
 * silencio a simulador que oculte un cobro no hecho).
 */
describe('kit F6 — payment-adapter', () => {
  it('sin política → simulador para cualquier org, marcado EXPLÍCITO', async () => {
    const adapter = createPaymentAdapter({})
    const charge = await adapter.createCharge({ orgId: 'org-a', amount: 49000, currency: 'COP' })
    assert.equal(charge.provider, 'simulator')
    assert.equal(charge.simulator, true)
    assert.equal(charge.status, 'approved_simulated')
    assert.equal(charge.amount, 49000)
    assert.equal(charge.currency, 'COP')
    assert.match(charge.reference, /^SIM-/)
  })

  it('proveedor por org desde la política; org sin entrada → simulador', async () => {
    const adapter = createPaymentAdapter({ policyJson: JSON.stringify({ 'org-a': 'wompi' }) })
    assert.equal(adapter.resolveProvider('org-a'), 'wompi')
    assert.equal(adapter.resolveProvider('org-b'), 'simulator')
  })

  it('proveedor real sin credenciales → error EXPLÍCITO con las variables faltantes', async () => {
    const adapter = createPaymentAdapter({ policyJson: JSON.stringify({ 'org-a': 'wompi' }) })
    await assert.rejects(
      async () => adapter.createCharge({ orgId: 'org-a', amount: 1000 }),
      /faltan WOMPI_PUBLIC_KEY, WOMPI_PRIVATE_KEY/
    )
    const mp = createPaymentAdapter({ policyJson: JSON.stringify({ 'org-a': 'mercadopago' }) })
    await assert.rejects(
      async () => mp.createCharge({ orgId: 'org-a', amount: 1000 }),
      /faltan MP_ACCESS_TOKEN/
    )
  })

  it('guardas de entrada: monto inválido, moneda no soportada y org faltante', async () => {
    const adapter = createPaymentAdapter({})
    await assert.rejects(async () => adapter.createCharge({ orgId: 'org-a', amount: -5 }), /número positivo/)
    await assert.rejects(async () => adapter.createCharge({ orgId: 'org-a', amount: 0 }), /número positivo/)
    await assert.rejects(async () => adapter.createCharge({ orgId: 'org-a', amount: 100, currency: 'BTC' }), /moneda no soportada/)
    // @ts-expect-error — guarda deliberadamente violada (orgId ausente)
    await assert.rejects(async () => adapter.createCharge({ amount: 100 } as any), /orgId requerido/)
    const ok = await adapter.createCharge({ orgId: 'org-a', amount: 100, currency: 'COP' })
    assert.ok(ok)
  })

  it('proveedor desconocido en la política → error al resolver (fail-fast)', () => {
    const adapter = createPaymentAdapter({ policyJson: JSON.stringify({ 'org-a': 'paypal' }) })
    assert.throws(() => adapter.resolveProvider('org-a'), /proveedor desconocido "paypal"/)
    assert.deepEqual(PROVIDERS, ['simulator', 'wompi', 'mercadopago', 'stripe'])
  })

  it('policyJson inválido → error tipado', () => {
    assert.throws(() => createPaymentAdapter({ policyJson: '{no-json' }), PaymentAdapterError)
  })
})
