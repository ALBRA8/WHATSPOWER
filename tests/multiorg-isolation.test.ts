import { test } from 'node:test'
import assert from 'node:assert'
import { createDatabase } from '../src/db.ts'
import { LockManager } from '../src/state/lock-manager.ts'
import { SuppressionStore } from '../src/suppression/suppression-store.ts'
import { FlowEngine } from '../src/engine/flow-engine.ts'
import { PaymentGatewayManager } from '../src/payments/payment-gateway.ts'
import { MockCrmClient, HttpCrmClient } from '../src/adapters/crm-client.ts'
import type { TransportSender, CrmClientInterface, InboundEvent } from '../src/types.ts'
import { ConversationRouter } from '../src/engine/router.ts'

/**
 * AISLAMIENTO MULTI-ORG Y CONCURRENCIA (segunda reparación — orden §3.A/§3.C/§3.D/§6).
 *
 * Prueba que el MISMO número de teléfono en DOS organizaciones tiene estados,
 * locks, sesiones, etiquetas, campos, supresiones y pagos COMPLETAMENTE
 * independientes; que dos eventos inbound idénticos concurrentes NO duplican
 * efectos; y que un webhook inválido no bloquea al válido.
 */

// ---------------------------------------------------------------------------
// Transporte de sala limpia (0 envíos reales)
// ---------------------------------------------------------------------------
class MockTransport implements TransportSender {
  dispatched: Array<{ phone: string; text: string; correlationId: string }> = []
  async sendMessage(phone: string, text: string, correlationId: string): Promise<void> {
    this.dispatched.push({ phone, text, correlationId })
  }
}

function bootRouter() {
  const db = createDatabase(':memory:')
  const transport = new MockTransport()
  const crm = new MockCrmClient()
  const router = new ConversationRouter(db, transport, crm as unknown as CrmClientInterface)
  return { db, transport, crm, router }
}

function inboundEvent(orgId: string, eventId: string, phone: string, text: string): InboundEvent {
  return {
    eventId,
    orgId,
    correlationId: `corr_${eventId}`,
    timestamp: new Date().toISOString(),
    channel: 'whatsapp',
    contact: { phone },
    message: { id: `m_${eventId}`, text, type: 'text' },
  }
}

// ---------------------------------------------------------------------------
test('MO-01: locks independientes — handoff de org A no bloquea a org B con el mismo teléfono', () => {
  const db = createDatabase(':memory:')
  const locks = new LockManager(db)
  const phone = '+573000111222'

  locks.acquireLock(phone, 'org_alpha', 'c1')
  locks.setHandoff(phone, 'org_alpha', 'c1')

  // Org B con el MISMO número: lock propio disponible
  const lockB = locks.acquireLock(phone, 'org_beta', 'c2')
  assert.strictEqual(lockB.acquired, true, 'org B NO debe verse afectada por el handoff de org A')

  // Org A sigue en HANDOFF_HUMAN
  const lockA = locks.getLock(phone, 'org_alpha')
  assert.strictEqual(lockA?.currentState, 'HANDOFF_HUMAN')

  // Liberar en org B no toca el lock de org A
  locks.releaseLock(phone, 'org_beta')
  assert.strictEqual(locks.getLock(phone, 'org_alpha')?.currentState, 'HANDOFF_HUMAN')
})

test('MO-02: supresión independiente — la baja en una org no silencia en la otra', () => {
  const db = createDatabase(':memory:')
  const sup = new SuppressionStore(db)
  const phone = '+573000333444'

  sup.addSuppression('org_alpha', phone, 'baja voluntaria')
  assert.strictEqual(sup.isSuppressed('org_alpha', phone), true)
  assert.strictEqual(sup.isSuppressed('org_beta', phone), false, 'org B NO hereda la baja de org A')

  sup.removeSuppression('org_alpha', phone)
  assert.strictEqual(sup.isSuppressed('org_alpha', phone), false)
})

