/**
 * OLEADA 2 — Registro de conexiones WhatsApp POR ORGANIZACIÓN y transporte
 * Meta Cloud por credenciales de organización (decisión 2026-11-11).
 *
 * Ejercita:
 *  - atribución automática phoneNumberId → organización (punto 4);
 *  - resolución de credenciales por org con aislamiento (puntos 2, 3, 8);
 *  - transporte Meta Cloud que envía SOLO con las credenciales de la org del
 *    envío (punto 6), fail-closed sin org / sin conexión / sin credencial;
 *  - revocación aislada: desconectar la org-a no rompe la org-b (punto 9);
 *  - clasificación B2 (SENT / REJECTED / UNCERTAIN) intacta.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EnvRegistrySource, OrgWaRegistry, parseOrgNumbers, parseOrgCredentials } from '../src/org-wa-registry.ts'
import { MetaCloudOrgTransport } from '../src/adapters/meta-cloud-org-transport.ts'
import type { WaRegistrySource, WaConnectionInfo } from '../src/org-wa-registry.ts'

describe('parseOrgNumbers / parseOrgCredentials (fuente env standalone)', () => {
  it('parsea identidad org→números y descarta entradas malformadas', () => {
    const parsed = parseOrgNumbers('org-a:111000111, org-b:222000222 ,mal, :::, org-a:333000333')
    assert.equal(parsed.length, 3)
    assert.deepEqual(parsed[0], { orgId: 'org-a', phoneNumberId: '111000111' })
    assert.deepEqual(parsed[2], { orgId: 'org-a', phoneNumberId: '333000333' })
  })

  it('las credenciales con token débil (<16) se rechazan al parsear', () => {
    const parsed = parseOrgCredentials('org-a:111000111:token-corto,org-b:222000222:token-suficientemente-largo-0123')
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].orgId, 'org-b')
  })
})

/** Fuente doble para ejercitar el aislamiento entre dos organizaciones. */
function dualSource(): WaRegistrySource {
  return new EnvRegistrySource({
    waOrgNumbers: 'org-a:111000111,org-b:222000222',
    waOrgCredentials: 'org-a:111000111:token-ORG-A-0123456789abcdef,org-b:222000222:token-ORG-B-0123456789abcdef',
  })
}

describe('OrgWaRegistry — identidad y credenciales por organización', () => {
  beforeEach(() => {
    process.env.WA_ORG_NUMBERS = 'org-a:111000111,org-b:222000222'
    process.env.WA_ORG_CREDENTIALS = 'org-a:111000111:token-ORG-A-0123456789abcdef,org-b:222000222:token-ORG-B-0123456789abcdef'
  })

  it('atribuye un phoneNumberId a SU organización (punto 4)', async () => {
    const registry = new OrgWaRegistry()
    const hit = await registry.resolveOrgByPhoneNumberId('111000111')
    assert.ok(hit)
    assert.equal(hit!.organizationId, 'org-a')
    const miss = await registry.resolveOrgByPhoneNumberId('999999999')
    assert.equal(miss, null)
  })

  it('cada org resuelve SOLO su token (punto 3: credenciales exclusivas por org)', async () => {
    const registry = new OrgWaRegistry()
    const credA = await registry.resolveCredential('org-a', '111000111')
    assert.ok(credA)
    assert.equal(credA!.accessToken, 'token-ORG-A-0123456789abcdef')
    const credB = await registry.resolveCredential('org-b', '222000222')
    assert.equal(credB!.accessToken, 'token-ORG-B-0123456789abcdef')
    // org-b jamás recibe el token del número de org-a
    const cross = await registry.resolveCredential('org-b', '111000111')
    assert.equal(cross, null)
  })

  it('credencial cacheada en memoria con TTL — jamás persistida en disco', async () => {
    const registry = new OrgWaRegistry()
    const cred = await registry.resolveCredential('org-a', '111000111')
    const cached = await registry.resolveCredential('org-a', '111000111')
    assert.equal(cached!.accessToken, cred!.accessToken)
    assert.ok(cred!.cachedUntil > Date.now())
    registry.invalidate()
    // tras invalidar vuelve a resolverse (no se lanza), sin estado en disco
    const again = await registry.resolveCredential('org-a', '111000111')
    assert.ok(again)
  })

  it('inventario por org: cada org solo ve SUS números (punto 8)', async () => {
    const registry = new OrgWaRegistry()
    const listA = await registry.listForOrg('org-a')
    assert.equal(listA.length, 1)
    assert.equal(listA[0].phoneNumberId, '111000111')
    const listB = await registry.listForOrg('org-b')
    assert.equal(listB[0].phoneNumberId, '222000222')
  })
})

