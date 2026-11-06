import { test } from 'node:test'
import assert from 'node:assert'
import { createServer } from 'node:http'
import { createDatabase } from '../src/db.ts'
import { MockTransportSender, HttpAlbraTransportSender, TransportAmbiguousError } from '../src/adapters/transport.ts'
import type { TransportSender, CrmClientInterface, InboundEvent } from '../src/types.ts'
import { ConversationRouter } from '../src/engine/router.ts'
import { createAgenticServer } from '../src/server.ts'

/**
 * CUARTA FASE CORRECTIVA — PRUEBAS FORZOSAS:
 *  - W4-01: ventana de duplicación de journaledEffect() — el proveedor aceptó el
 *    mensaje y el proceso muere ANTES de registrar DONE → el reingreso NO debe
 *    re-ejecutar el efecto (estado IN_FLIGHT ⇒ UNCERTAIN + reconciliación).
 *  - W4-02: envío NO aceptado (ok:false) NO debe quedar como DONE (pérdida
 *    silenciosa); queda PENDING y el evento falla limpio.
 *  - W4-03: resultado AMBIGUO del transporte ⇒ efecto IN_FLIGHT; la
 *    reconciliación está BLOQUEADA hasta resolución explícita por efecto;
 *    'delivered' ⇒ DONE sin reenvío; 'not_delivered' ⇒ PENDING re-ejecutable.
 *  - W4-04: clave de idempotencia EXTERNA (determinista por evento+efecto)
 *    transmitida al transporte (dedup en el proveedor cuando el daemon coopera).
 *  - W4-05: INTERNAL_API_KEYS — identidad por organización: clave dedicada
 *    obligatoria para orgs que la tienen; el secreto global NO sirve para esas
 *    orgs (refuerzo del secreto compartido).
 *  - W4-06: /api/payments/create-link con clave dedicada: el orgId del body
 *    debe coincidir con la organización de la clave (fail-closed).
 */

// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class RecordingCrm implements CrmClientInterface {
  calls: Array<{ action: string; orgId: string }> = []
  async createClient(orgId: string, name: string, phone: string, correlationId: string) {
    this.calls.push({ action: 'create_client', orgId })
    return { ok: true, summary: 'ok', clientId: `cl_${this.calls.length}`, orgId }
  }
  async createOpportunity(orgId: string, clientId: string, title: string, amount: number, correlationId: string) {
    this.calls.push({ action: 'create_opportunity', orgId })
    return { ok: true, summary: 'ok', orgId }
  }
  async addNote(orgId: string, clientId: string, content: string, correlationId: string) {
    this.calls.push({ action: 'add_note', orgId })
    return { ok: true, summary: 'ok', orgId }
  }
}

/** Transporte que puede "colgarse" tras aceptar (simula crash antes de DONE). */
class HangableTransport implements TransportSender {
  dispatched: Array<{ phone: string; text: string; idempotencyKey: string }> = []
  hang = false
  async sendMessage(to: string, text: string, correlationId: string, idempotencyKey?: string) {
    this.dispatched.push({ phone: to, text, idempotencyKey: idempotencyKey || '' })
    if (this.hang) return new Promise<{ ok: boolean }>(() => {}) // el proceso muere aquí
    return { ok: true, messageId: `w4_${this.dispatched.length}` }
  }
}

/** Transporte que registra claves y puede lanzar ambigüedad (conexión muerta a mitad). */
class AmbiguousTransport implements TransportSender {
  dispatched: Array<{ phone: string; text: string; idempotencyKey: string }> = []
  ambiguous = false
  async sendMessage(to: string, text: string, correlationId: string, idempotencyKey?: string) {
    if (this.ambiguous) throw new TransportAmbiguousError('daemon cerró la conexión sin respuesta (resultado desconocido)')
    this.dispatched.push({ phone: to, text, idempotencyKey: idempotencyKey || '' })
    return { ok: true, messageId: `w4a_${this.dispatched.length}` }
  }
}

