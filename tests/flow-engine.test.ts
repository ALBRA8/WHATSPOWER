import { test } from 'node:test'
import assert from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { FlowEngine } from '../src/engine/flow-engine.ts'
import { createDatabase } from '../src/db.ts'
import type { FlowDefinition } from '../src/engine/flow-types.ts'

test('SUITE: WhatsPower Flow Engine (Estilo ManyChat)', async (t) => {
  const db = createDatabase(':memory:')
  const engine = new FlowEngine(db)

  await t.test('FL-01: Registro y consulta de flujo visual', () => {
    const flows = engine.listFlows()
    assert.ok(flows.length >= 1, 'Debe haber al menos 1 flujo sembrado')
    const defaultFlow = flows[0]
    assert.strictEqual(defaultFlow.isActive, true)
    assert.ok(defaultFlow.triggerKeywords.includes('precio'))
    assert.ok(defaultFlow.nodes.length >= 5)
  })

  await t.test('FL-02: Trigger activa flujo y envía mensaje inicial con menú', async () => {
    const phone = '+573100000001'
    const res = await engine.evaluateStep(phone, 'Hola, quiero PRECIO y planes', { name: 'Camila' })

    assert.strictEqual(res.handled, true)
    assert.strictEqual(res.flowId, 'flow_ventas_manychat_01')
    assert.strictEqual(res.messagesToSend.length, 1)
    const text0 = res.messagesToSend[0].text
    assert.ok(text0.includes('¡Hola Camila!'))
    assert.ok(text0.includes('1️⃣ 1 a 3 asesores'))
    assert.ok(text0.includes('2️⃣ Más de 4 asesores'))

    // Verificar que la sesión quedó guardada esperando input
    const session = engine.getSession(phone)
    assert.ok(session)
    assert.strictEqual(session.waitingForInput, true)
    assert.strictEqual(session.context.nombre, 'Camila')
  })

  await t.test('FL-03: Respuesta opción 1 navega a Plan Emprendedor', async () => {
    const phone = '+573100000001'
    const res = await engine.evaluateStep(phone, '1')

    assert.strictEqual(res.handled, true)
    assert.strictEqual(res.messagesToSend.length, 1)
    assert.ok(res.messagesToSend[0].text.includes('Plan Emprendedor'))
    assert.ok(res.messagesToSend[0].text.includes('$29/mes'))
  })

  await t.test('FL-04: Respuesta opción 2 dispara acción CRM create_opportunity en ALBRA', async () => {
    const phone = '+573100000002'
    // Paso 1: Iniciar flujo
    await engine.evaluateStep(phone, 'info de la plataforma', { name: 'Roberto' })

    // Paso 2: Seleccionar opción 2 (Corporativo)
    const res = await engine.evaluateStep(phone, '2')

    assert.strictEqual(res.handled, true)
    // Debe haber ejecutado acción CRM
    assert.strictEqual(res.actionsToExecute.length, 1)
    assert.strictEqual(res.actionsToExecute[0].action, 'create_opportunity')
    assert.strictEqual(res.actionsToExecute[0].params.amount, 150)

    // Debe haber enviado el mensaje corporativo
    assert.strictEqual(res.messagesToSend.length, 1)
    assert.ok(res.messagesToSend[0].text.includes('Plan Corporativo'))
  })

  await t.test('FL-05: Respuesta opción 3 activa Human Handoff', async () => {
    const phone = '+573100000003'
    // Paso 1: Iniciar flujo
    await engine.evaluateStep(phone, 'planes', { name: 'Valeria' })

    // Paso 2: Seleccionar opción 3 (Asesor)
    const res = await engine.evaluateStep(phone, '3')

    assert.strictEqual(res.handled, true)
    assert.strictEqual(res.isHandoff, true)
    assert.ok(res.handoffReason?.includes('asesor humano'))
    assert.ok(res.messagesToSend[0].text.includes('comunicando con un asesor'))

    // La sesión debe quedar cerrada para ceder el turno al asesor
    const session = engine.getSession(phone)
    assert.strictEqual(session, null)
  })

  await t.test('FL-06: Creación de flujo personalizado y ejecución', async () => {
    const customFlow: FlowDefinition = {
      id: 'flow_soporte_rapido',
      name: 'Flujo de Soporte y Garantía',
      triggerKeywords: ['ayuda', 'garantia', 'problema'],
      isActive: true,
      nodes: [
        { id: 't1', type: 'trigger', title: 'Trigger Ayuda', data: { keywords: ['ayuda'] } },
        { id: 'm1', type: 'send_message', title: 'Mensaje Soporte', data: { messageText: '🛠️ Centro de soporte. Por favor describe tu número de factura.' } },
      ],
      edges: [{ id: 'e1', source: 't1', target: 'm1' }],
    }

    engine.saveFlow(customFlow)
    const retrieved = engine.getFlow('flow_soporte_rapido')
    assert.ok(retrieved)
    assert.strictEqual(retrieved.name, 'Flujo de Soporte y Garantía')

    const res = await engine.evaluateStep('+573109998888', 'tengo un problema y necesito ayuda')
    assert.strictEqual(res.handled, true)
    assert.strictEqual(res.flowId, 'flow_soporte_rapido')
    assert.ok(res.messagesToSend[0].text.includes('Centro de soporte'))
  })
})
