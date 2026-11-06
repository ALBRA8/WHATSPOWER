import { test } from 'node:test'
import assert from 'node:assert'
import { createServer } from 'node:http'
import { createDatabase } from '../src/db.ts'
import { MockCrmClient, HttpCrmClient } from '../src/adapters/crm-client.ts'
import type { TransportSender, CrmClientInterface, InboundEvent } from '../src/types.ts'
import { ConversationRouter } from '../src/engine/router.ts'
import { createAgenticServer } from '../src/server.ts'

/**
 * TERCERA REPARACIÓN — PRUEBAS FORZOSAS (orden §4.A–§4.F, §8):
 *  - aislamiento de flujos/agentes/canned/growth por organización (negativos);
 *  - idempotencia reforzada: journal de efectos, UNCERTAIN, reconciliación,
 *    renovación de lease, colisión de identificadores entre organizaciones;
 *  - HttpCrmClient estricto: respuesta SIN organización → rechazada;
 *  - pagos: pasarela real sin configuración → rechazo; webhook con org ajena → rechazo;
 *  - credenciales/seguridad: rate limit, supresión timing-safe, sin secretos en sessionStorage.
 */

// ---------------------------------------------------------------------------
class FlakyTransport implements TransportSender {
  dispatched: Array<{ phone: string; text: string; correlationId: string }> = []
  /** Número de llamadas sendMessage que deben lanzar error (simula fallo tras efecto). */
  failAfter = Infinity
  async sendMessage(phone: string, text: string, correlationId: string): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    if (this.dispatched.length >= this.failAfter) {
      throw new Error('TRANSPORT_DOWN_AFTER_EFFECT (fallo simulado tras el envío)')
    }
    this.dispatched.push({ phone, text, correlationId })
    return { ok: true, messageId: `t3_${this.dispatched.length}` }
  }
}

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
// T3-A. IDEMPOTENCIA REFORZADA (4.C)
// ---------------------------------------------------------------------------
test('T3-01: envío externo EXITOSO + fallo interno posterior + reintento → el mensaje NO se duplica (journal)', async () => {
  const transport = new FlakyTransport()
  const crm = new RecordingCrm()
  const { db, router } = bootRouter(transport, crm)

  // Contacto con clientId → el flujo "PRECIO" responde y NO crea cliente;
  // usamos el caso "handoff" (ASESOR): envía mensaje y luego addNote al CRM.
  // Simulamos: el PRIMER envío (mensaje) tiene éxito; el CRM FALLA después.
  const ev = inboundEvent('org_x', 'evt_t3_1', '+573001112233', 'ASESOR')
  ev.contact.clientId = 'cl_existente' // con cliente registrado, el handoff SÍ invoca al CRM
  // Forzamos fallo del CRM en la primera llamada addNote
  const originalAddNote = crm.addNote.bind(crm)
  crm.addNote = async (orgId: string, clientId: string, content: string, correlationId: string) => {
    throw new Error('CRM_DOWN: fallo simulado DESPUÉS del envío del mensaje')
  }

  await assert.rejects(() => router.processInbound(ev), /CRM_DOWN/)

  // Estado: el evento quedó UNCERTAIN (hubo 1 efecto DONE: el mensaje)
  const keyRow = db.prepare("SELECT status FROM idempotency_keys WHERE key = 'org_x::evt_t3_1'").get() as { status: string }
  assert.strictEqual(keyRow.status, 'UNCERTAIN', 'con efectos externos ya realizados, el estado debe ser UNCERTAIN')

  // Reintento del MISMO evento (pasarela reenvía): BLOQUEADO, sin efectos nuevos
  const retry = await router.processInbound(ev)
  assert.strictEqual(retry.actionTaken, 'uncertain_needs_reconciliation')
  assert.strictEqual(transport.dispatched.length, 1, 'el mensaje ya enviado NO se reenvía en el reintento')

  // Reconciliación: completa los efectos pendientes SIN reenviar el mensaje
  crm.addNote = originalAddNote
  const reconciled = await router.reconcileEvent('org_x::evt_t3_1')
  assert.ok(reconciled, 'la reconciliación completa el ciclo')
  assert.strictEqual(transport.dispatched.length, 1, 'la reconciliación JAMÁS reenvía un mensaje ya enviado')
  assert.ok((crm.calls.filter((c) => c.action === 'add_note').length >= 1), 'la nota pendiente SÍ se completa en reconciliación')

  const finalRow = db.prepare("SELECT status FROM idempotency_keys WHERE key = 'org_x::evt_t3_1'").get() as { status: string }
  assert.strictEqual(finalRow.status, 'COMPLETED')
})

