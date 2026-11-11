/**
 * B2 (FASE FINAL) — IDEMPOTENCIA DURABLE DE ENVÍOS EXTERNOS, AISLADA POR ORGANIZACIÓN.
 *
 * Hallazgo corregido: el daemon Baileys de Capa 1 NO consume ni persiste
 * "idempotencyKey" / "X-Correlation-Id"; si acepta un mensaje y la respuesta
 * se pierde antes de confirmar DONE, el journal podía re-ejecutar un efecto
 * PENDING al vencer el lease (duplicado real ante un daemon sin dedup).
 *
 * Contrato verificado (requisitos 1-7 del bloqueo B2):
 *  T-B2F-01  VENTANA CRÍTICA: el daemon ACEPTA el primer envío, la respuesta
 *            se pierde → 2ª petición con la misma clave NO genera un segundo
 *            sendMessage; la reconciliación sin confirmación tampoco.
 *  T-B2F-02  CAÍDA + LEASE VENCIDO: el journal JAMÁS re-ejecuta efectos
 *            PENDING tras una caída; pasan a UNCERTAIN (journal y registro
 *            durable de envíos) y exigen reconciliación con evidencia.
 *  T-B2F-03  El intento se REGISTRA ANTES de llamar a Baileys (fila IN_FLIGHT
 *            visible por el transporte en el momento de la llamada).
 *  T-B2F-04  Clave repetida en IN_FLIGHT / SENT / UNCERTAIN → se devuelve su
 *            estado y NO se reenvía (sólo REJECTED previo permite reintento).
 *  T-B2F-05  AISLAMIENTO POR ORGANIZACIÓN: claves IGUALES entre organizaciones
 *            no colisionan ni se contaminan (cada org envía lo suyo).
 *  T-B2F-06  Restricción única (organization_id, idempotency_key) en la BD.
 *  T-B2F-07  La clave POR MENSAJE viaja al daemon (X-Idempotency-Key + cuerpo).
 *  T-B2F-08  Regresión: toma de posesión con journal todo-DONE sigue
 *            completando SIN nuevos envíos (la caída fue tras todo efecto).
 *  T-B2F-09  Sin exactly-once: el reenvío autorizado (confirmResend) es UN
 *            intento auditado; si vuelve a ser incierto, sigue UNCERTAIN.
 *
 * Sin mocks en la lógica bajo prueba: ConversationRouter real + BD real
 * (':memory:') + transporte scripted QUE REGISTRA los despachos aceptados
 * por el "daemon" (el stub documenta qué salió por el cable).
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { createDatabase } from '../src/db.ts'
import { HttpAlbraTransportSender } from '../src/adapters/transport.ts'
import type { TransportSender, TransportSendResult, CrmClientInterface, InboundEvent } from '../src/types.ts'
import { ConversationRouter } from '../src/engine/router.ts'

// ---------------------------------------------------------------------------
// Stubs de laboratorio
// ---------------------------------------------------------------------------

type Behavior = 'ACCEPT_LOST' | 'OK' | 'UNCERTAIN_502' | 'REJECT_400'

/** Transporte scripted: ACCEPT_LOST = el daemon ACEPTA y despacha el mensaje,
 * pero la respuesta se pierde (ECONNRESET a mitad de respuesta). */
class ScriptedDaemonTransport implements TransportSender {
  calls = 0
  dispatched: Array<{ to: string; text: string; idempotencyKey?: string }> = []
  private script: Behavior[]
  constructor(script: Behavior[]) {
    this.script = script
  }
  private step(): Behavior {
    return this.script[Math.min(this.calls, this.script.length - 1)]
  }
  async sendMessage(to: string, text: string, correlationId: string, idempotencyKey?: string): Promise<TransportSendResult> {
    const s = this.step()
    this.calls++
    if (s === 'OK' || s === 'ACCEPT_LOST') {
      // Evidencia: el daemon aceptó y DESPACHÓ el mensaje al proveedor.
      this.dispatched.push({ to, text, idempotencyKey })
    }
    if (s === 'ACCEPT_LOST') throw new Error('ECONNRESET: la respuesta se perdió tras la aceptación del daemon')
    if (s === 'UNCERTAIN_502') return { ok: false, error: 'Error del transporte WhatsApp: 502', outcome: 'UNCERTAIN' }
    if (s === 'REJECT_400') return { ok: false, error: 'Error del transporte WhatsApp: 400', outcome: 'REJECTED' }
    return { ok: true, messageId: `wa_${this.calls}`, outcome: 'SENT' }
  }
}