function bootRouter(transport: TransportSender, crm: CrmClientInterface) {
  const db = createDatabase(':memory:')
  const router = new ConversationRouter(db, transport, crm)
  return { db, router }
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
// W4-A. VENTANA DE DUPLICACIÓN EN journaledEffect()
// ---------------------------------------------------------------------------
test('W4-01: proveedor acepta + crash antes de DONE → el reingreso NO re-ejecuta el envío (IN_FLIGHT ⇒ UNCERTAIN)', async () => {
  const transport = new HangableTransport()
  const crm = new RecordingCrm()
  const { db, router } = bootRouter(transport, crm)

  const ev = inboundEvent('org_w', 'evt_w4_1', '+573001112233', 'ASESOR') // regla determinista sin sesión de flujo
  transport.hang = true
  const first = router.processInbound(ev) // queda colgado: el "proceso" muere con el envío en vuelo
  await sleep(200) // la reserva y la marca IN_FLIGHT del efecto quedan escritas

  // Estado post-crash: el efecto del envío NO está DONE
  const eff = db.prepare("SELECT status FROM inbound_effect_journal WHERE key='org_w::evt_w4_1' AND effect_key LIKE 'send:%'").get() as { status: string }
  assert.strictEqual(eff.status, 'IN_FLIGHT', 'post-crash el efecto debe quedar IN_FLIGHT (no DONE ni PENDING)')

  // Simula la muerte del proceso: lease vencido
  db.prepare("UPDATE idempotency_keys SET lease_expires_at = strftime('%s','now') - 10 WHERE key='org_w::evt_w4_1'").run()
  transport.hang = false
  void first

  // Re-entrega del MISMO evento (la pasarela reintenta)
  const res = await router.processInbound(ev)
  assert.strictEqual(transport.dispatched.length, 1, 'el mensaje en vuelo NO se re-envía a ciegas (ventana de duplicación cerrada)')
  assert.strictEqual(res.actionTaken, 'uncertain_needs_reconciliation', 'el reingreso exige reconciliación, jamás re-ejecuta el efecto')

  // El operador confirma la ENTREGA → DONE; la reconciliación completa SIN reenviar
  const fx = db.prepare("SELECT effect_key FROM inbound_effect_journal WHERE key='org_w::evt_w4_1' AND status='IN_FLIGHT'").get() as { effect_key: string }
  router.resolveEffect('org_w::evt_w4_1', fx.effect_key, 'delivered', 'confirmado en el daemon')
  const rec = await router.reconcileEvent('org_w::evt_w4_1')
  assert.ok(rec, 'la reconciliación completa el ciclo tras la resolución')
  assert.strictEqual(transport.dispatched.length, 1, 'ni la reconciliación reenvía el mensaje aceptado')
})

test('W4-02: envío NO aceptado (ok:false) queda PENDING y el evento FALLA limpio — sin pérdida silenciosa', async () => {
  const transport = new MockTransportSender()
  const crm = new RecordingCrm()
  const { db, router } = bootRouter(transport, crm)

  transport.setSimulateFailure(true)
  const ev = inboundEvent('org_w', 'evt_w4_2', '+573004445566', 'CATALOGO') // regla determinista reply_only (sin handoff ni sesión de flujo)
  await assert.rejects(() => router.processInbound(ev), /SEND_NOT_COMPLETED/)

  const keyRow = db.prepare("SELECT status FROM idempotency_keys WHERE key='org_w::evt_w4_2'").get() as { status: string }
  assert.strictEqual(keyRow.status, 'FAILED', 'sin efectos externos aceptados, el reintento limpio está permitido')
  const eff = db.prepare("SELECT status FROM inbound_effect_journal WHERE key='org_w::evt_w4_2' AND effect_key LIKE 'send:%'").get() as { status: string }
  assert.strictEqual(eff.status, 'PENDING', 'el envío no aceptado NO puede quedar DONE (era una pérdida silenciosa)')

  // El daemon vuelve → reintento ejecuta el envío UNA vez
  transport.setSimulateFailure(false)
  const res = await router.processInbound(ev)
  assert.strictEqual(res.actionTaken, 'keyword_rule')
  assert.strictEqual(transport.dispatched.length, 1, 'el mensaje se entrega exactamente una vez tras el reintento')
})

test('W4-03: resultado AMBIGUO del transporte ⇒ IN_FLIGHT; reconciliación bloqueada hasta resolución explícita', async () => {
  const transport = new AmbiguousTransport()
  const crm = new RecordingCrm()
  const { db, router } = bootRouter(transport, crm)

  transport.ambiguous = true
  const ev = inboundEvent('org_w', 'evt_w4_3a', '+573005556677', 'ASESOR')
  await assert.rejects(() => router.processInbound(ev), /resultado desconocido|AMBIGUOUS/i)

  const keyRow = db.prepare("SELECT status FROM idempotency_keys WHERE key='org_w::evt_w4_3a'").get() as { status: string }
  assert.strictEqual(keyRow.status, 'UNCERTAIN', 'resultado externo desconocido ⇒ UNCERTAIN (no FAILED)')
  const fx = db.prepare("SELECT effect_key, status FROM inbound_effect_journal WHERE key='org_w::evt_w4_3a' AND effect_key LIKE 'send:%'").get() as { effect_key: string; status: string }
  assert.strictEqual(fx.status, 'IN_FLIGHT')

  // La reconciliación SIN resolver el efecto está BLOQUEADA (fail-closed)
  await assert.rejects(() => router.reconcileEvent('org_w::evt_w4_3a'), /RECONCILE_BLOCKED_UNRESOLVED_EFFECTS/)
  assert.strictEqual(transport.dispatched.length, 0, 'sin resolución no hay reenvío')

  // Variante A: el operador confirma ENTREGA → DONE, sin reenvío
  router.resolveEffect('org_w::evt_w4_3a', fx.effect_key, 'delivered', 'visto en el teléfono del cliente')
  const recA = await router.reconcileEvent('org_w::evt_w4_3a')
  assert.ok(recA)
  assert.strictEqual(transport.dispatched.length, 0, 'resolución delivered ⇒ jamás se reenvía')

  // Variante B: evento nuevo, el operador confirma NO ENTREGADO → re-ejecución segura (1 vez)
  transport.ambiguous = false
  const evB = inboundEvent('org_w', 'evt_w4_3b', '+573005556678', 'ASESOR')
  transport.ambiguous = true
  await assert.rejects(() => router.processInbound(evB), /resultado desconocido|AMBIGUOUS/i)
  const fxB = db.prepare("SELECT effect_key FROM inbound_effect_journal WHERE key='org_w::evt_w4_3b' AND status='IN_FLIGHT'").get() as { effect_key: string }
  router.resolveEffect('org_w::evt_w4_3b', fxB.effect_key, 'not_delivered', 'el daemon no lo registra')
  transport.ambiguous = false
  const recB = await router.reconcileEvent('org_w::evt_w4_3b')
  assert.ok(recB, 'la reconciliación tras not_delivered re-ejecuta el envío una vez')
  assert.strictEqual(transport.dispatched.length, 1, 're-ejecución segura: el mensaje sale UNA vez')
})

test('W4-04: clave de idempotencia EXTERNA determinista (evento+efecto) transmitida al transporte', async () => {
  const transport = new AmbiguousTransport()
  const crm = new RecordingCrm()
  const { router } = bootRouter(transport, crm)

  await router.processInbound(inboundEvent('org_w', 'evt_w4_4', '+573007778899', 'ASESOR'))
  const keyA = transport.dispatched[0].idempotencyKey
  assert.ok(keyA && keyA.length >= 8, 'el transporte recibe una clave de idempotencia externa')
  assert.ok(keyA.startsWith('wpfx_'), 'la clave usa el espacio reservado del sistema (wpfx_)')

  // Determinista: reingreso del MISMO evento (crash simulado + resolución) reutiliza LA MISMA clave
  transport.ambiguous = true
  await assert.rejects(() => router.processInbound(inboundEvent('org_w', 'evt_w4_4b', '+573007778898', 'ASESOR')), /AMBIGUOUS/i)
  const fxB = (router as unknown as { db: import('node:sqlite').DatabaseSync }).db
    .prepare("SELECT effect_key FROM inbound_effect_journal WHERE key='org_w::evt_w4_4b' AND status='IN_FLIGHT'").get() as { effect_key: string }
  router.resolveEffect('org_w::evt_w4_4b', fxB.effect_key, 'not_delivered')
  transport.ambiguous = false
  await router.reconcileEvent('org_w::evt_w4_4b')
  const keysForB = transport.dispatched.filter((d) => d.phone === '+573007778898').map((d) => d.idempotencyKey)
  assert.strictEqual(new Set(keysForB).size, 1, 'el MISMO efecto usa SIEMPRE la misma clave externa (dedup posible en el proveedor)')

  // Eventos distintos → claves distintas
  assert.notStrictEqual(keyA, keysForB[0], 'eventos distintos tienen claves externas distintas')
})

test('W4-04b: HttpAlbraTransportSender transmite idempotencyKey (body+header) y clasifica ECONNREFUSED como PREFLIGHT', async () => {
  let captured: { body: string; headers: Record<string, string | undefined> } | null = null
  const stub = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      captured = { body, headers: req.headers as Record<string, string | undefined> }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ messageId: 'stub_1' }))
    })
  })
  await new Promise<void>((r) => stub.listen(3083, () => r()))
  process.env.ALLOW_REAL_DISPATCH = 'true'
  try {
    const sender = new HttpAlbraTransportSender('http://localhost:3083', 'secret_demo_min24chars_000000')
    const out = await sender.sendMessage('+573000000000', 'hola', 'corr_1', 'wpfx_demo123')
    assert.ok(out.ok)
    const body = JSON.parse(captured!.body) as { idempotencyKey?: string }
    assert.strictEqual(body.idempotencyKey, 'wpfx_demo123', 'la clave viaja en el body para el daemon')
    assert.strictEqual(captured!.headers['x-idempotency-key'], 'wpfx_demo123', 'la clave viaja en el header')

    // Sin daemon (conexión rechazada): resultado DEFINITIVO de no-aceptación (PREFLIGHT), no ambigüedad
    const dead = new HttpAlbraTransportSender('http://localhost:39999', 'secret_demo_min24chars_000000')
    const refused = await dead.sendMessage('+573000000001', 'x', 'corr_2', 'wpfx_demo124')
    assert.strictEqual(refused.ok, false)
    assert.ok(String(refused.error).includes('PREFLIGHT'), 'ECONNREFUSED es no-aceptación definitiva (reintento seguro)')
  } finally {
    delete process.env.ALLOW_REAL_DISPATCH
    stub.close()
  }
})