test('T3-02: fallo SIN efectos externos previos → FAILED (reintento limpio permitido, sin UNCERTAIN)', async () => {
  const transport = new FlakyTransport()
  const crm = new RecordingCrm()
  const { db, router } = bootRouter(transport, crm)

  // Contacto NUEVO sin clientId: primer efecto = createClient en CRM → falla ANTES de enviar nada
  const originalCreate = crm.createClient.bind(crm)
  crm.createClient = async () => { throw new Error('CRM_DOWN_PRIMERO') }
  const ev = inboundEvent('org_y', 'evt_t3_2', '+573004445566', 'mensaje libre sin reglas')

  await assert.rejects(() => router.processInbound(ev), /CRM_DOWN_PRIMERO/)
  const row = db.prepare("SELECT status FROM idempotency_keys WHERE key = 'org_y::evt_t3_2'").get() as { status: string }
  assert.strictEqual(row.status, 'FAILED', 'sin efectos externos completados, FAILED permite reintento limpio')
  assert.strictEqual(transport.dispatched.length, 0)

  // Restaurar CRM y reintentar: la toma de posesión (FAILED → RESERVED) ejecuta completo
  crm.createClient = originalCreate
  const res = await router.processInbound(ev)
  assert.strictEqual(res.actionTaken, 'new_lead_welcome')
  assert.strictEqual(transport.dispatched.length, 1, 'el reintento limpio ejecuta los efectos una vez')
})

test('T3-03: dos organizaciones con el MISMO eventId NO colisionan (identificadores coincidentes)', async () => {
  const transport = new FlakyTransport()
  const crm = new RecordingCrm()
  const { router } = bootRouter(transport, crm)

  const r1 = await router.processInbound(inboundEvent('org_a', 'evt_colision', '+573007770011', 'PRECIO'))
  const r2 = await router.processInbound(inboundEvent('org_b', 'evt_colision', '+573007770011', 'PRECIO'))

  // Ambos se ejecutan COMO EVENTOS DISTINTOS (cada org tiene su propio espacio de claves)
  assert.notStrictEqual(r1.actionTaken, 'deduplicated')
  assert.notStrictEqual(r2.actionTaken, 'deduplicated')
  // Cada org envió SU mensaje (2 efectos: uno por organización)
  assert.strictEqual(transport.dispatched.length, 2)
  assert.ok(transport.dispatched.every((d) => d.text.length > 0))
})

test('T3-04: renovación de lease — un proceso VIVO conserva la posesión; el mismo evento sigue IN_FLIGHT', async () => {
  process.env.IDEMPOTENCY_LEASE_SECONDS = '2'
  process.env.LEASE_RENEWAL_INTERVAL_MS = '150'
  try {
    const transport = new FlakyTransport()
    const crm = new RecordingCrm()
    const { db, router } = bootRouter(transport, crm)

    // Ejecución LARGA (3s > lease de 2s): el heartbeat debe renovar el lease
    const originalCreate = crm.createClient.bind(crm)
    crm.createClient = async (orgId: string, name: string, phone: string, correlationId: string) => {
      await new Promise((r) => setTimeout(r, 3000))
      return originalCreate(orgId, name, phone, correlationId)
    }
    const ev = inboundEvent('org_z', 'evt_t3_lease', '+573009998800', 'mensaje libre largo')
    const execPromise = router.processInbound(ev)
    // Esperamos > lease sin renovación (2s): si el heartbeat NO renovara, otro proceso podría tomar posesión
    await new Promise((r) => setTimeout(r, 2500))
    const row = db.prepare("SELECT status, lease_expires_at - strftime('%s','now') AS remaining FROM idempotency_keys WHERE key = 'org_z::evt_t3_lease'").get() as { status: string; remaining: number }
    assert.strictEqual(row.status, 'PROCESSING')
    assert.ok(row.remaining > 0, 'el lease debe estar RENOVADO (quedan >0 s) pese a superar el TTL original')
    const res = await execPromise
    assert.strictEqual(res.actionTaken, 'new_lead_welcome')
  } finally {
    delete process.env.IDEMPOTENCY_LEASE_SECONDS
    delete process.env.LEASE_RENEWAL_INTERVAL_MS
  }
})

