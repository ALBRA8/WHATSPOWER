import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createHmac } from 'node:crypto'
import { createAgenticServer } from '../src/server.ts'
import { HttpAlbraTransportSender, MockTransportSender } from '../src/adapters/transport.ts'
import { MockCrmClient } from '../src/adapters/crm-client.ts'
import { productionConfigProblems } from '../src/security.ts'

/**
 * PRUEBAS DE SEGURIDAD (orden de cierre 2026-11-06)
 *  - AUTH-xx: todas las rutas administrativas rechazan anónimos y secretos inválidos.
 *  - WH-xx: webhooks exigen firma + timestamp + anti-replay.
 *  - ENV-xx: guard fail-fast de producción (nombra variables, jamás valores).
 *  - TR-xx: salvaguarda ALLOW_REAL_DISPATCH en el transporte real.
 *  - IDEM-xx: idempotencia scoped por organización (sin colisiones cross-org).
 */

process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'wp_sec_test_internal_min24chars_000'
const SECRET = process.env.INTERNAL_API_SECRET!
const AUTH = { 'Authorization': `Bearer ${SECRET}` }
const AUTH_JSON = { ...AUTH, 'Content-Type': 'application/json' }

async function listenEphemeral(server: any): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}

function bootServer(extra: Record<string, unknown> = {}) {
  const webhookSecret = 'wp_sec_test_webhook_secret_min24chars'
  const { server } = createAgenticServer({
    dbPath: ':memory:',
    transport: new MockTransportSender(),
    crm: new MockCrmClient(),
    webhookSecret,
    ...extra,
  })
  return { server, webhookSecret }
}

describe('AUTH: superficie administrativa protegida', () => {
  const protectedRoutes: Array<{ m: string; p: string; body?: object }> = [
    { m: 'GET', p: '/api/flows' },
    { m: 'POST', p: '/api/flows', body: { id: 'f1', name: 'x', nodes: [] } },
    { m: 'POST', p: '/api/flows/simulate', body: { phone: '573001112233', messageText: 'hola' } },
    { m: 'GET', p: '/api/internal/locks/573001112233' },
    { m: 'POST', p: '/api/internal/locks/573001112233/release' },
    { m: 'GET', p: '/api/internal/suppression/573001112233' },
    { m: 'GET', p: '/api/team/agents' },
    { m: 'POST', p: '/api/team/agents', body: { name: 'x', role: 'admin' } },
    { m: 'POST', p: '/api/team/assign', body: { phone: '573001112233' } },
    { m: 'GET', p: '/api/canned' },
    { m: 'POST', p: '/api/canned', body: { shortcut: '/x', text: 'y' } },
    { m: 'POST', p: '/api/growth/links', body: { slug: 'x', target: 'https://wa.me/57300' } },
    { m: 'POST', p: '/api/crm/stage-change', body: { clientId: 'c1', stage: 'NUEVO' } },
    { m: 'POST', p: '/api/payments/create-link', body: { amount: 100 } },
  ]

  for (const r of protectedRoutes) {
    it(`AUTH-ANON: ${r.m} ${r.p} anónimo → 401/503 (jamás 2xx)`, async () => {
      const { server } = bootServer()
      const base = await listenEphemeral(server)
      try {
        const res = await fetch(`${base}${r.p}`, {
          method: r.m,
          headers: { 'Content-Type': 'application/json' },
          body: r.body ? JSON.stringify(r.body) : undefined,
        })
        assert.ok([401, 503].includes(res.status), `esperado 401/503, obtenido ${res.status}`)
        const data = await res.json() as any
        assert.ok(data.error, 'debe explicar el rechazo')
        assert.ok(!JSON.stringify(data).includes(SECRET), 'el error NUNCA revela el secret')
      } finally { server.close() }
    })

    it(`AUTH-BAD: ${r.m} ${r.p} con secreto inválido → 401`, async () => {
      const { server } = bootServer()
      const base = await listenEphemeral(server)
      try {
        const res = await fetch(`${base}${r.p}`, {
          method: r.m,
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer secreto_maloso_inventado_000' },
          body: r.body ? JSON.stringify(r.body) : undefined,
        })
        assert.strictEqual(res.status, 401)
      } finally { server.close() }
    })

    it(`AUTH-OK: ${r.m} ${r.p} con secreto válido → jamás 401/503`, async () => {
      const { server } = bootServer()
      const base = await listenEphemeral(server)
      try {
        const res = await fetch(`${base}${r.p}`, {
          method: r.m,
          headers: AUTH_JSON,
          body: r.body ? JSON.stringify(r.body) : undefined,
        })
        assert.ok(res.status !== 401 && res.status !== 503, `con credencial válida no debe rechazarse (obtenido ${res.status})`)
      } finally { server.close() }
    })
  }

  it('AUTH-503: sin INTERNAL_API_SECRET configurado, la ruta admin responde 503 fail-closed', async () => {
    const prev = process.env.INTERNAL_API_SECRET
    delete process.env.INTERNAL_API_SECRET
    try {
      const { server } = bootServer()
      const base = await listenEphemeral(server)
      try {
        const res = await fetch(`${base}/api/team/agents`)
        assert.strictEqual(res.status, 503)
      } finally { server.close() }
    } finally {
      process.env.INTERNAL_API_SECRET = prev
    }
  })
})

