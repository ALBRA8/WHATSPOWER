/**
 * fixes-h1-h6.test.ts — Pruebas de los hallazgos funcionales (parte WHATSPOWER)
 * Auditoría funcional 2026-11-12. Cada hallazgo demostrado con resultado real
 * (sin prueba no se declara resuelto — regla de la orden maestra).
 *
 *   H1  Interpolación literal (sin RegExp dinámicas) — nombres de campo peligrosos
 *   H2  field_greater_than / field_less_than / message_equals implementados y probados
 *   H3  AI_RESPONSE ejecuta el motor real de IA (proveedor inyectable/fail-closed honesto)
 *   H4  recordOutboundMessage con política explícita (log observable, sin catch {})
 *   H5  webhookToCall SE EJECUTA en el router (validación, journal, headers, idempotencia)
 *   H6  mediaUrl/mediaType/buttons llegan al transporte (nativo en Meta Cloud,
 *       degradación explícita en transportes sin soporte)
 *
 * PATRÓN DE FLUJO (H1/H2): trigger → user_input → (condición|mensaje). El nodo
 * user_input hace que la sesión espere el mensaje SIGUIENTE; ese mensaje (a)
 * alimenta ultimo_mensaje/contexto y (b) hace avanzar el motor — así se evalúa
 * la condición/interpolación con datos controlados por la prueba.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createDatabase } from '../src/db.ts'
import { FlowEngine, AI_UNAVAILABLE_FALLBACK } from '../src/engine/flow-engine.ts'
import { normalizeForEngineCompare, compareNumericValues } from '../src/engine/flow-engine.ts'
import type { FlowDefinition, FlowNode } from '../src/engine/flow-types.ts'
import { MockTransportSender, renderMediaAsText, HttpAlbraTransportSender } from '../src/adapters/transport.ts'
import { MetaCloudOrgTransport } from '../src/adapters/meta-cloud-org-transport.ts'
import { MockCrmClient } from '../src/adapters/crm-client.ts'
import { ConversationRouter } from '../src/engine/router.ts'
import { UnconfiguredAiProvider, type AiCompletionProvider } from '../src/engine/ai-provider.ts'

function nodeOf(type: FlowNode['type'], data: FlowNode['data'], id?: string): FlowNode {
  return { id: id || `n_${type}_${Math.random().toString(36).substring(2, 8)}`, type, title: type, data }
}

function simpleFlow(nodes: FlowNode[], edges: Array<{ source: string; target: string; sourceHandle?: string }>): FlowDefinition {
  return {
    id: `flow_${Math.random().toString(36).substring(2, 8)}`,
    name: 'Flujo de prueba hallazgos',
    triggerKeywords: ['inicio_test_hallazgos'],
    isActive: true,
    nodes,
    edges: edges.map((e, i) => ({ id: `e_${i}`, ...e })),
  }
}

/** Sesión interna del motor (acceso de prueba al contexto). */
function ctxOf(engine: FlowEngine, org: string, phone: string): Record<string, string> {
  return (engine as unknown as { getSession: (o: string, p: string) => { context: Record<string, string> } | null }).getSession(org, phone)!.context
}

