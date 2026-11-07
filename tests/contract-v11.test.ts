/**
 * contract-v11.test.ts — VERIFICACIÓN DEL CONTRATO DE INTEGRACIÓN v1.1.0 (Capa 2A)
 * Reparación integral 2026-11-06.
 *
 * LOS 7 RECHAZOS OBLIGATORIOS (contrato §4), verificados uno a uno:
 *   R1. Firma válida + timestamp modificado → 401
 *   R2. Petición repetida (misma huella) → 401
 *   R3. Firma incorrecta → 401
 *   R4. Timestamp vencido → 401
 *   R5. Secreto ausente → 503 fail-closed
 *   R6. Eventos legítimos de dos organizaciones → sin colisión (cada uno en su org)
 *   R7. Dos peticiones simultáneas del mismo evento → UNA sola operación
 *
 * Más: persistencia del anti-replay entre instancias (sobrevive reinicios),
 * aislamiento por organización con teléfono compartido, roles (solo admin libera
 * locks / elimina supresiones), X-Org-Id restringivo, /qr y /qr/data protegidos,
 * máquina de estados de pagos, rate limiting 429+Retry-After y body 413.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgenticServer } from '../src/server.ts'
import { MockTransportSender } from '../src/adapters/transport.ts'
import { MockCrmClient } from '../src/adapters/crm-client.ts'

process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'wp_contract_test_internal_min24chars'
const LEGACY_SECRET = process.env.INTERNAL_API_SECRET!
const AUTH = { 'Authorization': `Bearer ${LEGACY_SECRET}` }
const AUTH_JSON = { ...AUTH, 'Content-Type': 'application/json' }

const ORG_X = 'org_contract_x'
const ORG_Y = 'org_contract_y'
const SECRET_X = 'contract_secret_org_x_min32chars_0001'
const SECRET_Y = 'contract_secret_org_y_min32chars_0002'

function signV2(secret: string, body: string, ts: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex')
}

async function listenEphemeral(server: any): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}

/** Servidor con secretos POR ORGANIZACIÓN (WEBHOOK_SECRETS) — el modo del contrato §3. */
const CRED_X_ADMIN = 'contract_cred_org_x_admin_min32ch_001' // (fusión) identidad de servicio POR ORGANIZACIÓN
function bootPerOrgServer(extraEnv: Record<string, string | undefined> = {}) {
  const prev = process.env.WEBHOOK_SECRETS
  const prevKeys = process.env.INTERNAL_API_KEYS
  process.env.WEBHOOK_SECRETS = `${ORG_X}:${SECRET_X},${ORG_Y}:${SECRET_Y}`
  process.env.INTERNAL_API_KEYS = `${ORG_X}:${CRED_X_ADMIN}:admin`
  const transport = new MockTransportSender()
  const crm = new MockCrmClient()
  const { server, db, router, paymentManager } = createAgenticServer({
    dbPath: ':memory:',
    transport,
    crm,
  })
  return { server, db, router, paymentManager, transport, crm, restore: () => { if (prev === undefined) delete process.env.WEBHOOK_SECRETS; else process.env.WEBHOOK_SECRETS = prev; if (prevKeys === undefined) delete process.env.INTERNAL_API_KEYS; else process.env.INTERNAL_API_KEYS = prevKeys } }
}

interface InboundOptions {
  eventId: string
  orgId?: string
  phone?: string
  text?: string
  secret: string
  ts?: string
  tamperTimestamp?: string
  skipSignature?: boolean
  eventIdHeaderOnly?: boolean
}

async function postInbound(base: string, opts: InboundOptions): Promise<{ status: number; data: any }> {
  const body = JSON.stringify({
    ...(opts.eventIdHeaderOnly ? {} : { eventId: opts.eventId }),
    orgId: opts.orgId,
    contact: { phone: opts.phone || '573000000421', name: 'Contrato' },
    message: { id: `msg_${opts.eventId}`, text: opts.text || 'Hola', type: 'text' },
    channel: 'whatsapp',
  })
  const ts = opts.ts || String(Date.now())
  const presentedTs = opts.tamperTimestamp || ts
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Timestamp': presentedTs,
  }
  if (!opts.skipSignature) {
    // La firma SIEMPRE se calcula sobre ts (el real); si tamperTimestamp está presente,
    // se presenta el timestamp MODIFICADO con la firma del original (ataque de replay).
    headers['X-Signature-SHA256'] = signV2(opts.secret, body, ts)
  }
  if (opts.eventIdHeaderOnly) headers['X-Event-Id'] = opts.eventId
  const res = await fetch(`${base}/api/inbound`, { method: 'POST', headers, body })
  return { status: res.status, data: await res.json() as any }
}

