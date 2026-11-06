/**
 * CUARTA REPARACIÓN — B2: RESULTADOS AMBIGUOS DEL TRANSPORTE.
 *
 * Problema reproducido: el transporte clasificaba CUALQUIER 5xx / fallo de red
 * como rechazo definitivo (ok:false sin más), cuando 502/503/timeout/conexión
 * cortada pueden ocurrir DESPUÉS de que el daemon aceptó el mensaje. Eso
 * permitía tratar un posible envío como "no enviado" (reintento ciego →
 * duplicado) y jamás dejaba la clave en UNCERTAIN.
 *
 * Contrato verificado:
 *  T-B2-01  Clasificación del HttpAlbraTransportSender: 2xx → SENT;
 *           400/401/403/429 → REJECTED (evidencia fiable de no aceptación);
 *           502/503/timeout/red/respuesta ilegible → UNCERTAIN.
 *  T-B2-02  La clave de idempotencia VIAJA al daemon (header + cuerpo).
 *  T-B2-03  Envío ambiguo (502) con router real: la clave queda UNCERTAIN,
 *           el reingreso del mismo evento NO reintenta a ciegas
 *           ('uncertain_needs_reconciliation') y NO re-invoca al transporte.
 *  T-B2-04  Reconciliación explícita tras ambigüedad: re-ejecuta SOLO el envío
 *           pendiente, exactamente UNA vez; clave → COMPLETED.
 *  T-B2-05  Rechazo DEFINITIVO (400): clave FAILED (no UNCERTAIN), efecto
 *           REJECTED, y el reintento limpio re-ejecuta el envío una vez.
 *  T-B2-06  Fallo SIN clasificar (ok:false sin outcome) → se asume ambiguo
 *           (fail-safe: nunca se trata un posible envío como rechazo).
 *  T-B2-07  El guard ALLOW_REAL_DISPATCH sigue bloqueando (REJECTED, sin fetch).
 *
 * Sin mocks en la lógica bajo prueba: ConversationRouter real + BD real
 * (':memory:') + transporte stub QUE REGISTRA despachos (el stub documenta
 * qué habría salido por el cable; la clasificación la hace el código real).
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { createDatabase } from '../src/db.ts'
import { HttpAlbraTransportSender } from '../src/adapters/transport.ts'
import type { TransportSender, TransportSendResult, CrmClientInterface, InboundEvent } from '../src/types.ts'
import { ConversationRouter } from '../src/engine/router.ts'

// ---------------------------------------------------------------------------
// Stubs de laboratorio (documentan el cable; la clasificación es código real)
// ---------------------------------------------------------------------------

/** Transporte que devuelve resultados guionizados y cuenta invocaciones. */
class ScriptedTransport implements TransportSender {
  calls = 0
  dispatched: Array<{ to: string; text: string }> = []
  private script: Array<TransportSendResult | 'THROW'>
  constructor(script: Array<TransportSendResult | 'THROW'>) {
    this.script = script
  }
  async sendMessage(to: string, text: string): Promise<TransportSendResult> {
    const step = this.script[Math.min(this.calls, this.script.length - 1)]
    this.calls++
    if (step === 'THROW') throw new Error('ECONNRESET: la conexión se cerró a mitad de la respuesta')
    if (step.ok) this.dispatched.push({ to, text })
    return step
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

function keyStatus(db: ReturnType<typeof createDatabase>, key: string): string {
  const row = db.prepare('SELECT status FROM idempotency_keys WHERE key = ?').get(key) as { status: string } | undefined
  return row?.status ?? '(sin fila)'
}

/** Estado de LOS efectos de envío del evento (el effect_key exacto depende de la regla disparada). */
function sendEffectStatuses(db: ReturnType<typeof createDatabase>, key: string): string[] {
  const rows = db.prepare("SELECT status FROM inbound_effect_journal WHERE key = ? AND effect_type = 'send_message'").all(key) as Array<{ status: string }>
  return rows.map((r) => r.status)
}

const AMBIGUOUS_502: TransportSendResult = { ok: false, error: 'Error del transporte WhatsApp: 502', outcome: 'UNCERTAIN' }
const SENT_OK = (n: number): TransportSendResult => ({ ok: true, messageId: `wa_${n}`, outcome: 'SENT' })

// ---------------------------------------------------------------------------
// T-B2-01/02: clasificación del transporte HTTP real (fetch stubbeado)
// ---------------------------------------------------------------------------
test('T-B2-01: HttpAlbraTransportSender clasifica 2xx/4xx/5xx/red sin ambigüedad', async () => {
  const realFetch = globalThis.fetch
  process.env.ALLOW_REAL_DISPATCH = 'true'
  try {
    const sender = new HttpAlbraTransportSender('http://crm.test', 's3cret')
    const respondWith = (status: number, body: unknown = { messageId: 'm1' }) => {
      globalThis.fetch = async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    }

    // 2xx legible → SENT
    respondWith(200)
    assert.deepEqual(await sender.sendMessage('+573001112233', 'hola', 'corr_x'), { ok: true, messageId: 'm1', outcome: 'SENT' })

    // 2xx con cuerpo ilegible → UNCERTAIN (aceptación no confirmable)
    respondWith(200, '<html>gateway garbage')
    let r = await sender.sendMessage('+573001112233', 'hola', 'corr_x')
    assert.equal(r.ok, false)
    assert.equal(r.outcome, 'UNCERTAIN')

    // 5xx y 408 → UNCERTAIN (el daemon pudo aceptar antes del fallo)
    for (const status of [500, 502, 503, 504, 408]) {
      respondWith(status, { error: 'x' })
      r = await sender.sendMessage('+573001112233', 'hola', 'corr_x')
      assert.equal(r.outcome, 'UNCERTAIN', `HTTP ${status} debe ser UNCERTAIN`)
      assert.equal(r.ok, false)
    }

    // 4xx de rechazo a nivel API → REJECTED (evidencia fiable de no aceptación)
    for (const status of [400, 401, 403, 404, 413, 422, 429]) {
      respondWith(status, { error: 'x' })
      r = await sender.sendMessage('+573001112233', 'hola', 'corr_x')
      assert.equal(r.outcome, 'REJECTED', `HTTP ${status} debe ser REJECTED`)
    }

    // Fallo de red (throw del fetch) → UNCERTAIN, JAMÁS rechazo definitivo
    globalThis.fetch = async () => {
      throw new Error('socket hang up')
    }
    r = await sender.sendMessage('+573001112233', 'hola', 'corr_x')
    assert.equal(r.ok, false)
    assert.equal(r.outcome, 'UNCERTAIN')
  } finally {
    globalThis.fetch = realFetch
    delete process.env.ALLOW_REAL_DISPATCH
  }
})

test('T-B2-02: la clave de idempotencia viaja al daemon (header X-Correlation-Id + cuerpo idempotencyKey)', async () => {
  const realFetch = globalThis.fetch
  process.env.ALLOW_REAL_DISPATCH = 'true'
  try {
    let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null
    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      captured = { url: String(url), headers, body }
      return new Response(JSON.stringify({ messageId: 'm1' }), { status: 200 })
    }
    const sender = new HttpAlbraTransportSender('http://crm.test', 's3cret-never-logged')
    await sender.sendMessage('+573001112233', 'hola', 'corr_idem_1')

    assert.ok(captured)
    const c = captured as unknown as { url: string; headers: Record<string, string>; body: Record<string, unknown> }
    assert.equal(c.headers['X-Correlation-Id'], 'corr_idem_1')
    assert.equal(c.body.idempotencyKey, 'corr_idem_1')
    assert.equal(c.body.path, '/send')
  } finally {
    globalThis.fetch = realFetch
    delete process.env.ALLOW_REAL_DISPATCH
  }
})

// ---------------------------------------------------------------------------
// T-B2-03: envío ambiguo → UNCERTAIN + SIN reintento ciego
// ---------------------------------------------------------------------------
test('T-B2-03: 502 tras posible aceptación → clave UNCERTAIN; el reingreso NO reintenta (bloqueado)', async () => {
  // El daemon pudo aceptar: el 502 llega sin confirmación (outcome UNCERTAIN).
  const transport = new ScriptedTransport([AMBIGUOUS_502])
  const crm = new RecordingCrm()
  const { db, router } = bootRouter(transport, crm)

  // Contacto existente → el caso D envía un único mensaje de ayuda genérica.
  const ev = inboundEvent('org_x', 'evt_b2_1', '+573001112233', 'CATALOGO')
  ev.contact.clientId = 'cl_existente'

  await assert.rejects(() => router.processInbound(ev), /AMBIGUOUS_DISPATCH/)
  const idemKey = 'org_x::evt_b2_1'
  assert.equal(keyStatus(db, idemKey), 'UNCERTAIN', 'la clave debe quedar UNCERTAIN (no FAILED ni COMPLETED)')
  assert.deepEqual(sendEffectStatuses(db, idemKey), ['PENDING'], 'el envío ambiguo queda PENDING en el journal')

  // REINGRESO del MISMO evento (lo que antes era un reintento ciego con
  // duplicado potencial): debe BLOQUEARSE sin invocar al transporte otra vez.
  const callsBefore = transport.calls
  const res = await router.processInbound(ev)
  assert.equal(res.actionTaken, 'uncertain_needs_reconciliation')
  assert.equal(transport.calls, callsBefore, 'prohibido re-invocar al transporte con la clave UNCERTAIN')
  assert.equal(keyStatus(db, idemKey), 'UNCERTAIN')

  // Visible en el listado de reconciliación explícita.
  const uncertain = router.listUncertainEvents(10)
  assert.ok(uncertain.some((u) => u.key === idemKey), 'la clave debe aparecer en el listado UNCERTAIN')
})

// ---------------------------------------------------------------------------
// T-B2-04: reconciliación explícita tras ambigüedad → exactamente un envío
// ---------------------------------------------------------------------------
test('T-B2-04: reconciliar tras ambigüedad re-ejecuta SOLO el envío pendiente, una vez', async () => {
  const transport = new ScriptedTransport([AMBIGUOUS_502, SENT_OK(2)])
  const crm = new RecordingCrm()
  const { db, router } = bootRouter(transport, crm)

  const ev = inboundEvent('org_x', 'evt_b2_2', '+573004445555', 'CATALOGO')
  ev.contact.clientId = 'cl_existente'
  await assert.rejects(() => router.processInbound(ev), /AMBIGUOUS_DISPATCH/)
  assert.equal(transport.dispatched.length, 0, 'un 502 sin confirmación no registra despacho confirmado')

  // Reconciliación EXPLÍCITA (nunca automática): el transporte ya responde bien.
  const result = await router.reconcileEvent('org_x::evt_b2_2')
  assert.ok(result)
  assert.equal(result?.handled, true)
  assert.equal(transport.dispatched.length, 1, 'el mensaje se envía EXACTAMENTE una vez en total')
  assert.equal(keyStatus(db, 'org_x::evt_b2_2'), 'COMPLETED')

  // Un reingreso posterior tras completar la reconciliación es deduplicado.
  const res = await router.processInbound(ev)
  assert.equal(res.actionTaken, 'deduplicated')
  assert.equal(transport.dispatched.length, 1)
})

// ---------------------------------------------------------------------------
// T-B2-05: rechazo DEFINITIVO (400) → FAILED + reintento limpio permitido
// ---------------------------------------------------------------------------
test('T-B2-05: rechazo 400 (evidencia fiable de no aceptación) → FAILED y reintento limpio una vez', async () => {
  const transport = new ScriptedTransport([
    { ok: false, error: 'Error del transporte WhatsApp: 400', outcome: 'REJECTED' },
    SENT_OK(2),
  ])
  const crm = new RecordingCrm()
  const { db, router } = bootRouter(transport, crm)

  const ev = inboundEvent('org_x', 'evt_b2_3', '+573006667777', 'CATALOGO')
  ev.contact.clientId = 'cl_existente'

  await assert.rejects(() => router.processInbound(ev), /TRANSPORT_REJECTED/)
  const idemKey = 'org_x::evt_b2_3'
  assert.equal(keyStatus(db, idemKey), 'FAILED', 'un rechazo definitivo NO debe contaminar con UNCERTAIN')
  assert.deepEqual(sendEffectStatuses(db, idemKey), ['REJECTED'], 'el efecto queda REJECTED (evidencia de no aceptación registrada)')

  // Reintento limpio (nuevo proceso del mismo evento): permitido porque hay
  // certeza de que el mensaje NO salió; se ejecuta UNA vez y completa.
  const res = await router.processInbound(ev)
  assert.equal(res.actionTaken, 'keyword_rule')
  assert.equal(res.handled, true)
  assert.equal(transport.dispatched.length, 1)
  assert.equal(keyStatus(db, idemKey), 'COMPLETED')
})

// ---------------------------------------------------------------------------
// T-B2-06: fallo SIN clasificar → ambiguo por defecto (fail-safe)
// ---------------------------------------------------------------------------
test('T-B2-06: resultado fallido sin outcome se asume AMBIGUO (nunca rechazo definitivo implícito)', async () => {
  const transport = new ScriptedTransport([{ ok: false, error: 'fallo legacy sin clasificar' }])
  const crm = new RecordingCrm()
  const { db, router } = bootRouter(transport, crm)

  const ev = inboundEvent('org_x', 'evt_b2_4', '+573008889999', 'CATALOGO')
  ev.contact.clientId = 'cl_existente'
  await assert.rejects(() => router.processInbound(ev), /AMBIGUOUS_DISPATCH/)
  assert.equal(keyStatus(db, 'org_x::evt_b2_4'), 'UNCERTAIN', 'sin clasificación el resultado es ambiguo (fail-safe)')
})

// ---------------------------------------------------------------------------
// T-B2-07: el guard ALLOW_REAL_DISPATCH sigue siendo fail-closed
// ---------------------------------------------------------------------------
test('T-B2-07: sin ALLOW_REAL_DISPATCH el envío se bloquea con REJECTED y sin fetch', async () => {
  const realFetch = globalThis.fetch
  delete process.env.ALLOW_REAL_DISPATCH
  let fetchCalled = 0
  globalThis.fetch = async () => {
    fetchCalled++
    return new Response('{}', { status: 200 })
  }
  try {
    const sender = new HttpAlbraTransportSender('http://crm.test', 's3cret')
    const r = await sender.sendMessage('+573001112233', 'hola', 'corr_guard')
    assert.equal(r.ok, false)
    assert.equal(r.outcome, 'REJECTED', 'el bloqueo local es previo al envío: evidencia fiable de que nada salió')
    assert.match(r.error || '', /DISPATCH_BLOCKED_BY_SAFETY_GUARD/)
    assert.equal(fetchCalled, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})
