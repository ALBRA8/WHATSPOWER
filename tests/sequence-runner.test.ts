/**
 * (ronda 21) EJECUTOR DE SECUENCIAS — tests/sequence-runner.test.ts
 *
 * QUÉ SE PRUEBA Y POR QUÉ
 * Hasta esta ronda, inscribir a alguien en una secuencia dejaba una fila ACTIVE
 * que nadie miraba: `next_run_at` se escribía y ningún código lo leía, así que
 * el contacto nunca recibía el paso 2. `runDueSequenceSteps` es la pieza que
 * envía lo que ya toca. Aquí se fija su comportamiento, incluido lo que NO debe
 * hacer (enviar a quien pidió la baja, avanzar con un resultado incierto).
 *
 * Contratos:
 *  SR-01  El paso vencido se envía una vez y el puntero avanza con el retardo
 *         del paso SIGUIENTE.
 *  SR-02  Lo que aún no toca no se envía.
 *  SR-03  Una secuencia desactivada no manda nada.
 *  SR-04  Un rechazo fiable no avanza y se reintenta (el mensaje no se pierde).
 *  SR-05  Un resultado incierto no avanza y se cuenta aparte.
 *  SR-06  Quien está en la lista de bajas no recibe nada y queda CANCELLED.
 *  SR-07  Al enviar el último paso la inscripción queda COMPLETED.
 *  SR-08  Cada mensaje enviado queda en la bandeja de SU organización.
 *
 * Base de datos ':memory:': sin ficheros, sin red.
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { createDatabase } from '../src/db.ts'
import { FlowEngine } from '../src/engine/flow-engine.ts'
import { runDueSequenceSteps } from '../src/engine/sequence-runner.ts'
import { SuppressionStore } from '../src/suppression/suppression-store.ts'
import { MockTransportSender } from '../src/adapters/transport.ts'
import type { TransportSender } from '../src/types.ts'

const ORG = 'org_runner'
const ORG_B = 'org_runner_b'
const SEQ = 'seq_runner_bienvenida'
const SEQ_B = 'seq_runner_otra'
const TEL = '573001234567'

type Db = ReturnType<typeof createDatabase>

function setup(seqActive = true) {
  const db = createDatabase(':memory:')
  const engine = new FlowEngine(db)
  engine.saveSequence(ORG, {
    id: SEQ,
    name: 'Bienvenida',
    isActive: seqActive,
    steps: [
      { id: 'p1', stepOrder: 1, delayMinutes: 0, messageText: 'Hola, soy Albra.' },
      { id: 'p2', stepOrder: 2, delayMinutes: 5, messageText: '¿Seguimos?' },
      { id: 'p3', stepOrder: 3, delayMinutes: 0, messageText: 'Último paso.' },
    ],
  })
  const transport = new MockTransportSender()
  const suppression = new SuppressionStore(db)
  return { db, engine, transport, suppression }
}

/** Hora de la inscripción, tal como la dejó el motor (para no depender del reloj). */
function horaDeInscripcion(db: Db, org: string, seq: string): number {
  const row = db.prepare('SELECT next_run_at FROM sequence_enrollments WHERE organization_id = ? AND sequence_id = ?')
    .get(org, seq) as { next_run_at: number }
  return row.next_run_at
}

function inscripcion(db: Db, org: string, seq: string): { current_step: number; status: string; next_run_at: number } {
  return db.prepare('SELECT current_step, status, next_run_at FROM sequence_enrollments WHERE organization_id = ? AND sequence_id = ?')
    .get(org, seq) as { current_step: number; status: string; next_run_at: number }
}

function bandeja(db: Db, org: string): Array<{ text: string; direction: string }> {
  return db.prepare('SELECT text, direction FROM inbox_messages WHERE organization_id = ? ORDER BY created_at ASC')
    .all(org) as Array<{ text: string; direction: string }>
}