describe('CONTRATO v1.1.0 §4 — LOS 7 RECHAZOS OBLIGATORIOS (Capa 2A)', () => {
  it('R1: firma válida + timestamp modificado → 401 (el timestamp entra en la MAC)', async () => {
    const { server, restore } = bootPerOrgServer()
    const base = await listenEphemeral(server)
    try {
      const res = await postInbound(base, {
        eventId: 'evt_r1', orgId: ORG_X, secret: SECRET_X, ts: String(Date.now()), tamperTimestamp: String(Date.now() + 250_000),
      })
      assert.strictEqual(res.status, 401)
      const r2 = await postInbound(base, {
        eventId: 'evt_r1b', orgId: ORG_X, secret: SECRET_X, ts: String(Date.now()), tamperTimestamp: String(Date.now() - 250_000),
      })
      assert.strictEqual(r2.status, 401, 'tamper hacia el pasado también debe fallar')
    } finally { server.close(); restore() }
  })

  it('R2: petición repetida (misma huella) → 401, y la huella es PERSISTENTE (SQLite)', async () => {
    const { server, restore } = bootPerOrgServer()
    const base = await listenEphemeral(server)
    try {
      const ts = String(Date.now())
      const r1 = await postInbound(base, { eventId: 'evt_r2', orgId: ORG_X, secret: SECRET_X, ts })
      assert.strictEqual(r1.status, 200)
      const r2 = await postInbound(base, { eventId: 'evt_r2', orgId: ORG_X, secret: SECRET_X, ts })
      assert.strictEqual(r2.status, 401)
      assert.ok(String(r2.data.error).toLowerCase().includes('duplicada') || String(r2.data.error).toLowerCase().includes('replay'))
    } finally { server.close(); restore() }
  })

  it('R3: firma incorrecta → 401', async () => {
    const { server, restore } = bootPerOrgServer()
    const base = await listenEphemeral(server)
    try {
      const res = await postInbound(base, { eventId: 'evt_r3', orgId: ORG_X, secret: 'firma_con_secreto_equivocado_000000' })
      assert.strictEqual(res.status, 401)
      assert.ok(String(res.data.error).includes('Firma') || String(res.data.error).toLowerCase().includes('invalid'))
    } finally { server.close(); restore() }
  })

  it('R4: timestamp vencido → 401 (firmado con ese timestamp)', async () => {
    const { server, restore } = bootPerOrgServer()
    const base = await listenEphemeral(server)
    try {
      const res = await postInbound(base, { eventId: 'evt_r4', orgId: ORG_X, secret: SECRET_X, ts: String(Date.now() - 400_000) })
      assert.strictEqual(res.status, 401)
    } finally { server.close(); restore() }
  })

  it('R5: secreto ausente → 503 fail-closed (jamás acepta)', async () => {
    const prevX = process.env.AGENTIC_2A_WEBHOOK_SECRET
    const prevW = process.env.WEBHOOK_SECRET
    const prevOrg = process.env.WEBHOOK_SECRETS
    delete process.env.AGENTIC_2A_WEBHOOK_SECRET
    delete process.env.WEBHOOK_SECRET
    delete process.env.WEBHOOK_SECRETS
    try {
      const { server } = createAgenticServer({ dbPath: ':memory:', transport: new MockTransportSender(), crm: new MockCrmClient() })
      const base = await listenEphemeral(server)
      try {
        const res = await postInbound(base, { eventId: 'evt_r5', orgId: ORG_X, secret: SECRET_X })
        assert.strictEqual(res.status, 503)
      } finally { server.close() }
    } finally {
      if (prevX !== undefined) process.env.AGENTIC_2A_WEBHOOK_SECRET = prevX
      if (prevW !== undefined) process.env.WEBHOOK_SECRET = prevW
      if (prevOrg !== undefined) process.env.WEBHOOK_SECRETS = prevOrg
    }
  })

  it('R6: eventos legítimos de dos organizaciones → sin colisión (cada uno en su org)', async () => {
    const { server, db, restore } = bootPerOrgServer()
    const base = await listenEphemeral(server)
    try {
      const phone = '573000000606'
      const r1 = await postInbound(base, { eventId: 'evt_mismo', orgId: ORG_X, secret: SECRET_X, phone })
      assert.strictEqual(r1.status, 200)
      assert.notStrictEqual(r1.data.actionTaken, 'deduplicated')

      const r2 = await postInbound(base, { eventId: 'evt_mismo', orgId: ORG_Y, secret: SECRET_Y, phone })
      assert.strictEqual(r2.status, 200)
      assert.notStrictEqual(r2.data.actionTaken, 'deduplicated', 'el MISMO eventId de OTRA org (otro secreto) no colisiona')

      // Cada evento quedó en SU organización: locks independientes con el mismo teléfono
      const rows = db.prepare('SELECT organization_id FROM conversation_locks WHERE contact_phone = ? ORDER BY organization_id').all(phone) as any[]
      const orgs = rows.map((r) => r.organization_id).sort()
      assert.deepStrictEqual(orgs, [ORG_X, ORG_Y].sort(), 'cada org tiene SU PROPIO lock para el teléfono compartido')
    } finally { server.close(); restore() }
  })

  it('R7: dos peticiones simultáneas del mismo evento → UNA sola operación', async () => {
    const { server, transport, crm, restore } = bootPerOrgServer()
    const base = await listenEphemeral(server)
    try {
      const ts = String(Date.now())
      const [a, b] = await Promise.all([
        postInbound(base, { eventId: 'evt_r7', orgId: ORG_X, secret: SECRET_X, ts, text: 'Hola primera vez' }),
        postInbound(base, { eventId: 'evt_r7', orgId: ORG_X, secret: SECRET_X, ts: String(Date.now() + 5), text: 'Hola primera vez' }),
      ])
      assert.strictEqual(a.status, 200)
      assert.strictEqual(b.status, 200)
      const outcomes = [a.data.actionTaken, b.data.actionTaken].sort()
      // Exactamente UNA ejecución real; la otra deduplicada o en curso (nunca dos ejecuciones).
      assert.ok(
        outcomes.includes('deduplicated') || outcomes.includes('event_in_progress'),
        `la segunda petición debe ser deduplicada/en curso, obtenido: ${outcomes.join(', ')}`,
      )
      assert.ok(
        outcomes.filter((o) => o !== 'deduplicated' && o !== 'event_in_progress').length === 1,
        `exactamente una ejecución real, obtenido: ${outcomes.join(', ')}`,
      )
      assert.strictEqual(transport.dispatched.length, 1, 'UN solo mensaje enviado (jamás doble despacho)')
      assert.ok(crm.executedActions.length <= 1, 'máximo una acción CRM')
    } finally { server.close(); restore() }
  })
})

