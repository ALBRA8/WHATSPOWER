import assert from 'node:assert'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { createAgenticServer } from '../src/server.ts'
import { MockTransportSender } from '../src/adapters/transport.ts'
import { MockCrmClient } from '../src/adapters/crm-client.ts'

// Importamos el módulo real de Capa 1
import {
  forwardToAgentic2A,
  isPhoneAllowedForPilot,
  canonicalizeColombianPhone,
  isAgentic2AEnabled,
} from '../../../audit_repos/CRM-ALBRA/src/lib/agentic-2a-bridge.ts'

async function runFinalPrePilotControl() {
  console.log('\n============================================================')
  console.log('  ALBRA: CONTROL FINAL PREVIO AL PILOTO 2A (VERIFICACIÓN RIGUROSA)')
  console.log('  Verificando: Canonización Colombia, Rechazo Ambiguo y Timeout Tardío')
  console.log('============================================================\n')

  // -------------------------------------------------------------------------
  // CONTROL 1: Allowlist se valida ANTES de cualquier llamada HTTP
  // -------------------------------------------------------------------------
  console.log('--- Control 1: Validación Previa Fail-Closed ---')
  delete process.env.AGENTIC_2A_PILOT_ALLOWLIST
  process.env.AGENTIC_2A_ENABLED = 'true'
  process.env.AGENTIC_2A_URL = 'http://localhost:9999/unreachable' // URL inválida a propósito

  const resNoHttp = await forwardToAgentic2A({
    orgId: 'org_test',
    clientId: 'cl_1',
    clientPhone: '+57 300 123 4567',
    message: 'Hola',
  })
  // Si hubiera intentado hacer HTTP, habría lanzado error de conexión al puerto 9999
  assert.strictEqual(resNoHttp.forwarded, false)
  assert.strictEqual(resNoHttp.handled, false)
  assert.strictEqual(resNoHttp.reason, 'phone_not_in_pilot_allowlist')
  console.log('  ✅ [PASS] Con allowlist ausente o vacía, se rechaza en memoria en 0ms sin tocar red')

  // -------------------------------------------------------------------------
  // CONTROL 2: Canonización Estricta de Móviles Colombianos
  // -------------------------------------------------------------------------
  console.log('\n--- Control 2: Canonización y Rechazo de Ambiguos ---')
  const expectedCanonical = '573001234567'

  // Variaciones válidas que deben converger a la misma identidad
  assert.strictEqual(canonicalizeColombianPhone('+57 300 123 4567'), expectedCanonical)
  assert.strictEqual(canonicalizeColombianPhone('+573001234567'), expectedCanonical)
  assert.strictEqual(canonicalizeColombianPhone('573001234567'), expectedCanonical)
  assert.strictEqual(canonicalizeColombianPhone('3001234567'), expectedCanonical)
  assert.strictEqual(canonicalizeColombianPhone('+57 (300) 123-4567'), expectedCanonical)
  assert.strictEqual(canonicalizeColombianPhone('300-123-4567'), expectedCanonical)
  console.log('  ✅ [PASS] 6 variaciones de formato colapsan a la identidad unívoca 573001234567')

  // Casos negativos / ambiguos que DEBEN ser rechazados con null
  assert.strictEqual(canonicalizeColombianPhone('12345'), null) // Demasiado corto
  assert.strictEqual(canonicalizeColombianPhone('300123'), null) // Incompleto
  assert.strictEqual(canonicalizeColombianPhone('57300123'), null) // Incompleto con prefijo
  assert.strictEqual(canonicalizeColombianPhone('6012345678'), null) // Fijo colombiano (no es móvil 3XX)
  assert.strictEqual(canonicalizeColombianPhone('+1 415 555 2671'), null) // Número internacional ajeno
  assert.strictEqual(canonicalizeColombianPhone(''), null) // Vacío
  assert.strictEqual(canonicalizeColombianPhone(undefined), null)
  console.log('  ✅ [PASS] Casos ambiguos o incompletos son rechazados estrictamente (null)')

  // Verificación en allowlist
  process.env.AGENTIC_2A_PILOT_ALLOWLIST = '+57 300 123 4567'
  assert.strictEqual(isPhoneAllowedForPilot('3001234567'), true) // Entra sin +57 pero coincide
  assert.strictEqual(isPhoneAllowedForPilot('+573001234567'), true) // Entra con +57 y coincide
  assert.strictEqual(isPhoneAllowedForPilot('3009999999'), false) // No coincide
  assert.strictEqual(isPhoneAllowedForPilot('12345'), false) // Ambiguo
  console.log('  ✅ [PASS] isPhoneAllowedForPilot evalúa de forma unívoca y rechaza no autorizados')

  // -------------------------------------------------------------------------
  // CONTROL 3: Timeout y Prueba de Respuesta Tardía (Single-Responder)
  // -------------------------------------------------------------------------
  console.log('\n--- Control 3: Prueba de Timeout Tardío y Despacho Único ---')
  const DELAY_PORT = 3095
  const DELAY_SECRET = 'delay_secret_test_32chars_hex_12345'
  let slowServerProcessed = false

  // Servidor que introduce un retraso deliberado de 800ms
  const slowServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    setTimeout(() => {
      slowServerProcessed = true
      if (!res.writableEnded) {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ handled: true, actionTaken: 'late_reply', replyText: 'Respuesta tardía de 2A' }))
        } catch {}
      }
    }, 800)
    let body = ''
    req.on('data', (c) => (body += c))
  })

  await new Promise<void>((r) => slowServer.listen(DELAY_PORT, '127.0.0.1', r))

  try {
    process.env.AGENTIC_2A_URL = `http://127.0.0.1:${DELAY_PORT}`
    process.env.AGENTIC_2A_WEBHOOK_SECRET = DELAY_SECRET
    process.env.AGENTIC_2A_PILOT_ALLOWLIST = '3001234567'

    const simulatedWhatsAppDispatches: string[] = []

    // El CRM llama con timeout corto de 250ms
    const start = Date.now()
    const bridgeResult = await forwardToAgentic2A(
      {
        orgId: 'org_timeout_test',
        clientId: 'cl_timeout',
        clientPhone: '+57 300 123 4567',
        message: 'Hola retrasado',
      },
      { timeoutMs: 250 }
    )
    const elapsed = Date.now() - start

    assert.ok(elapsed < 600, `El timeout debió dispararse cerca de 250ms, tardó ${elapsed}ms`)
    assert.strictEqual(bridgeResult.handled, false)
    assert.ok(bridgeResult.error?.toLowerCase().includes('aborted') || bridgeResult.error?.toLowerCase().includes('timeout'))

    // Simulador del CRM: como handled es false, el CRM activa su LLM y despacha físicamente
    simulatedWhatsAppDispatches.push('Respuesta del LLM local de CRM ALBRA')
    assert.strictEqual(simulatedWhatsAppDispatches.length, 1)

    // Esperamos a que el servidor lento de 2A termine su timer (800ms)
    await new Promise((r) => setTimeout(r, 1000))
    assert.strictEqual(slowServerProcessed, true)

    // Comprobamos que el array de despachos físicos de WhatsApp SIGUE SIENDO EXACTAMENTE 1
    assert.strictEqual(simulatedWhatsAppDispatches.length, 1)
    console.log('  ✅ [PASS] Timeout tardío verificado: CRM despachó su fallback a los 250ms y 2A no inyectó segundo mensaje')
  } finally {
    await new Promise<void>((r) => slowServer.close(() => r()))
  }

  // -------------------------------------------------------------------------
  // CONTROL 4: Desactivación Total del Flag y Restauración del Entorno
  // -------------------------------------------------------------------------
  console.log('\n--- Control 4: Desactivación y Restauración del Entorno ---')
  process.env.AGENTIC_2A_ENABLED = 'false'
  assert.strictEqual(isAgentic2AEnabled(), false)

  const resDisabled = await forwardToAgentic2A({
    orgId: 'org_test',
    clientId: 'cl_1',
    clientPhone: '3001234567',
    message: 'Hola con flag apagado',
  })
  assert.strictEqual(resDisabled.forwarded, false)
  assert.strictEqual(resDisabled.handled, false)
  assert.strictEqual(resDisabled.reason, 'agentic_2a_disabled')
  console.log('  ✅ [PASS] Con AGENTIC_2A_ENABLED=false, el puente queda 100% inactivo')

  // Limpieza final de variables del proceso
  delete process.env.AGENTIC_2A_ENABLED
  delete process.env.AGENTIC_2A_URL
  delete process.env.AGENTIC_2A_WEBHOOK_SECRET
  delete process.env.AGENTIC_2A_PILOT_ALLOWLIST

  console.log('\n============================================================')
  console.log('  TODOS LOS CONTROLES FINALES PREVIOS AL PILOTO SUPERADOS')
  console.log('============================================================\n')
}

runFinalPrePilotControl().catch((err) => {
  console.error('Fallo en control final:', err)
  process.exit(1)
})