test('SR-01: el paso que ya toca se envía una vez y avanza con el retardo del siguiente', async () => {
  const { db, engine, transport, suppression } = setup()
  engine.enrollContactInSequence(ORG, TEL, SEQ)
  const ahora = horaDeInscripcion(db, ORG, SEQ)

  const r = await runDueSequenceSteps({ engine, transport, suppression, now: ahora })
  assert.strictEqual(r.inspected, 1, 'una inscripción vencida')
  assert.strictEqual(r.sent, 1, 'un mensaje enviado')
  assert.strictEqual(transport.dispatched.length, 1, 'el transporte recibió exactamente un mensaje')
  assert.strictEqual(transport.dispatched[0].to, TEL)
  assert.strictEqual(transport.dispatched[0].text, 'Hola, soy Albra.', 'debe enviarse el texto del paso 1')
  assert.strictEqual(transport.dispatched[0].idempotencyKey, `seq:${r.results[0].enrollmentId}:1`, 'clave de idempotencia por paso')

  const fila = inscripcion(db, ORG, SEQ)
  assert.strictEqual(fila.current_step, 2, 'el puntero queda en el paso 2')
  assert.strictEqual(fila.status, 'ACTIVE', 'la secuencia sigue viva')
  assert.strictEqual(fila.next_run_at, ahora + 5 * 60000, 'la siguiente hora lleva el retardo del paso 2 (5 min)')
})

test('SR-02: lo que aún no toca no se envía', async () => {
  const { db, engine, transport, suppression } = setup()
  engine.enrollContactInSequence(ORG, TEL, SEQ)
  const ahora = horaDeInscripcion(db, ORG, SEQ)

  await runDueSequenceSteps({ engine, transport, suppression, now: ahora })
  const segunda = await runDueSequenceSteps({ engine, transport, suppression, now: ahora + 1000 })
  assert.strictEqual(segunda.inspected, 0, 'un segundo después todavía no toca el paso 2')
  assert.strictEqual(transport.dispatched.length, 1, 'no se envió nada más')
})

test('SR-03: una secuencia desactivada no manda nada', async () => {
  const { db, engine, transport, suppression } = setup(false)
  engine.enrollContactInSequence(ORG, TEL, SEQ)
  const r = await runDueSequenceSteps({ engine, transport, suppression, now: horaDeInscripcion(db, ORG, SEQ) })
  assert.strictEqual(r.inspected, 0)
  assert.strictEqual(transport.dispatched.length, 0, 'apagar la secuencia detiene los envíos')
})

test('SR-04: un rechazo fiable no avanza y se puede reintentar', async () => {
  const { db, engine, transport, suppression } = setup()
  engine.enrollContactInSequence(ORG, TEL, SEQ)
  const ahora = horaDeInscripcion(db, ORG, SEQ)

  let llamadas = 0
  const rejecter = {
    async sendMessage() {
      llamadas++
      return { ok: false, error: '400 el daemon rechazó la petición', outcome: 'REJECTED' as const }
    },
  } as unknown as TransportSender

  const primera = await runDueSequenceSteps({ engine, transport: rejecter, suppression, now: ahora })
  assert.strictEqual(llamadas, 1)
  assert.strictEqual(primera.failed, 1, 'se cuenta como rechazo fiable')
  assert.strictEqual(primera.sent, 0)
  const fila = inscripcion(db, ORG, SEQ)
  assert.strictEqual(fila.current_step, 1, 'el puntero NO avanza: el paso sigue pendiente')

  const segunda = await runDueSequenceSteps({ engine, transport, suppression, now: ahora + 1000 })
  assert.strictEqual(segunda.sent, 1, 'el reintento sí envía')
  assert.strictEqual(transport.dispatched[0].text, 'Hola, soy Albra.')
  assert.strictEqual(inscripcion(db, ORG, SEQ).current_step, 2)
})

