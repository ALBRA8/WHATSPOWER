/**
 * OLEADA 2 — Ejecutores de automatizaciones POR ORGANIZACIÓN
 * (decisión de negocio Meta/WhatsApp 2026-11-11).
 *
 * Cobertura:
 *   W2A-01  Idempotencia: replay del mismo eventId NO re-dispara ni reenvía.
 *   W2A-02  Despacho real por organización: el orgId viaja al transporte
 *           (jamás una org implícita) + clave de idempotencia por mensaje.
 *   W2A-03  Honestidad: org sin conexión → REJECTED_NO_CONNECTION (sin éxito fingido).
 *   W2A-04  UNCERTAIN: resultado incierto auditado; replay no reintenta.
 *   W2A-05  Reglas por organización: la regla de la org pisa el default;
 *           otra org sin regla propia sigue usando el fallback.
 *   W2A-06  start_flow REAL: sesión abierta EN LA ORG; flujo ajeno → FLOW_UNAVAILABLE.
 *   W2A-07  Clave derivada determinista (sin eventId) también deduplica.
 *   W2A-08  Modo legacy sin transporte: RECORDED_NO_TRANSPORT (sin éxito fingido).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAgenticServer } from '../src/server.ts'
import type { AutomationTransportResult } from '../src/engine/crm-triggers.ts'

interface SentCall {
  to: string
  text: string
  correlationId: string
  idempotencyKey?: string
  orgId?: string
}

function fakeTransport(responder: (call: SentCall) => AutomationTransportResult) {
  const calls: SentCall[] = []
  return {
    calls,
    sendMessage: async (to: string, text: string, correlationId: string, idempotencyKey?: string, orgId?: string) => {
      const call: SentCall = { to, text, correlationId, idempotencyKey, orgId }
      calls.push(call)
      return responder(call)
    },
  }
}

const BASE_EVENT = {
  orgId: 'org_a',
  clientId: 'cl_1',
  clientPhone: '573001112233',
  clientName: 'Laura Pérez',
  opportunityId: 'opp_9',
  fromStage: 'NUEVO',
  toStage: 'PROPUESTA_ENVIADA',
  dealValue: 500000,
}

describe('OLEADA 2 — ejecutores de automatizaciones por organización', () => {
  it('W2A-01: replay del mismo eventId NO vuelve a disparar la automatización', async () => {
    const transport = fakeTransport(() => ({ ok: true, messageId: 'wamid.OK1', outcome: 'SENT' }))
    const { crmTriggers, db } = createAgenticServer({ dbPath: ':memory:', transport: transport as any })

    const first = await crmTriggers.handleStageChange({ ...BASE_EVENT, eventId: 'sevt_abc_1' })
    const replay = await crmTriggers.handleStageChange({ ...BASE_EVENT, eventId: 'sevt_abc_1' })

    assert.equal(first.triggered, true)
    assert.equal(first.status, 'SENT')
    assert.equal(replay.triggered, false)
    assert.equal(replay.duplicate, true)
    // UN solo envío real, UN solo registro de auditoría SENT.
    assert.equal(transport.calls.length, 1)
    const sentRows = db.prepare("SELECT COUNT(*) AS n FROM automation_events WHERE status = 'SENT'").get() as { n: number }
    assert.equal(sentRows.n, 1)
    // Y UN solo mensaje en bandeja (auditoría), pese al replay.
    const outbox = db.prepare("SELECT COUNT(*) AS n FROM inbox_messages WHERE direction = 'outbound' AND contact_phone = ?").get(BASE_EVENT.clientPhone) as { n: number }
    assert.equal(outbox.n, 1)
  })

  it('W2A-02: el orgId del evento viaja al transporte con clave de idempotencia', async () => {
    const transport = fakeTransport(() => ({ ok: true, messageId: 'wamid.OK2', outcome: 'SENT' }))
    const { crmTriggers } = createAgenticServer({ dbPath: ':memory:', transport: transport as any })

    const res = await crmTriggers.handleStageChange({ ...BASE_EVENT, eventId: 'sevt_org_2' })

    assert.equal(res.status, 'SENT')
    assert.equal(transport.calls.length, 1)
    const call = transport.calls[0]
    assert.equal(call.orgId, 'org_a', 'el transporte debe recibir LA ORGANIZACIÓN del evento')
    assert.equal(call.to, BASE_EVENT.clientPhone)
    assert.ok(call.text.includes('Laura Pérez'))
    assert.ok(call.idempotencyKey?.startsWith('stage:sevt_org_2'), 'clave de idempotencia por mensaje')
    assert.ok(call.correlationId.includes('sevt_org_2'))
  })

  it('W2A-03: org sin conexión → REJECTED_NO_CONNECTION, sin éxito fingido', async () => {
    const transport = fakeTransport(() => ({ ok: false, outcome: 'REJECTED', error: 'NO_CONNECTED_NUMBER: la organización no tiene números de WhatsApp conectados (org verificada, sin credenciales resueltas)' }))
    const { crmTriggers, db } = createAgenticServer({ dbPath: ':memory:', transport: transport as any })

    const res = await crmTriggers.handleStageChange({ ...BASE_EVENT, eventId: 'sevt_noconn' })

    assert.equal(res.triggered, true)
    assert.equal(res.status, 'REJECTED_NO_CONNECTION')
    assert.ok(!res.messageId, 'sin messageId no hay envío confirmado')
    const ev = db.prepare("SELECT * FROM automation_events WHERE event_key = 'sevt_noconn'").get() as any
    assert.ok(ev)
    assert.equal(ev.status, 'REJECTED_NO_CONNECTION')
  })

  it('W2A-04: resultado UNCERTAIN queda auditado y el replay NO reintenta', async () => {
    const transport = fakeTransport(() => ({ ok: false, outcome: 'UNCERTAIN', error: 'graph 500 (resultado ambiguo: el mensaje pudo haberse aceptado)' }))
    const { crmTriggers, db } = createAgenticServer({ dbPath: ':memory:', transport: transport as any })

    const first = await crmTriggers.handleStageChange({ ...BASE_EVENT, eventId: 'sevt_unc_1' })
    assert.equal(first.status, 'UNCERTAIN')

    const replay = await crmTriggers.handleStageChange({ ...BASE_EVENT, eventId: 'sevt_unc_1' })
    assert.equal(replay.duplicate, true)
    assert.equal(transport.calls.length, 1, 'un resultado incierto exige reconciliación, no reintento a ciegas')
    const ev = db.prepare("SELECT status FROM automation_events WHERE event_key = 'sevt_unc_1'").get() as { status: string }
    assert.equal(ev.status, 'UNCERTAIN')
  })

  it('W2A-05: la regla DE LA ORGANIZACIÓN pisa el default; otras orgs mantienen el fallback', async () => {
    const transport = fakeTransport(() => ({ ok: true, messageId: 'wamid.OK5', outcome: 'SENT' }))
    const { crmTriggers } = createAgenticServer({ dbPath: ':memory:', transport: transport as any })

    crmTriggers.registerOrgRule('org_a', {
      targetStage: 'PROPUESTA_ENVIADA',
      action: 'send_message',
      templateMessage: 'Hola {{nombre}}, tu propuesta de org_a está lista.',
    })

    const resA = await crmTriggers.handleStageChange({ ...BASE_EVENT, eventId: 'sevt_rule_a' })
    assert.equal(resA.status, 'SENT')
    assert.ok(transport.calls[0].text.includes('org_a está lista'), 'usa la plantilla de LA org')

    // Otra organización, misma etapa, sin regla propia → fallback default.
    const resB = await crmTriggers.handleStageChange({
      ...BASE_EVENT, orgId: 'org_b', eventId: 'sevt_rule_b',
    })
    assert.equal(resB.status, 'SENT')
    assert.ok(transport.calls[1].text.includes('propuesta ya fue generada'), 'la otra org usa el default, no la plantilla ajena')
    assert.equal(transport.calls[1].orgId, 'org_b', 'y despacha con su propia organización')
  })

  it('W2A-06: start_flow abre sesión EN LA ORG; flujo ajeno → FLOW_UNAVAILABLE', async () => {
    const transport = fakeTransport(() => ({ ok: true, messageId: 'wamid.OK6', outcome: 'SENT' }))
    const { crmTriggers, router } = createAgenticServer({ dbPath: ':memory:', transport: transport as any })
    const flowEngine = router.getFlowEngine()

    flowEngine.saveFlow('org_a', {
      id: 'flow_reprogramar_cita',
      name: 'Reprogramar cita',
      triggerKeywords: [],
      isActive: true,
      nodes: [{ id: 'n1', type: 'send_message', title: 'Hola', data: { messageText: 'Hola {{nombre}}, ¿reprogramamos?' } }],
      edges: [],
    })

    const res = await crmTriggers.handleStageChange({
      ...BASE_EVENT, toStage: 'NO_SHOW', eventId: 'sevt_flow_1',
    })
    assert.equal(res.triggered, true)
    assert.equal(res.status, 'FLOW_STARTED')
    const session = flowEngine.getSession('org_a', BASE_EVENT.clientPhone)
    assert.ok(session, 'la sesión debe existir en la org del evento')
    assert.equal(session.flowId, 'flow_reprogramar_cita')

    // La MISMA regla para una org SIN el flujo → no se arranca flujo ajeno.
    const resB = await crmTriggers.handleStageChange({
      ...BASE_EVENT, orgId: 'org_b', toStage: 'NO_SHOW', eventId: 'sevt_flow_2',
    })
    assert.equal(resB.status, 'FLOW_UNAVAILABLE')
    assert.equal(resB.triggered, false)
    assert.equal(flowEngine.getSession('org_b', BASE_EVENT.clientPhone), null)
  })

  it('W2A-07: sin eventId, la clave derivada determinista deduplica igual', async () => {
    const transport = fakeTransport(() => ({ ok: true, messageId: 'wamid.OK7', outcome: 'SENT' }))
    const { crmTriggers } = createAgenticServer({ dbPath: ':memory:', transport: transport as any })

    const first = await crmTriggers.handleStageChange({ ...BASE_EVENT })
    const replay = await crmTriggers.handleStageChange({ ...BASE_EVENT })

    assert.equal(first.triggered, true)
    assert.ok(first.eventKey.startsWith('auto_'))
    assert.equal(replay.duplicate, true)
    assert.equal(transport.calls.length, 1)
  })

  it('W2A-08: sin transporte conectado → RECORDED_NO_TRANSPORT (sin éxito fingido)', async () => {
    const { crmTriggers, db, router } = createAgenticServer({ dbPath: ':memory:' })
    const { CrmTriggerListener } = await import('../src/engine/crm-triggers.ts')
    // Instancia directa SIN transporte: el mensaje se registra pero el estado
    // es honesto (RECORDED_NO_TRANSPORT), jamás un "enviado" falso.
    const listener = new CrmTriggerListener(db, router.getFlowEngine())

    const res = await listener.handleStageChange({ ...BASE_EVENT, eventId: 'sevt_legacy_1' })
    assert.equal(res.triggered, true)
    assert.equal(res.status, 'RECORDED_NO_TRANSPORT')
    const ev = db.prepare("SELECT status FROM automation_events WHERE event_key = 'sevt_legacy_1'").get() as { status: string }
    assert.ok(ev, 'la ejecución queda auditada')
    assert.equal(ev.status, 'RECORDED_NO_TRANSPORT')
    void crmTriggers
  })
})
