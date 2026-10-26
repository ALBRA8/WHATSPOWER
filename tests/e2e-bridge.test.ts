import assert from 'node:assert'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { createAgenticServer } from '../src/server.ts'
import { MockTransportSender } from '../src/adapters/transport.ts'
import { MockCrmClient } from '../src/adapters/crm-client.ts'

/**
 * SIMULADOR DEL AUTO-REPLY DE CRM ALBRA (Capa 1)
 * Emula el comportamiento exacto de `audit_repos/CRM-ALBRA/src/app/api/whatsapp/auto-reply/route.ts`
 * con el hook 5.5 del puente hacia Capa 2A y el fallback al LLM local.
 */
class CrmAutoReplySimulator {
  llmCallsCount = 0
  bridgeEnabled = true
  bridgeUrl: string
  bridgeSecret: string

  constructor(bridgeUrl: string, bridgeSecret: string) {
    this.bridgeUrl = bridgeUrl
    this.bridgeSecret = bridgeSecret
  }

  async handleInbound(body: {
    message: string
    clientId: string
    clientPhone: string
    clientName?: string
    orgId: string
  }): Promise<{ reply: string; engine: string; handoff: boolean; paused: boolean }> {
    const { message, clientId, clientPhone, clientName, orgId } = body

    // 5.5) PUENTE CAPA 2A (Hook verificado en route.ts)
    if (this.bridgeEnabled) {
      try {
        const payload = {
          eventId: `evt_sim_${Date.now()}`,
          orgId,
          correlationId: `corr_${Date.now()}`,
          timestamp: new Date().toISOString(),
          channel: 'whatsapp',
          contact: { phone: clientPhone, name: clientName, clientId },
          message: { id: `msg_${Date.now()}`, text: message, type: 'text' },
        }
        const bodyStr = JSON.stringify(payload)
        const signature = createHmac('sha256', this.bridgeSecret).update(bodyStr).digest('hex')

        const res = await fetch(this.bridgeUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature-SHA256': signature,
            'X-Timestamp': new Date().toISOString(),
          },
          body: bodyStr,
          signal: AbortSignal.timeout(3000),
        })

        if (res.ok) {
          const data = (await res.json()) as any
          if (data.handled) {
            // Capa 2A resolvió la conversación:
            // SE RETORNA INMEDIATAMENTE. El LLM NO se ejecuta (Cero doble respuesta).
            if (data.actionTaken === 'handoff_human') {
              return { reply: data.replyText || '', engine: 'agentic-2a', handoff: true, paused: true }
            }
            return { reply: data.replyText || '', engine: 'agentic-2a', handoff: false, paused: false }
          }
        }
      } catch (err) {
        // Fallback elegante si 2A no responde o da timeout
      }
    }

    // 6 y 7) FALLBACK AL LLM LOCAL DEL CRM
    this.llmCallsCount++
    return {
      reply: 'Respuesta generada por el LLM local del CRM ALBRA',
      engine: 'local-llm',
      handoff: false,
      paused: false,
    }
  }
}

