/**
 * (ronda 17, paso 1) Transporte Meta Cloud — soporte de plantillas HSM.
 *
 * Verifica:
 *  T-TPL-01  buildTemplatePayload produce un payload `type: 'template'` con
 *            name, language.code/policy y components (header/body/button).
 *  T-TPL-02  MetaCloudOrgTransport.sendMessage con media.template envía el
 *            payload tipo template (sin red: fetchImpl inyectado que captura).
 *  T-TPL-03  renderMediaAsText degrada la plantilla a texto para transportes
 *            sin soporte nativo (proxy Baileys, simulador) sin perder el
 *            nombre ni los parámetros; lo anota en degraded.
 *  T-TPL-04  La clasificación B2 se respeta con templates (2xx → SENT,
 *            400 → REJECTED, 503 → UNCERTAIN).
 *  T-TPL-05  Sin orgId o sin ALLOW_REAL_DISPATCH → REJECTED (fail-closed),
 *            sin llamada a fetch.
 *
 * Sin red: el fetch es un stub que captura la petición y devuelve una
 * respuesta guionizada. Sin mocks en la lógica del transporte.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MetaCloudOrgTransport } from '../src/adapters/meta-cloud-org-transport.ts'
import { OrgWaRegistry } from '../src/org-wa-registry.ts'
import { renderMediaAsText } from '../src/adapters/transport.ts'
import type { OutboundMedia, OutboundTemplate } from '../src/types.ts'

const ORG = 'org_tpl_test'
const PHONE_ID = '111000111'
const TOKEN = 'token-TPL-TEST-0123456789abcdef'

function envSource(): { waOrgNumbers: string; waOrgCredentials: string } {
  return {
    waOrgNumbers: `${ORG}:${PHONE_ID}`,
    waOrgCredentials: `${ORG}:${PHONE_ID}:${TOKEN}`,
  }
}

function fakeFetchOk(): { fetch: typeof fetch; calls: Array<{ url: string; body: any; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = []
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString()
    const body = init?.body ? JSON.parse(init.body as string) : null
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = init.headers as Record<string, string>
      for (const k of Object.keys(h)) headers[k] = h[k]
    }
    calls.push({ url: u, body, headers })
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.test.template.123' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return { fetch: f, calls }
}

test('T-TPL-01: buildTemplatePayload produce payload tipo template con name/language/components', () => {
  process.env.WA_ORG_NUMBERS = envSource().waOrgNumbers
  process.env.WA_ORG_CREDENTIALS = envSource().waOrgCredentials
  process.env.ALLOW_REAL_DISPATCH = 'true'
  const transport = new MetaCloudOrgTransport()
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: '573100000001' }
  const tpl: OutboundTemplate = {
    name: 'bienvenida_x',
    languageCode: 'es_CO',
    components: [
      { type: 'body', parameters: [{ type: 'text', text: 'Cliente X' }] },
      { type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: 'https://x.co/r/1' }] },
    ],
  }
  const { payload, degraded } = transport.buildTemplatePayload(base, tpl, [])
  assert.equal(payload.type, 'template')
  assert.equal(payload.messaging_product, 'whatsapp')
  assert.equal(payload.to, '573100000001')
  const tNode = payload.template as Record<string, unknown>
  assert.equal(tNode.name, 'bienvenida_x')
  assert.deepEqual(tNode.language, { code: 'es_CO', policy: 'deterministic' })
  const comps = tNode.components as Array<Record<string, unknown>>
  assert.equal(comps.length, 2)
  assert.equal(comps[0].type, 'body')
  assert.equal(comps[1].type, 'button')
  assert.equal(comps[1].sub_type, 'url')
  assert.equal(comps[1].index, 0)
  assert.deepEqual(degraded, [])
})

test('T-TPL-02: sendMessage con media.template envía payload tipo template (sin red)', async () => {
  process.env.WA_ORG_NUMBERS = envSource().waOrgNumbers
  process.env.WA_ORG_CREDENTIALS = envSource().waOrgCredentials
  process.env.ALLOW_REAL_DISPATCH = 'true'
  const { fetch, calls } = fakeFetchOk()
  const transport = new MetaCloudOrgTransport({ fetchImpl: fetch })
  const media: OutboundMedia = {
    template: {
      name: 'pedido_listo',
      languageCode: 'es_MX',
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Order #1234' }] }],
    },
  }
  const result = await transport.sendMessage('+573100000001', 'fallback texto', 'corr-1', 'idem-1', ORG, media)
  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'SENT')
  assert.equal(result.messageId, 'wamid.test.template.123')
  assert.equal(calls.length, 1, 'fetch debe invocarse exactamente una vez')
  const body = calls[0].body
  assert.equal(body.type, 'template')
  assert.equal(body.template.name, 'pedido_listo')
  assert.equal(body.template.language.code, 'es_MX')
  assert.equal(body.to, '573100000001')
  // No debe llevar text/mediaUrl/buttons (la plantilla define su contenido)
  assert.equal(body.text, undefined)
  assert.equal(body.image, undefined)
  assert.equal(body.interactive, undefined)
})

test('T-TPL-03: renderMediaAsText degrada plantilla a texto sin perder nombre ni params', () => {
  const media: OutboundMedia = {
    template: {
      name: 'recordatorio_cita',
      languageCode: 'es_CO',
      components: [
        { type: 'body', parameters: [{ type: 'text', text: 'Juan' }, { type: 'text', text: '3:00 PM' }] },
      ],
    },
  }
  const { text, degraded } = renderMediaAsText('Tu cita es pronto', media)
  assert.ok(text.includes('recordatorio_cita'), 'el nombre de la plantilla viaja en el texto')
  assert.ok(text.includes('es_CO'), 'el código de idioma viaja en el texto')
  assert.ok(text.includes('Juan'), 'el parámetro 1 viaja en el texto')
  assert.ok(text.includes('3:00 PM'), 'el parámetro 2 viaja en el texto')
  assert.ok(degraded.some((d) => d.startsWith('plantilla_hsm_degradada_a_texto')), 'se anota la degradación')
})

test('T-TPL-04: clasificación B2 con templates (400 REJECTED, 503 UNCERTAIN)', async () => {
  process.env.WA_ORG_NUMBERS = envSource().waOrgNumbers
  process.env.WA_ORG_CREDENTIALS = envSource().waOrgCredentials
  process.env.ALLOW_REAL_DISPATCH = 'true'

  // 400 → REJECTED
  const fetch400 = (async () => new Response('{"error":{"message":"template not approved"}}', { status: 400 })) as typeof fetch
  const t400 = new MetaCloudOrgTransport({ fetchImpl: fetch400 })
  const r400 = await t400.sendMessage('+573100000001', 'fallback', 'corr', 'idem', ORG, { template: { name: 'no_aprobada' } })
  assert.equal(r400.ok, false)
  assert.equal(r400.outcome, 'REJECTED')

  // 503 → UNCERTAIN (el mensaje pudo aceptarse antes del fallo del proxy)
  const fetch503 = (async () => new Response('proxy down', { status: 503 })) as typeof fetch
  const t503 = new MetaCloudOrgTransport({ fetchImpl: fetch503 })
  const r503 = await t503.sendMessage('+573100000001', 'fallback', 'corr', 'idem', ORG, { template: { name: 'aprobada' } })
  assert.equal(r503.ok, false)
  assert.equal(r503.outcome, 'UNCERTAIN')
})

test('T-TPL-05: sin orgId o sin ALLOW_REAL_DISPATCH → REJECTED, sin fetch', async () => {
  process.env.WA_ORG_NUMBERS = envSource().waOrgNumbers
  process.env.WA_ORG_CREDENTIALS = envSource().waOrgCredentials
  let fetchCalls = 0
  const fetchCounter = (async () => { fetchCalls++; return new Response('{}', { status: 200 }) }) as typeof fetch
  // Sin ALLOW_REAL_DISPATCH
  process.env.ALLOW_REAL_DISPATCH = 'false'
  const tNoDispatch = new MetaCloudOrgTransport({ fetchImpl: fetchCounter })
  const rNoDispatch = await tNoDispatch.sendMessage('+573100000001', 'fallback', 'corr', 'idem', ORG, { template: { name: 'x' } })
  assert.equal(rNoDispatch.outcome, 'REJECTED')
  assert.equal(fetchCalls, 0, 'sin fetch sin ALLOW_REAL_DISPATCH')
  // Con ALLOW_REAL_DISPATCH pero sin orgId
  process.env.ALLOW_REAL_DISPATCH = 'true'
  const tNoOrg = new MetaCloudOrgTransport({ fetchImpl: fetchCounter })
  const rNoOrg = await tNoOrg.sendMessage('+573100000001', 'fallback', 'corr', 'idem', undefined, { template: { name: 'x' } })
  assert.equal(rNoOrg.outcome, 'REJECTED')
  assert.equal(fetchCalls, 0, 'sin fetch sin orgId')
})