describe('WH: endurecimiento de webhooks', () => {
  const PAYLOAD = JSON.stringify({
    eventId: 'evt_sec_wh_001',
    orgId: 'org_sec_test',
    contact: { phone: '573000000099', name: 'Sec Test' },
    message: { text: 'hola prueba' },
    channel: 'whatsapp',
  })
  const sign = (secret: string) => createHmac('sha256', secret).update(PAYLOAD).digest('hex')

  it('WH-01: /api/inbound sin firma → 401 (también fuera de producción)', async () => {
    const { server } = bootServer()
    const base = await listenEphemeral(server)
    try {
      const res = await fetch(`${base}/api/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: PAYLOAD,
      })
      assert.strictEqual(res.status, 401)
    } finally { server.close() }
  })

  it('WH-02: /api/inbound sin timestamp → 401 (replay protection obligatoria)', async () => {
    const { server, webhookSecret } = bootServer()
    const base = await listenEphemeral(server)
    try {
      const res = await fetch(`${base}/api/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Signature-SHA256': sign(webhookSecret) },
        body: PAYLOAD,
      })
      assert.strictEqual(res.status, 401)
    } finally { server.close() }
  })

  it('WH-03: /api/inbound con timestamp vencido → 401', async () => {
    const { server, webhookSecret } = bootServer()
    const base = await listenEphemeral(server)
    try {
      const res = await fetch(`${base}/api/inbound`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-SHA256': sign(webhookSecret),
          'X-Timestamp': String(Date.now() - 400_000),
        },
        body: PAYLOAD,
      })
      assert.strictEqual(res.status, 401)
      const data = await res.json() as any
      assert.ok(data.error.includes('replay') || data.error.includes('Timestamp'))
    } finally { server.close() }
  })

  it('WH-04: replay exacto (misma firma+timestamp) → 401 en el segundo intento', async () => {
    const { server, webhookSecret } = bootServer()
    const base = await listenEphemeral(server)
    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-Signature-SHA256': sign(webhookSecret),
        'X-Timestamp': String(Date.now()),
      }
      const r1 = await fetch(`${base}/api/inbound`, { method: 'POST', headers, body: PAYLOAD })
      assert.strictEqual(r1.status, 200)
      const r2 = await fetch(`${base}/api/inbound`, { method: 'POST', headers, body: PAYLOAD })
      assert.strictEqual(r2.status, 401)
      const data = await r2.json() as any
      assert.ok(data.error.toLowerCase().includes('replay') || data.error.toLowerCase().includes('duplicada'))
    } finally { server.close() }
  })

  it('WH-05: /api/payments/webhook sin firma → 401/503 (antes aprobaba pagos anónimos)', async () => {
    const { server } = bootServer()
    const base = await listenEphemeral(server)
    try {
      const res = await fetch(`${base}/api/payments/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId: 'tx_1', status: 'APPROVED' }),
      })
      assert.ok([401, 503].includes(res.status))
    } finally { server.close() }
  })

  it('WH-06: /api/payments/webhook con HMAC válido → 200', async () => {
    process.env.PAYMENTS_WEBHOOK_SECRET = 'wp_sec_test_payments_secret_min24chars'
    try {
      const { server } = bootServer()
      const base = await listenEphemeral(server)
      try {
        const body = JSON.stringify({ transactionId: 'tx_sec_1', status: 'PENDING' })
        const res = await fetch(`${base}/api/payments/webhook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature-SHA256': createHmac('sha256', process.env.PAYMENTS_WEBHOOK_SECRET).update(body).digest('hex'),
            'X-Timestamp': String(Date.now()),
          },
          body,
        })
        assert.strictEqual(res.status, 200)
      } finally { server.close() }
    } finally {
      delete process.env.PAYMENTS_WEBHOOK_SECRET
    }
  })
})