async function runJointE2ETests() {
  console.log('\n============================================================')
  console.log('  TEST E2E CONJUNTO: CRM ALBRA ➔ PUENTE INBOUND ➔ CAPA 2A')
  console.log('  Verificando: Recorrido Completo, Prevención de Doble Respuesta y Fallback')
  console.log('============================================================\n')

  const transport = new MockTransportSender()
  const crm = new MockCrmClient()
  const bridgeSecret = 'shared_secret_e2e_albra_2a'

  const { server } = createAgenticServer({
    dbPath: ':memory:',
    transport,
    crm,
    webhookSecret: bridgeSecret,
  })

  const PORT = 3098
  await new Promise<void>((resolve) => server.listen(PORT, resolve))

  const crmSimulator = new CrmAutoReplySimulator(`http://localhost:${PORT}/api/inbound`, bridgeSecret)

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Recorrido Completo con Respuesta Determinista (Palabra clave PRECIO)
    // -------------------------------------------------------------------------
    const res1 = await crmSimulator.handleInbound({
      message: 'Por favor informarme el PRECIO de los servicios',
      clientId: 'cl_e2e_01',
      clientPhone: '+573001112233',
      clientName: 'Alejandro',
      orgId: 'org_e2e_1',
    })

    assert.strictEqual(res1.engine, 'agentic-2a')
    assert.strictEqual(res1.handoff, false)
    assert.ok(res1.reply.includes('Plan Emprendedor'))
    // Verificación crítica: el LLM de Capa 1 NO fue llamado
    assert.strictEqual(crmSimulator.llmCallsCount, 0)
    console.log('  ✅ [PASS] Recorrido completo 2A exitoso. LLM del CRM inhibido (cero doble respuesta).')

    // -------------------------------------------------------------------------
    // TEST 2: Recorrido Completo con Handoff Humano
    // -------------------------------------------------------------------------
    const res2 = await crmSimulator.handleInbound({
      message: 'Necesito que un asesor humano me ayude',
      clientId: 'cl_e2e_02',
      clientPhone: '+573001112244',
      clientName: 'Beatriz',
      orgId: 'org_e2e_1',
    })

    assert.strictEqual(res2.engine, 'agentic-2a')
    assert.strictEqual(res2.handoff, true)
    assert.strictEqual(res2.paused, true)
    assert.ok(res2.reply.includes('transfiriendo con un asesor'))
    // Verificación: se registró la nota en el timeline de ALBRA
    assert.strictEqual(crm.executedActions.length, 1)
    assert.strictEqual(crm.executedActions[0].action, 'add_note')
    assert.strictEqual(crmSimulator.llmCallsCount, 0)
    console.log('  ✅ [PASS] Handoff humano exitoso: pausa activada y nota creada en CRM ALBRA.')

    // -------------------------------------------------------------------------
    // TEST 3: Verificación de Fallback (Capa 2A Desactivada o con Fallo)
    // -------------------------------------------------------------------------
    crmSimulator.bridgeEnabled = false // Simulamos desactivación por feature flag

    const resFallback = await crmSimulator.handleInbound({
      message: 'Hola, tengo una pregunta',
      clientId: 'cl_e2e_03',
      clientPhone: '+573001112255',
      clientName: 'Carlos',
      orgId: 'org_e2e_1',
    })

    assert.strictEqual(resFallback.engine, 'local-llm')
    assert.ok(resFallback.reply.includes('LLM local del CRM ALBRA'))
    assert.strictEqual(crmSimulator.llmCallsCount, 1)
    console.log('  ✅ [PASS] Fallback verificado: si 2A está inactiva, CRM responde por LLM sin degradar servicio.')

    // -------------------------------------------------------------------------
    // TEST 4: Resiliencia ante Timeout de 2A
    // -------------------------------------------------------------------------
    crmSimulator.bridgeEnabled = true
    crmSimulator.bridgeUrl = `http://localhost:3097/unreachable` // Puerto no disponible

    const resTimeout = await crmSimulator.handleInbound({
      message: 'Hola qué tal',
      clientId: 'cl_e2e_04',
      clientPhone: '+573001112266',
      clientName: 'Diana',
      orgId: 'org_e2e_1',
    })

    assert.strictEqual(resTimeout.engine, 'local-llm')
    assert.strictEqual(crmSimulator.llmCallsCount, 2)
    console.log('  ✅ [PASS] Resiliencia ante caída de red de 2A: fallback automático al CRM sin interrupción.')

    console.log('\n============================================================')
    console.log('  RESULTADO: 4/4 PRUEBAS E2E DEL CIRCUITO COMPLETO SUPERADAS')
    console.log('============================================================\n')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

runJointE2ETests().catch((err) => {
  console.error('Fallo en test conjunto:', err)
  process.exit(1)
})