// ---------------------------------------------------------------------------
// W4-B. IDENTIDAD POR ORGANIZACIÓN (INTERNAL_API_KEYS)
// ---------------------------------------------------------------------------
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'wp_t3_internal_secret_min24chars_00'
const AUTH = { 'Authorization': `Bearer ${process.env.INTERNAL_API_SECRET}` }

test('W4-05: INTERNAL_API_KEYS — clave dedicada por organización; el secreto global NO sirve para orgs con clave', async () => {
  process.env.INTERNAL_API_KEYS = JSON.stringify({
    org_a: 'clave_dedicada_orga_min24chars_01',
    org_b: 'clave_dedicada_orgb_min24chars_02',
  })
  const { server } = createAgenticServer({ dbPath: ':memory:' })
  await new Promise<void>((resolve) => server.listen(3084, () => resolve()))
  const base = 'http://localhost:3084'
  try {
    // Clave dedicada de org_a + X-Org-Id org_a → 200
    const okA = await fetch(`${base}/api/flows`, { headers: { 'Authorization': 'Bearer clave_dedicada_orga_min24chars_01', 'X-Org-Id': 'org_a' } })
    assert.strictEqual(okA.status, 200, 'la clave dedicada autentica a SU organización')

    // Clave dedicada de org_a + X-Org-Id org_b → 403 (la clave NO adopta otras orgs)
    const cross = await fetch(`${base}/api/flows`, { headers: { 'Authorization': 'Bearer clave_dedicada_orga_min24chars_01', 'X-Org-Id': 'org_b' } })
    assert.strictEqual(cross.status, 403, 'clave de org_a con X-Org-Id de org_b → 403 ORG_KEY_MISMATCH')

    // Secreto GLOBAL para org_a (que TIENE clave dedicada) → 403 (refuerzo)
    const legacyForA = await fetch(`${base}/api/flows`, { headers: { ...AUTH, 'X-Org-Id': 'org_a' } })
    assert.strictEqual(legacyForA.status, 403, 'el secreto global ya NO autoriza a orgs con clave dedicada (ORG_HAS_DEDICATED_KEY)')

    // Secreto GLOBAL para org_c (sin clave dedicada) → 200 (compatibilidad documentada)
    const legacyForC = await fetch(`${base}/api/flows`, { headers: { ...AUTH, 'X-Org-Id': 'org_c' } })
    assert.strictEqual(legacyForC.status, 200, 'orgs SIN clave dedicada conservan el acceso por secreto global')

    // Clave dedicada SIN X-Org-Id → 400 (la org se exige en el header y valida contra la clave)
    const noOrg = await fetch(`${base}/api/flows`, { headers: { 'Authorization': 'Bearer clave_dedicada_orga_min24chars_01' } })
    assert.strictEqual(noOrg.status, 400)

    // Bearer desconocido → 401
    const bad = await fetch(`${base}/api/flows`, { headers: { 'Authorization': 'Bearer clave_inexistente', 'X-Org-Id': 'org_a' } })
    assert.strictEqual(bad.status, 401)
  } finally {
    delete process.env.INTERNAL_API_KEYS
    server.close()
  }
})