describe('ENV: guard fail-fast de producción', () => {
  const cleanEnv = () => {
    for (const k of ['INTERNAL_API_SECRET', 'AGENTIC_2A_WEBHOOK_SECRET', 'WEBHOOK_SECRET', 'CRM_API_KEY', 'TRANSPORT', 'ALLOW_MOCK_TRANSPORT', 'PAYMENTS_WEBHOOK_SECRET', 'NODE_ENV']) delete process.env[k]
  }

  /** Ningún mensaje del guard debe contener valores que estuvieran en el entorno. */
  const assertNoValuesLeaked = (problems: string[]) => {
    const values = Object.entries(process.env)
      .filter(([k, v]) => v && v.length >= 16 && k.includes('SECRET') || (v && v.length >= 32 && /^albra_|wp_|ultra_/.test(v)))
      .map(([, v]) => v as string)
    for (const p of problems) {
      for (const v of values) assert.ok(!p.includes(v), `el guard filtró un valor de ${v.length} caracteres`)
    }
  }

  it('ENV-01: producción sin secretos → lista TODAS las variables ausentes y NUNCA valores', () => {
    cleanEnv()
    process.env.NODE_ENV = 'production'
    try {
      const problems = productionConfigProblems()
      assert.ok(problems.some((p) => p.includes('INTERNAL_API_SECRET')))
      assert.ok(problems.some((p) => p.includes('AGENTIC_2A_WEBHOOK_SECRET')))
      assert.ok(problems.some((p) => p.includes('CRM_API_KEY')))
      assert.ok(problems.some((p) => p.includes('TRANSPORT')))
      assertNoValuesLeaked(problems)
    } finally { cleanEnv() }
  })

  it('ENV-02: producción con secretos débiles/publicados conocidos → rechazado', () => {
    cleanEnv()
    process.env.NODE_ENV = 'production'
    process.env.INTERNAL_API_SECRET = 'crm_albra_internal_secret_key_fixed_length_for_daemon_2026'
    try {
      const problems = productionConfigProblems()
      assert.ok(problems.some((p) => p.includes('INTERNAL_API_SECRET') && p.includes('débil')))
      assertNoValuesLeaked(problems)
    } finally { cleanEnv() }
  })

  it('ENV-03: producción con TRANSPORT=mock sin ALLOW_MOCK_TRANSPORT=true → rechazado', () => {
    cleanEnv()
    process.env.NODE_ENV = 'production'
    process.env.INTERNAL_API_SECRET = 'x'.repeat(32)
    process.env.AGENTIC_2A_WEBHOOK_SECRET = 'y'.repeat(32)
    process.env.CRM_API_KEY = 'albra_test-0000000000000000'
    process.env.TRANSPORT = 'mock'
    try {
      const problems = productionConfigProblems()
      assert.ok(problems.some((p) => p.includes('ALLOW_MOCK_TRANSPORT')))
    } finally { cleanEnv() }
  })
})