/** Transporte que PROBE el registro durable EN EL MOMENTO de la llamada a Baileys. */
class RegistryProbeTransport implements TransportSender {
  observations: Array<{ existed: boolean; status?: string; idempotencyKey?: string }> = []
  private db: ReturnType<typeof createDatabase>
  private orgId: string
  constructor(db: ReturnType<typeof createDatabase>, orgId: string) {
    this.db = db
    this.orgId = orgId
  }
  async sendMessage(to: string, text: string, correlationId: string, idempotencyKey?: string): Promise<TransportSendResult> {
    if (!idempotencyKey) throw new Error('el router debe pasar la clave de idempotencia POR MENSAJE al transporte')
    const row = this.db.prepare('SELECT status FROM daemon_send_idempotency WHERE organization_id = ? AND idempotency_key = ?')
      .get(this.orgId, idempotencyKey) as { status: string } | undefined
    this.observations.push({ existed: Boolean(row), status: row?.status, idempotencyKey })
    return { ok: true, messageId: 'probe_1', outcome: 'SENT' }
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

function bootRouter(transport: TransportSender, crm: CrmClientInterface, db = createDatabase(':memory:')) {
  const router = new ConversationRouter(db, transport, crm)
  return { db, router }
}

function inboundEvent(orgId: string, eventId: string, phone: string, text: string, correlationId?: string): InboundEvent {
  return {
    eventId,
    orgId,
    correlationId: correlationId ?? `corr_${eventId}`,
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

function sendRow(db: ReturnType<typeof createDatabase>, orgId: string, sendIdemKey: string): { status: string; attempt_count: number; daemon_message_id: string | null } | undefined {
  return db.prepare('SELECT status, attempt_count, daemon_message_id FROM daemon_send_idempotency WHERE organization_id = ? AND idempotency_key = ?')
    .get(orgId, sendIdemKey) as { status: string; attempt_count: number; daemon_message_id: string | null } | undefined
}

function journalSendStatus(db: ReturnType<typeof createDatabase>, key: string): string[] {
  const rows = db.prepare("SELECT status FROM inbound_effect_journal WHERE key = ? AND effect_type = 'send_message'").all(key) as Array<{ status: string }>
  return rows.map((r) => r.status)
}

// 'CATALOGO' dispara la regla determinista (Caso B): UN único envío
// 'rule_keyword_reply' y ninguna acción CRM. sendIdemKey = `${corr}#rule_keyword_reply`.
const KEYWORD = 'CATALOGO'
const EFFECT = 'rule_keyword_reply'

// ---------------------------------------------------------------------------
// T-B2F-01 (requisito 5): aceptación externa + pérdida de respuesta
// ---------------------------------------------------------------------------
test('T-B2F-01: el daemon acepta, la respuesta se pierde y una 2ª petición con la misma clave NO genera un 2º sendMessage', async () => {
  // 1er intento: aceptación + respuesta perdida. Tras verificar externamente
  // la no llegada, el operador autoriza exactamente UN reenvío (OK).
  const transport = new ScriptedDaemonTransport(['ACCEPT_LOST', 'OK'])
  const crm = new RecordingCrm()
  const { db, router } = bootRouter(transport, crm)

  const ev = inboundEvent('org_x', 'evt_f1', '+573001112233', KEYWORD)
  await assert.rejects(() => router.processInbound(ev), /AMBIGUOUS_DISPATCH/)

  const org = 'org_x'
  const sendKey = `corr_evt_f1#${EFFECT}`
  // Evidencia durable: el intento quedó registrado y su resultado es UNKNOWN.
  assert.deepEqual(journalSendStatus(db, 'org_x::evt_f1'), ['PENDING'])
  const row1 = sendRow(db, org, sendKey)
  assert.equal(row1?.status, 'UNCERTAIN', 'el intento aceptado con respuesta perdida queda UNCERTAIN (no REJECTED ni SENT)')
  assert.equal(row1?.attempt_count, 1)
  assert.equal(transport.dispatched.length, 1, 'el daemon aceptó EXACTAMENTE un despacho')

  // SEGUNDA PETICIÓN con la misma clave (reingreso del evento): debe devolver
  // el estado y NO volver a llamar a sendMessage (ni aunque el transporte ya
  // funcione: el script siguiente sería OK).
  const res2 = await router.processInbound(ev)
  assert.equal(res2.actionTaken, 'uncertain_needs_reconciliation')
  assert.equal(transport.calls, 1, 'NO se invocó sendMessage una segunda vez')
  assert.equal(transport.dispatched.length, 1, 'NO hay segundo despacho al proveedor')
  assert.equal(keyStatus(db, 'org_x::evt_f1'), 'UNCERTAIN')

  // Reconciliación SIN confirmación: tampoco reenvía (falla de forma segura,
  // requisito 7) y entrega la EVIDENCIA del envío incierto.
  const report = await router.reconcileEvent('org_x::evt_f1')
  assert.ok(report)
  assert.equal(report?.resolved, false)
  assert.equal(report?.requiresManualResolution, true)
  assert.equal(transport.calls, 1, 'la reconciliación sin confirmResend JAMÁS reenvía')
  assert.equal(report?.uncertainSends.length, 1)
  assert.equal(report?.uncertainSends[0]?.status, 'UNCERTAIN')
  assert.equal(report?.uncertainSends[0]?.idempotencyKey, sendKey)
  assert.equal(keyStatus(db, 'org_x::evt_f1'), 'UNCERTAIN', 'sin confirmación la clave sigue UNCERTAIN')

  // Resolución CON EVIDENCIA (requisito 4): el operador afirmó externamente
  // que el mensaje NO llegó → UN solo reenvío autorizado y auditado.
  const report2 = await router.reconcileEvent('org_x::evt_f1', { confirmResend: true })
  assert.ok(report2)
  assert.equal(report2?.resolved, true, 'el reenvío autorizado completa el ciclo')
  assert.equal(report2?.resendAuthorized, true)
  assert.equal(transport.calls, 2, 'exactamente UN reenvío autorizado')
  assert.equal(transport.dispatched.length, 2)
  assert.equal(keyStatus(db, 'org_x::evt_f1'), 'COMPLETED')
  const row2 = sendRow(db, org, sendKey)
  assert.equal(row2?.status, 'SENT')
  assert.equal(row2?.attempt_count, 2, 'la evidencia audita los DOS intentos')

  // Reingreso tras resolver: deduplicado, sin más envíos.
  const res3 = await router.processInbound(ev)
  assert.equal(res3.actionTaken, 'deduplicated')
  assert.equal(transport.calls, 2)
})

// ---------------------------------------------------------------------------
// T-B2F-02 (requisito 4): caída + lease vencido → PENDING jamás se re-ejecuta
// ---------------------------------------------------------------------------
test('T-B2F-02: crash tras aceptación (lease vencido) → el journal NO re-ejecuta el PENDING; pasa a UNCERTAIN con evidencia', async () => {
  const transport1 = new ScriptedDaemonTransport(['ACCEPT_LOST'])
  const crm = new RecordingCrm()
  const db = createDatabase(':memory:')
  const router1 = new ConversationRouter(db, transport1, crm)

  const ev = inboundEvent('org_x', 'evt_f2', '+573002223344', KEYWORD)
  await assert.rejects(() => router1.processInbound(ev), /AMBIGUOUS_DISPATCH/)
  assert.equal(transport1.dispatched.length, 1, 'el daemon aceptó el primer despacho')

  // SIMULACIÓN DEL CRASH EN LA VENTANA CRÍTICA: el proceso murió entre el
  // registro del intento (IN_FLIGHT) y la escritura del resultado — estado en
  // disco: registro IN_FLIGHT + journal PENDING + clave PROCESSING con lease vencido.
  const past = Math.floor(Date.now() / 1000) - 300
  db.prepare("UPDATE daemon_send_idempotency SET status = 'IN_FLIGHT' WHERE organization_id = 'org_x' AND idempotency_key = 'corr_evt_f2#rule_keyword_reply'").run()
  db.prepare("UPDATE idempotency_keys SET status = 'PROCESSING', lease_expires_at = ? WHERE key = 'org_x::evt_f2'").run(past)
  assert.deepEqual(journalSendStatus(db, 'org_x::evt_f2'), ['PENDING'])

  // NUEVO PROCESO (nueva instancia, BD compartida) + reentrega del evento:
  // la toma de posesión NO debe re-ejecutar el envío.
  const transport2 = new ScriptedDaemonTransport(['OK', 'OK'])
  const router2 = new ConversationRouter(db, transport2, crm)
  const res = await router2.processInbound(ev)

  assert.equal(res.actionTaken, 'uncertain_needs_reconciliation', 'el reingreso tras crash exige reconciliación')
  assert.equal(transport2.calls, 0, 'JAMÁS se re-invoca a sendMessage tras la caída (requisito 4)')
  assert.equal(transport2.dispatched.length, 0)
  assert.equal(keyStatus(db, 'org_x::evt_f2'), 'UNCERTAIN')
  assert.deepEqual(journalSendStatus(db, 'org_x::evt_f2'), ['UNCERTAIN'], 'el efecto PENDING pasa a UNCERTAIN en el journal')
  const row = sendRow(db, 'org_x', 'corr_evt_f2#rule_keyword_reply')
  assert.equal(row?.status, 'UNCERTAIN', 'el intento huérfano IN_FLIGHT pasa a UNCERTAIN (evidencia de resultado desconocido)')

  // Mientras el lease está VIVO, la reentrega es in_flight (sin toma de posesión).
  const alive = Math.floor(Date.now() / 1000) + 300
  db.prepare("UPDATE daemon_send_idempotency SET status = 'IN_FLIGHT' WHERE organization_id = 'org_x' AND idempotency_key = 'corr_evt_f2#rule_keyword_reply'").run()
  db.prepare("UPDATE inbound_effect_journal SET status = 'PENDING' WHERE key = 'org_x::evt_f2'").run()
  db.prepare("UPDATE idempotency_keys SET status = 'PROCESSING', lease_expires_at = ? WHERE key = 'org_x::evt_f2'").run(alive)
  const resLive = await router2.processInbound(ev)
  assert.equal(resLive.actionTaken, 'in_flight')
  assert.equal(transport2.calls, 0)
})

// ---------------------------------------------------------------------------
// T-B2F-03 (requisito 2): el intento se registra ANTES de llamar a Baileys
// ---------------------------------------------------------------------------
test('T-B2F-03: la fila IN_FLIGHT existe ANTES de la llamada al transporte (registro previo a Baileys)', async () => {
  const db = createDatabase(':memory:')
  const probe = new RegistryProbeTransport(db, 'org_x')
  const router = new ConversationRouter(db, probe, new RecordingCrm())

  const ev = inboundEvent('org_x', 'evt_f3', '+573003334455', KEYWORD)
  const res = await router.processInbound(ev)
  assert.equal(res.handled, true)

  // El transporte OBSERVÓ la fila ya registrada (IN_FLIGHT) al ejecutarse:
  // prueba de orden registro → llamada.
  assert.deepEqual(probe.observations, [{ existed: true, status: 'IN_FLIGHT', idempotencyKey: 'corr_evt_f3#rule_keyword_reply' }])
  const row = sendRow(db, 'org_x', 'corr_evt_f3#rule_keyword_reply')
  assert.equal(row?.status, 'SENT')
  assert.ok(row?.daemon_message_id)
})

// ---------------------------------------------------------------------------
// T-B2F-04 (requisito 3): clave repetida en SENT / IN_FLIGHT / UNCERTAIN
// ---------------------------------------------------------------------------
test('T-B2F-04: repetición de clave en estado SENT devuelve el estado y NO reenvía; IN_FLIGHT y UNCERTAIN fallan seguro', async () => {
  const transport = new ScriptedDaemonTransport(['OK', 'OK', 'OK'])
  const crm = new RecordingCrm()
  const { db, router } = bootRouter(transport, crm)

  // Evento 1: envío confirmado (registry SENT).
  const ev1 = inboundEvent('org_x', 'evt_f4a', '+573004440001', KEYWORD, 'corr_compartida')
  const r1 = await router.processInbound(ev1)
  assert.equal(r1.handled, true)
  assert.equal(transport.calls, 1)
  const row1 = sendRow(db, 'org_x', `corr_compartida#${EFFECT}`)
  assert.equal(row1?.status, 'SENT')

  // Evento DISTINTO (otro eventId/teléfono) que reutiliza la MISMA clave de
  // envío (misma org + mismo correlationId + mismo efecto): el registro
  // devuelve el estado SENT y NO se despacha un segundo mensaje.
  const ev2 = inboundEvent('org_x', 'evt_f4b', '+573004440002', KEYWORD, 'corr_compartida')
  const r2 = await router.processInbound(ev2)
  assert.equal(r2.handled, true, 'el ciclo del 2º evento completa (el efecto lógico ya estaba hecho)')
  assert.equal(transport.calls, 1, 'clave repetida en SENT: NO hay segundo sendMessage')
  assert.equal(transport.dispatched.length, 1)
  assert.equal(sendRow(db, 'org_x', `corr_compartida#${EFFECT}`)?.attempt_count, 1)

  // Clave repetida en IN_FLIGHT (otro ejecutor VIVO la sostiene): fail-safe,
  // sin envío y la clave del evento queda UNCERTAIN (no se puede confirmar).
  db.prepare(`
    INSERT INTO daemon_send_idempotency
      (organization_id, idempotency_key, status, to_phone, message_text, correlation_id, attempt_token, attempt_count, created_at, updated_at)
    VALUES ('org_x', 'corr_en_vuelo#rule_keyword_reply', 'IN_FLIGHT', '+573004440003', 'x', 'corr_en_vuelo', 'token-vivo', 1, strftime('%s','now'), strftime('%s','now'))
  `).run()
  const ev3 = inboundEvent('org_x', 'evt_f4c', '+573004440003', KEYWORD, 'corr_en_vuelo')
  await assert.rejects(() => router.processInbound(ev3), /SEND_ALREADY_ATTEMPTED/)
  assert.equal(transport.calls, 1, 'clave IN_FLIGHT: prohibido reenviar')
  assert.equal(sendRow(db, 'org_x', `corr_en_vuelo#${EFFECT}`)?.attempt_count, 1)

  // Clave repetida en UNCERTAIN: mismo trato (sin reenvío, requiere reconciliación).
  db.prepare(`
    INSERT INTO daemon_send_idempotency
      (organization_id, idempotency_key, status, to_phone, message_text, correlation_id, attempt_token, attempt_count, created_at, updated_at)
    VALUES ('org_x', 'corr_incierta#rule_keyword_reply', 'UNCERTAIN', '+573004440004', 'x', 'corr_incierta', 'token-viejo', 1, strftime('%s','now'), strftime('%s','now'))
  `).run()
  const ev4 = inboundEvent('org_x', 'evt_f4d', '+573004440004', KEYWORD, 'corr_incierta')
  await assert.rejects(() => router.processInbound(ev4), /SEND_ALREADY_ATTEMPTED/)
  assert.equal(transport.calls, 1, 'clave UNCERTAIN: prohibido reenviar')
})

// ---------------------------------------------------------------------------
// T-B2F-05 (requisito 6): claves IGUALES entre organizaciones no colisionan
// ---------------------------------------------------------------------------
test('T-B2F-05: aislamiento por organización — la misma clave de envío en dos orgs es independiente', async () => {
  const transport = new ScriptedDaemonTransport(['ACCEPT_LOST', 'OK', 'OK'])
  const crm = new RecordingCrm()
  const { db, router } = bootRouter(transport, crm)

  // org_a: aceptación + respuesta perdida → su clave queda UNCERTAIN.
  const evA = inboundEvent('org_a', 'evt_f5', '+573005550001', KEYWORD, 'corr_igual')
  await assert.rejects(() => router.processInbound(evA), /AMBIGUOUS_DISPATCH/)
  assert.equal(sendRow(db, 'org_a', `corr_igual#${EFFECT}`)?.status, 'UNCERTAIN')

  // org_b: LA MISMA clave de envío (mismo correlationId y efecto) — NO debe
  // heredar el bloqueo ni el estado de org_a: envía SU mensaje.
  const evB = inboundEvent('org_b', 'evt_f5', '+573005550002', KEYWORD, 'corr_igual')
  const rB = await router.processInbound(evB)
  assert.equal(rB.handled, true, 'la clave de org_a no bloquea a org_b')
  assert.equal(transport.dispatched.length, 2, 'cada organización despachó SU mensaje (2 en total)')

  // Estados y evidencia independientes por organización.
  const rowA = sendRow(db, 'org_a', `corr_igual#${EFFECT}`)
  const rowB = sendRow(db, 'org_b', `corr_igual#${EFFECT}`)
  assert.equal(rowA?.status, 'UNCERTAIN', 'el estado de org_a no fue contaminado por org_b')
  assert.equal(rowB?.status, 'SENT')
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM daemon_send_idempotency WHERE idempotency_key = ?').get(`corr_igual#${EFFECT}`) as { n: number }).n,
    2,
    'existen DOS filas con la misma idempotency_key: la unicidad es (organization_id, idempotency_key)'
  )

  // La reentrega de org_a sigue bloqueada (SU clave es UNCERTAIN), la de org_b completó.
  const reA = await router.processInbound(evA)
  assert.equal(reA.actionTaken, 'uncertain_needs_reconciliation')
  const reB = await router.processInbound(evB)
  assert.equal(reB.actionTaken, 'deduplicated')

  // La evidencia listada de cada evento sólo contiene SU organización.
  const evA2 = router.describeUncertainEvent('org_a::evt_f5')
  assert.equal(evA2.sends.length, 1)
  assert.equal(evA2.sends[0]?.organization_id, 'org_a')
})

// ---------------------------------------------------------------------------
// T-B2F-06 (requisito 1): restricción única (organization_id, idempotency_key)
// ---------------------------------------------------------------------------
test('T-B2F-06: la BD impone unicidad (organization_id, idempotency_key) — misma org colisiona, otra org no', () => {
  const db = createDatabase(':memory:')
  const now = Math.floor(Date.now() / 1000)
  const insert = db.prepare(`
    INSERT INTO daemon_send_idempotency
      (organization_id, idempotency_key, status, to_phone, message_text, correlation_id, attempt_token, attempt_count, created_at, updated_at)
    VALUES (?, ?, 'IN_FLIGHT', '+573000000000', 'x', 'c', 't', 1, ?, ?)
  `)
  insert.run('org_a', 'k1', now, now)
  assert.throws(() => insert.run('org_a', 'k1', now, now), 'la MISMA (org, clave) debe chocar con la restricción única')
  insert.run('org_b', 'k1', now, now)
  assert.doesNotThrow(() => insert.run('org_a', 'k2', now, now))
})

// ---------------------------------------------------------------------------
// T-B2F-07: la clave POR MENSAJE viaja al daemon (header + cuerpo)
// ---------------------------------------------------------------------------
test('T-B2F-07: HttpAlbraTransportSender envía X-Idempotency-Key (por mensaje) y conserva X-Correlation-Id', async () => {
  const realFetch = globalThis.fetch
  process.env.ALLOW_REAL_DISPATCH = 'true'
  try {
    let captured: { headers: Record<string, string>; body: Record<string, unknown> } | null = null
    globalThis.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      }
      return new Response(JSON.stringify({ messageId: 'm1' }), { status: 200 })
    }
    const sender = new HttpAlbraTransportSender('http://crm.test', 's3cret-never-logged')
    await sender.sendMessage('+573001112233', 'hola', 'corr_evt', 'corr_evt#rule_keyword_reply')

    assert.ok(captured)
    const c = captured as unknown as { headers: Record<string, string>; body: Record<string, unknown> }
    assert.equal(c.headers['X-Correlation-Id'], 'corr_evt', 'la correlación del evento se conserva')
    assert.equal(c.headers['X-Idempotency-Key'], 'corr_evt#rule_keyword_reply', 'la clave POR MENSAJE viaja en su header')
    assert.equal(c.body.idempotencyKey, 'corr_evt#rule_keyword_reply', 'y también en el cuerpo para el daemon')
  } finally {
    globalThis.fetch = realFetch
    delete process.env.ALLOW_REAL_DISPATCH
  }
})

// ---------------------------------------------------------------------------
// T-B2F-08 (regresión): toma de posesión con journal todo-DONE sigue completando
// ---------------------------------------------------------------------------
test('T-B2F-08: crash DESPUÉS de todos los efectos (journal todo DONE) → el reingreso completa sin nuevos envíos', async () => {
  const transport = new ScriptedDaemonTransport(['OK'])
  const crm = new RecordingCrm()
  const { db, router } = bootRouter(transport, crm)

  const ev = inboundEvent('org_x', 'evt_f8', '+573008880001', KEYWORD)
  await router.processInbound(ev)
  assert.equal(transport.calls, 1)

  // Simula crash entre el último efecto DONE y completeIdempotency:
  // clave PROCESSING con lease vencido y journal todo DONE (sin PENDING).
  const past = Math.floor(Date.now() / 1000) - 300
  db.prepare("UPDATE idempotency_keys SET status = 'PROCESSING', response_json = NULL, lease_expires_at = ? WHERE key = 'org_x::evt_f8'").run(past)

  const transport2 = new ScriptedDaemonTransport(['OK', 'OK'])
  const router2 = new ConversationRouter(db, transport2, crm)
  const res = await router2.processInbound(ev)
  assert.equal(res.handled, true, 'la recuperación segura re-ejecuta el ciclo')
  assert.equal(transport2.calls, 0, 'los efectos DONE se saltan: ningún mensaje se reenvía')
  assert.equal(keyStatus(db, 'org_x::evt_f8'), 'COMPLETED')
})

// ---------------------------------------------------------------------------
// T-B2F-09 (requisito 7): sin exactly-once; un permiso = un intento auditado
// ---------------------------------------------------------------------------
test('T-B2F-09: reenvío autorizado que vuelve a ser incierto sigue UNCERTAIN y audita los intentos', async () => {
  const transport = new ScriptedDaemonTransport(['ACCEPT_LOST', 'UNCERTAIN_502'])
  const crm = new RecordingCrm()
  const { db, router } = bootRouter(transport, crm)

  const ev = inboundEvent('org_x', 'evt_f9', '+573009990001', KEYWORD)
  await assert.rejects(() => router.processInbound(ev), /AMBIGUOUS_DISPATCH/)

  // Autorización 1 → reenvío que vuelve a ser ambiguo (502).
  const report1 = await router.reconcileEvent('org_x::evt_f9', { confirmResend: true })
  assert.equal(report1?.resolved, false, 'la entrega no puede afirmarse: sigue incierto')
  assert.equal(report1?.requiresManualResolution, true)
  assert.equal(transport.calls, 2, 'un permiso = exactamente un intento')
  const row = sendRow(db, 'org_x', `corr_evt_f9#${EFFECT}`)
  assert.equal(row?.status, 'UNCERTAIN')
  assert.equal(row?.attempt_count, 2, 'los intentos quedan auditados en la evidencia')
  assert.equal(keyStatus(db, 'org_x::evt_f9'), 'UNCERTAIN')

  // Sin nueva autorización, ninguna reentrega ni reconciliación vuelve a enviar.
  await router.processInbound(ev)
  await router.reconcileEvent('org_x::evt_f9')
  assert.equal(transport.calls, 2, 'sin confirmResend no hay más intentos')

  // Una NUEVA autorización permite UN intento más (auditable, at-least-once).
  // (Transporte nuevo: su 1ª llamada corresponde al 3er intento histórico.)
  const transport3 = new ScriptedDaemonTransport(['OK'])
  const router3 = new ConversationRouter(db, transport3, crm)
  const report2 = await router3.reconcileEvent('org_x::evt_f9', { confirmResend: true })
  assert.equal(report2?.resolved, true)
  assert.equal(transport3.calls, 1, 'la nueva autorización produce exactamente un intento más')
  assert.equal(sendRow(db, 'org_x', `corr_evt_f9#${EFFECT}`)?.attempt_count, 3, 'evidencia acumulada: 3 intentos')
})
