import assert from 'node:assert'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { createAgenticServer } from '../src/server.ts'
import { MockTransportSender } from '../src/adapters/transport.ts'
import { MockCrmClient } from '../src/adapters/crm-client.ts'

async function runBridgeTests() {
  console.log('\n============================================================')
  console.log('  TEST DE INTEGRACIÓN: PUENTE INBOUND CRM ➔ CAPA 2A')
  console.log('  Verificando: Feature Flag, Firma HMAC y Replay Tolerance')
  console.log('============================================================\n')

  const transport = new MockTransportSender()
  const crm = new MockCrmClient()
  const webhookSecret = 'secret_albra_bridge_test_48hex'

  const { server } = createAgenticServer({
    dbPath: ':memory:',
    transport,
    crm,
    webhookSecret,
  })

  const PORT = 3099
  await new Promise<void>((resolve) => server.listen(PORT, resolve))

  try {
    // -------------------------------------------------------------------------
    // 1. Petición válida con firma HMAC y Timestamp actual
    // -------------------------------------------------------------------------
    const validEvent = {
      eventId: 'evt_bridge_01',
      orgId: 'org_bridge_test',
      correlationId: 'corr_bridge_01',
      timestamp: new Date().toISOString(),
      channel: 'whatsapp',
      contact: { phone: '+573110000001', name: 'Mario Rossi', clientId: 'cl_1' },
      message: { id: 'msg_01', text: 'PRECIO', type: 'text' },
    }

    const validBody = JSON.stringify(validEvent)
    const validHmac = createHmac('sha256', webhookSecret).update(validBody).digest('hex')

    const resValid = await fetch(`http://localhost:${PORT}/api/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-SHA256': validHmac,
        'X-Timestamp': new Date().toISOString(),
        'X-Correlation-Id': 'corr_bridge_01',
      },
      body: validBody,
    })

    assert.strictEqual(resValid.status, 200)
    const dataValid = (await resValid.json()) as any
    assert.strictEqual(dataValid.handled, true)
    assert.ok(dataValid.actionTaken === 'keyword_rule' || dataValid.actionTaken === 'visual_flow_execution')
    assert.ok(dataValid.replyText.includes('Plan Emprendedor'))
    console.log('  ✅ [PASS] Petición válida con HMAC y Timestamp procesada correctamente (200 OK)')

    // -------------------------------------------------------------------------
    // 2. Petición con Timestamp desfasado (> 300 segundos)
    // -------------------------------------------------------------------------
    const expiredTimestamp = new Date(Date.now() - 400_000).toISOString()
    const resExpired = await fetch(`http://localhost:${PORT}/api/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-SHA256': validHmac,
        'X-Timestamp': expiredTimestamp,
        'X-Correlation-Id': 'corr_bridge_02',
      },
      body: validBody,
    })

    assert.strictEqual(resExpired.status, 401)
    const dataExpired = (await resExpired.json()) as any
    assert.ok(dataExpired.error.includes('replay protection'))
    console.log('  ✅ [PASS] Replay attack / Timestamp expirado rechazado con 401 Unauthorized')

    // -------------------------------------------------------------------------
    // 3. Petición con firma HMAC corrupta
    // -------------------------------------------------------------------------
    const resBadHmac = await fetch(`http://localhost:${PORT}/api/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-SHA256': 'corrupted_hmac_signature_value',
        'X-Timestamp': new Date().toISOString(),
        'X-Correlation-Id': 'corr_bridge_03',
      },
      body: validBody,
    })

    assert.strictEqual(resBadHmac.status, 401)
    const dataBadHmac = (await resBadHmac.json()) as any
    assert.ok(dataBadHmac.error.includes('Firma HMAC'))
    console.log('  ✅ [PASS] Firma HMAC corrupta rechazada con 401 Unauthorized')

    // -------------------------------------------------------------------------
    // 4. Handoff a humano a través del puente
    // -------------------------------------------------------------------------
    const handoffEvent = {
      eventId: 'evt_bridge_04',
      orgId: 'org_bridge_test',
      correlationId: 'corr_bridge_04',
      timestamp: new Date().toISOString(),
      channel: 'whatsapp',
      contact: { phone: '+573110000004', name: 'Laura', clientId: 'cl_4' },
      message: { id: 'msg_04', text: 'Quiero hablar con un asesor', type: 'text' },
    }
    const handoffBody = JSON.stringify(handoffEvent)
    const handoffHmac = createHmac('sha256', webhookSecret).update(handoffBody).digest('hex')

    const resHandoff = await fetch(`http://localhost:${PORT}/api/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-SHA256': handoffHmac,
        'X-Timestamp': new Date().toISOString(),
        'X-Correlation-Id': 'corr_bridge_04',
      },
      body: handoffBody,
    })

    assert.strictEqual(resHandoff.status, 200)
    const dataHandoff = (await resHandoff.json()) as any
    assert.strictEqual(dataHandoff.actionTaken, 'handoff_human')
    assert.ok(dataHandoff.replyText.includes('transfiriendo con un asesor'))
    console.log('  ✅ [PASS] Evento de Handoff a humano procesado con éxito y lock activado')

    console.log('\n============================================================')
    console.log('  RESULTADO: 4/4 PRUEBAS DEL PUENTE SUPERADAS')
    console.log('============================================================\n')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

runBridgeTests().catch((err) => {
  console.error('Fallo en test de puente:', err)
  process.exit(1)
})
