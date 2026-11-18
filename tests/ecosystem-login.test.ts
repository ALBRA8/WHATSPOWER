/**
 * ecosystem-login.test.ts — Acceso directo al ecosistema (2026-11-17)
 *
 * El CRM (capa 1) emite enlaces de UN SOLO USO firmados con HMAC-SHA256
 * (ECOSYSTEM_SSO_SECRET compartido) a sesiones autenticadas; al abrirlos aquí
 * se concede la MISMA sesión de operador del Studio (/studio/login-ecosystem).
 *
 * Contrato verificado en este servidor (capa 2A):
 *  1. Fail-closed: sin ECOSYSTEM_SSO_SECRET la ruta NO existe (404) — el
 *     canje jamás se ofrece sin el secreto configurado explícitamente.
 *  2. Token válido → 302 a '/' con Set-Cookie de sesión del Studio.
 *  3. El token es de UN SOLO USO (jti): el segundo canje → 403.
 *  4. Token expirado, manipulado o firmado con otro secreto → 403.
 *  5. No es el login-demo anónimo: esa puerta (/studio/login) queda intacta.
 */
import test from 'node:test'
import assert from 'node:assert'
import { request } from 'node:http'
import type { Server } from 'node:http'
import { createAgenticServer } from '../src/server.ts'
import { signEcosystemToken } from '../src/ecosystem-sso.ts'

const SSO_SECRET = 'ecosystem_sso_secret_test_min_32_chars_0001'
const INTERNAL_SECRET = 'internal_api_secret_test_min_32_chars_01'

interface Resp {
  status: number | undefined
  headers: Record<string, string | string[] | undefined>
  body: string
}

function req(
  port: number,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  opts: { cookie?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers || {}) }
    if (opts.cookie) headers['Cookie'] = opts.cookie
    if (opts.body) headers['Content-Type'] = 'application/json'
    const r = request(`http://127.0.0.1:${port}${path}`, { method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    r.on('error', reject)
    if (opts.body) r.write(opts.body)
    r.end()
  })
}

function bootServer(): { server: ReturnType<typeof createAgenticServer>['server']; restore: () => void } {
  const prevSso = process.env.ECOSYSTEM_SSO_SECRET
  const prevInternal = process.env.INTERNAL_API_SECRET
  const prevKeys = process.env.INTERNAL_API_KEYS
  const prevAllowMock = process.env.ALLOW_MOCK_TRANSPORT
  const prevTransport = process.env.TRANSPORT
  const prevDemo = process.env.DEMO_MODE
  const prevNodeEnv = process.env.NODE_ENV
  process.env.INTERNAL_API_SECRET = INTERNAL_SECRET
  delete process.env.INTERNAL_API_KEYS
  process.env.ALLOW_MOCK_TRANSPORT = 'true'
  // En producción el arranque exige una decisión explícita de TRANSPORT;
  // el subtest de 403-en-producción la toma aquí (mock permitido solo para tests).
  if (process.env.TRANSPORT === undefined) process.env.TRANSPORT = 'mock'
  const { server } = createAgenticServer({ dbPath: ':memory:' })
  return {
    server,
    restore: () => {
      if (prevSso === undefined) delete process.env.ECOSYSTEM_SSO_SECRET; else process.env.ECOSYSTEM_SSO_SECRET = prevSso
      if (prevInternal === undefined) delete process.env.INTERNAL_API_SECRET; else process.env.INTERNAL_API_SECRET = prevInternal
      if (prevKeys === undefined) delete process.env.INTERNAL_API_KEYS; else process.env.INTERNAL_API_KEYS = prevKeys
      if (prevAllowMock === undefined) delete process.env.ALLOW_MOCK_TRANSPORT; else process.env.ALLOW_MOCK_TRANSPORT = prevAllowMock
      if (prevTransport === undefined) delete process.env.TRANSPORT; else process.env.TRANSPORT = prevTransport
      if (prevDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = prevDemo
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv
    },
  }
}

async function listenEphemeral(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as { port: number }).port
}

