/**
 * (ronda 22) ESPERAS DE FLUJO — tests/flow-wait-runner.test.ts
 *
 * QUÉ SE PRUEBA Y POR QUÉ
 * Hasta la ronda 21 un nodo «Espera» (delay / smart_delay) no esperaba nada: el
 * motor lo avisaba por consola y seguía de inmediato, así que el flujo no tenía
 * pausa real. Ahora el motor aparca el flujo en la tabla flow_waits y este
 * ejecutor lo despierta cuando llega la hora. Aquí se fija el contrato completo,
 * incluido lo que NO debe hacer (despertar a quien pidió la baja, girar para
 * siempre cuando el flujo ya no existe, duplicar el aviso).
 *
 * Contratos:
 *  FW-01  Al llegar a un nodo «Espera» el flujo se aparca: nada se envía, la
 *         sesión se cierra y queda la hora de vuelta.
 *  FW-02  Cuando vence la hora se reanuda y se envía el paso siguiente, con su
 *         clave de idempotencia y su rastro en la bandeja.
 *  FW-03  Antes de la hora no se despierta nada.
 *  FW-04  Dos pasadas seguidas no duplican el aviso.
 *  FW-05  Quien está en la lista de bajas no se despierta y la espera se cierra.
 *  FW-06  Si el flujo se apagó o se borró, la espera se ABANDONA y no gira.
 *  FW-07  Si el nodo por el que había que seguir ya no está, igual: ABANDONA.
 *  FW-08  Cada organización despierta su flujo en su propia bandeja (aislamiento).
 *  FW-09  Si el contacto está metido en otro flujo, la espera se CANCELA en vez
 *         de pisarle la conversación.
 *
 * Base de datos ':memory:': sin ficheros y sin red.
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { createDatabase } from '../src/db.ts'
import { FlowEngine } from '../src/engine/flow-engine.ts'
import type { FlowDefinition } from '../src/engine/flow-types.ts'
import { runDueFlowWaits } from '../src/engine/flow-wait-runner.ts'
import { SuppressionStore } from '../src/suppression/suppression-store.ts'
import { MockTransportSender } from '../src/adapters/transport.ts'

const ORG = 'org_espera'
const ORG_B = 'org_espera_b'
const FLOW = 'flow_espera_5min'
const TEL = '573001112233'
const TEL_B = '573004445566'
const KW = 'lista_de_espera_x'

type Db = ReturnType<typeof createDatabase>

/** Un flujo mínimo con la forma real: disparador → espera de 5 min → mensaje. */
function flujo(cambios: Partial<FlowDefinition> = {}): FlowDefinition {
  const base: FlowDefinition = {
    id: FLOW,
    name: 'Espera 5 min',
    triggerKeywords: [KW],
    isActive: true,
    nodes: [
      { id: 'n1', type: 'trigger', title: 'Disparador', data: { keywords: [KW], matchType: 'contains' } },
      { id: 'n2', type: 'delay', title: 'Espera 5 min', data: { delayMinutes: 5 } },
      { id: 'n3', type: 'send_message', title: 'Aviso', data: { messageText: 'Seguimos donde lo dejamos.' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  }
  return { ...base, ...cambios }
}

function setup() {
  const db = createDatabase(':memory:')
  const engine = new FlowEngine(db)
  engine.saveFlow(ORG, flujo())
  const transport = new MockTransportSender()
  const suppression = new SuppressionStore(db)
  return { db, engine, transport, suppression }
}

function espera(db: Db): { id: string; status: string; next_node_id: string; due_at: number; attempts: number } {
  return db
    .prepare('SELECT id, status, next_node_id, due_at, attempts FROM flow_waits ORDER BY created_at ASC LIMIT 1')
    .get() as { id: string; status: string; next_node_id: string; due_at: number; attempts: number }
}

function bandeja(db: Db, org: string): Array<{ text: string; direction: string }> {
  return db
    .prepare("SELECT text, direction FROM inbox_messages WHERE organization_id = ? AND direction = 'outbound' ORDER BY created_at ASC")
    .all(org) as Array<{ text: string; direction: string }>
}

test('FW-01: el nodo «Espera» aparca el flujo y no manda nada todavía', async () => {
  const { db, engine } = setup()
  const antes = Date.now()
  const r = await engine.evaluateStep(ORG, TEL, KW, { name: 'Camila' })

  assert.strictEqual(r.flowId, FLOW, 'el flujo que dispara es el de la prueba')
  assert.strictEqual(r.messagesToSend.length, 0, 'no se manda nada antes de tiempo')
  assert.strictEqual(r.flowCompleted, false, 'el flujo no ha terminado: está esperando')
  assert.strictEqual(r.waitNodeId, 'n2', 'se aparcó en el nodo de espera')
  assert.ok(
    typeof r.parkedUntil === 'number' && r.parkedUntil >= antes + 5 * 60000 - 2000,
    'la hora de vuelta es a 5 minutos vista',
  )

  const fila = espera(db)
  assert.strictEqual(fila.status, 'PENDING', 'la espera queda pendiente')
  assert.strictEqual(fila.next_node_id, 'n3', 'al despertar hay que seguir por el nodo siguiente')
  assert.strictEqual(fila.due_at, r.parkedUntil, 'la hora guardada es la que se devolvió')
  assert.strictEqual(engine.getSession(ORG, TEL), null, 'la sesión se cierra: un mensaje no se salta la espera')
})

test('FW-02: al vencer la hora el flujo se reanuda y envía el paso siguiente', async () => {
  const { db, engine, transport, suppression } = setup()
  const arranque = await engine.evaluateStep(ORG, TEL, KW, {})
  const vence = arranque.parkedUntil as number
  const idEspera = espera(db).id

  const resumen = await runDueFlowWaits({ engine, transport, suppression, now: vence })

  assert.strictEqual(resumen.inspected, 1, 'una espera vencida')
  assert.strictEqual(resumen.resumed, 1, 'un flujo reanudado')
  assert.strictEqual(resumen.sent, 1, 'un mensaje entregado')
  assert.strictEqual(transport.dispatched.length, 1)
  assert.strictEqual(transport.dispatched[0].to, TEL)
  assert.strictEqual(transport.dispatched[0].text, 'Seguimos donde lo dejamos.')
  assert.strictEqual(transport.dispatched[0].idempotencyKey, `wait:${idEspera}:0`, 'clave de idempotencia por espera')
  assert.strictEqual(espera(db).status, 'DONE', 'la espera queda cerrada')
  // El motor, al terminar un flujo con un mensaje, deja la conversación esperando
  // respuesta (waitingForInput): eso ya era así antes y no lo cambia la espera.
  assert.strictEqual(engine.getSession(ORG, TEL)?.currentNodeId, 'n3', 'la espera quedó atrás')
  assert.deepStrictEqual(bandeja(db, ORG).map((m) => m.text), ['Seguimos donde lo dejamos.'], 'queda el rastro en la bandeja')
})

test('FW-03: antes de la hora no se despierta nada', async () => {
  const { engine, transport, suppression } = setup()
  const arranque = await engine.evaluateStep(ORG, TEL, KW, {})
  const vence = arranque.parkedUntil as number

  const resumen = await runDueFlowWaits({ engine, transport, suppression, now: vence - 60000 })
  assert.strictEqual(resumen.inspected, 0, 'todavía no toca')
  assert.strictEqual(transport.dispatched.length, 0, 'no salió nada')
})

test('FW-04: dos pasadas seguidas no duplican el aviso', async () => {
  const { engine, transport, suppression } = setup()
  const arranque = await engine.evaluateStep(ORG, TEL, KW, {})
  const vence = arranque.parkedUntil as number

  await runDueFlowWaits({ engine, transport, suppression, now: vence })
  const segunda = await runDueFlowWaits({ engine, transport, suppression, now: vence + 1000 })

  assert.strictEqual(segunda.inspected, 0, 'la espera ya no está pendiente')
  assert.strictEqual(transport.dispatched.length, 1, 'un solo mensaje')
})

test('FW-05: quien pidió la baja no se despierta y la espera se cierra', async () => {
  const { db, engine, transport, suppression } = setup()
  const arranque = await engine.evaluateStep(ORG, TEL, KW, {})
  suppression.addSuppression(ORG, TEL, 'STOP')

  const resumen = await runDueFlowWaits({ engine, transport, suppression, now: arranque.parkedUntil as number })
  assert.strictEqual(resumen.skippedSuppressed, 1, 'se cuenta como baja')
  assert.strictEqual(transport.dispatched.length, 0, 'no se le manda nada')
  assert.strictEqual(espera(db).status, 'CANCELLED', 'la espera no se queda girando')
})

test('FW-06: si el flujo se apaga, la espera se abandona en vez de girar', async () => {
  const { db, engine, transport, suppression } = setup()
  const arranque = await engine.evaluateStep(ORG, TEL, KW, {})
  engine.saveFlow(ORG, flujo({ isActive: false }))

  const resumen = await runDueFlowWaits({ engine, transport, suppression, now: arranque.parkedUntil as number })
  assert.strictEqual(resumen.abandoned, 1, 'la espera se abandona')
  assert.strictEqual(transport.dispatched.length, 0, 'no se manda nada')
  assert.strictEqual(espera(db).status, 'ABANDONED', 'queda cerrada, no pendiente para siempre')
})

test('FW-07: si el nodo siguiente desapareció, también se abandona', async () => {
  const { db, engine, transport, suppression } = setup()
  const arranque = await engine.evaluateStep(ORG, TEL, KW, {})
  // Se guarda el flujo sin el nodo de aviso: al despertar no hay a dónde ir.
  engine.saveFlow(
    ORG,
    flujo({
      nodes: [
        { id: 'n1', type: 'trigger', title: 'Disparador', data: { keywords: [KW], matchType: 'contains' } },
        { id: 'n2', type: 'delay', title: 'Espera 5 min', data: { delayMinutes: 5 } },
      ],
    }),
  )

  const resumen = await runDueFlowWaits({ engine, transport, suppression, now: arranque.parkedUntil as number })
  assert.strictEqual(resumen.abandoned, 1)
  assert.strictEqual(transport.dispatched.length, 0)
  assert.strictEqual(espera(db).status, 'ABANDONED')
})

test('FW-08: cada organización despierta su flujo en su propia bandeja', async () => {
  const { db, engine, transport, suppression } = setup()
  engine.saveFlow(ORG_B, flujo())
  const a = await engine.evaluateStep(ORG, TEL, KW, {})
  const b = await engine.evaluateStep(ORG_B, TEL_B, KW, {})

  const resumen = await runDueFlowWaits({ engine, transport, suppression, now: Math.max(a.parkedUntil as number, b.parkedUntil as number) })
  assert.strictEqual(resumen.inspected, 2, 'las dos esperas')
  assert.strictEqual(resumen.sent, 2, 'y las dos se enviaron')
  assert.strictEqual(bandeja(db, ORG).length, 1, 'la bandeja de A tiene su mensaje')
  assert.strictEqual(bandeja(db, ORG_B).length, 1, 'la bandeja de B tiene el suyo')
})

test('FW-10: el panel puede ver cuántos esperan y cuándo toca el siguiente', async () => {
  const { engine } = setup()
  assert.deepStrictEqual(engine.flowWaitStats(ORG), { pending: 0, nextAt: null }, 'sin esperas, cero')
  assert.deepStrictEqual(engine.pendingFlowWaits(ORG), [], 'y la lista vacía')

  const a = await engine.evaluateStep(ORG, TEL, KW, {})
  const stats = engine.flowWaitStats(ORG)
  assert.strictEqual(stats.pending, 1, 'una espera pendiente')
  assert.strictEqual(stats.nextAt, a.parkedUntil, 'y la hora de la próxima es la de vuelta de ese flujo')

  const lista = engine.pendingFlowWaits(ORG)
  assert.strictEqual(lista.length, 1)
  assert.strictEqual(lista[0].waitNodeId, 'n2', 'dice en qué nodo espera')
  assert.strictEqual(lista[0].contactPhone, TEL, 'y a quién espera')
  assert.deepStrictEqual(engine.pendingFlowWaits(ORG_B), [], 'otra organización no ve esta espera')
})

test('FW-09: si el contacto está en otro flujo, la espera se cancela', async () => {
  const { db, engine, transport, suppression } = setup()
  const arranque = await engine.evaluateStep(ORG, TEL, KW, {})
  // Alguien abrió una conversación con este contacto mientras esperaba.
  engine.saveSession(ORG, {
    contactPhone: TEL,
    flowId: 'otro_flujo',
    currentNodeId: 'x1',
    waitingForInput: true,
    context: {},
    lastActivity: Date.now(),
  })

  const resumen = await runDueFlowWaits({ engine, transport, suppression, now: arranque.parkedUntil as number })
  assert.strictEqual(resumen.cancelledBusy, 1, 'se cancela por conversación abierta')
  assert.strictEqual(transport.dispatched.length, 0, 'no se pisa la conversación')
  assert.strictEqual(espera(db).status, 'CANCELLED')
})