describe('H1 — interpolación literal segura (sin RegExp dinámicas)', () => {
  /** trigger → user_input(campo) → mensaje con {{campo}} y {{no_existe}} */
  async function interpCase(field: string, value: string): Promise<string> {
    const db = createDatabase(':memory:')
    const engine = new FlowEngine(db)
    const org = `org_${Math.random().toString(36).substring(2, 8)}`
    const phone = `+57300000${Math.floor(Math.random() * 90000 + 10000)}`
    engine.saveFlow(
      org,
      simpleFlow(
        [
          nodeOf('trigger', { keywords: ['inicio_test_hallazgos'] }, 't1'),
          nodeOf('user_input', { inputPrompt: 'Dame el dato', saveToCustomField: field }, 'u1'),
          nodeOf('send_message', { messageText: `Con: {{${field}}} | Sin: {{no_existe}}` }, 'm1'),
        ],
        [
          { source: 't1', target: 'u1' },
          { source: 'u1', target: 'm1' },
        ]
      )
    )
    await engine.evaluateStep(org, phone, 'inicio_test_hallazgos', { name: 'Cliente Prueba' })
    await engine.evaluateStep(org, phone, value, {})
    const session = (engine as unknown as { getSession: (o: string, p: string) => { currentNodeId: string } | null }).getSession(org, phone)
    assert.ok(session, 'la sesión sigue viva tras el mensaje')
    const rows = db.prepare(
      "SELECT text FROM inbox_messages WHERE organization_id = ? AND direction = 'outbound' ORDER BY rowid DESC LIMIT 1"
    ).all(org) as Array<{ text: string }>
    return rows[0]?.text || ''
  }

  it('H1-01: nombres con metacaracteres de regex NO rompen la interpolación ni sustituyen por accidente', async () => {
    for (const field of ['cliente[', 'cliente.nombre', 'precio+iva', '(paréntesis)', 'a|b', '$especial']) {
      const text = await interpCase(field, 'VALOR_X')
      assert.strictEqual(
        text,
        `Con: VALOR_X | Sin: {{no_existe}}`,
        `campo peligroso "${field}": sustitución EXACTA de su placeholder, placeholders desconocidos intactos`
      )
    }
  })

  it('H1-02: valores con "$&" o "$1" llegan LITERALES (sin la semántica de replace)', async () => {
    const text = await interpCase('total', '$& $1 100%')
    assert.ok(text.includes('total: ') === false, 'sanidad')
    assert.ok(text.startsWith('Con: $& $1 100%'), `el valor con $ especiales llega literal (recibido: ${text})`)
  })

  it('H1-03: sustitución normal se preserva (compatibilidad — flujo demo con {{nombre}})', async () => {
    const db = createDatabase(':memory:')
    const engine = new FlowEngine(db)
    // El flujo demo sembrado matchea "precio" y su mensaje de bienvenida usa {{nombre}}:
    const res = await engine.evaluateStep('org_h1c', '+573000000003', 'precio', { name: 'Cliente Prueba' })
    assert.ok(res.messagesToSend.length >= 1, 'la primera evaluación envía el mensaje de bienvenida')
    assert.ok(res.messagesToSend[0].text.includes('Cliente Prueba'), 'el nombre del contacto se interpola')
  })
})

