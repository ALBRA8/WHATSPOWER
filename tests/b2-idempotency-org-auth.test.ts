/**
 * B2 HARDENING — AUTORIZACIÓN Y AISLAMIENTO POR ORGANIZACIÓN EN LA
 * RECONCILIACIÓN DE IDEMPOTENCIA (rutas HTTP internas, servidor REAL).
 *
 * Problema corregido: GET /api/internal/idempotency/uncertain y
 * POST /api/internal/idempotency/reconcile se autorizaban con el secreto
 * GLOBAL (INTERNAL_API_SECRET): cualquier poseedor de ese secreto podía listar
 * claves/estados/evidencias de TODAS las organizaciones, reconciliar claves
 * AJENAS y disparar reenvíos (confirmResend) masivos sin ataduras.
 *
 * Contrato nuevo (fail-closed, verificado contra servidor REAL
 * createAgenticServer con provisión de credenciales por entorno):
 *  W-B2H-01  Sin identidad de servicio (sin X-Org-Id o sin Bearer) → 401 en
 *            GET y POST. El secreto global SOLO ya no autoriza nada aquí.
 *  W-B2H-02  Credencial inválida, de OTRA organización, u org sin provisión
 *            → 403 (GET y POST).
 *  W-B2H-03  Org autorizada → 200; el GET devuelve EXCLUSIVAMENTE sus eventos
 *            UNCERTAIN (sin claves, teléfonos ni evidencias ajenas).
 *  W-B2H-04  POST con clave AJENA → 403 SIN tomar posesión (la clave sigue
 *            UNCERTAIN e intacta para su dueño).
 *  W-B2H-05  `all: true` sólo procesa los eventos UNCERTAIN de la organización
 *            autenticada (jamás eventos globales ni ajenos).
 *  W-B2H-06  `confirmResend: true`: prohibido en lote (400), exige evidencia
 *            documentada (400 si falta/corta) y clave propia (403 ajena). Sin
 *            confirmResend NO hay reenvío alguno (ningún automático). Con
 *            evidencia: exactamente UN reenvío auditado (at-least-once).
 *  W-B2H-07  Aislamiento extremo a extremo: la operación de org_alpha jamás
 *            reenvía ni muta el estado de org_beta.
 *
 * Semilla de estado UNCERTAIN: eventos reales por /api/inbound (HMAC) con un
 * transporte que responde 502 ambiguo (el mensaje pudo salir). Las
 * credenciales usadas aquí son de prueba y jamás se imprimen.
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { createHmac } from 'node:crypto'
import { createAgenticServer } from '../src/server.ts'
import type { TransportSender, TransportSendResult, CrmClientInterface } from '../src/types.ts'

const GLOBAL_SECRET = 'wp_b2h_global_secret_min24chars_000'
const CRED_A = 'org-alpha-service-credential-0000000001'
const CRED_B = 'org-beta-service-credential-000000000002'
const WEBHOOK_SECRET = 'wp_b2h_webhook_secret_test_min24chars'

/** Transporte controlable: 502 ambiguo (UNCERTAIN) o éxito; registra TODO
 * despacho aceptado por el "daemon" para demostrar que no hay reenvíos. */
class ControlledTransport implements TransportSender {
  calls = 0
  dispatched: Array<{ to: string; text: string; idempotencyKey?: string }> = []
  mode: 'UNCERTAIN_502' | 'OK' = 'UNCERTAIN_502'
  async sendMessage(to: string, text: string, correlationId: string, idempotencyKey?: string): Promise<TransportSendResult> {
    this.calls++
    if (this.mode === 'OK') {
      this.dispatched.push({ to, text, idempotencyKey })
      return { ok: true, messageId: `wa_${this.calls}`, outcome: 'SENT' as const }
    }
    return { ok: false, error: 'Error del transporte WhatsApp: 502', outcome: 'UNCERTAIN' as const }
  }
}

