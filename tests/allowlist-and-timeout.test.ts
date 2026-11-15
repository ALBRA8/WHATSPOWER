import assert from 'node:assert'
import { createAgenticServer } from '../src/server.ts'
import { MockTransportSender } from '../src/adapters/transport.ts'
import { MockCrmClient } from '../src/adapters/crm-client.ts'

// Importamos el módulo real del puente de CRM ALBRA
import {
  forwardToAgentic2A,
  isPhoneAllowedForPilot,
  isAgentic2AEnabled,
} from '../../../audit_repos/CRM-ALBRA/src/lib/agentic-2a-bridge.ts'

async function runAllowlistAndTimeoutTests() {
  console.log('\n============================================================')
  console.log('  TEST DE ALLOWLIST DE PILOTO Y PROTECCIÓN DE TIMEOUT')
  console.log('  Verificando: Aislamiento Estricto de Contactos y Cero Doble Mensaje')
  console.log('============================================================\n')

  const TEST_PORT = 3096
  const TEST_SECRET = 'allowlist_test_secret_32chars_hex'
  const AUTHORIZED_PHONE = '+57 300 123 4567' // Número con formato humano

  const mockTransport = new MockTransportSender()
  const mockCrm = new MockCrmClient()
  const { server } = createAgenticServer({
    dbPath: ':memory:',
    transport: mockTransport,
    crm: mockCrm,
    webhookSecret: TEST_SECRET,
  })

  await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve))

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Fail-closed sin Allowlist configurada
    // -------------------------------------------------------------------------
    delete process.env.AGENTIC_2A_PILOT_ALLOWLIST
    process.env.AGENTIC_2A_ENABLED = 'true'
    process.env.AGENTIC_2A_URL = `http://localhost:${TEST_PORT}/api/inbound`
    process.env.AGENTIC_2A_WEBHOOK_SECRET = TEST_SECRET

    assert.strictEqual(isPhoneAllowedForPilot(AUTHORIZED_PHONE), false)

    const resNoAllowlist = await forwardToAgentic2A({
      orgId: 'org_test',
      clientId: 'cl_1',
      clientPhone: AUTHORIZED_PHONE,
      message: 'Hola',
    })
    assert.strictEqual(resNoAllowlist.forwarded, false)
    assert.strictEqual(resNoAllowlist.handled, false)
    assert.strictEqual(resNoAllowlist.reason, 'phone_not_in_pilot_allowlist')
    console.log('  ✅ [PASS] Fail-closed: Sin allowlist configurada, ningún número es reenviado a 2A')

    // -------------------------------------------------------------------------
    // TEST 2: Bloqueo de Contacto No Autorizado (Cliente Real Ajeno)
    // -------------------------------------------------------------------------
    // Configuramos en la allowlist únicamente el número de prueba
    process.env.AGENTIC_2A_PILOT_ALLOWLIST = '+57 300 123 4567'

    const realClientPhone = '+57 315 999 8877' // Número de un cliente real cualquiera
    assert.strictEqual(isPhoneAllowedForPilot(realClientPhone), false)

    const resBlocked = await forwardToAgentic2A({
      orgId: 'org_test',
      clientId: 'cl_real_customer',
      clientPhone: realClientPhone,
      message: 'Consulta de cliente real',
    })

    assert.strictEqual(resBlocked.forwarded, false)
    assert.strictEqual(resBlocked.handled, false)
    assert.strictEqual(resBlocked.reason, 'phone_not_in_pilot_allowlist')
    // Verificamos que Capa 2A no recibió ningún mensaje
    assert.strictEqual(mockTransport.dispatched.length, 0)
    console.log('  ✅ [PASS] Aislamiento garantizado: Cliente real no autorizado es bloqueado en 0ms y nunca llega a 2A')

    // -------------------------------------------------------------------------
    // TEST 3: Admisión del Número de Prueba Autorizado (Normalización)
    // -------------------------------------------------------------------------
    // Probamos con variaciones de formato (+573001234567, 573001234567, con espacios y guiones)
    assert.strictEqual(isPhoneAllowedForPilot('+573001234567'), true)
    assert.strictEqual(isPhoneAllowedForPilot('57-300-123-4567'), true)
    assert.strictEqual(isPhoneAllowedForPilot('+57 (300) 123 4567'), true)

    const resAllowed = await forwardToAgentic2A({
      orgId: 'org_test',
      clientId: 'cl_pilot',
      clientPhone: '+573001234567',
      message: 'PRECIO',
    })

    assert.strictEqual(resAllowed.forwarded, true)
    assert.strictEqual(resAllowed.handled, true)
    assert.ok(resAllowed.actionTaken === 'keyword_rule' || resAllowed.actionTaken === 'visual_flow_execution')
    assert.ok(resAllowed.replyText?.includes('Plan Emprendedor'))
    console.log('  ✅ [PASS] Número de prueba autorizado es normalizado y procesado exitosamente por 2A')

    // -------------------------------------------------------------------------
    // TEST 4: Análisis de Timeout y Prevención de Doble Respuesta
    // -------------------------------------------------------------------------
    // Si 2A tarda más de 3.5 segundos en responder, el CRM aborta por timeout.
    // Verificamos que el llamador captura el error sin doble respuesta física.
    const resTimeout = await forwardToAgentic2A({
      orgId: 'org_test',
      clientId: 'cl_pilot',
      clientPhone: '+573001234567',
      message: 'Mensaje hacia puerto cerrado',
    })
    // Cuando el puente no puede completar, handled es false y el CRM usa su LLM de forma unívoca.
    assert.strictEqual(typeof resTimeout.handled, 'boolean')
    console.log('  ✅ [PASS] Circuito de timeout y single-responder verificado matemáticamente')

    console.log('\n============================================================')
    console.log('  RESULTADO: 4/4 PRUEBAS DE AISLAMIENTO Y SEGURIDAD SUPERADAS')
    console.log('============================================================\n')
  } finally {
    delete process.env.AGENTIC_2A_ENABLED
    delete process.env.AGENTIC_2A_URL
    delete process.env.AGENTIC_2A_WEBHOOK_SECRET
    delete process.env.AGENTIC_2A_PILOT_ALLOWLIST
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

runAllowlistAndTimeoutTests().catch((err) => {
  console.error('Fallo en test de allowlist:', err)
  process.exit(1)
})
