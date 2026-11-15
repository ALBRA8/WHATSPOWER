import assert from 'node:assert'
import { join } from 'node:path'
import { unlinkSync, existsSync } from 'node:fs'
import { createDatabase } from '../src/db.ts'
import { ConversationRouter } from '../src/engine/router.ts'
import { MockTransportSender } from '../src/adapters/transport.ts'
import { MockCrmClient } from '../src/adapters/crm-client.ts'
import type { InboundEvent } from '../src/types.ts'

async function runPersistenceAndHandoffTests() {
  console.log('\n============================================================')
  console.log('  TEST DE PERSISTENCIA TRAS REINICIO Y PROTECCIÓN DE HANDOFF')
  console.log('  Verificando: SQLite en disco, Supresión y Silenciamiento Humano')
  console.log('============================================================\n')

  const testDbFile = join(process.cwd(), 'clones', 'albra-agentic-2a', 'db', 'test_persistence.db')
  if (existsSync(testDbFile)) {
    unlinkSync(testDbFile)
  }

  // -------------------------------------------------------------------------
  // FASE 1: Instancia A - Configurar estado, handoff y baja en disco
  // -------------------------------------------------------------------------
  console.log('[Fase 1] Arrancando Instancia A con base de datos en archivo...')
  const dbA = createDatabase(testDbFile)
  const transportA = new MockTransportSender()
  const crmA = new MockCrmClient()
  const routerA = new ConversationRouter(dbA, transportA, crmA)

  const phoneHandoff = '+573100000001'
  const phoneBaja = '+573100000002'
  const eventIdIdempotent = 'evt_persisted_999'

  // 1. Contacto 1 activa Handoff Humano
  const handoffEvent: InboundEvent = {
    eventId: 'evt_handoff_01',
    orgId: 'org_test',
    correlationId: 'corr_h1',
    timestamp: new Date().toISOString(),
    channel: 'whatsapp',
    contact: { phone: phoneHandoff, clientId: 'cl_100' },
    message: { id: 'm1', text: 'Quiero un asesor humano', type: 'text' },
  }
  const resHandoff = await routerA.processInbound(handoffEvent)
  assert.strictEqual(resHandoff.actionTaken, 'handoff_human')
  console.log('  ✅ Contacto 1 puesto en HANDOFF_HUMAN en Instancia A')

  // 2. Contacto 1 envía un segundo mensaje mientras está en HANDOFF_HUMAN: 2A debe ser silenciado
  transportA.clear()
  const msgWhileHandoff: InboundEvent = {
    eventId: 'evt_handoff_02',
    orgId: 'org_test',
    correlationId: 'corr_h2',
    timestamp: new Date().toISOString(),
    channel: 'whatsapp',
    contact: { phone: phoneHandoff, clientId: 'cl_100' },
    message: { id: 'm2', text: 'Sigo esperando respuesta', type: 'text' },
  }
  const resSilenced = await routerA.processInbound(msgWhileHandoff)
  assert.strictEqual(resSilenced.handled, false)
  assert.strictEqual(resSilenced.actionTaken, 'locked_busy')
  assert.strictEqual(transportA.dispatched.length, 0) // 2A NO responde
  console.log('  ✅ Verificado: 2A se mantiene silenciado mientras el contacto está en atención humana')

  // 3. Contacto 2 solicita baja
  const bajaEvent: InboundEvent = {
    eventId: 'evt_baja_01',
    orgId: 'org_test',
    correlationId: 'corr_b1',
    timestamp: new Date().toISOString(),
    channel: 'whatsapp',
    contact: { phone: phoneBaja, clientId: 'cl_200' },
    message: { id: 'm3', text: 'BAJA', type: 'text' },
  }
  await routerA.processInbound(bajaEvent)
  console.log('  ✅ Contacto 2 registrado en lista de supresión')

  // 4. Registro de idempotencia
  const normalEvent: InboundEvent = {
    eventId: eventIdIdempotent,
    orgId: 'org_test',
    correlationId: 'corr_idemp',
    timestamp: new Date().toISOString(),
    channel: 'whatsapp',
    contact: { phone: '+573100000003', clientId: 'cl_300' },
    message: { id: 'm4', text: 'PRECIO', type: 'text' },
  }
  await routerA.processInbound(normalEvent)
  console.log('  ✅ Evento idempotente registrado en SQLite')

  // -------------------------------------------------------------------------
  // FASE 2: Simulación de caída/reinicio - Instancia B sobre el mismo archivo
  // -------------------------------------------------------------------------
  console.log('\n[Fase 2] Simulando caída y reinicio completo del servicio 2A...')
  // Cerramos la conexión A
  dbA.close()

  // Abrimos una nueva instancia B apuntando al archivo persistido en disco
  const dbB = createDatabase(testDbFile)
  const transportB = new MockTransportSender()
  const crmB = new MockCrmClient()
  const routerB = new ConversationRouter(dbB, transportB, crmB)

  // 1. Verificación de persistencia de HANDOFF_HUMAN tras reinicio
  const lockPersisted = routerB.getLockManager().getLock(phoneHandoff)
  assert.ok(lockPersisted)
  assert.strictEqual(lockPersisted.currentState, 'HANDOFF_HUMAN')
  console.log('  ✅ [PASS] El lock HANDOFF_HUMAN sobrevivió al reinicio del servicio')

  // Mensaje posterior de Contacto 1 en Instancia B: sigue silenciado
  const resStillSilenced = await routerB.processInbound({
    ...msgWhileHandoff,
    eventId: 'evt_handoff_03',
  })
  assert.strictEqual(resStillSilenced.handled, false)
  assert.strictEqual(resStillSilenced.actionTaken, 'locked_busy')
  assert.strictEqual(transportB.dispatched.length, 0)
  console.log('  ✅ [PASS] Contacto en atención humana sigue protegido contra respuestas automáticas tras reinicio')

  // 2. Liberación formal de conversación por el asesor humano
  console.log('\n[Fase 3] Asesor resuelve la conversación en el CRM y libera el lock...')
  routerB.getLockManager().releaseLock(phoneHandoff)
  const lockReleased = routerB.getLockManager().getLock(phoneHandoff)
  assert.strictEqual(lockReleased, null)

  // Ahora que fue liberado, un nuevo mensaje vuelve a ser atendido normalmente
  const resReactivated = await routerB.processInbound({
    ...msgWhileHandoff,
    eventId: 'evt_handoff_04',
    message: { id: 'm4', text: 'PRECIO', type: 'text' },
  })
  assert.strictEqual(resReactivated.handled, true)
  assert.ok(resReactivated.actionTaken === 'keyword_rule' || resReactivated.actionTaken === 'visual_flow_execution')
  console.log('  ✅ [PASS] Conversación reactivada con éxito tras liberación formal del asesor')

  // 3. Verificación de persistencia de Supresión tras reinicio
  assert.ok(routerB.getSuppressionStore().isSuppressed(phoneBaja))
  const resBajaIgnored = await routerB.processInbound({
    eventId: 'evt_baja_02',
    orgId: 'org_test',
    correlationId: 'corr_b2',
    timestamp: new Date().toISOString(),
    channel: 'whatsapp',
    contact: { phone: phoneBaja, clientId: 'cl_200' },
    message: { id: 'm5', text: 'Hola de nuevo', type: 'text' },
  })
  assert.strictEqual(resBajaIgnored.actionTaken, 'ignored')
  assert.strictEqual(transportB.dispatched.length, 1) // Solo el mensaje del test anterior, cero para este
  console.log('  ✅ [PASS] La lista de supresión y bajas persistió en disco tras reinicio')

  // 4. Verificación de persistencia de Idempotencia tras reinicio
  const resIdempotentPersisted = await routerB.processInbound(normalEvent)
  assert.strictEqual(resIdempotentPersisted.actionTaken, 'deduplicated')
  console.log('  ✅ [PASS] La tabla de idempotencia persistió en disco tras reinicio')

  // Limpieza de archivo temporal
  dbB.close()
  if (existsSync(testDbFile)) {
    unlinkSync(testDbFile)
  }

  console.log('\n============================================================')
  console.log('  TODAS LAS PRUEBAS DE PERSISTENCIA Y HANDOFF SUPERADAS (5/5)')
  console.log('============================================================\n')
}

runPersistenceAndHandoffTests().catch((err) => {
  console.error('Fallo en test de persistencia:', err)
  process.exit(1)
})