describe('Fuente CRM — verificación de identidad del CRM (contrato OLEADA 2)', () => {
  it('si el CRM responde una org distinta a la solicitada → fail-closed ([] / null)', async () => {
    const source = new EnvRegistrySource({ waOrgNumbers: '', waOrgCredentials: '' })
    // Simulación de la fuente CRM: respondiendo org equivocada
    const fakeCrmSource: WaRegistrySource = {
      async listForOrg(orgId: string): Promise<WaConnectionInfo[]> {
        return orgId === 'org-a' ? [] : [{ organizationId: 'org-b', connectionId: 'c1', phoneNumberId: '222000222', phoneNumber: null, wabaId: null }]
      },
      async resolveCredential(orgId: string, phoneNumberId: string) {
        return orgId === 'org-b' && phoneNumberId === '222000222'
          ? { accessToken: 'token-ORG-B-0123456789abcdef', connectionId: 'c1', phoneNumberId }
          : null
      },
    }
    const registry = new OrgWaRegistry([source, fakeCrmSource])
    // org-b resuelve su número; org-a no recibe NADA del número de org-b
    const cross = await registry.resolveCredential('org-a', '222000222')
    assert.equal(cross, null)
  })
})

describe('MetaCloudOrgTransport — envío con credenciales de la organización (punto 6)', () => {
  const REAL_DISPATCH = process.env.ALLOW_REAL_DISPATCH
  beforeEach(() => {
    process.env.WA_ORG_NUMBERS = 'org-a:111000111,org-b:222000222'
    process.env.WA_ORG_CREDENTIALS = 'org-a:111000111:token-ORG-A-0123456789abcdef,org-b:222000222:token-ORG-B-0123456789abcdef'
    process.env.ALLOW_REAL_DISPATCH = 'true'
  })

  function graphStub(captured: Array<{ auth: string | undefined; phoneId: string; body: unknown }>, status = 200, body: unknown = { messages: [{ id: 'wamid.TEST-1' }] }) {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const match = url.match(/graph\.facebook\.com\/v[\d.]+\/(\d+)\/messages/)
      if (!match) return new Response('{}', { status: 404 })
      captured.push({
        auth: (init?.headers as Record<string, string>)['Authorization'],
        phoneId: match[1],
        body: JSON.parse(String(init?.body)),
      })
      return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch
  }

  it('cada envío va con el token y el phoneNumberId de SU organización', async () => {
    const captured: Array<{ auth: string | undefined; phoneId: string; body: unknown }> = []
    const transport = new MetaCloudOrgTransport({ fetchImpl: graphStub(captured) })
    const resA = await transport.sendMessage('521551111111', 'hola de A', 'corr-1', 'idem-1', 'org-a')
    assert.equal(resA.ok, true)
    assert.equal(resA.outcome, 'SENT')
    const resB = await transport.sendMessage('521552222222', 'hola de B', 'corr-2', 'idem-2', 'org-b')
    assert.equal(resB.ok, true)
    // org-a usó el número 111000111 y su token; org-b el suyo (aislamiento)
    assert.equal(captured[0].phoneId, '111000111')
    assert.equal(captured[0].auth, 'Bearer token-ORG-A-0123456789abcdef')
    assert.equal(captured[1].phoneId, '222000222')
    assert.equal(captured[1].auth, 'Bearer token-ORG-B-0123456789abcdef')
    assert.equal(transport.sentLog.length, 2)
    assert.equal(transport.sentLog[0].orgId, 'org-a')
    // el registro de pruebas no contiene tokens
    assert.equal(JSON.stringify(transport.sentLog).includes('token-ORG'), false)
  })

  it('sin orgId → REJECTED (jamás org implícita)', async () => {
    const transport = new MetaCloudOrgTransport()
    const res = await transport.sendMessage('521551111111', 'x', 'corr-3')
    assert.equal(res.ok, false)
    assert.equal(res.outcome, 'REJECTED')
    assert.match(res.error!, /ORG_REQUIRED/)
  })

  it('org sin número conectado → REJECTED sin enviar nada', async () => {
    const captured: Array<{ auth: string | undefined; phoneId: string; body: unknown }> = []
    const transport = new MetaCloudOrgTransport({ fetchImpl: graphStub(captured) })
    const res = await transport.sendMessage('521553333333', 'x', 'corr-4', 'idem-4', 'org-desconocida')
    assert.equal(res.ok, false)
    assert.equal(res.outcome, 'REJECTED')
    assert.match(res.error!, /NO_CONNECTED_NUMBER/)
    assert.equal(captured.length, 0)
  })

  it('org sin credencial resoluble → REJECTED (fail-closed, punto 8)', async () => {
    const captured: Array<{ auth: string | undefined; phoneId: string; body: unknown }> = []
    const registry = new OrgWaRegistry([new EnvRegistrySource({ waOrgNumbers: 'org-a:111000111', waOrgCredentials: '' })])
    const transport = new MetaCloudOrgTransport({ registry, fetchImpl: graphStub(captured) })
    const res = await transport.sendMessage('521551111111', 'x', 'corr-5', 'idem-5', 'org-a')
    assert.equal(res.ok, false)
    assert.equal(res.outcome, 'REJECTED')
    assert.match(res.error!, /CREDENTIAL_UNAVAILABLE/)
    assert.equal(captured.length, 0)
  })

  it('salvaguarda ALLOW_REAL_DISPATCH=false → REJECTED sin red', async () => {
    const captured: Array<{ auth: string | undefined; phoneId: string; body: unknown }> = []
    const transport = new MetaCloudOrgTransport({ fetchImpl: graphStub(captured), allowRealDispatch: false })
    const res = await transport.sendMessage('521551111111', 'x', 'corr-6', 'idem-6', 'org-a')
    assert.equal(res.ok, false)
    assert.equal(res.outcome, 'REJECTED')
    assert.match(res.error!, /DISPATCH_BLOCKED_BY_SAFETY_GUARD/)
    assert.equal(captured.length, 0)
  })

  it('clasificación B2: 4xx → REJECTED, 5xx → UNCERTAIN', async () => {
    const transport400 = new MetaCloudOrgTransport({ fetchImpl: graphStub([], 400, { error: { message: 'bad request' } }) })
    const r400 = await transport400.sendMessage('521551111111', 'x', 'corr-7', 'idem-7', 'org-a')
    assert.equal(r400.outcome, 'REJECTED')
    const transport500 = new MetaCloudOrgTransport({ fetchImpl: graphStub([], 503, { error: 'boom' }) })
    const r500 = await transport500.sendMessage('521551111111', 'x', 'corr-8', 'idem-8', 'org-a')
    assert.equal(r500.outcome, 'UNCERTAIN')
    const transport401 = new MetaCloudOrgTransport({ fetchImpl: graphStub([], 401, { error: { message: 'token expirado' } }) })
    const r401 = await transport401.sendMessage('521551111111', 'x', 'corr-9', 'idem-9', 'org-a')
    assert.equal(r401.outcome, 'REJECTED') // token revocado: evidencia fiable de no envío
  })

  it('revocación aislada (punto 9): quitar la credencial de org-a NO rompe org-b', async () => {
    const captured: Array<{ auth: string | undefined; phoneId: string; body: unknown }> = []
    // org-a revocada: su credencial desaparece; org-b intacta
    const registry = new OrgWaRegistry([new EnvRegistrySource({
      waOrgNumbers: 'org-a:111000111,org-b:222000222',
      waOrgCredentials: 'org-b:222000222:token-ORG-B-0123456789abcdef',
    })])
    const transport = new MetaCloudOrgTransport({ registry, fetchImpl: graphStub(captured) })
    const resA = await transport.sendMessage('521551111111', 'x', 'corr-10', 'idem-10', 'org-a')
    assert.equal(resA.ok, false)
    assert.equal(resA.outcome, 'REJECTED')
    const resB = await transport.sendMessage('521552222222', 'x', 'corr-11', 'idem-11', 'org-b')
    assert.equal(resB.ok, true)
    assert.equal(resB.outcome, 'SENT')
    assert.equal(captured.length, 1)
    assert.equal(captured[0].phoneId, '222000222')
  })

  if (REAL_DISPATCH !== undefined) process.env.ALLOW_REAL_DISPATCH = REAL_DISPATCH
})
