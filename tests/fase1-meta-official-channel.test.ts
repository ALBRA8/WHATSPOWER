import { test, describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { createServer } from 'node:http'
import { createDatabase } from '../src/db.ts'
import { createMockMetaServer } from './helpers/mock-meta-server.ts'
import { MessagingWindowStore } from '../src/safety/messaging-window.ts'
import { TemplateRegistry, type MetaTemplate } from '../src/safety/template-registry.ts'
import { classifyMetaError } from '../src/adapters/meta-error-classifier.ts'
import {
  resolveOrganizationTransportPlan,
  type OrganizationPlanConfig,
} from '../src/adapters/transport-selector.ts'

describe('FASE 1 — CANAL OFICIAL DE WHATSAPP (WHATSPOWER Nivel 2)', () => {
  describe('1.1 Transporte por defecto y aviso de riesgo Baileys', () => {
    it('Organización de pago (plan: paid) usa Meta Cloud API por defecto', () => {
      const config: OrganizationPlanConfig = {
        organizationId: 'org_paid_1',
        plan: 'paid',
      }
      const resolution = resolveOrganizationTransportPlan(config)
      assert.strictEqual(resolution.selectedTransport, 'meta-cloud')
      assert.strictEqual(resolution.allowed, true)
    })

    it('Baileys en plan básico viene DESACTIVADO por defecto sin confirmación de riesgo', () => {
      const config: OrganizationPlanConfig = {
        organizationId: 'org_basic_1',
        plan: 'basic',
        preferredTransport: 'baileys',
        baileysRiskAcknowledged: false,
      }
      const resolution = resolveOrganizationTransportPlan(config)
      assert.strictEqual(resolution.allowed, false)
      assert.ok(resolution.error?.includes('BAILEYS_RISK_NOT_ACKNOWLEDGED'))
    })

    it('Baileys se autoriza ÚNICAMENTE cuando la organización acepta explícitamente el riesgo', () => {
      const config: OrganizationPlanConfig = {
        organizationId: 'org_basic_2',
        plan: 'basic',
        preferredTransport: 'baileys',
        baileysRiskAcknowledged: true,
      }
      const resolution = resolveOrganizationTransportPlan(config)
      assert.strictEqual(resolution.allowed, true)
      assert.strictEqual(resolution.selectedTransport, 'baileys')
      assert.ok(resolution.warning?.includes('ALTO RIESGO'))
    })
  })

  describe('1.2 Ventana de 24 horas y plantillas aprobadas', () => {
    const db = createDatabase(':memory:')
    const windowStore = new MessagingWindowStore(db)
    const templateRegistry = new TemplateRegistry(db)

    const orgId = 'org_test_window'
    const contactPhone = '573001234567'

    it('Sin interacción entrante previa, está FUERA de la ventana de 24h', () => {
      const isInside = windowStore.isInside24hWindow(orgId, contactPhone)
      assert.strictEqual(isInside, false)
    })

    it('Un mensaje entrante abre la ventana de 24 horas', () => {
      windowStore.recordCustomerInbound(orgId, contactPhone, Date.now())
      assert.strictEqual(windowStore.isInside24hWindow(orgId, contactPhone), true)
    })

    it('Una interacción de hace 25 horas está FUERA de la ventana de 24h', () => {
      const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000
      windowStore.recordCustomerInbound(orgId, '573009999999', twentyFiveHoursAgo)
      assert.strictEqual(windowStore.isInside24hWindow(orgId, '573009999999'), false)
    })

    it('Fuera de la ventana, una plantilla APROBADA es permitida', () => {
      const tpl: MetaTemplate = {
        id: 'tpl_bienvenida_01',
        organizationId: orgId,
        name: 'bienvenida_cliente',
        language: 'es',
        category: 'UTILITY',
        status: 'APPROVED',
        body: 'Hola {{1}}, tu pedido está en camino.',
      }
      templateRegistry.registerTemplate(tpl)
      const check = templateRegistry.isTemplateApproved(orgId, 'bienvenida_cliente')
      assert.strictEqual(check.approved, true)
      assert.strictEqual(check.status, 'APPROVED')
    })

    it('Fuera de la ventana, una plantilla RECHAZADA o PENDIENTE queda bloqueada', () => {
      templateRegistry.registerTemplate({
        id: 'tpl_promo_01',
        organizationId: orgId,
        name: 'promo_rechazada',
        language: 'es',
        category: 'MARKETING',
        status: 'REJECTED',
        body: 'Descuento del 90% hoy.',
      })
      const checkRejected = templateRegistry.isTemplateApproved(orgId, 'promo_rechazada')
      assert.strictEqual(checkRejected.approved, false)
      assert.strictEqual(checkRejected.status, 'REJECTED')

      templateRegistry.registerTemplate({
        id: 'tpl_promo_02',
        organizationId: orgId,
        name: 'promo_pendiente',
        language: 'es',
        category: 'MARKETING',
        status: 'PENDING',
        body: 'Descuento pendiente de revisión.',
      })
      const checkPending = templateRegistry.isTemplateApproved(orgId, 'promo_pendiente')
      assert.strictEqual(checkPending.approved, false)
      assert.strictEqual(checkPending.status, 'PENDING')
    })
  })

  describe('1.3 Clasificación explícita de errores de Meta (sin reintentos ciegos)', () => {
    it('Error de límites (código 131048 / 130429) mapea a META_RATE_LIMIT_EXCEEDED sin reintento', () => {
      const graphError = {
        error: {
          message: 'Rate limit hit',
          type: 'OAuthException',
          code: 131048,
          error_subcode: 131048,
          fbtrace_id: 'abc123xyz',
        },
      }
      const classified = classifyMetaError(400, graphError)
      assert.strictEqual(classified.state, 'META_RATE_LIMIT_EXCEEDED')
      assert.strictEqual(classified.retryable, false)
      assert.strictEqual(classified.uncertain, false)
    })

    it('Error de calidad de número (código 131049) mapea a META_NUMBER_QUALITY_DEGRADED sin reintento', () => {
      const graphError = {
        error: {
          message: 'Phone number quality degraded',
          type: 'OAuthException',
          code: 131049,
          error_subcode: 131049,
          fbtrace_id: 'trace_qual',
        },
      }
      const classified = classifyMetaError(400, graphError)
      assert.strictEqual(classified.state, 'META_NUMBER_QUALITY_DEGRADED')
      assert.strictEqual(classified.retryable, false)
      assert.strictEqual(classified.uncertain, false)
    })

    it('Error de plantilla rechazada (código 132000) mapea a META_TEMPLATE_REJECTED sin reintento', () => {
      const graphError = {
        error: {
          message: 'Template does not exist or rejected',
          type: 'OAuthException',
          code: 132000,
          error_subcode: 132000,
          fbtrace_id: 'trace_tpl',
        },
      }
      const classified = classifyMetaError(400, graphError)
      assert.strictEqual(classified.state, 'META_TEMPLATE_REJECTED')
      assert.strictEqual(classified.retryable, false)
      assert.strictEqual(classified.uncertain, false)
    })

    it('Error de ventana de 24h expirada (código 131047) mapea a META_WINDOW_EXPIRED', () => {
      const graphError = {
        error: {
          message: 'More than 24 hours have passed since last reply',
          type: 'OAuthException',
          code: 131047,
          error_subcode: 131047,
        },
      }
      const classified = classifyMetaError(400, graphError)
      assert.strictEqual(classified.state, 'META_WINDOW_EXPIRED')
      assert.strictEqual(classified.retryable, false)
    })
  })

  describe('1.4 Servidor Meta simulado local (Mock Meta Server)', () => {
    let mockServer: ReturnType<typeof createMockMetaServer>
    let baseUrl: string

    before(async () => {
      mockServer = createMockMetaServer()
      const port = await mockServer.start()
      baseUrl = `http://localhost:${port}`
    })

    after(async () => {
      await mockServer.stop()
    })

    it('Mock Meta Server responde con messageId ante mensaje válido', async () => {
      const res = await fetch(`${baseUrl}/v21.0/123456789/messages`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid_meta_token_123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: '573001234567',
          type: 'text',
          text: { body: 'Hola prueba' },
        }),
      })
      assert.strictEqual(res.status, 200)
      const data = await res.json()
      assert.ok(data.messages?.[0]?.id.startsWith('wamid.'))
    })

    it('Mock Meta Server simula y rechaza envío con código de error de rate limit', async () => {
      mockServer.simulateNextError({
        status: 400,
        code: 131048,
        message: 'Spam rate limit hit for phone number',
      })
      const res = await fetch(`${baseUrl}/v21.0/123456789/messages`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid_meta_token_123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: '573001234567',
          type: 'text',
          text: { body: 'Hola spam' },
        }),
      })
      assert.strictEqual(res.status, 400)
      const data = await res.json()
      assert.strictEqual(data.error.code, 131048)
      const classified = classifyMetaError(res.status, data)
      assert.strictEqual(classified.state, 'META_RATE_LIMIT_EXCEEDED')
    })
  })
})