describe('H2 — condiciones declaradas con comportamiento real y probado', () => {
  /** trigger → user_input → condition(rules, logic) → RAMA_SI/RAMA_NO */
  async function evalCondition(
    rules: Array<{ type: string; field?: string; value: string }>,
    logic: 'AND' | 'OR',
    opts: { fields?: Record<string, string> } = {}
  ): Promise<string> {
    const db = createDatabase(':memory:')
    const engine = new FlowEngine(db)
    const org = `org_${Math.random().toString(36).substring(2, 8)}`
    const phone = `+57300000${Math.floor(Math.random() * 90000 + 10000)}`
    engine.saveFlow(
      org,
      simpleFlow(
        [
          nodeOf('trigger', { keywords: ['inicio_test_hallazgos'] }, 't1'),
          nodeOf('user_input', { inputPrompt: 'Responde', saveToCustomField: 'respuesta' }, 'u1'),
          nodeOf('condition', { rules: rules as never, conditionLogic: logic }, 'cond'),
          nodeOf('send_message', { messageText: 'RAMA_SI' }, 'yes_node'),
          nodeOf('send_message', { messageText: 'RAMA_NO' }, 'no_node'),
        ],
        [
          { source: 't1', target: 'u1' },
          { source: 'u1', target: 'cond' },
          { source: 'cond', target: 'yes_node', sourceHandle: 'yes' },
          { source: 'cond', target: 'no_node', sourceHandle: 'no' },
        ]
      )
    )
    for (const [k, v] of Object.entries(opts.fields ?? {})) engine.setCustomField(org, phone, k, v)
    await engine.evaluateStep(org, phone, 'inicio_test_hallazgos', { name: 'Cliente Prueba' })
    const res = await engine.evaluateStep(org, phone, 'RESPONDE_AQUI', {})
    return res.messagesToSend[0]?.text || ''
  }

  it('H2-01: field_greater_than positivo/negativo/límite/dato inválido/vacío', async () => {
    assert.strictEqual(await evalCondition([{ type: 'field_greater_than', field: 'edad', value: '18' }], 'AND', { fields: { edad: '25' } }), 'RAMA_SI')
    assert.strictEqual(await evalCondition([{ type: 'field_greater_than', field: 'edad', value: '18' }], 'AND', { fields: { edad: '18' } }), 'RAMA_NO', 'límite: 18 > 18 es falso')
    assert.strictEqual(await evalCondition([{ type: 'field_greater_than', field: 'edad', value: '18' }], 'AND', { fields: { edad: 'abc' } }), 'RAMA_NO', 'dato inválido → false definido')
    assert.strictEqual(await evalCondition([{ type: 'field_greater_than', field: 'edad', value: '18' }], 'AND', { fields: { edad: '' } }), 'RAMA_NO', 'vacío → false definido')
    assert.strictEqual(await evalCondition([{ type: 'field_greater_than', field: 'precio+iva', value: '10.5' }], 'AND', { fields: { 'precio+iva': '10.7' } }), 'RAMA_SI', 'nombre con + y decimales')
  })

  it('H2-02: field_less_than positivo/negativo/límite/decimales', async () => {
    assert.strictEqual(await evalCondition([{ type: 'field_less_than', field: 'stock', value: '5' }], 'AND', { fields: { stock: '2' } }), 'RAMA_SI')
    assert.strictEqual(await evalCondition([{ type: 'field_less_than', field: 'stock', value: '5' }], 'AND', { fields: { stock: '5' } }), 'RAMA_NO', 'límite: 5 < 5 es falso')
    assert.strictEqual(await evalCondition([{ type: 'field_less_than', field: 'stock', value: '0.5' }], 'AND', { fields: { stock: '0.25' } }), 'RAMA_SI', 'decimales')
    assert.strictEqual(await evalCondition([{ type: 'field_less_than', field: 'stock', value: 'x' }], 'AND', { fields: { stock: '2' } }), 'RAMA_NO', 'valor de regla inválido → false')
  })

  /** Flujo mínimo: trigger(keyword) → condition(message_equals value) → SI/NO. */
  async function messageEqualsCase(input: string, value: string): Promise<string> {
    const db = createDatabase(':memory:')
    const engine = new FlowEngine(db)
    const org = `org_${Math.random().toString(36).substring(2, 8)}`
    const phone = `+57300000${Math.floor(Math.random() * 90000 + 10000)}`
    // (detalle del motor) el matching de triggers usa flow.triggerKeywords:
    engine.saveFlow(
      org,
      {
        ...simpleFlow(
          [
            nodeOf('trigger', { keywords: [value] }, 't1'),
            nodeOf('condition', { rules: [{ type: 'message_equals', value }] as never, conditionLogic: 'AND' }, 'cond'),
            nodeOf('send_message', { messageText: 'RAMA_SI' }, 'yes_node'),
            nodeOf('send_message', { messageText: 'RAMA_NO' }, 'no_node'),
          ],
          [
            { source: 't1', target: 'cond' },
            { source: 'cond', target: 'yes_node', sourceHandle: 'yes' },
            { source: 'cond', target: 'no_node', sourceHandle: 'no' },
          ]
        ),
        triggerKeywords: [value],
      }
    )
    const res = await engine.evaluateStep(org, phone, input, { name: 'X' })
    return res.messagesToSend[0]?.text || ''
  }

  it('H2-03: message_equals respeta la normalización del motor (trim/case/des-acento)', async () => {
    assert.strictEqual(await messageEqualsCase('  diámante  ', 'DIAMANTE'), 'RAMA_SI', 'trim+minúsculas+des-acento NFD')
    assert.strictEqual(await messageEqualsCase('   DIÁCRÍTICO   ', 'diacritico'), 'RAMA_SI', 'simetría de la normalización')
    assert.strictEqual(await messageEqualsCase('quiero una cosa', 'QUIERO'), 'RAMA_NO', 'exacto: substring no basta')
    assert.strictEqual(await messageEqualsCase('valgo', 'VALGO'), 'RAMA_SI', 'igual exacto normalizado')
  })

  it('H2-04: combinaciones AND/OR con las nuevas condiciones', async () => {
    assert.strictEqual(
      await evalCondition(
        [
          { type: 'field_greater_than', field: 'edad', value: '17' },
          { type: 'field_less_than', field: 'edad', value: '66' },
        ],
        'AND',
        { fields: { edad: '30' } }
      ),
      'RAMA_SI'
    )
    assert.strictEqual(
      await evalCondition(
        [
          { type: 'field_greater_than', field: 'edad', value: '65' },
          { type: 'field_less_than', field: 'edad', value: '18' },
        ],
        'OR',
        { fields: { edad: '70' } }
      ),
      'RAMA_SI'
    )
    assert.strictEqual(
      await evalCondition(
        [
          { type: 'field_greater_than', field: 'edad', value: '65' },
          { type: 'field_less_than', field: 'edad', value: '66' },
        ],
        'AND',
        { fields: { edad: '30' } }
      ),
      'RAMA_NO'
    )
  })

  it('H2-05: helpers de validación numérica y normalización (unidad)', () => {
    assert.strictEqual(compareNumericValues('10', '5'), 1)
    assert.strictEqual(compareNumericValues('5', '10'), -1)
    assert.strictEqual(compareNumericValues('5', '5.0'), 0)
    assert.strictEqual(compareNumericValues('', '5'), null)
    assert.strictEqual(compareNumericValues('abc', '5'), null)
    assert.strictEqual(normalizeForEngineCompare('  ÁÉÍÓÚ  '), 'aeiou')
  })
})

