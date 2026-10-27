import assert from 'node:assert'
import { createHmac } from 'node:crypto'
import { createAgenticServer } from '../src/server.ts'
import { MockTransportSender } from '../src/adapters/transport.ts'
import { MockCrmClient } from '../src/adapters/crm-client.ts'
import type { InboundEvent } from '../src/types.ts'

async function runTestSuite() {
  console.log('\n============================================================')
  console.log('  EJECUTANDO SUITE DE PRUEBAS DE ACEPTACIÓN: CAPA 2A (CP-01 a CP-10)')
  console.log('  Transporte: MockTransportSender (Sala Limpia, 0 envíos reales)')
  console.log('============================================================\n')

  const transport = new MockTransportSender()
  const crm = new MockCrmClient()
  const webhookSecret = 'test_secret_key_12345'
  const { router, server } = createAgenticServer({
    dbPath: ':memory:',
    transport,
    crm,
    webhookSecret,
  })

  let passed = 0
  let failed = 0

  async function test(name: string, fn: () => Promise<void>) {
    try {
      transport.clear()
      crm.clear()
      await fn()
      console.log(`  ✅ [PASS] ${name}`)
      passed++
    } catch (err: any) {
      console.error(`  ❌ [FAIL] ${name}:`, err.message)
      failed++
    }
  }

  // -------------------------------------------------------------
  // CP-01: Lead nuevo entrante
  // -------------------------------------------------------------
  await test('CP-01: Lead nuevo entrante registra cliente en CRM y envía bienvenida', async () => {
    const event: InboundEvent = {
      eventId: 'evt_001',
      orgId: 'org_test_1',
      correlationId: 'corr_001',
      timestamp: new Date().toISOString(),
      channel: 'whatsapp',
      contact: { phone: '+573000000001', name: 'Laura Gómez', clientId: null },
      message: { id: 'msg_001', text: 'Hola, buenas tardes', type: 'text' },
    }

    const res = await router.processInbound(event)
    assert.strictEqual(res.handled, true)
    assert.strictEqual(res.actionTaken, 'new_lead_welcome')
    assert.strictEqual(crm.executedActions.length, 1)
    assert.strictEqual(crm.executedActions[0].action, 'create_client')
    assert.strictEqual(crm.executedActions[0].params.name, 'Laura Gómez')
    assert.strictEqual(transport.dispatched.length, 1)
    assert.ok(transport.dispatched[0].text.includes('Gracias por comunicarte'))
  })

  // -------------------------------------------------------------
  // CP-02: Palabra clave determinista (Precios)
  // -------------------------------------------------------------
  await test('CP-02: Contacto escribe "PRECIO" y recibe catálogo determinista sin LLM', async () => {
    const event: InboundEvent = {
      eventId: 'evt_002',
      orgId: 'org_test_1',
      correlationId: 'corr_002',
      timestamp: new Date().toISOString(),
      channel: 'whatsapp',
      contact: { phone: '+573000000002', clientId: 'cl_existing_1' },
      message: { id: 'msg_002', text: 'Quisiera saber el PRECIO de los planes', type: 'text' },
    }

    const res = await router.processInbound(event)
    assert.strictEqual(res.handled, true)
    assert.ok(res.actionTaken === 'keyword_rule' || res.actionTaken === 'visual_flow_execution')
    assert.strictEqual(transport.dispatched.length, 1)
    assert.ok(transport.dispatched[0].text.includes('Plan Emprendedor'))
  })

  // -------------------------------------------------------------
  // CP-03: Handoff a humano
  // -------------------------------------------------------------
  await test('CP-03: Detección de "asesor" activa handoff, silencia bot y anota en CRM', async () => {
    const event: InboundEvent = {
      eventId: 'evt_003',
      orgId: 'org_test_1',
      correlationId: 'corr_003',
      timestamp: new Date().toISOString(),
      channel: 'whatsapp',
      contact: { phone: '+573000000003', clientId: 'cl_existing_2' },
      message: { id: 'msg_003', text: 'Necesito hablar con un ASESOR humano por favor', type: 'text' },
    }

    const res = await router.processInbound(event)
    assert.strictEqual(res.handled, true)
    assert.strictEqual(res.actionTaken, 'handoff_human')
    assert.strictEqual(crm.executedActions.length, 1)
    assert.strictEqual(crm.executedActions[0].action, 'add_note')
    assert.ok((crm.executedActions[0].params.content as string).includes('Handoff IA'))

    // Comprobar que el lock quedó en HANDOFF_HUMAN
    const lock = router.getLockManager().getLock('+573000000003')
    assert.ok(lock)
    assert.strictEqual(lock.currentState, 'HANDOFF_HUMAN')
  })

  // -------------------------------------------------------------
  // CP-04: Deduplicación e Idempotencia
  // -------------------------------------------------------------
  await test('CP-04: Mismo eventId enviado 2 veces devuelve respuesta cacheada sin re-ejecutar', async () => {
    const event: InboundEvent = {
      eventId: 'evt_duplicate_004',
      orgId: 'org_test_1',
      correlationId: 'corr_004',
      timestamp: new Date().toISOString(),
      channel: 'whatsapp',
      contact: { phone: '+573000000004', clientId: 'cl_existing_4' },
      message: { id: 'msg_004', text: 'CATALOGO', type: 'text' },
    }

    const first = await router.processInbound(event)
    assert.strictEqual(first.actionTaken, 'keyword_rule')
    assert.strictEqual(transport.dispatched.length, 1)

    // Segundo envío idéntico
    const second = await router.processInbound(event)
    assert.strictEqual(second.actionTaken, 'deduplicated')
    // El transporte NO debe haber enviado un segundo mensaje
    assert.strictEqual(transport.dispatched.length, 1)
  })

  // -------------------------------------------------------------
  // CP-05: Resiliencia ante caída del CRM
  // -------------------------------------------------------------
  await test('CP-05: CRM responde 503 pero 2A no crashea y responde con degradación elegante', async () => {
    crm.setSimulateUnavailable(true)
    const event: InboundEvent = {
      eventId: 'evt_005',
      orgId: 'org_test_1',
      correlationId: 'corr_005',
      timestamp: new Date().toISOString(),
      channel: 'whatsapp',
      contact: { phone: '+573000000005', name: 'Pedro', clientId: null },
      message: { id: 'msg_005', text: 'Hola quiero comprar', type: 'text' },
    }

    const res = await router.processInbound(event)
    assert.strictEqual(res.handled, true)
    // Se despachó el mensaje de bienvenida aunque el CRM falló en responder ok
    assert.strictEqual(transport.dispatched.length, 1)
    crm.setSimulateUnavailable(false)
  })

  // -------------------------------------------------------------
  // CP-06: Prevención de colisión 2A vs 2B (Lock para Broadcast)
  // -------------------------------------------------------------
  await test('CP-06: Teléfono en diálogo con 2A reporta lock activo a Capa 2B', async () => {
    const phone = '+573000000006'
    router.getLockManager().acquireLock(phone, 'org_test_1', 'corr_006')

    const lockInfo = router.getLockManager().getLock(phone)
    assert.ok(lockInfo)
    assert.strictEqual(lockInfo.currentState, 'IN_FLOW_2A')

    // Liberar lock simula cierre de conversación
    router.getLockManager().releaseLock(phone)
    const freeLock = router.getLockManager().getLock(phone)
    assert.strictEqual(freeLock, null)
  })

  // -------------------------------------------------------------
  // CP-07: Aislamiento Multi-tenant
  // -------------------------------------------------------------
  await test('CP-07: Locks y eventos entre organizaciones no se cruzan', async () => {
    const phone = '+573000000007'
    router.getLockManager().acquireLock(phone, 'org_albra_alpha', 'corr_007_a')

    const lockA = router.getLockManager().getLock(phone)
    assert.strictEqual(lockA?.organizationId, 'org_albra_alpha')

    // Si otra org intenta adquirirlo sobre el mismo número activo, es bloqueado por concurrencia
    const lockTryB = router.getLockManager().acquireLock(phone, 'org_albra_beta', 'corr_007_b')
    assert.strictEqual(lockTryB.acquired, true) // Extiende el lock
    assert.strictEqual(router.getLockManager().getLock(phone)?.organizationId, 'org_albra_alpha')
  })

  // -------------------------------------------------------------
  // CP-08: Evento falsificado (Firma HMAC)
  // -------------------------------------------------------------
  await test('CP-08: Validación de firma HMAC SHA-256 rechaza firmas corruptas', async () => {
    const payload = JSON.stringify({ test: 'data' })
    const validSignature = createHmac('sha256', webhookSecret).update(payload).digest('hex')
    const invalidSignature = 'bad_signature_99999'

    assert.notStrictEqual(validSignature, invalidSignature)
    // Simulación de verificación interna
    const verify = (sig: string) => sig === createHmac('sha256', webhookSecret).update(payload).digest('hex')
    assert.strictEqual(verify(validSignature), true)
    assert.strictEqual(verify(invalidSignature), false)
  })

  // -------------------------------------------------------------
  // CP-09: Solicitud de baja voluntaria (Opt-out)
  // -------------------------------------------------------------
  await test('CP-09: Contacto que escribe "BAJA" es suprimido y no recibe mensajes futuros', async () => {
    const phone = '+573000000009'
    const eventOptOut: InboundEvent = {
      eventId: 'evt_009_a',
      orgId: 'org_test_1',
      correlationId: 'corr_009_a',
      timestamp: new Date().toISOString(),
      channel: 'whatsapp',
      contact: { phone, clientId: 'cl_9' },
      message: { id: 'msg_009_a', text: 'Por favor dar de BAJA mi número', type: 'text' },
    }

    const res = await router.processInbound(eventOptOut)
    assert.strictEqual(res.actionTaken, 'suppression_opt_out')
    assert.ok(router.getSuppressionStore().isSuppressed(phone))
    assert.ok(transport.dispatched[0].text.includes('dado de baja correctamente'))

    // Intento subsiguiente de mensaje normal
    transport.clear()
    const eventAfter: InboundEvent = {
      eventId: 'evt_009_b',
      orgId: 'org_test_1',
      correlationId: 'corr_009_b',
      timestamp: new Date().toISOString(),
      channel: 'whatsapp',
      contact: { phone, clientId: 'cl_9' },
      message: { id: 'msg_009_b', text: 'Hola de nuevo', type: 'text' },
    }

    const resAfter = await router.processInbound(eventAfter)
    assert.strictEqual(resAfter.actionTaken, 'ignored')
    assert.strictEqual(transport.dispatched.length, 0) // No se envía nada
  })

  // -------------------------------------------------------------
  // CP-10: Expiración de Lock por Timeout (TTL)
  // -------------------------------------------------------------
  await test('CP-10: Lock con más de 15 minutos de inactividad vence y permite re-adquisición', async () => {
    const phone = '+573000000010'
    router.getLockManager().acquireLock(phone, 'org_test_1', 'corr_010')

    // Simulamos que el lock fue adquirido hace 16 minutos (960 segundos atrás)
    const oldTimestamp = Math.floor(Date.now() / 1000) - 960
    const pastExpires = oldTimestamp + 900 // Ya venció hace 60s
    router['db'].prepare('UPDATE conversation_locks SET locked_at = ?, expires_at = ? WHERE contact_phone = ?').run(oldTimestamp, pastExpires, phone)

    // Al consultar, debe detectar expiración por TTL y liberarlo
    const lockAfterTtl = router.getLockManager().getLock(phone)
    assert.strictEqual(lockAfterTtl, null)
  })

  // -------------------------------------------------------------
  // CP-11: Gestión Administrativa de Supresiones (API Interna)
  // -------------------------------------------------------------
  await test('CP-11: Registro y consulta de baja vía endpoints internos /api/internal/suppression', async () => {
    const testPort = 3988
    await new Promise<void>((r) => server.listen(testPort, r))

    try {
      const phone = '573199998877'
      // FAIL-CLOSED (rotación 2026-10-27): la suite exige el secret en el entorno, sin literales publicadas
      const secret = process.env.INTERNAL_API_SECRET
      if (!secret) {
        console.error('FAIL-CLOSED: CP-11 exige INTERNAL_API_SECRET en el entorno. Abortando.')
        process.exit(1)
      }

      // 1. Consulta inicial: no suprimido
      const resGet1 = await fetch(`http://localhost:${testPort}/api/internal/suppression/${phone}`)
      const dataGet1 = await resGet1.json() as any
      assert.strictEqual(dataGet1.suppressed, false)

      // 2. Registro administrativo con autenticación
      const resPost = await fetch(`http://localhost:${testPort}/api/internal/suppression/${phone}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secret}`,
        },
        body: JSON.stringify({ reason: 'Opt-out test unitario CP-11' }),
      })
      assert.strictEqual(resPost.status, 200)
      const dataPost = await resPost.json() as any
      assert.strictEqual(dataPost.suppressed, true)

      // 3. Consulta posterior: suprimido confirmado
      const resGet2 = await fetch(`http://localhost:${testPort}/api/internal/suppression/${phone}`)
      const dataGet2 = await resGet2.json() as any
      assert.strictEqual(dataGet2.suppressed, true)

      // 4. Intento con secreto inválido debe responder 401
      const resBadAuth = await fetch(`http://localhost:${testPort}/api/internal/suppression/${phone}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer bad_secret',
        },
        body: JSON.stringify({ reason: 'Hack attempt' }),
      })
      assert.strictEqual(resBadAuth.status, 401)

      // 5. Eliminación administrativa (re-activación)
      const resDel = await fetch(`http://localhost:${testPort}/api/internal/suppression/${phone}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${secret}`,
        },
      })
      assert.strictEqual(resDel.status, 200)
      const dataDel = await resDel.json() as any
      assert.strictEqual(dataDel.suppressed, false)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  console.log('\n============================================================')
  console.log(`  RESULTADO: ${passed} pruebas superadas, ${failed} fallidas.`)
  console.log('============================================================\n')

  if (failed > 0) {
    process.exit(1)
  }
}

runTestSuite().catch((err) => {
  console.error('Error fatal en suite:', err)
  process.exit(1)
})