describe('TR: salvaguarda ALLOW_REAL_DISPATCH en transporte real', () => {
  it('TR-01: HttpAlbraTransportSender BLOQUEA el envío sin ALLOW_REAL_DISPATCH=true (no llama fetch)', async () => {
    const prev = process.env.ALLOW_REAL_DISPATCH
    delete process.env.ALLOW_REAL_DISPATCH
    let fetchCalled = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { fetchCalled++; throw new Error('fetch NO debió llamarse') }) as any
    try {
      const t = new HttpAlbraTransportSender('http://127.0.0.1:9', 'secret-test-24-chars-000000')
      const r = await t.sendMessage('573001112233', 'hola', 'corr-1')
      assert.strictEqual(r.ok, false)
      assert.ok(r.error!.includes('DISPATCH_BLOCKED_BY_SAFETY_GUARD'))
      assert.strictEqual(fetchCalled, 0, 'ninguna petición de red salió')
    } finally {
      globalThis.fetch = origFetch
      if (prev !== undefined) process.env.ALLOW_REAL_DISPATCH = prev
    }
  })

  it('TR-02: con ALLOW_REAL_DISPATCH=true SÍ intenta el envío (comportamiento legítimo)', async () => {
    process.env.ALLOW_REAL_DISPATCH = 'true'
    let fetchCalled = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { fetchCalled++; return new Response(JSON.stringify({ messageId: 'wamid_test' }), { status: 200 }) }) as any
    try {
      const t = new HttpAlbraTransportSender('http://127.0.0.1:9', 'secret-test-24-chars-000000')
      const r = await t.sendMessage('573001112233', 'hola', 'corr-2')
      assert.strictEqual(r.ok, true)
      assert.strictEqual(fetchCalled, 1)
    } finally {
      globalThis.fetch = origFetch
      delete process.env.ALLOW_REAL_DISPATCH
    }
  })

  it('TR-03: producción sin TRANSPORT → createAgenticServer lanza error nombrando la variable', () => {
    const prevNode = process.env.NODE_ENV
    const prevTransport = process.env.TRANSPORT
    process.env.NODE_ENV = 'production'
    process.env.INTERNAL_API_SECRET = 'x'.repeat(32)
    delete process.env.TRANSPORT
    delete process.env.CRM_API_KEY
    try {
      assert.throws(
        () => createAgenticServer({ dbPath: ':memory:' }),
        (e: Error) => e.message.includes('TRANSPORT'),
      )
    } finally {
      if (prevNode) process.env.NODE_ENV = prevNode; else delete process.env.NODE_ENV
      if (prevTransport) process.env.TRANSPORT = prevTransport
    }
  })

  it('TR-04: producción con TRANSPORT=mock sin decisión explícita → rechazado', () => {
    const prevNode = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    process.env.INTERNAL_API_SECRET = 'x'.repeat(32)
    process.env.CRM_API_KEY = 'albra_test-0000000000000000'
    process.env.TRANSPORT = 'mock'
    delete process.env.ALLOW_MOCK_TRANSPORT
    try {
      assert.throws(
        () => createAgenticServer({ dbPath: ':memory:' }),
        (e: Error) => e.message.includes('ALLOW_MOCK_TRANSPORT'),
      )
    } finally {
      if (prevNode) process.env.NODE_ENV = prevNode; else delete process.env.NODE_ENV
      delete process.env.TRANSPORT
      delete process.env.INTERNAL_API_SECRET
      delete process.env.CRM_API_KEY
    }
  })
})

describe('IDEM: idempotencia scoped por organización', () => {
  async function postInbound(base: string, secret: string, orgId: string, eventId: string, text: string): Promise<any> {
    const body = JSON.stringify({
      eventId,
      orgId,
      contact: { phone: '573000000777', name: 'Idem' },
      message: { text },
      channel: 'whatsapp',
    })
    const res = await fetch(`${base}/api/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-SHA256': createHmac('sha256', secret).update(body).digest('hex'),
        'X-Timestamp': String(Date.now()),
      },
      body,
    })
    return { status: res.status, data: await res.json() as any }
  }

  it('IDEM-01: mismo eventId en dos orgs → ambas procesadas (sin colisión cross-org)', async () => {
    const { server, webhookSecret } = bootServer()
    const base = await listenEphemeral(server)
    try {
      const r1 = await postInbound(base, webhookSecret, 'org_aaa', 'evt_mismo_id', 'PRECIO')
      assert.strictEqual(r1.status, 200)
      assert.notStrictEqual(r1.data.actionTaken, 'deduplicated')

      const r2 = await postInbound(base, webhookSecret, 'org_bbb', 'evt_mismo_id', 'PRECIO')
      assert.strictEqual(r2.status, 200)
      assert.notStrictEqual(r2.data.actionTaken, 'deduplicated', 'el eventId repetido de OTRA org debe procesarse, no deducirse')
    } finally { server.close() }
  })

  it('IDEM-02: mismo eventId en la MISMA org → deduplicado (comportamiento intacto)', async () => {
    const { server, webhookSecret } = bootServer()
    const base = await listenEphemeral(server)
    try {
      // WH-04 demuestra que el replay exacto (misma firma+ts) se rechaza; aquí usamos
      // timestamps distintos con el mismo eventId+org para probar la capa de idempotencia.
      const post = async (ts: number) => {
        const body = JSON.stringify({
          eventId: 'evt_misma_org',
          orgId: 'org_idem',
          contact: { phone: '573000000778', name: 'Idem2' },
          message: { text: 'PRECIO' },
          channel: 'whatsapp',
        })
        const res = await fetch(`${base}/api/inbound`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature-SHA256': createHmac('sha256', webhookSecret).update(body).digest('hex'),
            'X-Timestamp': String(ts),
          },
          body,
        })
        return { status: res.status, data: await res.json() as any }
      }
      const r1 = await post(Date.now())
      assert.strictEqual(r1.status, 200)
      const r2 = await post(Date.now())
      assert.strictEqual(r2.status, 200)
      assert.strictEqual(r2.data.actionTaken, 'deduplicated')
    } finally { server.close() }
  })
})