describe('H3 — nodo AI_RESPONSE ejecuta el motor real de IA', () => {
  function aiFlow(prompt: string, model?: string) {
    return simpleFlow(
      [
        nodeOf('trigger', { keywords: ['inicio_test_hallazgos'] }, 't1'),
        nodeOf('ai_response', { aiPrompt: prompt, aiModel: model }, 'ai1'),
      ],
      [{ source: 't1', target: 'ai1' }]
    )
  }

  it('H3-01: con proveedor REAL inyectado, la respuesta del proveedor se entrega (no texto fijo)', async () => {
    const db = createDatabase(':memory:')
    let receivedPrompt = ''
    const provider: AiCompletionProvider = {
      complete: async (prompt, ctx) => {
        receivedPrompt = prompt
        return { ok: true, text: `RESPUESTA_IA_PARA: ${prompt} | ctx=${Object.keys(ctx).length}` }
      },
    }
    const engine = new FlowEngine(db, provider)
    const org = 'org_h3a'
    engine.saveFlow(org, aiFlow('Cotiza 3 unidades del plan X'))
    const res = await engine.evaluateStep(org, '+573000000020', 'inicio_test_hallazgos', { name: 'Cliente IA' })
    assert.ok(res.messagesToSend[0].text.startsWith('RESPUESTA_IA_PARA:'), 'la respuesta IA real viaja al cliente')
    assert.ok(receivedPrompt.includes('Cotiza 3 unidades'), 'el prompt interpolado fue enviado al proveedor')
    assert.ok(!res.messagesToSend[0].text.includes('[IA Asistente]'), 'el texto fijo viejo NO aparece')
  })

  it('H3-02: error del proveedor → aviso EXPLÍCITO (jamás texto fingido de IA), fallo registrado', async () => {
    const db = createDatabase(':memory:')
    const errors: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { errors.push(String(args[0])) }
    try {
      const provider: AiCompletionProvider = { complete: async () => ({ ok: false, fallback: true, error: 'proveedor IA respondió HTTP 503' }) }
      const engine = new FlowEngine(db, provider)
      const org = 'org_h3b'
      engine.saveFlow(org, aiFlow('hola'))
      const res = await engine.evaluateStep(org, '+573000000021', 'inicio_test_hallazgos', {})
      assert.strictEqual(res.messagesToSend[0].text, AI_UNAVAILABLE_FALLBACK, 'fallback explícito de indisponibilidad')
      assert.ok(errors.some((e) => e.includes('AI_RESPONSE')), 'el fallo queda registrado (no silencio)')
    } finally {
      console.error = originalError
    }
  })

  it('H3-03: respuesta vacía del proveedor → fallback explícito', async () => {
    const db = createDatabase(':memory:')
    const provider: AiCompletionProvider = { complete: async () => ({ ok: true, text: '   ' }) }
    const engine = new FlowEngine(db, provider)
    const org = 'org_h3c'
    engine.saveFlow(org, aiFlow('hola'))
    const res = await engine.evaluateStep(org, '+573000000022', 'inicio_test_hallazgos', {})
    assert.strictEqual(res.messagesToSend[0].text, AI_UNAVAILABLE_FALLBACK)
  })

  it('H3-04: sin AI_API_KEY → proveedor fail-closed, fallback honesto (no aparenta IA)', async () => {
    const db = createDatabase(':memory:')
    const engine = new FlowEngine(db, new UnconfiguredAiProvider())
    const org = 'org_h3d'
    engine.saveFlow(org, aiFlow('hola'))
    const res = await engine.evaluateStep(org, '+573000000023', 'inicio_test_hallazgos', {})
    assert.strictEqual(res.messagesToSend[0].text, AI_UNAVAILABLE_FALLBACK)
    assert.ok(!res.messagesToSend[0].text.includes('🤖'), 'el fallback NO aparenta ser IA')
  })

  it('H3-05: throw del proveedor NO rompe el flujo (clasificado como fallback)', async () => {
    const db = createDatabase(':memory:')
    const provider: AiCompletionProvider = { complete: async () => { throw new Error('timeout de red') } }
    const engine = new FlowEngine(db, provider)
    const org = 'org_h3e'
    engine.saveFlow(org, aiFlow('hola'))
    const res = await engine.evaluateStep(org, '+573000000024', 'inicio_test_hallazgos', {})
    assert.strictEqual(res.messagesToSend[0].text, AI_UNAVAILABLE_FALLBACK)
    assert.strictEqual(res.handled, true, 'el flujo continúa')
  })
})