test('ECOSISTEMA — /studio/login-ecosystem (canje SSO de un solo uso)', async (t) => {
  const prevDemoSuite = process.env.DEMO_MODE
  const prevNodeEnvSuite = process.env.NODE_ENV
  process.env.DEMO_MODE = 'true'
  process.env.NODE_ENV = 'development'
  t.after(() => {
    if (prevDemoSuite === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = prevDemoSuite
    if (prevNodeEnvSuite === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnvSuite
  })
  await t.test('1. Fail-closed: sin ECOSYSTEM_SSO_SECRET la ruta NO existe (404)', async () => {
    const { server, restore } = bootServer()
    delete process.env.ECOSYSTEM_SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const res = await req(port, '/studio/login-ecosystem?token=lo-que-sea')
      assert.equal(res.status, 404, 'sin secreto configurado el canje NO se ofrece')
      assert.equal(res.headers['set-cookie'], undefined, 'sin secreto jamás se emite sesión')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('2. Token válido → 302 a / con cookie de sesión del Studio', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const token = signEcosystemToken(SSO_SECRET)
      const res = await req(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      assert.equal(res.status, 302, 'el canje válido redirige al Studio')
      assert.equal(res.headers['location'], '/')
      const cookie = res.headers['set-cookie']
      assert.ok(cookie, 'se emite la cookie de sesión')
      assert.ok(String(cookie).includes('wp_2a_studio_session='), 'cookie del Studio de la capa 2A')
      assert.ok(String(cookie).includes('HttpOnly'), 'la cookie es HttpOnly')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('3. UN SOLO USO: reutilizar el mismo enlace → 403 sin nueva sesión', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const token = signEcosystemToken(SSO_SECRET)
      const first = await req(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      assert.equal(first.status, 302)
      const second = await req(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      assert.equal(second.status, 403, 'el jti ya fue canjeado')
      assert.equal(second.headers['set-cookie'], undefined, 'no se emite sesión en el reintento')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('4. Token expirado → 403', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const expired = signEcosystemToken(SSO_SECRET, Date.now() - 10 * 60_000)
      const res = await req(port, `/studio/login-ecosystem?token=${encodeURIComponent(expired)}`)
      assert.equal(res.status, 403, 'el TTL de 90 s se respeta')
      assert.equal(res.headers['set-cookie'], undefined)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('5. Token manipulado (firma alterada) → 403', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const token = signEcosystemToken(SSO_SECRET)
      const tampered = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA')
      const res = await req(port, `/studio/login-ecosystem?token=${encodeURIComponent(tampered)}`)
      assert.equal(res.status, 403, 'la firma HMAC no cuadra')
      assert.equal(res.headers['set-cookie'], undefined)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('6. Token firmado con OTRO secreto → 403', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const foreign = signEcosystemToken('otro_secreto_totalmente_distinto_0002')
      const res = await req(port, `/studio/login-ecosystem?token=${encodeURIComponent(foreign)}`)
      assert.equal(res.status, 403, 'solo el secreto compartido del ecosistema valida')
      assert.equal(res.headers['set-cookie'], undefined)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('7. La puerta del Studio (/studio/login con secreto admin) sigue intacta', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const res = await req(port, '/studio/login', 'POST')
      // sin cuerpo → credencial inválida, pero la ruta EXISTE y responde 401 (no 404)
      assert.equal(res.status, 401, 'el login clásico del Studio no se ve afectado')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('8. CADENA DE ACEPTACIÓN: canje → cookie → GET /api/flows responde 200 (no 401)', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const token = signEcosystemToken(SSO_SECRET)
      const redemption = await req(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      assert.equal(redemption.status, 302)
      const cookiePair = String(redemption.headers['set-cookie']).split(';')[0]
      assert.ok(cookiePair.startsWith('wp_2a_studio_session='), 'cookie de sesión emitida por el canje')
      // Con la cookie del canje y org 'default' (lo que el Studio fija por SSO
      // SIN preguntar), el listado de flujos responde 200 — este es exactamente
      // el paso 5 del guion de aceptación del dueño.
      const flows = await req(port, '/api/flows', 'GET', {
        cookie: cookiePair,
        headers: { 'X-Org-Id': 'default' },
      })
      assert.equal(flows.status, 200, 'la sesión del canje autoriza /api/flows')
      assert.ok(Array.isArray(JSON.parse(flows.body)), 'el body es un listado JSON de flujos')
      // Y sin cookie sigue 401: la sesión es la única llave, jamás el token suelto.
      const anon = await req(port, '/api/flows', 'GET', { headers: { 'X-Org-Id': 'default' } })
      assert.equal(anon.status, 401)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('9. Fallo del canje responde PÁGINA HTML con motivo y “Volver al CRM”', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      // Reutilizado → 403 con HTML: motivo “ya fue utilizado” + botón volver.
      const token = signEcosystemToken(SSO_SECRET)
      await req(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      const replay = await req(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      assert.equal(replay.status, 403)
      assert.ok(String(replay.headers['content-type']).includes('text/html'), 'la respuesta de fallo es HTML, no JSON crudo')
      assert.ok(replay.body.includes('ya fue utilizado'), 'el motivo (enlace ya usado) es visible para el dueño')
      assert.ok(replay.body.includes('Volver al CRM'), 'hay camino de salida hacia el CRM')
      // Caducado → 403 con HTML: motivo “caducado”.
      const expired = signEcosystemToken(SSO_SECRET, Date.now() - 10 * 60_000)
      const exp = await req(port, `/studio/login-ecosystem?token=${encodeURIComponent(expired)}`)
      assert.equal(exp.status, 403)
      assert.ok(exp.body.includes('caducado'), 'el motivo (TTL de 90 s) es visible')
      // Sin secreto → 404 con HTML: fail-closed explicado.
      delete process.env.ECOSYSTEM_SSO_SECRET
      const unconfigured = await req(port, '/studio/login-ecosystem?token=x')
      assert.equal(unconfigured.status, 404)
      assert.ok(String(unconfigured.headers['content-type']).includes('text/html'))
      assert.ok(unconfigured.body.includes('no configurado'), 'el fail-closed se explica, no se oculta')
      assert.equal(unconfigured.headers['set-cookie'], undefined, 'sin secreto jamás se emite sesión')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('10. POST /studio/login-demo (paridad 2B): habilitado SOLO fuera de producción', async () => {
    const { server, restore } = bootServer()
    const prevNodeEnv = process.env.NODE_ENV
    const prevDemo = process.env.DEMO_MODE
    try {
      // (a) dev + DEMO_MODE=true → 200 + cookie HttpOnly + sesión operativa.
      process.env.NODE_ENV = 'development'
      process.env.DEMO_MODE = 'true'
      let port = await listenEphemeral(server)
      const ok = await req(port, '/studio/login-demo', 'POST', { body: '{}' })
      assert.equal(ok.status, 200, 'demo concedido en dev con DEMO_MODE=true')
      const cookiePair = String(ok.headers['set-cookie']).split(';')[0]
      assert.ok(cookiePair.startsWith('wp_2a_studio_session='))
      assert.ok(String(ok.headers['set-cookie']).includes('HttpOnly'))
      const flows = await req(port, '/api/flows', 'GET', { cookie: cookiePair, headers: { 'X-Org-Id': 'default' } })
      assert.equal(flows.status, 200, 'la sesión demo autoriza /api/flows')
      await new Promise<void>((resolve) => server.close(() => resolve()))

      // (b) producción → 403 SIEMPRE (aunque DEMO_MODE=true): puerta intacta.
      // La ruta comprueba NODE_ENV al recibir la petición: se arranca en dev y
      // se pone NODE_ENV=production ANTES del POST (el arranque completo en
      // producción ya se cubre en security-hardening / productionConfigProblems).
      const { server: server2, restore: restore2 } = bootServer()
      process.env.NODE_ENV = 'production'
      process.env.DEMO_MODE = 'true'
      port = await listenEphemeral(server2)
      const blocked = await req(port, '/studio/login-demo', 'POST', { body: '{}' })
      assert.equal(blocked.status, 403, 'el demo anónimo jamás entra en producción')
      assert.equal(blocked.headers['set-cookie'], undefined)
      process.env.NODE_ENV = 'development'
      await new Promise<void>((resolve) => server2.close(() => resolve()))
      restore2()

      // (c) dev sin DEMO_MODE → 403.
      process.env.NODE_ENV = 'development'
      delete process.env.DEMO_MODE
      const { server: server3, restore: restore3 } = bootServer()
      port = await listenEphemeral(server3)
      const off = await req(port, '/studio/login-demo', 'POST', { body: '{}' })
      assert.equal(off.status, 403, 'sin DEMO_MODE=true el demo no se ofrece')
      await new Promise<void>((resolve) => server3.close(() => resolve()))
      restore3()
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv
      if (prevDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = prevDemo
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('11. GET /studio/login-ecosystem: prohibido en producción (403)', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    process.env.NODE_ENV = 'production'
    process.env.DEMO_MODE = 'true'
    const port = await listenEphemeral(server)
    try {
      const token = signEcosystemToken(SSO_SECRET)
      const res = await req(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      assert.equal(res.status, 403, 'en producción responde 403 Forbidden')
      assert.equal(res.headers['set-cookie'], undefined, 'jamás emite sesión en producción')
      assert.ok(res.body.includes('Acceso Prohibido en Producción') || res.body.includes('403'))
    } finally {
      process.env.NODE_ENV = 'development'
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('12. GET /studio/login-ecosystem: rechazado con DEMO_MODE apagado (403)', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    process.env.NODE_ENV = 'development'
    delete process.env.DEMO_MODE
    const port = await listenEphemeral(server)
    try {
      const token = signEcosystemToken(SSO_SECRET)
      const res = await req(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      assert.equal(res.status, 403, 'sin DEMO_MODE responde 403')
      assert.equal(res.headers['set-cookie'], undefined)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('13. Token de una organización rechazado para otra organización (403)', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    process.env.DEMO_MODE = 'true'
    const port = await listenEphemeral(server)
    try {
      // Token emitido para org_A
      const tokenA = signEcosystemToken(SSO_SECRET, Date.now(), 90_000, { orgId: 'org_A' })
      // Se intenta canjear solicitando org_B
      const res = await req(port, `/studio/login-ecosystem?token=${encodeURIComponent(tokenA)}&orgId=org_B`)
      assert.equal(res.status, 403, 'token de org_A no sirve en org_B')
      assert.equal(res.headers['set-cookie'], undefined)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })
})