test('W4-06: create-link con clave dedicada — el orgId del body debe ser el de la clave (fail-closed)', async () => {
  process.env.INTERNAL_API_KEYS = JSON.stringify({ org_pagos: 'clave_dedicada_pagos_min24chars_1' })
  const { server } = createAgenticServer({ dbPath: ':memory:' })
  await new Promise<void>((resolve) => server.listen(3085, () => resolve()))
  const base = 'http://localhost:3085'
  try {
    const key = { 'Authorization': 'Bearer clave_dedicada_pagos_min24chars_1', 'Content-Type': 'application/json' }
    // org correcta → 200 (simulador local, sin cobros reales)
    const ok = await fetch(`${base}/api/payments/create-link`, { method: 'POST', headers: { ...key, 'X-Org-Id': 'org_pagos' }, body: JSON.stringify({ orgId: 'org_pagos', contactPhone: '573001112233', amount: 5000, description: 'pago', gateway: 'simulator' }) })
    assert.strictEqual(ok.status, 200)

    // org AJENA en el body → 403
    const foreign = await fetch(`${base}/api/payments/create-link`, { method: 'POST', headers: { ...key, 'X-Org-Id': 'org_pagos' }, body: JSON.stringify({ orgId: 'org_ajena', contactPhone: '573001112233', amount: 5000, description: 'pago', gateway: 'simulator' }) })
    assert.strictEqual(foreign.status, 403, 'la clave dedicada no puede crear pagos para otra organización')
  } finally {
    delete process.env.INTERNAL_API_KEYS
    server.close()
  }
})