describe('H4 — persistencia outbound con política explícita', () => {
  /** Proxy de db que hace fallar SOLO el INSERT outbound (dirección 'outbound'). */
  function dbConFalloOutbound(db: ReturnType<typeof createDatabase>) {
    const originalPrepare = db.prepare.bind(db)
    const patched = ((sql: string) => {
      if (sql.includes("'outbound'")) {
        return {
          run: () => { throw new Error('disk I/O error simulado (prueba H4)') },
        }
      }
      return originalPrepare(sql)
    }) as typeof db.prepare
    ;(db as unknown as { prepare: typeof db.prepare }).prepare = patched
    return db
  }

  it('H4-01: fallo de BD NO desaparece: log observable, sin throw y el envío continúa', async () => {
    const db = dbConFalloOutbound(createDatabase(':memory:'))
    const engine = new FlowEngine(db)
    const org = 'org_h4'
    engine.saveFlow(
      org,
      simpleFlow(
        [
          nodeOf('trigger', { keywords: ['inicio_test_hallazgos'] }, 't1'),
          nodeOf('send_message', { messageText: 'Mensaje que SÍ debe enviarse' }, 'm1'),
        ],
        [{ source: 't1', target: 'm1' }]
      )
    )
    const logs: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { logs.push(String(args[0])) }
    let res
    try {
      res = await engine.evaluateStep(org, '+573000000030', 'inicio_test_hallazgos', { name: 'Cliente H4' })
    } finally {
      console.error = originalError
    }
    assert.strictEqual(res.messagesToSend.length, 1, 'el envío NO se revierte por un fallo de auditoría de bandeja')
    assert.strictEqual(res.messagesToSend[0].text, 'Mensaje que SÍ debe enviarse')
    const logged = logs.filter((l) => l.includes('OUTBOUND_NOT_PERSISTED'))
    assert.strictEqual(logged.length, 1, 'el fallo queda REGISTRADO exactamente una vez (no catch {} silencioso)')
    assert.ok(logged[0].includes('org=org_h4'), 'contexto mínimo en el log')
    assert.ok(!logged[0].includes('573000000030'), 'el teléfono (dato sensible) NO aparece en el log')
    // El mensaje INBOUND de la misma evaluación sí quedó persistido (el fallo es solo outbound):
    const inbound = db.prepare("SELECT count(*) AS n FROM inbox_messages WHERE direction = 'inbound'").get() as { n: number }
    assert.strictEqual(inbound.n, 1, 'la operación general sigue funcionando')
  })

  it('H4-02: registro normal se persiste (compatibilidad)', async () => {
    const db = createDatabase(':memory:')
    const engine = new FlowEngine(db)
    const org = 'org_h4b'
    engine.saveFlow(
      org,
      simpleFlow(
        [
          nodeOf('trigger', { keywords: ['inicio_test_hallazgos'] }, 't1'),
          nodeOf('send_message', { messageText: 'ok' }, 'm1'),
        ],
        [{ source: 't1', target: 'm1' }]
      )
    )
    await engine.evaluateStep(org, '+573000000031', 'inicio_test_hallazgos', {})
    const rows = db.prepare("SELECT count(*) AS n FROM inbox_messages WHERE organization_id = ? AND direction = 'outbound'").get(org) as { n: number }
    assert.strictEqual(rows.n, 1, 'el registro outbound queda en la bandeja en operación normal')
  })
})