describe('CONTRATO v1.1.0 — persistencia y aislamiento (Capa 2A)', () => {
  it('P1: el anti-replay SOBREVIVE el reinicio del proceso (nueva instancia, misma BD)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-contract-'))
    const dbPath = join(dir, 'replay-persistence.db')
    const ts = String(Date.now())
    const envRestore = process.env.WEBHOOK_SECRETS
    process.env.WEBHOOK_SECRETS = `${ORG_X}:${SECRET_X}`

    try {
      // Instancia A: procesa el evento y registra la huella
      const a = createAgenticServer({ dbPath, transport: new MockTransportSender(), crm: new MockCrmClient() })
      const baseA = await listenEphemeral(a.server)
      const r1 = await postInbound(baseA, { eventId: 'evt_persist', orgId: ORG_X, secret: SECRET_X, ts })
      assert.strictEqual(r1.status, 200)
      await new Promise<void>((resolve) => a.server.close(() => resolve()))

      // Instancia B (simula reinicio): la MISMA petición debe seguir siendo replay
      const b = createAgenticServer({ dbPath, transport: new MockTransportSender(), crm: new MockCrmClient() })
      const baseB = await listenEphemeral(b.server)
      const r2 = await postInbound(baseB, { eventId: 'evt_persist', orgId: ORG_X, secret: SECRET_X, ts })
      assert.strictEqual(r2.status, 401, 'la huella debe persistir en SQLite entre instancias')
      await new Promise<void>((resolve) => b.server.close(() => resolve()))
    } finally {
      if (envRestore === undefined) delete process.env.WEBHOOK_SECRETS
      else process.env.WEBHOOK_SECRETS = envRestore
    }
  })

  it('P2: teléfono compartido entre dos orgs NO comparte supresión ni sesión', async () => {
    const { server, db, router, restore } = bootPerOrgServer()
    const base = await listenEphemeral(server)
    try {
      const phone = '573000000707'
      // Org X suprime el teléfono administrativamente (vía API interna autenticada)
      // (fusión) credencial de servicio POR ORGANIZACIÓN (el secreto global ya no
      // sustituye identidad de organización — spec §3/§10).
      await fetch(`${base}/api/internal/suppression/${phone}`, { method: 'POST', headers: { 'Authorization': `Bearer ${CRED_X_ADMIN}`, 'X-Org-Id': ORG_X }, body: JSON.stringify({ reason: 'baja org X' }) })
      // Con credencial legado la org es 'default'; suprimimos también en ORG_X vía store directo
      router.getSuppressionStore().addSuppression(ORG_X, phone, 'baja X') // API org-first unificada
      assert.strictEqual(router.getSuppressionStore().isSuppressed(ORG_X, phone), true) // API org-first
      assert.strictEqual(router.getSuppressionStore().isSuppressed(ORG_Y, phone), false, 'la supresión de X NO afecta a Y')

      // El evento inbound de Y con ese teléfono se procesa con normalidad (no suprimido en Y)
      const r = await postInbound(base, { eventId: 'evt_p2', orgId: ORG_Y, secret: SECRET_Y, phone, text: 'Hola desde Y' })
      assert.strictEqual(r.status, 200)
      assert.notStrictEqual(r.data.actionTaken, 'ignored')

      // Y la fila de supresión de X sigue intacta
      const rowX = db.prepare('SELECT organization_id FROM suppression_list WHERE phone = ? AND organization_id = ?').get(phone, ORG_X)
      assert.ok(rowX, 'la supresión de X persiste independiente')
    } finally { server.close(); restore() }
  })

  it('P3: roles — la credencial rol agent NO puede liberar locks ni eliminar supresiones (403)', async () => {
    const prevKeys = process.env.INTERNAL_API_KEYS
    process.env.INTERNAL_API_KEYS = `org_roles:agent_secret_min32chars_0001:agent,org_roles:admin_secret_min32chars01:admin`
    try {
      const { server } = createAgenticServer({ dbPath: ':memory:', transport: new MockTransportSender(), crm: new MockCrmClient() })
      const base = await listenEphemeral(server)
      try {
        const agentAuth = { 'Authorization': 'Bearer agent_secret_min32chars_0001' }
        const adminAuth = { 'Authorization': 'Bearer admin_secret_min32chars01' }

        const r1 = await fetch(`${base}/api/internal/locks/573000000808/release`, { method: 'POST', headers: agentAuth })
        assert.strictEqual(r1.status, 403, 'agent no libera locks')
        const r2 = await fetch(`${base}/api/internal/suppression/573000000808`, { method: 'DELETE', headers: agentAuth })
        assert.strictEqual(r2.status, 403, 'agent no elimina supresiones')

        const r3 = await fetch(`${base}/api/internal/suppression/573000000808`, { method: 'DELETE', headers: adminAuth })
        assert.strictEqual(r3.status, 200, 'admin sí elimina supresiones')
        const r4 = await fetch(`${base}/api/internal/locks/573000000808/release`, { method: 'POST', headers: adminAuth })
        assert.strictEqual(r4.status, 200, 'admin sí libera locks')
      } finally { server.close() }
    } finally {
      if (prevKeys === undefined) delete process.env.INTERNAL_API_KEYS
      else process.env.INTERNAL_API_KEYS = prevKeys
    }
  })

  it('P4: X-Org-Id ajeno a la credencial → 403 (solo restringe, jamás amplía)', async () => {
    const prevKeys = process.env.INTERNAL_API_KEYS
    process.env.INTERNAL_API_KEYS = `org_header:header_secret_min32chars_001:admin`
    try {
      const { server } = createAgenticServer({ dbPath: ':memory:', transport: new MockTransportSender(), crm: new MockCrmClient() })
      const base = await listenEphemeral(server)
      try {
        const r1 = await fetch(`${base}/api/internal/locks/573000000909`, {
          headers: { 'Authorization': 'Bearer header_secret_min32chars_001', 'X-Org-Id': 'org_header' },
        })
        assert.strictEqual(r1.status, 200, 'X-Org-Id coincidente pasa')
        const r2 = await fetch(`${base}/api/internal/locks/573000000909`, {
          headers: { 'Authorization': 'Bearer header_secret_min32chars_001', 'X-Org-Id': 'otra_org' },
        })
        assert.strictEqual(r2.status, 403, 'X-Org-Id de otra org se rechaza')
      } finally { server.close() }
    } finally {
      if (prevKeys === undefined) delete process.env.INTERNAL_API_KEYS
      else process.env.INTERNAL_API_KEYS = prevKeys
    }
  })

  it('P5: /qr/data anónimo → 401; rol agent → 403; jamás QR a anónimos', async () => {
    const prevKeys = process.env.INTERNAL_API_KEYS
    process.env.INTERNAL_API_KEYS = `org_qr:qr_agent_secret_min32chars01:agent,org_qr:qr_admin_secret_min32chars01:admin`
    try {
      const { server } = createAgenticServer({ dbPath: ':memory:', transport: new MockTransportSender(), crm: new MockCrmClient() })
      const base = await listenEphemeral(server)
      try {
        const anon = await fetch(`${base}/qr/data`)
        assert.ok([401, 503].includes(anon.status), 'anónimo jamás recibe datos de QR')
        const anonQr = await fetch(`${base}/qr`)
        // (fusión) el shell /qr anónimo es la puerta del fix: HTML SIN datos de QR
        // (ni imagen ni payload); el QR real solo sale por /qr/data autenticado.
        const shellHtml = await anonQr.text()
        assert.ok(!shellHtml.includes('data:image') && !shellHtml.includes('base64'), 'el shell anónimo no contiene QR embebido')
        const agent = await fetch(`${base}/qr/data`, { headers: { 'Authorization': 'Bearer qr_agent_secret_min32chars01' } })
        assert.strictEqual(agent.status, 403, 'rol agent no vincula dispositivos')
        const admin = await fetch(`${base}/qr/data`, { headers: { 'Authorization': 'Bearer qr_admin_secret_min32chars01' } })
        assert.notStrictEqual(admin.status, 401, 'admin accede (el daemon no corre en la prueba: 5xx de red permitido)')
      } finally { server.close() }
    } finally {
      if (prevKeys === undefined) delete process.env.INTERNAL_API_KEYS
      else process.env.INTERNAL_API_KEYS = prevKeys
    }
  })

  it('P6: eventId aceptado por cabecera X-Event-Id (contrato §3) y deduplicado por ella', async () => {
    const { server, restore } = bootPerOrgServer()
    const base = await listenEphemeral(server)
    try {
      const r1 = await postInbound(base, { eventId: 'evt_header_id', orgId: ORG_X, secret: SECRET_X, eventIdHeaderOnly: true })
      assert.strictEqual(r1.status, 200)
      const r2 = await postInbound(base, { eventId: 'evt_header_id', orgId: ORG_X, secret: SECRET_X, eventIdHeaderOnly: true, ts: String(Date.now() + 1000) })
      assert.strictEqual(r2.status, 200)
      assert.strictEqual(r2.data.actionTaken, 'deduplicated', 'el X-Event-Id participa de la idempotencia orgId::eventId')
    } finally { server.close(); restore() }
  })
})