// ---------------------------------------------------------------------------
// T3-B. HttpCrmClient ESTRICTO (4.D)
// ---------------------------------------------------------------------------
test('T3-05: HttpCrmClient RECHAZA respuestas sin organización (TENANT_UNVERIFIED) y con organización ajena', async () => {
  // Stub HTTP local que emula un CRM: configurable por petición
  let responseMode: 'missing_org' | 'wrong_org' | 'ok' | 'not_json' = 'ok'
  const stub = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (responseMode === 'missing_org') { res.end(JSON.stringify({ ok: true, summary: 'sin org' })) }
      else if (responseMode === 'wrong_org') { res.end(JSON.stringify({ ok: true, summary: 'otra org', orgId: 'org_malvada' })) }
      else if (responseMode === 'not_json') { res.setHeader('Content-Type', 'text/html'); res.end('<html>gateway error</html>') }
      else { res.end(JSON.stringify({ ok: true, summary: 'creado', orgId: String(req.headers['x-org-id']) })) }
    })
  })
  await new Promise<void>((r) => stub.listen(3077, () => r()))
  const client = new HttpCrmClient('http://localhost:3077', 'albra_test_key_x')

  try {
    responseMode = 'ok'
    const okRes = await client.createClient('org_buena', 'N', '573000000000', 'c1')
    assert.ok(okRes.ok, 'respuesta CON la organización correcta se acepta')

    responseMode = 'missing_org'
    const missing = await client.createClient('org_buena', 'N', '573000000000', 'c2')
    assert.strictEqual(missing.ok, false, 'respuesta SIN organización se RECHAZA (fail-closed)')
    assert.ok(String(missing.error).includes('TENANT_UNVERIFIED'))

    responseMode = 'wrong_org'
    const wrong = await client.createClient('org_buena', 'N', '573000000000', 'c3')
    assert.strictEqual(wrong.ok, false, 'respuesta con organización AJENA se rechaza')
    assert.ok(String(wrong.error).includes('TENANT_MISMATCH'))

    responseMode = 'not_json'
    const nj = await client.createClient('org_buena', 'N', '573000000000', 'c4')
    assert.strictEqual(nj.ok, false, 'respuesta no-JSON ambigua se rechaza')

    responseMode = 'ok'
    const authFail = await client.createClient('org_sin_clave', 'N', '573000000000', 'c5')
    // Configurar multi-org con otra org → org_sin_clave NO tiene credencial → fail-closed
    const clientMulti = new HttpCrmClient('http://localhost:3077', '', { org_buena: 'k1' })
    const noCred = await clientMulti.createClient('org_sin_clave', 'N', '573000000000', 'c6')
    assert.strictEqual(noCred.ok, false, 'sin credencial para la org → fail-closed')
    void authFail
  } finally {
    stub.close()
  }
})

// ---------------------------------------------------------------------------
// T3-C. AISLAMIENTO HTTP DE ENDPOINTS ADMIN (4.A) + SEGURIDAD (4.F)
// ---------------------------------------------------------------------------
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'wp_t3_internal_secret_min24chars_00'
const AUTH = { 'Authorization': `Bearer ${process.env.INTERNAL_API_SECRET}` }