describe('H5 — webhookToCall SE EJECUTA (router, journal, validación, timeout)', () => {
  function webhookFlow(url: string, headers?: Record<string, string>) {
    return simpleFlow(
      [
        nodeOf('trigger', { keywords: ['inicio_test_hallazgos'] }, 't1'),
        nodeOf('action', { actionType: 'http_webhook', webhookUrl: url, webhookHeaders: headers }, 'w1'),
      ],
      [{ source: 't1', target: 'w1' }]
    )
  }

  function bootRouterWithFlow(db: ReturnType<typeof createDatabase>, flow: FlowDefinition) {
    const transport = new MockTransportSender()
    const router = new ConversationRouter(db, transport, new MockCrmClient())
    router.getFlowEngine().saveFlow('org_h5', flow)
    return { router, transport }
  }

  function mkEvent(eventId: string) {
    return {
      eventId,
      orgId: 'org_h5',
      timestamp: new Date().toISOString(),
      channel: 'whatsapp' as const,
      contact: { phone: '+573000000040', name: 'Cliente H5' },
      message: { id: `msg_${eventId}`, text: 'inicio_test_hallazgos', type: 'text' as const },
    }
  }

  it('H5-01: el webhook configurado SE llama con URL/cabeceras/cuerpo y correlación', async () => {
    const db = createDatabase(':memory:')
    const calls: Array<{ url: string; init: RequestInit }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ received: true }), { status: 200 })
    }) as typeof fetch
    try {
      const { router } = bootRouterWithFlow(db, webhookFlow('https://ejemplo.local/hook', { 'X-Custom-Auth': 'secreto-receptor' }))
      const res = await router.processInbound(mkEvent('evt_h5_1'))
      assert.strictEqual(res.handled, true)
      assert.strictEqual(calls.length, 1, 'el webhook se ejecuta EXACTAMENTE una vez')
      assert.strictEqual(calls[0].url, 'https://ejemplo.local/hook')
      const headers = calls[0].init.headers as Record<string, string>
      assert.strictEqual(headers['X-Custom-Auth'], 'secreto-receptor', 'las cabeceras del nodo viajan')
      assert.ok(headers['X-Correlation-Id'], 'correlación presente')
      assert.strictEqual(headers['Content-Type'], 'application/json')
      const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
      assert.strictEqual(body.contactPhone, '+573000000040', 'el cuerpo del motor viaja')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('H5-02: URL con esquema no permitido → NO se llama y el evento continúa (resultado observable)', async () => {
    const db = createDatabase(':memory:')
    let called = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { called++; return new Response('{}', { status: 200 }) }) as typeof fetch
    try {
      const { router } = bootRouterWithFlow(db, webhookFlow('file:///etc/passwd'))
      const res = await router.processInbound(mkEvent('evt_h5_2'))
      assert.strictEqual(res.handled, true, 'el evento continúa (sin bloquear)')
      assert.strictEqual(called, 0, 'esquema file:// jamás se fetch-ea')
      const j = db.prepare("SELECT status, result_json FROM inbound_effect_journal WHERE effect_key = 'webhook:flow_0'").get() as { status: string; result_json: string }
      assert.strictEqual(j.status, 'DONE', 'el intento queda journalizado')
      const outcome = JSON.parse(j.result_json) as { ok: boolean; error?: string }
      assert.strictEqual(outcome.ok, false)
      assert.ok(outcome.error?.includes('WEBHOOK_URL_NO_PERMITIDA'))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('H5-03: fallo HTTP del receptor → resultado observable, evento COMPLETA (no bloquea)', async () => {
    const db = createDatabase(':memory:')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
    try {
      const { router } = bootRouterWithFlow(db, webhookFlow('https://ejemplo.local/hook'))
      const res = await router.processInbound(mkEvent('evt_h5_3'))
      assert.strictEqual(res.handled, true)
      const j = db.prepare("SELECT result_json FROM inbound_effect_journal WHERE effect_key = 'webhook:flow_0'").get() as { result_json: string }
      const outcome = JSON.parse(j.result_json) as { ok: boolean; status?: number }
      assert.strictEqual(outcome.ok, false)
      assert.strictEqual(outcome.status, 500)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('H5-04: la ejecución es journalizada — reingreso del mismo evento NO repite la llamada', async () => {
    const db = createDatabase(':memory:')
    let called = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { called++; return new Response('{}', { status: 200 }) }) as typeof fetch
    try {
      const { router } = bootRouterWithFlow(db, webhookFlow('https://ejemplo.local/hook'))
      await router.processInbound(mkEvent('evt_h5_4'))
      assert.strictEqual(called, 1)
      await router.processInbound(mkEvent('evt_h5_4'))
      assert.strictEqual(called, 1, 'idempotencia extremo a extremo preservada')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('H6 — multimedia y botones llegan al transporte', () => {
  function mediaFlow(mediaUrl?: string, mediaType?: 'image' | 'audio' | 'video' | 'document', buttons?: Array<{ id: string; title: string; url?: string }>) {
    return simpleFlow(
      [
        nodeOf('trigger', { keywords: ['inicio_test_hallazgos'] }, 't1'),
        nodeOf('send_message', { messageText: 'Mira esto', mediaUrl, mediaType, buttons }, 'm1'),
      ],
      [{ source: 't1', target: 'm1' }]
    )
  }

  it('H6-01: motor → router → MockTransport: mediaUrl/mediaType/buttons propagados', async () => {
    const db = createDatabase(':memory:')
    const transport = new MockTransportSender()
    const router = new ConversationRouter(db, transport, new MockCrmClient())
    router.getFlowEngine().saveFlow('org_h6', mediaFlow('https://cdn.local/catalogo.png', 'image', [{ id: 'b1', title: 'Ver más' }]))
    await router.processInbound({
      eventId: 'evt_h6_1',
      orgId: 'org_h6',
      timestamp: new Date().toISOString(),
      channel: 'whatsapp',
      contact: { phone: '+573000000050', name: 'Cliente H6' },
      message: { id: 'msg_h6_1', text: 'inicio_test_hallazgos', type: 'text' },
    })
    assert.strictEqual(transport.dispatched.length, 1)
    const media = transport.dispatched[0].media
    assert.ok(media, 'el transporte RECIBE el contenido enriquecido')
    assert.strictEqual(media?.mediaUrl, 'https://cdn.local/catalogo.png')
    assert.strictEqual(media?.mediaType, 'image')
    assert.strictEqual(media?.buttons?.length, 1)
    assert.strictEqual(media?.buttons?.[0].title, 'Ver más')
  })

  it('H6-02: Meta Cloud sin media → payload de texto nativo (compatibilidad)', () => {
    const t = new MetaCloudOrgTransport({ allowRealDispatch: true })
    const { payload, degraded } = t.buildGraphPayload('+573000000051', 'hola', undefined)
    assert.strictEqual(degraded.length, 0)
    assert.strictEqual(payload.type, 'text')
    assert.deepStrictEqual((payload as { text: { body: string } }).text, { preview_url: true, body: 'hola' })
  })

  it('H6-03: Meta Cloud con imagen → payload nativo type=image + caption', () => {
    const t = new MetaCloudOrgTransport({ allowRealDispatch: true })
    const { payload, degraded } = t.buildGraphPayload('+573000000052', 'Mira', { mediaUrl: 'https://cdn.local/a.png', mediaType: 'image' })
    assert.strictEqual(degraded.length, 0)
    assert.strictEqual(payload.type, 'image')
    assert.deepStrictEqual((payload as { image: { link: string; caption: string } }).image, { link: 'https://cdn.local/a.png', caption: 'Mira' })
  })

  it('H6-04: Meta Cloud con audio → sin caption (limitación del proveedor respetada)', () => {
    const t = new MetaCloudOrgTransport({ allowRealDispatch: true })
    const { payload } = t.buildGraphPayload('+573000000053', 'Escucha', { mediaUrl: 'https://cdn.local/a.mp3', mediaType: 'audio' })
    assert.strictEqual(payload.type, 'audio')
    const audio = (payload as { audio: { link: string; caption?: string } }).audio
    assert.strictEqual(audio.link, 'https://cdn.local/a.mp3')
    assert.strictEqual(audio.caption, undefined, 'audio no admite caption en Cloud API')
  })

  it('H6-05: Meta Cloud botones de respuesta → interactive button nativo (máx 3, títulos recortados)', () => {
    const t = new MetaCloudOrgTransport({ allowRealDispatch: true })
    const { payload, degraded } = t.buildGraphPayload('+573000000054', 'Elige:', {
      buttons: [
        { title: 'Opción A' },
        { title: 'Opción B con un título MUCHO demasiado largo para WhatsApp' },
        { title: 'Opción C' },
        { title: 'Opción D (excedente)' },
      ],
    })
    assert.strictEqual(payload.type, 'interactive')
    const interactive = (payload as { interactive: { type: string; body: { text: string }; action: { buttons: Array<{ reply: { title: string } }> } } }).interactive
    assert.strictEqual(interactive.type, 'button')
    assert.strictEqual(interactive.action.buttons.length, 3, 'máximo duro de 3 botones de WhatsApp')
    assert.strictEqual(interactive.action.buttons[1].reply.title.length, 20, 'título recortado al límite del proveedor')
    assert.ok(interactive.body.text.includes('Opción D (excedente)'), 'el excedente NO se pierde: viaja como texto')
    assert.ok(degraded.some((d) => d.includes('maximo_3_botones')), 'limitación explícita en degraded')
    assert.ok(degraded.some((d) => d.includes('titulo_boton_recortado')), 'recorte explícito en degraded')
  })

  it('H6-06: Meta Cloud botón URL → cta_url nativo (máx 1, excedente en texto)', () => {
    const t = new MetaCloudOrgTransport({ allowRealDispatch: true })
    const { payload, degraded } = t.buildGraphPayload('+573000000055', 'Abre:', {
      buttons: [
        { title: 'Catalogo', url: 'https://tienda.local/cat' },
        { title: 'Segundo', url: 'https://tienda.local/2' },
      ],
    })
    assert.strictEqual(payload.type, 'interactive')
    const interactive = (payload as { interactive: { type: string; action: { name: string; parameters: { display_text: string; url: string } } } }).interactive
    assert.strictEqual(interactive.type, 'cta_url')
    assert.strictEqual(interactive.action.name, 'cta_url')
    assert.strictEqual(interactive.action.parameters.url, 'https://tienda.local/cat')
    const bodyText = (payload as { interactive: { body: { text: string } } }).interactive.body.text
    assert.ok(bodyText.includes('https://tienda.local/2'), 'el segundo URL no se pierde')
    assert.ok(degraded.some((d) => d.includes('solo_un_boton_url')), 'limitación explícita')
  })

  it('H6-07: Meta Cloud media+botones → caption lista (limitación explícita, sin pérdida)', () => {
    const t = new MetaCloudOrgTransport({ allowRealDispatch: true })
    const { payload, degraded } = t.buildGraphPayload('+573000000056', 'Ficha', {
      mediaUrl: 'https://cdn.local/ficha.jpg',
      mediaType: 'image',
      buttons: [{ title: 'Comprar' }],
    })
    assert.strictEqual(payload.type, 'image')
    const caption = (payload as { image: { caption: string } }).image.caption
    assert.ok(caption.includes('Ficha') && caption.includes('Comprar'), 'texto y botón viajan en el caption')
    assert.ok(degraded.some((d) => d.includes('botones_no_combinables_con_media')), 'limitación explícita')
  })

  it('H6-08: transporte sin soporte nativo (proxy Baileys) degrada EXPLÍCITAMENTE sin perder contenido', () => {
    const { text, degraded } = renderMediaAsText('Mira esto', {
      mediaUrl: 'https://cdn.local/x.jpg',
      mediaType: 'image',
      buttons: [{ title: 'Ver más', url: 'https://tienda.local/mas' }],
    })
    assert.ok(text.includes('Mira esto'), 'el texto original se preserva')
    assert.ok(text.includes('https://cdn.local/x.jpg'), 'la URL de la media viaja en el texto')
    assert.ok(text.includes('Ver más: https://tienda.local/mas'), 'los botones viajan como lista')
    assert.ok(degraded.some((d) => d.includes('media_url_entregada_como_enlace')), 'degradación explícita declarada')
    assert.ok(degraded.some((d) => d.includes('boton_url_convertido_a_texto')), 'limitación declarada')
  })

  it('H6-09: HttpAlbraTransport con media → mensaje degradado llega al daemon (evidencia en body)', async () => {
    process.env.ALLOW_REAL_DISPATCH = 'true'
    let capturedBody: Record<string, unknown> | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ messageId: 'd1' }), { status: 200 })
    }) as typeof fetch
    try {
      const sender = new HttpAlbraTransportSender('http://crm.local', 'secreto')
      const res = await sender.sendMessage('+573000000057', 'Mira', 'corr_h6', 'idem_h6', 'org_h6', {
        mediaUrl: 'https://cdn.local/x.jpg',
        mediaType: 'image',
      })
      assert.strictEqual(res.ok, true)
      assert.ok(res.degraded?.some((d) => d.includes('media_url_entregada_como_enlace')), 'degradación declarada en el resultado')
      assert.ok(String(capturedBody?.message).includes('https://cdn.local/x.jpg'), 'el daemon recibe la URL (contenido no perdido)')
    } finally {
      globalThis.fetch = originalFetch
      process.env.ALLOW_REAL_DISPATCH = 'false'
    }
  })
})
