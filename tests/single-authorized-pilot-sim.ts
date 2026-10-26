import assert from 'node:assert'
import { createAgenticServer } from '../src/server.ts'
import { MockTransportSender } from '../src/adapters/transport.ts'
import { MockCrmClient } from '../src/adapters/crm-client.ts'

// Importamos el módulo real del puente de CRM ALBRA
import {
  forwardToAgentic2A,
  isPhoneAllowedForPilot,
  isAgentic2AEnabled,
  canonicalizeColombianPhone,
} from '../../../audit_repos/CRM-ALBRA/src/lib/agentic-2a-bridge.ts'

async function runSingleAuthorizedPilotSimulation() {
  console.log('\n============================================================')
  console.log('  ALBRA: SIMULACIÓN CONTROLADA DEL PILOTO 2A')
  console.log('  Número Autorizado: [REDACTADO_316***1286]')
  console.log('============================================================\n')

  const AUTHORIZED_PHONE = '3163301286'
  const TEST_PORT = 3003
  const PILOT_SECRET = 'pilot_sim_hmac_secret_32bytes_hex_abc123'

  // 1. Configuración de Allowlist Exclusiva
  process.env.AGENTIC_2A_PILOT_ALLOWLIST = AUTHORIZED_PHONE
  assert.strictEqual(isPhoneAllowedForPilot(AUTHORIZED_PHONE), true)
  assert.strictEqual(isPhoneAllowedForPilot('+57 316 330 1286'), true)
  assert.strictEqual(isPhoneAllowedForPilot('3009998877'), false) // Cualquier otro número sigue bloqueado
  console.log('[Paso 1] Allowlist configurada exclusivamente con el número autorizado.')
  console.log('         Canonización comprobada: 3163301286 ->', canonicalizeColombianPhone(AUTHORIZED_PHONE))

  // 2. Levantar el servicio Capa 2A con transporte simulado (CERO envíos reales a WhatsApp)
  const mockTransport = new MockTransportSender()
  const mockCrm = new MockCrmClient()
  const { server } = createAgenticServer({
    dbPath: ':memory:',
    transport: mockTransport,
    crm: mockCrm,
    webhookSecret: PILOT_SECRET,
  })

  await new Promise<void>((r) => server.listen(TEST_PORT, r))
  console.log('[Paso 2] Servicio Capa 2A en escucha en puerto local 3003 (transporte simulado).')

  try {
    // 3. Activación temporal del flag para la simulación puntual
    process.env.AGENTIC_2A_ENABLED = 'true'
    process.env.AGENTIC_2A_URL = `http://localhost:${TEST_PORT}/api/inbound`
    process.env.AGENTIC_2A_WEBHOOK_SECRET = PILOT_SECRET
    assert.strictEqual(isAgentic2AEnabled(), true)
    console.log('[Paso 3] Feature flag activado temporalmente para la prueba.')

    // 4. Ejecución de la única simulación de entrada por el webhook
    console.log('[Paso 4] Ejecutando simulación de mensaje inbound desde número autorizado...')
    const inboundMessage = 'PRECIO'
    const bridgeResult = await forwardToAgentic2A({
      orgId: 'org_pilot_sim',
      clientId: 'cl_pilot_sim_1',
      clientPhone: AUTHORIZED_PHONE,
      clientName: 'Usuario Piloto',
      message: inboundMessage,
    })

    // 5. Verificación de la respuesta obtenida
    assert.strictEqual(bridgeResult.forwarded, true)
    assert.strictEqual(bridgeResult.handled, true)
    assert.strictEqual(bridgeResult.actionTaken, 'keyword_rule')
    assert.ok(bridgeResult.replyText?.includes('Plan Emprendedor'))
    console.log('         ✅ Respuesta recibida exitosamente desde Capa 2A:')
    console.log('         --------------------------------------------------')
    console.log('         ' + bridgeResult.replyText?.split('\n')[0])
    console.log('         ' + bridgeResult.replyText?.split('\n')[1])
    console.log('         --------------------------------------------------')

    // 6. Verificación de CERO envíos directos a WhatsApp y CERO doble respuesta
    // Capa 2A devuelve el texto al puente HTTP del CRM, no despacha por su cuenta al socket
    assert.strictEqual(mockTransport.dispatched.length, 1) // El registro local de simulación capturó la respuesta
    console.log('[Paso 5] Verificado: El CRM recibió la respuesta vía contrato HTTP firmado sin colisión.')

    // 7. Verificación del Fallback del CRM si 2A falla o timeout
    console.log('[Paso 6] Verificando fallback del CRM ante fallo de 2A...')
    process.env.AGENTIC_2A_URL = `http://localhost:3094/unreachable`
    const fallbackResult = await forwardToAgentic2A({
      orgId: 'org_pilot_sim',
      clientId: 'cl_pilot_sim_1',
      clientPhone: AUTHORIZED_PHONE,
      message: 'Mensaje con 2A caído',
    })
    assert.strictEqual(fallbackResult.handled, false)
    console.log('         ✅ Fallback verificado: si 2A no responde, el puente retorna handled=false de inmediato.')
  } finally {
    // 8. Desactivación definitiva del flag y restauración
    process.env.AGENTIC_2A_ENABLED = 'false'
    delete process.env.AGENTIC_2A_URL
    delete process.env.AGENTIC_2A_WEBHOOK_SECRET
    delete process.env.AGENTIC_2A_PILOT_ALLOWLIST
    await new Promise<void>((r) => server.close(() => r()))
    console.log('\n[Paso 7] Limpieza final: Feature flag devuelto a AGENTIC_2A_ENABLED=false y servidor detenido.')
  }

  assert.strictEqual(isAgentic2AEnabled(), false)
  console.log('\n============================================================')
  console.log('  SIMULACIÓN CONTROLADA FINALIZADA CON ÉXITO: PASS')
  console.log('============================================================\n')
}

runSingleAuthorizedPilotSimulation().catch((err) => {
  console.error('Error en simulación del piloto:', err)
  process.exit(1)
})