class NoCrm implements CrmClientInterface {
  calls: Array<{ action: string; orgId: string }> = []
  async createClient(orgId: string) { this.calls.push({ action: 'create_client', orgId }); return { ok: true, summary: 'ok', clientId: 'cl_x', orgId } }
  async createOpportunity(orgId: string) { this.calls.push({ action: 'create_opportunity', orgId }); return { ok: true, summary: 'ok', orgId } }
  async addNote(orgId: string) { this.calls.push({ action: 'add_note', orgId }); return { ok: true, summary: 'ok', orgId } }
}

async function listen(server: import('node:http').Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve(addr.port)
    })
  })
}

async function withServer(fn: (base: string, transport: ControlledTransport) => Promise<void>): Promise<void> {
  process.env.INTERNAL_API_SECRET = GLOBAL_SECRET
  process.env.ORG_SERVICE_CREDENTIALS = `org_alpha:${CRED_A},org_beta:${CRED_B}`
  const transport = new ControlledTransport()
  const { server } = createAgenticServer({
    dbPath: ':memory:',
    transport,
    crm: new NoCrm(),
    webhookSecret: WEBHOOK_SECRET,
  })
  const port = await listen(server)
  const base = `http://127.0.0.1:${port}`
  try {
    await fn(base, transport)
  } finally {
    server.close()
    delete process.env.ORG_SERVICE_CREDENTIALS
  }
}

/** Semilla REAL de un evento UNCERTAIN: entrega firmada por /api/inbound con
 * transporte ambiguo (502) — el daemon pudo aceptar el mensaje. */
async function seedUncertainEvent(base: string, orgId: string, eventId: string, phone: string): Promise<void> {
  const event = {
    eventId,
    orgId,
    correlationId: `corr_${eventId}`,
    timestamp: new Date().toISOString(),
    channel: 'whatsapp',
    contact: { phone },
    message: { id: `m_${eventId}`, text: 'CATALOGO', type: 'text' },
  }
  const body = JSON.stringify(event)
  const ts = new Date().toISOString()
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex')
  const res = await fetch(`${base}/api/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature-SHA256': sig, 'X-Timestamp': ts },
    body,
  })
  // El despacho ambiguo termina en 500 (AMBIGUOUS_DISPATCH) PERO el estado
  // UNCERTAIN quedó registrado durable — exactamente el estado a reconciliar.
  assert.ok(res.status === 500, `la semilla ambigua responde 500 (llegó ${res.status})`)
}

/** Re-entrega el MISMO evento (nueva firma/timestamp → sin replay). */
async function redeliverEvent(base: string, orgId: string, eventId: string, phone: string): Promise<{ status: number; body: any }> {
  const event = {
    eventId,
    orgId,
    correlationId: `corr_${eventId}`,
    timestamp: new Date().toISOString(),
    channel: 'whatsapp',
    contact: { phone },
    message: { id: `m_${eventId}`, text: 'CATALOGO', type: 'text' },
  }
  const body = JSON.stringify(event)
  const ts = new Date().toISOString()
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex')
  const res = await fetch(`${base}/api/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature-SHA256': sig, 'X-Timestamp': ts },
    body,
  })
  return { status: res.status, body: await res.json() }
}

function authHeaders(orgId: string, credential: string): Record<string, string> {
  return { 'X-Org-Id': orgId, Authorization: `Bearer ${credential}` }
}

async function getJson(res: Response): Promise<any> {
  return JSON.parse(await res.text())
}

// ---------------------------------------------------------------------------
// W-B2H-01: sin identidad de servicio → 401 (fail-closed)
// ---------------------------------------------------------------------------
test('W-B2H-01: sin credenciales → 401 en GET uncertain y POST reconcile (también secreto global solo)', async () => {
  await withServer(async (base) => {
    // GET sin nada.
    const g1 = await fetch(`${base}/api/internal/idempotency/uncertain`)
    assert.equal(g1.status, 401, 'GET sin identidad → 401')

    // GET con SOLO el secreto global (sin X-Org-Id): la identidad de servicio
    // está incompleta → 401 (el global ya no es una identidad por sí mismo).
    const g2 = await fetch(`${base}/api/internal/idempotency/uncertain`, {
      headers: { Authorization: `Bearer ${GLOBAL_SECRET}` },
    })
    assert.equal(g2.status, 401, 'GET con secreto global sin X-Org-Id → 401')

    // POST sin nada.
    const p1 = await fetch(`${base}/api/internal/idempotency/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
    assert.equal(p1.status, 401, 'POST sin identidad → 401')

    // POST con X-Org-Id pero sin Bearer → 401.
    const p2 = await fetch(`${base}/api/internal/idempotency/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org_alpha' },
      body: JSON.stringify({ all: true }),
    })
    assert.equal(p2.status, 401, 'POST sin Bearer → 401')
  })
})

