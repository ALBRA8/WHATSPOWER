/**
 * (ronda 17, pasos 1-2) DASHBOARD PANEL SECURITY — Invariantes de aislamiento
 * multi-organización para los endpoints de lectura/lista que el dashboard Next.js
 * consume. Estilo: servidor real + SQLite ':memory:' (sin red, sin mocks en la
 * lógica bajo prueba). El transporte y el CRM son mocks que sólo documentan el
 * cable; la seguridad se ejercita contra el código real.
 *
 * Contratos verificados (ronda 17):
 *  DPS-01  Cualquier /api/* no público sin Bearer válido → 401 (puerta fail-closed).
 *  DPS-02  Cualquier endpoint nuevo SIN X-Org-Id → 400 (requireOrgHeader fail-closed).
 *  DPS-03  GET /api/inbox con X-Org-Id=X devuelve EXCLUSIVAMENTE mensajes de X.
 *  DPS-04  GET /api/locks con X-Org-Id=X devuelve EXCLUSIVAMENTE locks de X.
 *  DPS-05  GET /api/suppressions con X-Org-Id=X devuelve EXCLUSIVAMENTE supresiones de X.
 *  DPS-06  GET /api/metrics con X-Org-Id=X devuelve KPIs calculados SOLO sobre filas de X.
 *  DPS-07  GET /api/realtime/stats con X-Org-Id=X devuelve contadores (sin leak de secretos).
 *  DPS-08  GET /api/sequences con X-Org-Id=X devuelve SOLO secuencias de X.
 *  DPS-09  GET /api/contacts con X-Org-Id=X devuelve SOLO contactos de X (con tags/CF propios).
 *  DPS-10  GET /api/audit con X-Org-Id=X devuelve SOLO automation_events de X.
 *  DPS-11  Ninguna respuesta contiene el secreto del Bearer ni el webhook secret.
 *  DPS-12  GET /api/inbox con ?phone= filtra por contacto dentro de la org autenticada.
 *  DPS-13  POST /api/contacts con X-Org-Id=X crea el contacto SOLO en X (X no lo ve en Y).
 *  DPS-14  POST /api/sequences con X-Org-Id=X crea la secuencia SOLO en X (Y no la lista).
 *  DPS-15  El símbolo '__legacy__' NO se acepta como X-Org-Id (espacio reservado).
 *
 * Sin red: usa SQLite ':memory:'. Sin mocks en la lógica bajo prueba: el servidor
 * real con createAgenticServer() y los endpoints reales.
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { createAgenticServer } from '../src/server.ts'

// Re-usamos los mocks canónicos del repo (no se redefinen aquí).
import { MockTransportSender as MT } from '../src/adapters/transport.ts'
import { MockCrmClient as MC } from '../src/adapters/crm-client.ts'

const ORG_X = 'org_panel_x'
const ORG_Y = 'org_panel_y'
const SECRET_X = 'panel_secret_org_x_min_24_chars_0123'
const SECRET_Y = 'panel_secret_org_y_min_24_chars_0123'
const CRED_X = 'panel_cred_org_x_admin_min_32_chars_0123456789'
const CRED_Y = 'panel_cred_org_y_admin_min_32_chars_0123456789'

interface BootResult {
  server: ReturnType<typeof createAgenticServer>['server']
  db: ReturnType<typeof createAgenticServer>['db']
  router: ReturnType<typeof createAgenticServer>['router']
  restore: () => void
}

function bootPanelServer(): BootResult {
  const prevSecrets = process.env.WEBHOOK_SECRETS
  const prevKeys = process.env.INTERNAL_API_KEYS
  const prevAllowMock = process.env.ALLOW_MOCK_TRANSPORT
  process.env.WEBHOOK_SECRETS = `${ORG_X}:${SECRET_X},${ORG_Y}:${SECRET_Y}`
  process.env.INTERNAL_API_KEYS = `${ORG_X}:${CRED_X}:admin,${ORG_Y}:${CRED_Y}:admin`
  process.env.ALLOW_MOCK_TRANSPORT = 'true'
  const { server, db, router } = createAgenticServer({
    dbPath: ':memory:',
    transport: new MT(),
    crm: new MC(),
  })
  return {
    server, db, router,
    restore: () => {
      if (prevSecrets === undefined) delete process.env.WEBHOOK_SECRETS; else process.env.WEBHOOK_SECRETS = prevSecrets
      if (prevKeys === undefined) delete process.env.INTERNAL_API_KEYS; else process.env.INTERNAL_API_KEYS = prevKeys
      if (prevAllowMock === undefined) delete process.env.ALLOW_MOCK_TRANSPORT; else process.env.ALLOW_MOCK_TRANSPORT = prevAllowMock
    },
  }
}

async function listenEphemeral(server: { listen: (port: number, host: string, cb: () => void) => void; address: () => unknown }): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as { port: number }
  return `http://127.0.0.1:${addr.port}`
}

/** Siembra datos de prueba en ambas orgs, distintos por organización. */
function seedPanelData(db: BootResult['db']): void {
  const now = Date.now()
  // Inbox: X tiene 2 inbound + 1 outbound, Y tiene 1 inbound
  db.prepare('INSERT INTO inbox_messages (id, organization_id, contact_phone, direction, text, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('ix1', ORG_X, '+573100000001', 'inbound', 'Hola desde X', now - 5000)
  db.prepare('INSERT INTO inbox_messages (id, organization_id, contact_phone, direction, text, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('ix2', ORG_X, '+573100000001', 'outbound', 'Bienvenido a X', now - 4000)
  db.prepare('INSERT INTO inbox_messages (id, organization_id, contact_phone, direction, text, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('ix3', ORG_X, '+573100000002', 'inbound', 'Precio?', now - 3000)
  db.prepare('INSERT INTO inbox_messages (id, organization_id, contact_phone, direction, text, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('iy1', ORG_Y, '+573100000001', 'inbound', 'Hola desde Y (mismo teléfono, OTRA org)', now - 2000)

  // Locks: X tiene un IN_FLOW_2A activo, Y tiene un HANDOFF_HUMAN
  db.prepare('INSERT INTO conversation_locks (organization_id, contact_phone, current_state, locked_at, expires_at, correlation_id) VALUES (?, ?, ?, ?, ?, ?)').run(ORG_X, '+573100000001', 'IN_FLOW_2A', now - 1000, now + 60000, 'corr_x_1')
  db.prepare('INSERT INTO conversation_locks (organization_id, contact_phone, current_state, locked_at, expires_at, correlation_id) VALUES (?, ?, ?, ?, ?, ?)').run(ORG_Y, '+573100000099', 'HANDOFF_HUMAN', now - 2000, now + 60000, 'corr_y_1')

  // Supresiones: X tiene 1, Y tiene 1
  db.prepare('INSERT INTO suppression_list (organization_id, phone, reason, created_at) VALUES (?, ?, ?, ?)').run(ORG_X, '+573100000077', 'opt_out', now - 1000)
  db.prepare('INSERT INTO suppression_list (organization_id, phone, reason, created_at) VALUES (?, ?, ?, ?)').run(ORG_Y, '+573100000088', 'opt_out', now - 500)

  // Tags: X tiene 'vip' en un contacto, Y tiene 'lead' en otro
  db.prepare('INSERT INTO contact_tags (organization_id, contact_phone, tag_name, created_at) VALUES (?, ?, ?, ?)').run(ORG_X, '+573100000001', 'vip', now)
  db.prepare('INSERT INTO contact_tags (organization_id, contact_phone, tag_name, created_at) VALUES (?, ?, ?, ?)').run(ORG_Y, '+573100000099', 'lead', now)

  // Custom fields: X tiene 'name' en un contacto
  db.prepare('INSERT INTO contact_custom_fields (organization_id, contact_phone, field_key, field_value, updated_at) VALUES (?, ?, ?, ?, ?)').run(ORG_X, '+573100000001', 'name', 'Cliente X', now)

  // Secuencias: X tiene 1 activa, Y tiene 1 inactiva
  db.prepare('INSERT INTO sequences (id, organization_id, name, is_active, created_at) VALUES (?, ?, ?, ?, ?)').run('seq_x_1', ORG_X, 'Bienvenida X', 1, now - 1000)
  db.prepare('INSERT INTO sequences (id, organization_id, name, is_active, created_at) VALUES (?, ?, ?, ?, ?)').run('seq_y_1', ORG_Y, 'Bienvenida Y', 0, now - 500)

  // Automation events: X y Y
  db.prepare('INSERT INTO automation_events (id, organization_id, event_key, stage, action, status, detail, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('ae_x_1', ORG_X, 'evt_x', 'stage_a', 'send', 'OK', 'detalle X', 'msg_x', now)
  db.prepare('INSERT INTO automation_events (id, organization_id, event_key, stage, action, status, detail, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('ae_y_1', ORG_Y, 'evt_y', 'stage_b', 'send', 'OK', 'detalle Y', 'msg_y', now)
}

async function getJson(base: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; data: any; text: string }> {
  const res = await fetch(`${base}${path}`, { method: 'GET', headers })
  const text = await res.text()
  let data: any = null
  try { data = JSON.parse(text) } catch { /* dejar null */ }
  return { status: res.status, data, text }
}

async function postJson(base: string, path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; data: any; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = null
  try { data = JSON.parse(text) } catch { /* dejar null */ }
  return { status: res.status, data, text }
}

test('DPS-01: cualquier /api/* no público sin Bearer válido → 401', async () => {
  const { server, restore } = bootPanelServer()
  const base = await listenEphemeral(server)
  try {
    // Sin Authorization
    const r1 = await getJson(base, '/api/inbox', { 'X-Org-Id': ORG_X })
    assert.strictEqual(r1.status, 401, `/api/inbox sin Bearer debe ser 401 (fue ${r1.status})`)
    // Bearer inválido
    const r2 = await getJson(base, '/api/inbox', { 'X-Org-Id': ORG_X, Authorization: 'Bearer credencial_inventada' })
    assert.strictEqual(r2.status, 401)
    // Cada endpoint nuevo respeta la puerta
    for (const p of ['/api/locks', '/api/suppressions', '/api/metrics', '/api/realtime/stats', '/api/sequences', '/api/contacts', '/api/audit']) {
      const r = await getJson(base, p, { 'X-Org-Id': ORG_X })
      assert.strictEqual(r.status, 401, `${p} sin Bearer debe ser 401 (fue ${r.status})`)
    }
  } finally { server.close(); restore() }
})

test('DPS-02: cualquier endpoint nuevo SIN X-Org-Id → 400', async () => {
  const { server, restore } = bootPanelServer()
  const base = await listenEphemeral(server)
  try {
    const cred = CRED_X
    for (const p of ['/api/inbox', '/api/locks', '/api/suppressions', '/api/metrics', '/api/realtime/stats', '/api/sequences', '/api/contacts', '/api/audit']) {
      const r = await getJson(base, p, { Authorization: `Bearer ${cred}` })
      assert.strictEqual(r.status, 400, `${p} sin X-Org-Id debe ser 400 (fue ${r.status})`)
      assert.ok(String(r.data?.error || '').includes('x-org-id'), `${p} debe explicar que falta x-org-id`)
    }
  } finally { server.close(); restore() }
})

test('DPS-15: __legacy__ NO se acepta como X-Org-Id (espacio reservado)', async () => {
  const { server, restore } = bootPanelServer()
  const base = await listenEphemeral(server)
  try {
    const r = await getJson(base, '/api/inbox', { Authorization: `Bearer ${CRED_X}`, 'X-Org-Id': '__legacy__' })
    // 400 (requireOrgHeader rechaza el espacio reservado) o 403 (si la validación
    // posterior detecta que la credencial no es de __legacy__). En ambos casos
    // la petición NO se procesa: el espacio reservado jamás opera.
    assert.ok(r.status === 400 || r.status === 403, `__legacy__ debe rechazarse (fue ${r.status})`)
  } finally { server.close(); restore() }
})

test('DPS-03 a DPS-10: aislamiento multi-org en TODOS los endpoints de lista', async () => {
  const { server, db, restore } = bootPanelServer()
  const base = await listenEphemeral(server)
  try {
    seedPanelData(db)
    const headersX = { Authorization: `Bearer ${CRED_X}`, 'X-Org-Id': ORG_X }
    const headersY = { Authorization: `Bearer ${CRED_Y}`, 'X-Org-Id': ORG_Y }

    // DPS-03 /api/inbox
    const rIX = await getJson(base, '/api/inbox?limit=500', headersX)
    assert.strictEqual(rIX.status, 200)
    assert.ok(Array.isArray(rIX.data.messages))
    const ixPhones = new Set(rIX.data.messages.map((m: any) => m.contactPhone))
    assert.ok(ixPhones.has('+573100000001'), 'X debe ver su propio contacto +573100000001')
    assert.ok(!rIX.data.messages.some((m: any) => m.text === 'Hola desde Y (mismo teléfono, OTRA org)'), 'X NO debe ver el mensaje de Y aunque sea el mismo teléfono')
    const rIY = await getJson(base, '/api/inbox?limit=500', headersY)
    assert.strictEqual(rIY.status, 200)
    assert.ok(rIY.data.messages.some((m: any) => m.text === 'Hola desde Y (mismo teléfono, OTRA org)'), 'Y debe ver su propio mensaje')
    assert.ok(!rIY.data.messages.some((m: any) => m.text === 'Hola desde X'), 'Y NO debe ver mensajes de X')

    // DPS-12 /api/inbox?phone= filtra dentro de la org
    const rIXfilter = await getJson(base, '/api/inbox?phone=%2B573100000001', headersX)
    assert.strictEqual(rIXfilter.status, 200)
    assert.ok(rIXfilter.data.messages.every((m: any) => m.contactPhone === '+573100000001'), 'filtro por phone respeta la org')

    // DPS-04 /api/locks
    const rLX = await getJson(base, '/api/locks', headersX)
    assert.strictEqual(rLX.status, 200)
    assert.ok(rLX.data.locks.every((l: any) => l.contactPhone === '+573100000001'), 'X sólo ve su lock')
    assert.ok(!rLX.data.locks.some((l: any) => l.contactPhone === '+573100000099'), 'X no ve el lock de Y')
    const rLY = await getJson(base, '/api/locks', headersY)
    assert.ok(rLY.data.locks.some((l: any) => l.contactPhone === '+573100000099'), 'Y ve su lock')

    // DPS-05 /api/suppressions
    const rSX = await getJson(base, '/api/suppressions', headersX)
    assert.strictEqual(rSX.status, 200)
    assert.ok(rSX.data.suppressions.every((s: any) => s.phone === '+573100000077'), 'X sólo ve su supresión')
    const rSY = await getJson(base, '/api/suppressions', headersY)
    assert.ok(rSY.data.suppressions.some((s: any) => s.phone === '+573100000088'), 'Y ve su supresión')

    // DPS-06 /api/metrics (conteos sólo de la org)
    const rMX = await getJson(base, '/api/metrics', headersX)
    assert.strictEqual(rMX.status, 200)
    assert.strictEqual(rMX.data.messages.inboundTotal, 2, 'X tiene 2 inbound')
    assert.strictEqual(rMX.data.messages.outboundTotal, 1, 'X tiene 1 outbound')
    assert.strictEqual(rMX.data.suppressions, 1, 'X tiene 1 supresión')
    const rMY = await getJson(base, '/api/metrics', headersY)
    assert.strictEqual(rMY.data.messages.inboundTotal, 1, 'Y tiene 1 inbound (no ve los de X)')
    assert.strictEqual(rMY.data.suppressions, 1, 'Y tiene 1 supresión')

    // DPS-07 /api/realtime/stats (sin leak)
    const rRX = await getJson(base, '/api/realtime/stats', headersX)
    assert.strictEqual(rRX.status, 200)
    assert.ok(typeof rRX.data.clients === 'number')
    assert.ok(typeof rRX.data.messagesSent === 'number')

    // DPS-08 /api/sequences
    const rQX = await getJson(base, '/api/sequences', headersX)
    assert.strictEqual(rQX.status, 200)
    assert.ok(Array.isArray(rQX.data))
    const seqIdsX = rQX.data.map((s: any) => s.id)
    assert.ok(seqIdsX.includes('seq_x_1'), 'X ve su secuencia')
    assert.ok(!seqIdsX.includes('seq_y_1'), 'X no ve la secuencia de Y')
    const rQY = await getJson(base, '/api/sequences', headersY)
    assert.ok(rQY.data.some((s: any) => s.id === 'seq_y_1'), 'Y ve su secuencia')
    assert.ok(!rQY.data.some((s: any) => s.id === 'seq_x_1'), 'Y no ve la secuencia de X')

    // DPS-09 /api/contacts
    const rCX = await getJson(base, '/api/contacts', headersX)
    assert.strictEqual(rCX.status, 200)
    const phonesX = rCX.data.contacts.map((c: any) => c.phone)
    assert.ok(phonesX.includes('+573100000001'), 'X ve su contacto')
    // Y tiene un mensaje inbound del MISMO teléfono, debe verlo en su lista (aislamiento: mismo teléfono, distinta org)
    const rCY = await getJson(base, '/api/contacts', headersY)
    const phonesY = rCY.data.contacts.map((c: any) => c.phone)
    assert.ok(phonesY.includes('+573100000001'), 'Y ve el mismo teléfono (es suyo en su tabla)')
    // Pero los tags del contacto en X ('vip') no deben aparecer en Y
    const contactY = rCY.data.contacts.find((c: any) => c.phone === '+573100000001')
    assert.ok(!contactY.tags.includes('vip'), 'Y no ve los tags de X (aislamiento por org en contact_tags)')
    assert.ok(!contactY.customFields.name, 'Y no ve los custom fields de X')

    // DPS-10 /api/audit
    const rAX = await getJson(base, '/api/audit', headersX)
    assert.strictEqual(rAX.status, 200)
    assert.ok(rAX.data.events.every((e: any) => e.id !== 'ae_y_1'), 'X no ve los events de Y')
    const rAY = await getJson(base, '/api/audit', headersY)
    assert.ok(rAY.data.events.some((e: any) => e.id === 'ae_y_1'), 'Y ve su event')
    assert.ok(!rAY.data.events.some((e: any) => e.id === 'ae_x_1'), 'Y no ve events de X')
  } finally { server.close(); restore() }
})

test('DPS-13: POST /api/contacts crea el contacto SOLO en la org autenticada', async () => {
  const { server, db, restore } = bootPanelServer()
  const base = await listenEphemeral(server)
  try {
    const headersX = { Authorization: `Bearer ${CRED_X}`, 'X-Org-Id': ORG_X, 'Content-Type': 'application/json' }
    const headersY = { Authorization: `Bearer ${CRED_Y}`, 'X-Org-Id': ORG_Y, 'Content-Type': 'application/json' }
    const phone = '+573100000123'
    const r = await postJson(base, '/api/contacts', { phone, name: 'Test X', tags: ['nuevo'] }, headersX)
    assert.strictEqual(r.status, 201)
    // X lo ve
    const rX = await getJson(base, '/api/contacts', headersX)
    assert.ok(rX.data.contacts.some((c: any) => c.phone === phone && c.tags.includes('nuevo')), 'X ve su contacto creado')
    // Y NO lo ve
    const rY = await getJson(base, '/api/contacts', headersY)
    assert.ok(!rY.data.contacts.some((c: any) => c.phone === phone), 'Y no ve el contacto creado en X')
  } finally { server.close(); restore() }
})

test('DPS-14: POST /api/sequences crea la secuencia SOLO en la org autenticada', async () => {
  const { server, restore } = bootPanelServer()
  const base = await listenEphemeral(server)
  try {
    const headersX = { Authorization: `Bearer ${CRED_X}`, 'X-Org-Id': ORG_X, 'Content-Type': 'application/json' }
    const headersY = { Authorization: `Bearer ${CRED_Y}`, 'X-Org-Id': ORG_Y, 'Content-Type': 'application/json' }
    const seq = { id: 'seq_test_dps14', name: 'Seq Test DPS14', isActive: true, steps: [] }
    const r = await postJson(base, '/api/sequences', seq, headersX)
    assert.strictEqual(r.status, 201)
    const rX = await getJson(base, '/api/sequences', headersX)
    assert.ok(rX.data.some((s: any) => s.id === 'seq_test_dps14'), 'X ve su secuencia creada')
    const rY = await getJson(base, '/api/sequences', headersY)
    assert.ok(!rY.data.some((s: any) => s.id === 'seq_test_dps14'), 'Y no ve la secuencia creada en X')
  } finally { server.close(); restore() }
})

test('DPS-11: ninguna respuesta contiene el Bearer secret ni el webhook secret', async () => {
  const { server, db, restore } = bootPanelServer()
  const base = await listenEphemeral(server)
  try {
    seedPanelData(db)
    const headersX = { Authorization: `Bearer ${CRED_X}`, 'X-Org-Id': ORG_X }
    for (const p of ['/api/inbox', '/api/locks', '/api/suppressions', '/api/metrics', '/api/realtime/stats', '/api/sequences', '/api/contacts', '/api/audit']) {
      const r = await getJson(base, p, headersX)
      const blob = r.text + JSON.stringify(r.data || {})
      assert.ok(!blob.includes(CRED_X), `${p} NO debe filtrar CRED_X`)
      assert.ok(!blob.includes(CRED_Y), `${p} NO debe filtrar CRED_Y`)
      assert.ok(!blob.includes(SECRET_X), `${p} NO debe filtrar SECRET_X`)
      assert.ok(!blob.includes(SECRET_Y), `${p} NO debe filtrar SECRET_Y`)
    }
  } finally { server.close(); restore() }
})

test('DPS-EXTRA: POST /api/sequences con organizationId del body contradictorio → 403', async () => {
  const { server, restore } = bootPanelServer()
  const base = await listenEphemeral(server)
  try {
    const headersX = { Authorization: `Bearer ${CRED_X}`, 'X-Org-Id': ORG_X, 'Content-Type': 'application/json' }
    const r = await postJson(base, '/api/sequences', { id: 'seq_conflict', name: 'X', organizationId: ORG_Y }, headersX)
    assert.strictEqual(r.status, 403, 'organizationId del body que choca con X-Org-Id debe ser 403')
  } finally { server.close(); restore() }
})
