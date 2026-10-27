import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createHmac } from 'node:crypto'
import { createAgenticServer } from '../src/server.ts'

/**
 * Regresión de configuración de secrets del Inbound Bridge (POST /api/inbound).
 * Cadena de prioridad esperada:
 *   options.webhookSecret > AGENTIC_2A_WEBHOOK_SECRET > WEBHOOK_SECRET (legacy) > default dev
 */
function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

async function listenOnEphemeralPort(server: { listen: Function; close: Function; address: Function }): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as { port: number }).port
}

const PAYLOAD = JSON.stringify({
  eventId: 'evt-secret-config-001',
  orgId: 'org_secret_config_test',
  contact: { phone: '573000000001', name: 'Test Secret' },
  message: { text: 'Hola, prueba de configuración' },
  timestamp: new Date().toISOString(),
  channel: 'whatsapp',
})

async function postInbound(port: number, secret: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/inbound`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature-SHA256': sign(PAYLOAD, secret),
      'X-Timestamp': String(Date.now()),
    },
    body: PAYLOAD,
  })
  return res.status
}

describe('CONFIGURACIÓN DE SECRETS DEL INBOUND BRIDGE (regresión wiring de producción)', () => {
  it('SEC-01: AGENTIC_2A_WEBHOOK_SECRET tiene prioridad sobre WEBHOOK_SECRET (legacy)', async () => {
    process.env.AGENTIC_2A_WEBHOOK_SECRET = 'secret_agentic_prioritario_test'
    process.env.WEBHOOK_SECRET = 'secret_legacy_descartado_test'
    try {
      const { server } = createAgenticServer({ dbPath: ':memory:' })
      const port = await listenOnEphemeralPort(server as any)
      try {
        // Firmado con el secret prioritario: la firma es VÁLIDA (no debe ser 401)
        const withAgentic = await postInbound(port, 'secret_agentic_prioritario_test')
        assert.notStrictEqual(withAgentic, 401, 'AGENTIC_2A_WEBHOOK_SECRET debe usarse para verificar la firma')

        // Firmado con el legacy descartado: la firma ya NO es válida (401)
        const withLegacy = await postInbound(port, 'secret_legacy_descartado_test')
        assert.strictEqual(withLegacy, 401, 'WEBHOOK_SECRET legacy debe ser ignorado si existe AGENTIC_2A_WEBHOOK_SECRET')
      } finally {
        server.close()
      }
    } finally {
      delete process.env.AGENTIC_2A_WEBHOOK_SECRET
      delete process.env.WEBHOOK_SECRET
    }
  })

  it('SEC-02: options.webhookSecret tiene la máxima prioridad sobre las variables de entorno', async () => {
    process.env.AGENTIC_2A_WEBHOOK_SECRET = 'secret_entorno_ignorado_test'
    try {
      const { server } = createAgenticServer({ dbPath: ':memory:', webhookSecret: 'secret_options_maxima_prioridad' })
      const port = await listenOnEphemeralPort(server as any)
      try {
        const withOptions = await postInbound(port, 'secret_options_maxima_prioridad')
        assert.notStrictEqual(withOptions, 401, 'options.webhookSecret debe tener la máxima prioridad')

        const withEnv = await postInbound(port, 'secret_entorno_ignorado_test')
        assert.strictEqual(withEnv, 401, 'La variable de entorno debe ser ignorada cuando hay options.webhookSecret')
      } finally {
        server.close()
      }
    } finally {
      delete process.env.AGENTIC_2A_WEBHOOK_SECRET
    }
  })

  it('SEC-03: sin AGENTIC_2A_WEBHOOK_SECRET, cae al legacy WEBHOOK_SECRET (compatibilidad)', async () => {
    delete process.env.AGENTIC_2A_WEBHOOK_SECRET
    process.env.WEBHOOK_SECRET = 'secret_legacy_solo_test'
    try {
      const { server } = createAgenticServer({ dbPath: ':memory:' })
      const port = await listenOnEphemeralPort(server as any)
      try {
        const withLegacy = await postInbound(port, 'secret_legacy_solo_test')
        assert.notStrictEqual(withLegacy, 401, 'Sin AGENTIC_2A_WEBHOOK_SECRET debe usarse el legacy WEBHOOK_SECRET')
      } finally {
        server.close()
      }
    } finally {
      delete process.env.WEBHOOK_SECRET
    }
  })
})