test('SR-05: un resultado incierto no avanza y se cuenta aparte', async () => {
  const { db, engine, transport, suppression } = setup()
  engine.enrollContactInSequence(ORG, TEL, SEQ)
  const ahora = horaDeInscripcion(db, ORG, SEQ)

  transport.setSimulateFailure(true)
  const r = await runDueSequenceSteps({ engine, transport, suppression, now: ahora })
  assert.strictEqual(r.uncertain, 1, 'un 503 del daemon es incierto, no un envío')
  assert.strictEqual(r.sent, 0)
  assert.strictEqual(r.completed, 0)
  const fila = inscripcion(db, ORG, SEQ)
  assert.strictEqual(fila.current_step, 1, 'no se avanza: el mensaje pudo salir o no')
  assert.strictEqual(bandeja(db, ORG).length, 0, 'no se registra en la bandeja lo que no consta enviado')
})

test('SR-06: quien pidió la baja no recibe nada y su inscripción se cierra', async () => {
  const { db, engine, transport, suppression } = setup()
  engine.enrollContactInSequence(ORG, TEL, SEQ)
  suppression.addSuppression(ORG, TEL, 'pidió la baja por WhatsApp')
  const r = await runDueSequenceSteps({ engine, transport, suppression, now: horaDeInscripcion(db, ORG, SEQ) })
  assert.strictEqual(r.skippedSuppressed, 1)
  assert.strictEqual(transport.dispatched.length, 0, 'a quien pidió la baja no se le escribe')
  assert.strictEqual(inscripcion(db, ORG, SEQ).status, 'CANCELLED', 'y se le saca de la secuencia')
})

test('SR-07: al enviar el último paso la inscripción queda COMPLETED', async () => {
  const { db, engine, transport, suppression } = setup()
  engine.enrollContactInSequence(ORG, TEL, SEQ)
  let ahora = horaDeInscripcion(db, ORG, SEQ)

  for (let i = 0; i < 3; i++) {
    await runDueSequenceSteps({ engine, transport, suppression, now: ahora })
    ahora = inscripcion(db, ORG, SEQ).next_run_at || ahora + 1
  }

  assert.strictEqual(transport.dispatched.length, 3, 'los tres pasos salieron')
  assert.deepStrictEqual(transport.dispatched.map((d) => d.text), ['Hola, soy Albra.', '¿Seguimos?', 'Último paso.'])
  const fila = inscripcion(db, ORG, SEQ)
  assert.strictEqual(fila.status, 'COMPLETED', 'terminada, no colgada para siempre')
  const despues = await runDueSequenceSteps({ engine, transport, suppression, now: ahora + 24 * 3600000 })
  assert.strictEqual(despues.inspected, 0, 'una inscripción terminada no vuelve a salir')
})

test('SR-08: cada mensaje enviado queda en la bandeja de SU organización', async () => {
  const { db, engine, transport, suppression } = setup()
  engine.saveSequence(ORG_B, {
    id: SEQ_B,
    name: 'Otra empresa',
    isActive: true,
    steps: [{ id: 'b1', stepOrder: 1, delayMinutes: 0, messageText: 'Mensaje de la empresa B.' }],
  })
  engine.enrollContactInSequence(ORG, TEL, SEQ)
  engine.enrollContactInSequence(ORG_B, TEL, SEQ_B)
  const r = await runDueSequenceSteps({ engine, transport, suppression, now: Math.max(horaDeInscripcion(db, ORG, SEQ), horaDeInscripcion(db, ORG_B, SEQ_B)) })
  assert.strictEqual(r.sent, 2, 'sale un mensaje por organización')

  const bandejaA = bandeja(db, ORG)
  const bandejaB = bandeja(db, ORG_B)
  assert.strictEqual(bandejaA.length, 1)
  assert.strictEqual(bandejaB.length, 1)
  assert.strictEqual(bandejaA[0].text, 'Hola, soy Albra.', 'la bandeja de A sólo tiene lo de A')
  assert.strictEqual(bandejaB[0].text, 'Mensaje de la empresa B.', 'y la de B sólo lo de B')
  assert.strictEqual(bandejaA[0].direction, 'outbound')
})