describe('CONTRATO v1.1.0 §6 — máquina de estados de pagos (Capa 2A)', () => {
  it('PAY-01: PENDING→APPROVED 200; terminal intocable (409); status inválido 400; tx desconocida 404; auditoría registrada', async () => {
    const { server, db, restore } = bootPerOrgServer()
    const base = await listenEphemeral(server)
    try {
      // Crear transacción (org default con credencial legado)
      const created = await fetch(`${base}/api/payments/create-link`, {
        method: 'POST', headers: AUTH_JSON,
        body: JSON.stringify({ orgId: ORG_X, contactPhone: '573000001001', amount: 90000, currency: 'COP', description: 'Plan contrato' }), // (fusión) org explícita del operador central
      })
      assert.strictEqual(created.status, 200)
      const tx = await created.json() as any
      assert.strictEqual(tx.mode, 'simulator', 'por defecto el modo es SIMULADOR y se etiqueta')
      assert.ok(tx.paymentLink.includes('/simulator/'), 'el enlace del simulador jamás apunta a una pasarela real')

      process.env.PAYMENTS_WEBHOOK_SECRET = 'contract_payments_secret_min32chars_001'
      try {
        const postWebhook = async (status: string, txId = tx.id) => {
          const body = JSON.stringify({ transactionId: txId, status })
          const ts = String(Date.now())
          const res = await fetch(`${base}/api/payments/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Signature-SHA256': signV2(process.env.PAYMENTS_WEBHOOK_SECRET!, body, ts), 'X-Timestamp': ts },
            body,
          })
          return { status: res.status, data: await res.json() as any }
        }
        const ok = await postWebhook('APPROVED')
        assert.strictEqual(ok.status, 200)
        assert.strictEqual(ok.data.transaction.status, 'APPROVED')

        const terminal = await postWebhook('REJECTED')
        assert.strictEqual(terminal.status, 409, 'los estados terminales son intocables')

        const invalid = await postWebhook('WEIRD_STATUS')
        assert.strictEqual(invalid.status, 400, 'status fuera de whitelist → 400')

        const unknown = await postWebhook('APPROVED', 'tx_inexistente_999')
        assert.strictEqual(unknown.status, 404, 'transacción desconocida → 404 (sin filtrar detalles)')

        // (fusión) la auditoría registra TAMBIÉN la creación (from NULL, ver PAY-07 de
      // payments-qr-hardening); la transición se verifica por su acción explícita.
      const audit = db.prepare("SELECT from_status, to_status FROM payment_audit WHERE transaction_id = ? AND action LIKE 'WEBHOOK_TRANSITION%'").all(tx.id) as any[]
        assert.ok(audit.length >= 1, 'toda transición queda auditada')
        assert.strictEqual(audit[0].from_status, 'PENDING')
        assert.strictEqual(audit[0].to_status, 'APPROVED')
      } finally {
        delete process.env.PAYMENTS_WEBHOOK_SECRET
      }
    } finally { server.close(); restore() }
  })
})

describe('CONTRATO v1.1.0 §7 — límites y abuso (Capa 2A)', () => {
  it('AB-01: body > 1MB → 413 con drenaje (jamás cuerpo parcial procesado)', async () => {
    const { server, restore } = bootPerOrgServer()
    const base = await listenEphemeral(server)
    try {
      const big = JSON.stringify({ eventId: 'evt_big', orgId: ORG_X, contact: { phone: '1' }, message: { id: 'm', text: 'x'.repeat(1_100_000) }, channel: 'whatsapp' })
      const res = await fetch(`${base}/api/flows`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json', 'X-Org-Id': ORG_X }, body: big })
      assert.strictEqual(res.status, 413)
    } finally { server.close(); restore() }
  })

  it('AB-02: rate limit en /qr/data → 429 + Retry-After (30/min por IP)', async () => {
    const prevKeys = process.env.INTERNAL_API_KEYS
    process.env.INTERNAL_API_KEYS = `org_rl:rl_admin_secret_min32chars_001:admin`
    try {
      const { server } = createAgenticServer({ dbPath: ':memory:', transport: new MockTransportSender(), crm: new MockCrmClient() })
      const base = await listenEphemeral(server)
      try {
        const headers = { 'Authorization': 'Bearer rl_admin_secret_min32chars_001' }
        let saw429 = false
        let retryAfter = ''
        for (let i = 0; i < 40; i++) {
          const res = await fetch(`${base}/qr/data`, { headers })
          if (res.status === 429) {
            saw429 = true
            retryAfter = res.headers.get('retry-after') || ''
            break
          }
        }
        assert.ok(saw429, 'el límite de tasa debe activarse')
        assert.ok(retryAfter !== '' && Number(retryAfter) >= 1, 'Retry-After presente y >= 1')
      } finally { server.close() }
    } finally {
      if (prevKeys === undefined) delete process.env.INTERNAL_API_KEYS
      else process.env.INTERNAL_API_KEYS = prevKeys
    }
  })
})
