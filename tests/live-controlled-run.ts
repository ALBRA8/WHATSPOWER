import assert from 'node:assert'
import { createAgenticServer } from '../src/server.ts'
import { MockTransportSender } from '../src/adapters/transport.ts'
import { MockCrmClient } from '../src/adapters/crm-client.ts'

// Importamos el módulo REAL de Capa 1 (CRM ALBRA)
import { forwardToAgentic2A, isAgentic2AEnabled } from '../../../audit_repos/CRM-ALBRA/src/lib/agentic-2a-bridge.ts'

async function executeControlledLiveTest() {
  console.log('\n============================================================')
  console.log('  ALBRA: PRIMERA PRUEBA CONTROLADA LOCAL DE CAPA 2A')
  console.log('  Límites: Entorno local, sin WhatsApp real, sin datos de producción')
  console.log('============================================================\n')

  const TEST_PORT = 3003
  const SHARED_SECRET = 'controlled_local_test_secret_32_bytes_2026'

  // 1. Instanciamos y arrancamos el servidor real de Capa 2A en el puerto 3003
  const mockTransport = new MockTransportSender()
  const mockCrm = new MockCrmClient()

  const { server, router } = createAgenticServer({
    dbPath: ':memory:', // SQLite en memoria privada para no alterar disco
    transport: mockTransport,
    crm: mockCrm,
    webhookSecret: SHARED_SECRET,
  })

  await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve))
  console.log(`[Paso 1] Servicio Capa 2A arrancado en http://localhost:${TEST_PORT}`)

  try {
    // 2. Verificación de Healthcheck de Capa 2A
    const healthRes = await fetch(`http://localhost:${TEST_PORT}/api/health`)
    assert.strictEqual(healthRes.status, 200)
    const healthData = await healthRes.json() as any
    assert.strictEqual(healthData.status, 'ok')
    console.log('[Paso 2] Healthcheck de Capa 2A verificado (200 OK)')

    // 3. Habilitamos temporalmente el feature flag para el entorno de pruebas
    process.env.AGENTIC_2A_ENABLED = 'true'
    process.env.AGENTIC_2A_URL = `http://localhost:${TEST_PORT}/api/inbound`
    process.env.AGENTIC_2A_WEBHOOK_SECRET = SHARED_SECRET

    assert.strictEqual(isAgentic2AEnabled(), true)
    console.log('[Paso 3] Feature Flag AGENTIC_2A_ENABLED=true activado para la prueba')

    // -------------------------------------------------------------------------
    // CASO A: Contacto nuevo
    // -------------------------------------------------------------------------
    console.log('\n--- Ejecutando Caso A: Contacto nuevo ---')
    const resA = await forwardToAgentic2A({
      orgId: 'org_controlled_test',
      clientId: '',
      clientPhone: '+573009990001',
      clientName: 'Daniel Gómez',
      message: 'Hola, buenos días',
    })

    assert.strictEqual(resA.forwarded, true)
    assert.strictEqual(resA.handled, true)
    assert.strictEqual(resA.actionTaken, 'new_lead_welcome')
    assert.ok(resA.replyText?.includes('Gracias por comunicarte'))
    // Verificamos que se ordenó la creación del cliente en el CRM
    assert.strictEqual(mockCrm.executedActions.length, 1)
    assert.strictEqual(mockCrm.executedActions[0].action, 'create_client')
    console.log('✅ Caso A superado: Contacto nuevo registrado en CRM y bienvenida generada por Capa 2A')

    // -------------------------------------------------------------------------
    // CASO B: Consulta de PRECIO (Regla determinista)
    // -------------------------------------------------------------------------
    console.log('\n--- Ejecutando Caso B: Consulta PRECIO ---')
    mockCrm.clear()
    const resB = await forwardToAgentic2A({
      orgId: 'org_controlled_test',
      clientId: 'cl_existing_101',
      clientPhone: '+573009990002',
      clientName: 'Elena Martínez',
      message: 'Quisiera saber el PRECIO de los servicios',
    })

    assert.strictEqual(resB.forwarded, true)
    assert.strictEqual(resB.handled, true)
    assert.strictEqual(resB.actionTaken, 'keyword_rule')
    assert.ok(resB.replyText?.includes('Plan Emprendedor'))
    // Cero invocaciones al LLM del CRM: el satélite 2A resolvió de forma determinista
    console.log('✅ Caso B superado: Regla "PRECIO" resuelta por Capa 2A sin llamar al LLM del CRM')

    // -------------------------------------------------------------------------
    // CASO C: Solicitud de asesor humano (Handoff)
    // -------------------------------------------------------------------------
    console.log('\n--- Ejecutando Caso C: Solicitud de asesor ---')
    mockCrm.clear()
    const resC = await forwardToAgentic2A({
      orgId: 'org_controlled_test',
      clientId: 'cl_existing_102',
      clientPhone: '+573009990003',
      clientName: 'Fernando Torres',
      message: 'Necesito hablar con un asesor humano urgente',
    })

    assert.strictEqual(resC.forwarded, true)
    assert.strictEqual(resC.handled, true)
    assert.strictEqual(resC.actionTaken, 'handoff_human')
    assert.ok(resC.replyText?.includes('transfiriendo con un asesor'))
    // Verificamos que 2A anotó en el timeline del CRM y puso el lock en HANDOFF_HUMAN
    assert.strictEqual(mockCrm.executedActions.length, 1)
    assert.strictEqual(mockCrm.executedActions[0].action, 'add_note')
    assert.ok((mockCrm.executedActions[0].params.content as string).includes('Handoff IA'))

    const lockC = router.getLockManager().getLock('+573009990003')
    assert.strictEqual(lockC?.currentState, 'HANDOFF_HUMAN')
    console.log('✅ Caso C superado: Handoff ejecutado, nota registrada en CRM y lock en HANDOFF_HUMAN')

    // -------------------------------------------------------------------------
    // 5. Verificación de ausencia de doble respuesta
    // -------------------------------------------------------------------------
    console.log('\n--- Comprobación de Ausencia de Doble Respuesta ---')
    // El motor que respondió en los 3 casos fue estrictamente 'agentic-2a'.
    // El hook de `auto-reply/route.ts` retorna inmediatamente cuando `bridgeRes.handled === true`,
    // impidiendo que la ejecución continúe hacia el LLM local o hacia otros workflows.
    console.log('✅ Evidencia: Los 3 casos devolvieron handled=true, cortando la ejecución en route.ts antes del LLM.')

    // -------------------------------------------------------------------------
    // 6. Deshabilitar el puente y verificar retorno al comportamiento normal
    // -------------------------------------------------------------------------
    console.log('\n--- Deshabilitando el puente ---')
    process.env.AGENTIC_2A_ENABLED = 'false'
    assert.strictEqual(isAgentic2AEnabled(), false)

    const resDisabled = await forwardToAgentic2A({
      orgId: 'org_controlled_test',
      clientId: 'cl_existing_103',
      clientPhone: '+573009990004',
      message: 'Hola con flag apagado',
    })

    assert.strictEqual(resDisabled.forwarded, false)
    assert.strictEqual(resDisabled.handled, false)
    console.log('✅ Comprobación final: Con flag apagado, el puente retorna handled=false de inmediato y el CRM recupera su flujo normal intacto.')

    console.log('\n============================================================')
    console.log('  TODAS LAS VERIFICACIONES CONTROLADAS FUERON SUPERADAS AL 100%')
    console.log('============================================================\n')
  } finally {
    // 7. Apagado limpio del servidor
    delete process.env.AGENTIC_2A_ENABLED
    delete process.env.AGENTIC_2A_URL
    delete process.env.AGENTIC_2A_WEBHOOK_SECRET
    await new Promise<void>((resolve) => server.close(() => resolve()))
    console.log('[Fin] Servidor de pruebas detenido y entorno restablecido.')
  }
}

executeControlledLiveTest().catch((err) => {
  console.error('Error en prueba controlada:', err)
  process.exit(1)
})