test('MO-03: etiquetas, campos y sesiones de flujo por (org, contacto)', async () => {
  const db = createDatabase(':memory:')
  const fe = new FlowEngine(db)
  const phone = '+573000555666'

  fe.addTag('org_alpha', phone, 'vip')
  assert.strictEqual(fe.hasTag('org_beta', phone, 'vip'), false, 'la etiqueta no cruza organizaciones')
  assert.strictEqual(fe.hasTag('org_alpha', phone, 'vip'), true)

  fe.setCustomField('org_alpha', phone, 'email', 'a@alpha.co')
  assert.strictEqual(fe.getCustomField('org_beta', phone, 'email'), null, 'el campo no cruza organizaciones')
  assert.strictEqual(fe.getCustomField('org_alpha', phone, 'email'), 'a@alpha.co')

  // Sesión de flujo: alfa tiene sesión activa, beta no la ve
  fe.saveSession('org_alpha', {
    contactPhone: phone,
    flowId: 'flow_ventas_manychat_01',
    currentNodeId: 'n_welcome',
    waitingForInput: true,
    context: { nombre: 'X' },
    lastActivity: Date.now(),
  })
  assert.ok(fe.getSession('org_alpha', phone))
  assert.strictEqual(fe.getSession('org_beta', phone), null, 'la sesión de flujo no cruza organizaciones')

  // Secuencias: inscripción por org
  fe.enrollContactInSequence('org_alpha', phone, 'seq_1')
  const rowsAlpha = (db.prepare("SELECT count(*) c FROM sequence_enrollments WHERE organization_id = 'org_alpha' AND contact_phone = ?").get(phone) as any).c
  const rowsBeta = (db.prepare("SELECT count(*) c FROM sequence_enrollments WHERE organization_id = 'org_beta' AND contact_phone = ?").get(phone) as any).c
  assert.strictEqual(rowsAlpha, 1)
  assert.strictEqual(rowsBeta, 0)
})

test('CONC-01: DOS eventos inbound IDÉNTICOS CONCURRENTES → efectos ejecutados UNA sola vez', async () => {
  const { transport, router } = bootRouter()
  const phone = '+573000777888'
  const mk = () => inboundEvent('org_alpha', 'evt_dupe_1', phone, 'Hola, quiero información')

  // Dos llamadas SIMULTÁNEAS con el mismo evento
  const [r1, r2] = await Promise.all([router.processInbound(mk()), router.processInbound(mk())])

  const actions = [r1.actionTaken, r2.actionTaken]
  // Uno ejecuta el flujo real; el otro queda en deduplicated o in_flight SIN efectos
  assert.ok(
    actions.includes('new_lead_welcome') || actions.includes('visual_flow_execution') || actions.includes('keyword_rule'),
    `uno debe ejecutar la acción real (obtuvimos: ${actions.join(', ')})`
  )
  assert.ok(
    actions.includes('deduplicated') || actions.includes('in_flight'),
    `el otro debe ser deduplicado o in_flight (obtuvimos: ${actions.join(', ')})`
  )
  // EXACTAMENTE un efecto de bienvenida/respuesta: sin duplicación de mensajes
  assert.strictEqual(transport.dispatched.length, 1, `mensajes enviados: ${transport.dispatched.length} (debe ser 1)`)
})

test('CONC-02: reserva interrumpida (lease vencido) permite la recuperación del evento', async () => {
  const { db, router, transport } = bootRouter()
  const phone = '+573000999000'
  // Simula un proceso que murió con la reserva activa: inserta PROCESSING con lease vencido
  const past = Math.floor(Date.now() / 1000) - 300
  db.prepare("INSERT INTO idempotency_keys (key, status, response_json, created_at, lease_expires_at) VALUES ('org_alpha::evt_stale_1', 'PROCESSING', NULL, ?, ?)").run(past, past)

  const res = await router.processInbound(inboundEvent('org_alpha', 'evt_stale_1', phone, 'hola'))
  assert.notStrictEqual(res.actionTaken, 'in_flight', 'la reserva vencida NO debe bloquear el evento para siempre')
  assert.strictEqual(transport.dispatched.length, 1, 'el evento recuperado ejecuta sus efectos una vez')
})

test('PAY-ISO: pagos vinculados a organización — el evento de una org no toca pagos de otra', () => {
  const db = createDatabase(':memory:')
  const pay = new PaymentGatewayManager(db)
  const txA = pay.createPaymentLink({ orgId: 'org_alpha', contactPhone: '+573000123456', amount: 1000, description: 'pago A' })
  pay.createPaymentLink({ orgId: 'org_beta', contactPhone: '+573000123456', amount: 2000, description: 'pago B' })

  // Webhook autenticado para la org alpha: la transacción de beta es invisible para su consulta scoped
  const scoped = pay.getTransaction(txA.id, 'org_beta')
  assert.strictEqual(scoped, null, 'la transacción de org alpha no es visible consultando como org beta')

  // Transición en org alpha (sin orgId explícita: el webhook de la pasarela llega por el id global)
  const res = pay.handlePaymentWebhook({ eventId: 'evt_pay_iso_1', transactionId: txA.id, status: 'APPROVED' })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(pay.getTransaction(txA.id)!.status, 'APPROVED')
})