// ---------------------------------------------------------------------------
// W-B2H-02: credencial inválida / de otra organización → 403
// ---------------------------------------------------------------------------
test('W-B2H-02: credencial inválida, ajena o de org sin provisión → 403 en GET y POST', async () => {
  await withServer(async (base) => {
    // El secreto global YA NO autoriza: no es una credencial de la org (403).
    const gGlobal = await fetch(`${base}/api/internal/idempotency/uncertain`, {
      headers: authHeaders('org_alpha', GLOBAL_SECRET),
    })
    assert.equal(gGlobal.status, 403, 'secreto global como credencial → 403')

    // Credencial de org_beta presentada como si fuera de org_alpha → 403.
    const gCross = await fetch(`${base}/api/internal/idempotency/uncertain`, {
      headers: authHeaders('org_alpha', CRED_B),
    })
    assert.equal(gCross.status, 403, 'GET con credencial de otra org → 403')

    // POST cruzado (credencial de B, org declarada alpha) → 403.
    const pCross = await fetch(`${base}/api/internal/idempotency/reconcile`, {
      method: 'POST',
      headers: { ...authHeaders('org_alpha', CRED_B), 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
    assert.equal(pCross.status, 403, 'POST con credencial de otra org → 403')

    // Org SIN credenciales registradas → 403 aunque traiga una credencial válida de otra org.
    const gUnknown = await fetch(`${base}/api/internal/idempotency/uncertain`, {
      headers: authHeaders('org_sin_provision', CRED_A),
    })
    assert.equal(gUnknown.status, 403, 'org sin provisión → 403')
  })
})

// ---------------------------------------------------------------------------
// W-B2H-03: org autorizada → 200 y su listado SIN fugas de otras organizaciones
// ---------------------------------------------------------------------------
test('W-B2H-03: org autorizada accede; el GET sólo contiene SUS eventos UNCERTAIN (sin claves ni evidencias ajenas)', async () => {
  await withServer(async (base) => {
    // Dos eventos UNCERTAIN de org_alpha y uno de org_beta (semilla real).
    await seedUncertainEvent(base, 'org_alpha', 'evt_h_a1', '+573111000001')
    await seedUncertainEvent(base, 'org_alpha', 'evt_h_a2', '+573111000002')
    await seedUncertainEvent(base, 'org_beta', 'evt_h_b1', '+573222000001')

    // Lectura autorizada de org_alpha.
    const gA = await fetch(`${base}/api/internal/idempotency/uncertain`, {
      headers: authHeaders('org_alpha', CRED_A),
    })
    assert.equal(gA.status, 200)
    const bodyA = await getJson(gA)
    assert.equal(bodyA.organizationId, 'org_alpha')
    assert.equal(bodyA.uncertain.length, 2, 'org_alpha ve SOLO sus 2 eventos')
    for (const u of bodyA.uncertain) {
      assert.ok(u.key.startsWith('org_alpha::'), `clave de org_alpha: ${u.key}`)
    }

    // SIN FUGA: ni el id de la otra org, ni su teléfono, ni su correlationId.
    const rawA = JSON.stringify(bodyA)
    assert.ok(!rawA.includes('org_beta'), 'no aparece la otra organización')
    assert.ok(!rawA.includes('evt_h_b1'), 'no aparece la clave ajena')
    assert.ok(!rawA.includes('573222000001'), 'no aparece el teléfono ajeno')
    assert.ok(!rawA.includes('corr_evt_h_b1'), 'no aparece la correlación ajena')

    // Evidencia propia completa: envío ambiguo registrado de SU organización.
    const own = bodyA.uncertain[0]
    assert.ok(own.evidence, 'incluye evidencia durable')
    assert.equal(own.evidence.sends.length, 1)
    assert.equal(own.evidence.sends[0].organization_id, 'org_alpha')
    assert.equal(own.evidence.sends[0].status, 'UNCERTAIN')

    // Lectura autorizada de org_beta: sólo lo suyo.
    const gB = await fetch(`${base}/api/internal/idempotency/uncertain`, {
      headers: authHeaders('org_beta', CRED_B),
    })
    assert.equal(gB.status, 200)
    const bodyB = await getJson(gB)
    assert.equal(bodyB.organizationId, 'org_beta')
    assert.equal(bodyB.uncertain.length, 1)
    assert.ok(bodyB.uncertain[0].key.startsWith('org_beta::'))
    const rawB = JSON.stringify(bodyB)
    assert.ok(!rawB.includes('org_alpha'), 'org_beta no ve nada de org_alpha')
    assert.ok(!rawB.includes('573111000001'), 'ni el teléfono de org_alpha')
  })
})

// ---------------------------------------------------------------------------
// W-B2H-04: POST con clave AJENA → 403 sin efectos (defensa en profundidad)
// ---------------------------------------------------------------------------
test('W-B2H-04: reconciliar clave de otra organización → 403 y la clave queda intacta (sin tomar posesión)', async () => {
  await withServer(async (base) => {
    await seedUncertainEvent(base, 'org_alpha', 'evt_h_a1', '+573111000001')
    await seedUncertainEvent(base, 'org_beta', 'evt_h_b1', '+573222000001')
    const foreignKey = 'org_beta::evt_h_b1'

    // org_alpha intenta reconciliar la clave de org_beta → 403.
    const p = await fetch(`${base}/api/internal/idempotency/reconcile`, {
      method: 'POST',
      headers: { ...authHeaders('org_alpha', CRED_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: foreignKey }),
    })
    assert.equal(p.status, 403, 'clave ajena → 403')

    // La clave sigue UNCERTAIN y visible para SU dueña (no quedó en PROCESSING).
    const gB = await fetch(`${base}/api/internal/idempotency/uncertain`, {
      headers: authHeaders('org_beta', CRED_B),
    })
    const bodyB = await getJson(gB)
    assert.equal(bodyB.uncertain.length, 1, 'la clave sigue listándose para su dueña')
    assert.equal(bodyB.uncertain[0].key, foreignKey)

    // Incluso con confirmResend + evidencia, una clave ajena → 403.
    const pResend = await fetch(`${base}/api/internal/idempotency/reconcile`, {
      method: 'POST',
      headers: { ...authHeaders('org_alpha', CRED_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: foreignKey, confirmResend: true, evidence: 'verificación externa documentada de no llegada' }),
    })
    assert.equal(pResend.status, 403, 'confirmResend sobre clave ajena → 403')

    // Clave malformada (sin organización) → 403 (fail-closed).
    const pMalformed = await fetch(`${base}/api/internal/idempotency/reconcile`, {
      method: 'POST',
      headers: { ...authHeaders('org_alpha', CRED_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'clave-sin-organizacion' }),
    })
    assert.equal(pMalformed.status, 403, 'clave sin org válida → 403')
  })
})

// ---------------------------------------------------------------------------
// W-B2H-05: all:true limitado estrictamente a la organización autenticada
// ---------------------------------------------------------------------------
test('W-B2H-05: all:true procesa SOLO los eventos de la org autenticada; los ajenos quedan UNCERTAIN e intactos', async () => {
  await withServer(async (base) => {
    await seedUncertainEvent(base, 'org_alpha', 'evt_h_a1', '+573111000001')
    await seedUncertainEvent(base, 'org_alpha', 'evt_h_a2', '+573111000002')
    await seedUncertainEvent(base, 'org_beta', 'evt_h_b1', '+573222000001')

    const p = await fetch(`${base}/api/internal/idempotency/reconcile`, {
      method: 'POST',
      headers: { ...authHeaders('org_alpha', CRED_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
    assert.equal(p.status, 200)
    const body = await getJson(p)
    assert.equal(body.organizationId, 'org_alpha')
    assert.ok(Array.isArray(body.outcomes))
    assert.equal(body.outcomes.length, 2, 'sólo los 2 eventos de org_alpha')
    for (const o of body.outcomes) {
      assert.ok(String(o.key).startsWith('org_alpha::'), 'ninguna clave ajena fue procesada')
      // Sin confirmResend la reconciliación NO resuelve (no reenvía): exige decisión.
      assert.equal(o.ok, false, 'sin confirmResend no se completa (ningún reenvío automático)')
    }

    // Los eventos de org_beta NO fueron tocados: siguen UNCERTAIN para ella.
    const gB = await fetch(`${base}/api/internal/idempotency/uncertain`, {
      headers: authHeaders('org_beta', CRED_B),
    })
    const bodyB = await getJson(gB)
    assert.equal(bodyB.uncertain.length, 1, 'el evento de org_beta sigue pendiente')
    assert.equal(bodyB.uncertain[0].key, 'org_beta::evt_h_b1')
    assert.equal(bodyB.uncertain[0].evidence.sends[0].attempt_count, 1, 'sin intentos adicionales')
  })
})

// ---------------------------------------------------------------------------
// W-B2H-06: controles de confirmResend (sin masivos, con evidencia, UN reenvío)
// ---------------------------------------------------------------------------
test('W-B2H-06: confirmResend — lote prohibido (400), evidencia obligatoria (400), sin confirmación no reenvía nada y con evidencia hay EXACTAMENTE UN reenvío', async () => {
  await withServer(async (base, transport) => {
    await seedUncertainEvent(base, 'org_alpha', 'evt_h_a1', '+573111000001')
    const ownKey = 'org_alpha::evt_h_a1'
    const callsAfterSeed = transport.calls
    assert.equal(callsAfterSeed, 1, 'la semilla consumió el único despacho ambiguo')

    // (a) confirmResend en lote → 400 (reenvío masivo prohibido).
    const pBatch = await fetch(`${base}/api/internal/idempotency/reconcile`, {
      method: 'POST',
      headers: { ...authHeaders('org_alpha', CRED_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true, confirmResend: true }),
    })
    assert.equal(pBatch.status, 400, 'confirmResend + all → 400')
    assert.equal(transport.calls, callsAfterSeed, 'el lote prohibido no despachó nada')

    // (b) confirmResend sin evidencia → 400.
    const pNoEv = await fetch(`${base}/api/internal/idempotency/reconcile`, {
      method: 'POST',
      headers: { ...authHeaders('org_alpha', CRED_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: ownKey, confirmResend: true }),
    })
    assert.equal(pNoEv.status, 400, 'confirmResend sin evidencia → 400')
    assert.equal(transport.calls, callsAfterSeed, 'sin evidencia no hubo despacho')

    // (c) evidencia demasiado corta (sin sustancia) → 400.
    const pShortEv = await fetch(`${base}/api/internal/idempotency/reconcile`, {
      method: 'POST',
      headers: { ...authHeaders('org_alpha', CRED_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: ownKey, confirmResend: true, evidence: 'corta' }),
    })
    assert.equal(pShortEv.status, 400, 'evidencia trivial → 400')
    assert.equal(transport.calls, callsAfterSeed)

    // (d) Sin confirmResend: la reconciliación entrega evidencia y NO reenvía.
    const pSafe = await fetch(`${base}/api/internal/idempotency/reconcile`, {
      method: 'POST',
      headers: { ...authHeaders('org_alpha', CRED_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: ownKey }),
    })
    assert.equal(pSafe.status, 200)
    const safe = await getJson(pSafe)
    assert.equal(safe.result.resolved, false)
    assert.equal(safe.result.requiresManualResolution, true)
    assert.equal(safe.result.uncertainSends.length, 1)
    assert.equal(safe.result.uncertainSends[0].status, 'UNCERTAIN')
    assert.equal(transport.calls, callsAfterSeed, 'reconciliación sin confirmResend JAMÁS reenvía')

    // (e) Reentrega del mismo evento por el puente: deduplicada, sin reenvío.
    const redeliver = await redeliverEvent(base, 'org_alpha', 'evt_h_a1', '+573111000001')
    assert.equal(redeliver.status, 200)
    assert.equal(redeliver.body.actionTaken, 'uncertain_needs_reconciliation')
    assert.equal(transport.calls, callsAfterSeed, 'la reentrega no genera segundo sendMessage')

    // (f) Autorización explícita CON evidencia → exactamente UN reenvío auditado.
    transport.mode = 'OK'
    const pAuth = await fetch(`${base}/api/internal/idempotency/reconcile`, {
      method: 'POST',
      headers: { ...authHeaders('org_alpha', CRED_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: ownKey,
        confirmResend: true,
        evidence: 'Verificado en la bandeja del negocio: el mensaje no llegó (sin estado de entrega en el proveedor).',
      }),
    })
    assert.equal(pAuth.status, 200)
    const auth = await getJson(pAuth)
    assert.equal(auth.result.resolved, true, 'el reenvío autorizado completa el ciclo')
    assert.equal(auth.result.resendAuthorized, true)
    assert.equal(transport.calls, callsAfterSeed + 1, 'EXACTAMENTE un reenvío autorizado')
    assert.equal(transport.dispatched.length, 1)
    assert.equal(transport.dispatched[0].idempotencyKey, 'corr_evt_h_a1#rule_keyword_reply')
    assert.equal(auth.result.uncertainSends.length, 0, 'ya no quedan envíos inciertos del evento')

    // (g) La clave resuelta sale del listado UNCERTAIN de su organización.
    const gA = await fetch(`${base}/api/internal/idempotency/uncertain`, {
      headers: authHeaders('org_alpha', CRED_A),
    })
    const bodyA = await getJson(gA)
    assert.equal(bodyA.uncertain.length, 0, 'el evento reconciliado ya no está pendiente')
  })
})

// ---------------------------------------------------------------------------
// W-B2H-07: aislamiento extremo a extremo del reenvío autorizado
// ---------------------------------------------------------------------------
test('W-B2H-07: el reenvío autorizado de org_alpha jamás toca el estado ni el tráfico de org_beta', async () => {
  await withServer(async (base, transport) => {
    await seedUncertainEvent(base, 'org_alpha', 'evt_h_a1', '+573111000001')
    await seedUncertainEvent(base, 'org_beta', 'evt_h_b1', '+573222000001')

    transport.mode = 'OK'
    const p = await fetch(`${base}/api/internal/idempotency/reconcile`, {
      method: 'POST',
      headers: { ...authHeaders('org_alpha', CRED_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'org_alpha::evt_h_a1',
        confirmResend: true,
        evidence: 'Confirmación humana con verificación externa de no llegada (captura del proveedor).',
      }),
    })
    assert.equal(p.status, 200)
    const body = await getJson(p)
    assert.equal(body.result.resolved, true)

    // El único despacho post-autorización fue al teléfono de org_alpha.
    assert.equal(transport.dispatched.length, 1)
    assert.equal(transport.dispatched[0].to, '+573111000001', 'sólo org_alpha despachó su reenvío')

    // org_beta sigue EXACTAMENTE igual: UNCERTAIN, un intento, sin autorización.
    const gB = await fetch(`${base}/api/internal/idempotency/uncertain`, {
      headers: authHeaders('org_beta', CRED_B),
    })
    const bodyB = await getJson(gB)
    assert.equal(bodyB.uncertain.length, 1)
    const sendB = bodyB.uncertain[0].evidence.sends[0]
    assert.equal(sendB.status, 'UNCERTAIN', 'el estado de org_beta no fue contaminado')
    assert.equal(sendB.attempt_count, 1, 'org_beta no tuvo intentos adicionales')
    assert.equal(sendB.resend_authorized_at, null, 'org_beta no tuvo autorizaciones de reenvío')
  })
})
