/**
 * PANEL — SEGURIDAD Y ORDEN (capa nueva del dashboard).
 *
 * Qué se comprueba, y por qué importa:
 *  D-01  El panel se sirve (página y recursos) sin filtrar rutas.
 *  D-02  Sin credencial no hay datos (401 antes de tocar nada).
 *  D-03  Un asesor NO puede difundir: 403 y el intento queda anotado.
 *  D-04  Una difusión real exige confirm: true (sin él, 400 y nada se envía).
 *  D-05  Toda acción sensible deja rastro: acción, actor, resultado e IP.
 *  D-06  El rastro guarda el teléfono ENMASCARADO, nunca completo.
 *  D-07  Un teléfono que no es un teléfono se rechaza con 400.
 *  D-08  Un asesor no puede leer la auditoría; administración sí.
 *  D-09  La auditoría está aislada por organización.
 *  D-10  Un contacto dado de baja no recibe respuesta manual (409).
 *
 * Servidor REAL (createAgenticServer) contra SQLite en memoria.
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { createAgenticServer } from '../src/server.ts'

const GLOBAL_SECRET = 'wp_panel_secret_min24chars_000000' // scan-secrets:allow
const ORG_A = 'org_panel_a'
const CRED_A_ADMIN = 'panel-admin-credential-00000000000001'
const CRED_A_AGENT = 'panel-agent-credential-00000000000002'
const ORG_B = 'org_panel_b'
const CRED_B_ADMIN = 'panel-org-b-credential-00000000000003'

const PHONE = '5215512345678'

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  process.env.INTERNAL_API_SECRET = GLOBAL_SECRET
  process.env.INTERNAL_API_KEYS = `${ORG_A}:${CRED_A_ADMIN}:admin,${ORG_A}:${CRED_A_AGENT}:agent,${ORG_B}:${CRED_B_ADMIN}:admin`
  process.env.TRANSPORT = 'mock'
  const { server } = createAgenticServer({ dbPath: ':memory:' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  try {
    await fn(base)
  } finally {
    ;(server as any).closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    delete process.env.INTERNAL_API_KEYS
  }
}

function headers(org: string, cred: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Org-Id': org, Authorization: `Bearer ${cred}` }
}

async function call(
  base: string,
  path: string,
  org: string,
  cred: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method || 'GET',
    headers: headers(org, cred),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  return { status: res.status, body }
}

test('D-01: el panel se sirve sin exponer rutas internas', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/dashboard`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') || '', /text\/html/)
    const html = await page.text()
    assert.match(html, /WhatsPower/)

    const js = await fetch(`${base}/dashboard/assets/app.js`)
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type') || '', /javascript/)

    const missing = await fetch(`${base}/dashboard/assets/no-existe.js`)
    assert.equal(missing.status, 404)
  })
})

test('D-02: sin credencial no se entrega ningún dato del panel', async () => {
  await withServer(async (base) => {
    const anon = await fetch(`${base}/api/dashboard/overview`, { headers: { 'X-Org-Id': ORG_A } })
    assert.equal(anon.status, 401)
    const noOrg = await call(base, '/api/dashboard/overview', '', CRED_A_ADMIN)
    assert.ok([400, 403].includes(noOrg.status), `esperaba 400/403, llegó ${noOrg.status}`)
  })
})

test('D-03: un asesor no puede difundir y el intento queda anotado', async () => {
  await withServer(async (base) => {
    const attempt = await call(base, '/api/dashboard/broadcast', ORG_A, CRED_A_AGENT, {
      method: 'POST',
      body: { text: 'promo para todos', confirm: true },
    })
    assert.equal(attempt.status, 403)
    assert.equal(attempt.body.code, 'FORBIDDEN_ROLE')

    const audit = await call(base, '/api/dashboard/audit?limit=10', ORG_A, CRED_A_ADMIN)
    assert.equal(audit.status, 200)
    const denied = (audit.body.entries || []).filter((e: any) => e.outcome === 'denied')
    assert.ok(denied.length >= 1, 'la negativa debe quedar registrada')
    assert.equal(denied[0].actor_role, 'agent')
  })
})

test('D-04: la difusión real exige confirmación explícita', async () => {
  await withServer(async (base) => {
    const preview = await call(base, '/api/dashboard/broadcast', ORG_A, CRED_A_ADMIN, {
      method: 'POST',
      body: { text: 'hola', dryRun: true },
    })
    assert.equal(preview.status, 200)
    assert.equal(preview.body.dryRun, true)

    const noConfirm = await call(base, '/api/dashboard/broadcast', ORG_A, CRED_A_ADMIN, {
      method: 'POST',
      body: { text: 'hola' },
    })
    assert.equal(noConfirm.status, 400)
    assert.equal(noConfirm.body.code, 'CONFIRM_REQUIRED')

    const sent = await call(base, '/api/dashboard/broadcast', ORG_A, CRED_A_ADMIN, {
      method: 'POST',
      body: { text: 'hola', confirm: true },
    })
    assert.equal(sent.status, 200)
    assert.ok(['SENT', 'PARTIAL', 'REJECTED'].includes(sent.body.status))
  })
})

test('D-05 y D-06: las acciones dejan rastro con el teléfono enmascarado', async () => {
  await withServer(async (base) => {
    const reply = await call(base, `/api/dashboard/inbox/${PHONE}/reply`, ORG_A, CRED_A_AGENT, {
      method: 'POST',
      body: { text: 'Te confirmo tu pedido' },
    })
    assert.equal(reply.status, 200, JSON.stringify(reply.body))

    const audit = await call(base, '/api/dashboard/audit?limit=20', ORG_A, CRED_A_ADMIN)
    assert.equal(audit.status, 200)
    const row = (audit.body.entries || []).find((e: any) => e.action === 'inbox.reply' && e.outcome === 'ok')
    assert.ok(row, 'la respuesta manual debe quedar registrada')
    assert.equal(row.actor_role, 'agent')
    assert.ok(row.actor.startsWith('cred:'), 'el actor identifica la credencial')
    assert.ok(row.ip, 'se guarda la IP de origen')
    assert.ok(String(row.subject).includes('****'), 'el teléfono va enmascarado')
    assert.ok(!String(row.subject).includes(PHONE), 'el teléfono completo NUNCA se guarda')
    // El cuerpo del mensaje no se copia a la auditoría: solo su longitud.
    assert.ok(!JSON.stringify(row).includes('Te confirmo tu pedido'))
  })
})

test('D-07: un teléfono imposible se rechaza antes de tocar la base', async () => {
  await withServer(async (base) => {
    const bad = await call(base, '/api/dashboard/inbox/abc/reply', ORG_A, CRED_A_ADMIN, {
      method: 'POST',
      body: { text: 'hola' },
    })
    assert.equal(bad.status, 400)
  })
})

test('D-08: la auditoría es solo de administración', async () => {
  await withServer(async (base) => {
    const asAgent = await call(base, '/api/dashboard/audit', ORG_A, CRED_A_AGENT)
    assert.equal(asAgent.status, 403)
    const asAdmin = await call(base, '/api/dashboard/audit', ORG_A, CRED_A_ADMIN)
    assert.equal(asAdmin.status, 200)
  })
})

test('D-09: la auditoría está aislada por organización', async () => {
  await withServer(async (base) => {
    await call(base, `/api/dashboard/inbox/${PHONE}/reply`, ORG_A, CRED_A_ADMIN, {
      method: 'POST',
      body: { text: 'solo para A' },
    })
    const b = await call(base, '/api/dashboard/audit', ORG_B, CRED_B_ADMIN)
    assert.equal(b.status, 200)
    assert.equal(b.body.total, 0, 'la organización B no ve acciones de A')
  })
})

test('D-10: un contacto dado de baja no recibe respuesta manual', async () => {
  await withServer(async (base) => {
    const sup = await call(base, `/api/dashboard/contacts/${PHONE}/suppression`, ORG_A, CRED_A_ADMIN, {
      method: 'POST',
      body: { suppressed: true, reason: 'pidió no recibir mensajes' },
    })
    assert.equal(sup.status, 200)

    const reply = await call(base, `/api/dashboard/inbox/${PHONE}/reply`, ORG_A, CRED_A_ADMIN, {
      method: 'POST',
      body: { text: '¿sigues interesado?' },
    })
    assert.equal(reply.status, 409)

    // Y un asesor no puede levantar esa baja.
    const lift = await call(base, `/api/dashboard/contacts/${PHONE}/suppression`, ORG_A, CRED_A_AGENT, {
      method: 'POST',
      body: { suppressed: false },
    })
    assert.equal(lift.status, 403)
  })
})