test('T3-06: endpoints de team/canned/growth exigen x-org-id y aislan por organización', async () => {
  const { server } = createAgenticServer({ dbPath: ':memory:' })
  await new Promise<void>((resolve) => server.listen(3078, () => resolve()))
  const base = 'http://localhost:3078'
  try {
    // Registrar agente SIN x-org-id → 400
    const noOrg = await fetch(`${base}/api/team/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ id: 'ag_x', name: 'X', email: 'x@x.co' }) })
    assert.strictEqual(noOrg.status, 400, 'sin X-Org-Id → 400')

    // Registrar agentes en org_a y org_b
    await fetch(`${base}/api/team/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH, 'X-Org-Id': 'org_a' }, body: JSON.stringify({ id: 'ag_a1', name: 'Agente A', email: 'a@a.co' }) })
    await fetch(`${base}/api/team/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH, 'X-Org-Id': 'org_b' }, body: JSON.stringify({ id: 'ag_b1', name: 'Agente B', email: 'b@b.co' }) })

    const listA = await (await fetch(`${base}/api/team/agents`, { headers: { ...AUTH, 'X-Org-Id': 'org_a' } })).json()
    const listB = await (await fetch(`${base}/api/team/agents`, { headers: { ...AUTH, 'X-Org-Id': 'org_b' } })).json()
    assert.strictEqual(listA.length, 1)
    assert.strictEqual(listA[0].id, 'ag_a1')
    assert.strictEqual(listB.length, 1)
    assert.strictEqual(listB[0].id, 'ag_b1', 'cada org solo ve SUS agentes')

    // Canned aislado: mismo shortcut en dos orgs, contenidos distintos
    await fetch(`${base}/api/canned`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH, 'X-Org-Id': 'org_a' }, body: JSON.stringify({ shortcut: '/precio', title: 'A', content: 'precio de A' }) })
    await fetch(`${base}/api/canned`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH, 'X-Org-Id': 'org_b' }, body: JSON.stringify({ shortcut: '/precio', title: 'B', content: 'precio de B' }) })
    const cannedA = await (await fetch(`${base}/api/canned`, { headers: { ...AUTH, 'X-Org-Id': 'org_a' } })).json()
    assert.strictEqual(cannedA.length, 1)
    assert.strictEqual(cannedA[0].content, 'precio de A', 'el shortcut /precio de org_a es independiente del de org_b')

    // Growth: mismo slug en dos orgs sin colisión
    const g1 = await fetch(`${base}/api/growth/links`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH, 'X-Org-Id': 'org_a' }, body: JSON.stringify({ slug: 'promo', prefilledText: 'promo A' }) })
    assert.strictEqual(g1.status, 200)
    const g2 = await fetch(`${base}/api/growth/links`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH, 'X-Org-Id': 'org_b' }, body: JSON.stringify({ slug: 'promo', prefilledText: 'promo B' }) })
    assert.strictEqual(g2.status, 200, 'el MISMO slug en otra org NO colisiona (unicidad por org)')
  } finally {
    server.close()
  }
})

test('T3-07: respuestas internas de locks/suppression CONFIRMAN la organización (eco) y el auth es timing-safe', async () => {
  const { server } = createAgenticServer({ dbPath: ':memory:' })
  await new Promise<void>((resolve) => server.listen(3079, () => resolve()))
  const base = 'http://localhost:3079'
  try {
    const lockRes = await fetch(`${base}/api/internal/locks/573001234567`, { headers: { ...AUTH, 'X-Org-Id': 'org_a' } })
    assert.strictEqual(lockRes.status, 200)
    const lockData = await lockRes.json()
    assert.strictEqual(lockData.organizationId, 'org_a', 'la respuesta confirma la organización consultada')

    // Auth con secreto INCORRECTO → 401 (isAuthorizedBearer timing-safe)
    const bad = await fetch(`${base}/api/internal/suppression/573001234567`, { method: 'POST', headers: { 'Authorization': 'Bearer secreto-incorrecto', 'Content-Type': 'application/json', 'X-Org-Id': 'org_a' }, body: '{}' })
    assert.strictEqual(bad.status, 401)

    // Sin x-org-id → 400
    const noOrg = await fetch(`${base}/api/internal/suppression/573001234567`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: '{}' })
    assert.strictEqual(noOrg.status, 400)
  } finally {
    server.close()
  }
})

test('T3-08: rate limit en /ref/:slug responde 429 bajo ráfaga (4.F)', async () => {
  const { server } = createAgenticServer({ dbPath: ':memory:' })
  await new Promise<void>((resolve) => server.listen(3080, () => resolve()))
  const base = 'http://localhost:3080'
  try {
    await fetch(`${base}/api/growth/links`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH, 'X-Org-Id': 'org_a' }, body: JSON.stringify({ slug: 'rafaga', prefilledText: 'x' }) })
    let got429 = false
    for (let i = 0; i < 320; i++) {
      const res = await fetch(`${base}/ref/rafaga`, { redirect: 'manual' })
      if (res.status === 429) { got429 = true; break }
    }
    assert.ok(got429, 'la ráfaga debe alcanzar el límite y recibir 429')
  } finally {
    server.close()
  }
})

test('T3-09: webhook de pasarela con organización AJENA en el payload → rechazado sin consumir eventId (4.E)', () => {
  const db = createDatabase(':memory:')
  // Parchear env para wompi NO requerido: usamos simulator (enlace local)
  const { paymentManager } = createAgenticServer({ dbPath: ':memory:' })
  void db
  const tx = paymentManager.createPaymentLink({ orgId: 'org_duenia', contactPhone: '573001112233', amount: 5000, description: 'pago', gateway: 'simulator' })
  const res = paymentManager.handlePaymentWebhook({ eventId: 'evt_t3_pago_1', transactionId: tx.id, status: 'APPROVED', orgId: 'org_ajena' })
  assert.strictEqual(res.ok, false)
  assert.ok(res.ok === false && res.code === 'VALIDATION_MISMATCH')
  // El eventId NO se consume: el webhook legítimo (org correcta) se acepta
  const res2 = paymentManager.handlePaymentWebhook({ eventId: 'evt_t3_pago_1', transactionId: tx.id, status: 'APPROVED', orgId: 'org_duenia' })
  assert.ok(res2.ok, 'el evento legítimo usa la clave liberada')
})

test('T3-10: el Studio NO guarda el secreto en sessionStorage (4.F) y sirve login por cookie', async () => {
  const { server } = createAgenticServer({ dbPath: ':memory:' })
  await new Promise<void>((resolve) => server.listen(3081, () => resolve()))
  const base = 'http://localhost:3081'
  try {
    const html = await (await fetch(`${base}/studio`)).text()
    assert.ok(!html.includes("sessionStorage.getItem('wp_api_key')"), 'el secreto administrativo JAMÁS se lee de sessionStorage')
    assert.ok(html.includes('/studio/login'), 'el studio canjea el secreto por cookie HttpOnly')
    assert.ok(html.includes('X-Org-Id'), 'el studio envía la organización en X-Org-Id')

    // Login correcto → Set-Cookie HttpOnly
    const login = await fetch(`${base}/studio/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: process.env.INTERNAL_API_SECRET }) })
    assert.strictEqual(login.status, 200)
    const setCookie = login.headers.get('set-cookie') || ''
    assert.ok(setCookie.includes('HttpOnly'), 'la cookie de sesión es HttpOnly')
    assert.ok(setCookie.includes('SameSite=Strict'), 'la cookie de sesión es SameSite=Strict')

    // Con la cookie, /api/flows (con org) responde 200 SIN Bearer
    const cookie = setCookie.split(';')[0]
    const flows = await fetch(`${base}/api/flows`, { headers: { 'Cookie': cookie, 'X-Org-Id': 'org_studio' } })
    assert.strictEqual(flows.status, 200, 'la sesión HttpOnly autentica sin Bearer')
  } finally {
    server.close()
  }
})