test('PAY-NEG: webhook con importe incorrecto NO consume el eventId — el evento válido corregido se acepta', () => {
  const db = createDatabase(':memory:')
  const pay = new PaymentGatewayManager(db)
  const tx = pay.createPaymentLink({ orgId: 'org_alpha', contactPhone: '+573000654321', amount: 5000, description: 'pago corregible' })

  // 1º: importe equivocado con eventId E1 → rechazo VALIDATION_MISMATCH
  const bad = pay.handlePaymentWebhook({ eventId: 'evt_corr_1', transactionId: tx.id, status: 'APPROVED', amount: 9999 })
  assert.strictEqual(bad.ok, false)
  assert.strictEqual((bad as any).code, 'VALIDATION_MISMATCH')

  // 2º: la pasarela corrige y reenvía el MISMO eventId con el importe correcto → ACEPTADO
  const good = pay.handlePaymentWebhook({ eventId: 'evt_corr_1', transactionId: tx.id, status: 'APPROVED', amount: 5000 })
  assert.strictEqual(good.ok, true, 'un evento inválido NO debe consumir la clave del evento válido')
  assert.strictEqual(pay.getTransaction(tx.id)!.status, 'APPROVED')
})

test('PAY-CONC: DOS webhooks idénticos CONCURRENTES → una sola transición de estado', async () => {
  const db = createDatabase(':memory:')
  const pay = new PaymentGatewayManager(db)
  const tx = pay.createPaymentLink({ orgId: 'org_alpha', contactPhone: '+573000987654', amount: 3000, description: 'pago concurrente' })

  const event = { eventId: 'evt_conc_pay_1', transactionId: tx.id, status: 'APPROVED' as const }
  const [r1, r2] = await Promise.all([
    Promise.resolve().then(() => pay.handlePaymentWebhook(event)),
    Promise.resolve().then(() => pay.handlePaymentWebhook(event)),
  ])

  const okCount = [r1, r2].filter((r) => r.ok).length
  assert.ok(okCount >= 1, 'al menos una transición aplica')
  // Estado final APPROVED exactamente una vez: la otra respuesta es idempotente o rechazo de carrera
  const events = pay.listWebhookEvents(tx.id)
  assert.strictEqual(events.length, 1, `registros de evento: ${events.length} (debe ser 1)`)
  const tags = db.prepare("SELECT COUNT(*) n FROM contact_tags WHERE contact_phone = ? AND tag_name = 'CLIENTE_PAGADO'").get('+573000987654') as any
  assert.strictEqual(tags.n, 1, 'etiqueta CLIENTE_PAGADO aplicada UNA sola vez')
})

test('CRM-ISO: discrepancia de tenant del CRM → TENANT_MISMATCH y acción NO aceptada', async () => {
  const db = createDatabase(':memory:')
  const transport = new MockTransport()
  const crm = new MockCrmClient()
  // El "CRM" responde atribuyendo la acción a OTRA organización
  crm.simulateResponseOrgId = 'org_otra'
  const router = new ConversationRouter(db, transport, crm as unknown as CrmClientInterface)

  const res = await router.processInbound(inboundEvent('org_alpha', 'evt_mismatch_1', '+573001112233', 'hola'))
  assert.strictEqual(res.crmSynced, false, 'la acción con org discrepante se rechaza')

  // Sin discrepancia: el orgId confirmado por el CRM se valida OK
  crm.simulateResponseOrgId = undefined
  const res2 = await router.processInbound(inboundEvent('org_alpha', 'evt_mismatch_2', '+573001112233', 'hola'))
  assert.strictEqual(res2.crmSynced, true)
})

test('CRM-KEYS: HttpCrmClient resuelve credenciales POR organización (fail-closed)', async () => {
  const client = new HttpCrmClient('http://localhost:59999', 'albra_single_key', {
    'org_alpha': 'albra_key_alpha',
    'org_beta': 'albra_key_beta',
  })
  assert.strictEqual(client.resolveApiKey('org_alpha'), 'albra_key_alpha')
  assert.strictEqual(client.resolveApiKey('org_beta'), 'albra_key_beta')
  // Org SIN clave configurada: NO se usa la clave de otra org (ni la single)
  assert.strictEqual(client.resolveApiKey('org_gamma'), null, 'fail-closed: sin credencial para esa org')
  // Cliente mono-org: la clave única sirve para la org declarada
  const single = new HttpCrmClient('http://localhost:59999', 'albra_only_key')
  assert.strictEqual(single.resolveApiKey('cualquier_org'), 'albra_only_key')
})
