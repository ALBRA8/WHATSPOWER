import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createAgenticServer } from '../src/server.ts'

describe('SUITE SUPERPODERES NIVEL 2: WHATSPOWER (ManyChat + Respond.io + Kommo)', () => {
  it('SP2-01: Team Manager asigna asesores por Round-Robin y Balanceo de Carga', () => {
    const { teamManager } = createAgenticServer({ dbPath: ':memory:' })

    // Registrar 3 agentes
    teamManager.registerAgent({ id: 'ag_1', name: 'Laura Asesora', email: 'laura@albra.co' })
    teamManager.registerAgent({ id: 'ag_2', name: 'Carlos Ventas', email: 'carlos@albra.co' })
    teamManager.registerAgent({ id: 'ag_3', name: 'Sofia Closer', email: 'sofia@albra.co' })

    const active = teamManager.getActiveAgents()
    assert.strictEqual(active.length, 3)

    // Asignación 1 -> ag_1
    const a1 = teamManager.assignRoundRobin('573001110001')
    assert.strictEqual(a1?.id, 'ag_1')

    // Asignación 2 -> ag_2
    const a2 = teamManager.assignRoundRobin('573001110002')
    assert.strictEqual(a2?.id, 'ag_2')

    // Asignación 3 -> ag_3
    const a3 = teamManager.assignRoundRobin('573001110003')
    assert.strictEqual(a3?.id, 'ag_3')

    // Asignación 4 (Vuelve a empezar Round-Robin) -> ag_1
    const a4 = teamManager.assignRoundRobin('573001110004')
    assert.strictEqual(a4?.id, 'ag_1')

    // Contacto ya asignado devuelve el mismo asesor asignado (Sticky Assignment)
    const a1Repeat = teamManager.assignRoundRobin('573001110001')
    assert.strictEqual(a1Repeat?.id, 'ag_1')

    // Resolver conversación
    teamManager.resolveAssignment('573001110001')
    const checkResolved = teamManager.getAssignment('573001110001')
    assert.strictEqual(checkResolved?.status, 'RESOLVED')
  })

  it('SP2-02: Canned Responses permite registrar y expandir atajos con variables', () => {
    const { cannedManager } = createAgenticServer({ dbPath: ':memory:' })

    cannedManager.createResponse({
      shortcut: '/precio',
      title: 'Precios Planes 2026',
      content: 'Hola {{nombre}}, nuestro Plan Pro tiene un valor de $99/mes con {{garantia}} días de garantía.',
      category: 'ventas',
    })

    const found = cannedManager.findByShortcut('/precio')
    assert.ok(found)
    assert.strictEqual(found?.title, 'Precios Planes 2026')

    const expanded = cannedManager.expandSnippet(found!.content, {
      nombre: 'Andrés',
      garantia: '30',
    })

    assert.strictEqual(expanded, 'Hola Andrés, nuestro Plan Pro tiene un valor de $99/mes con 30 días de garantía.')
  })

  it('SP2-03: Growth Tools genera Ref URLs y resuelve payload al recibir mensaje', () => {
    const { growthManager } = createAgenticServer({ dbPath: ':memory:', businessPhone: '573017543786' })

    const link = growthManager.createGrowthLink({
      slug: 'promo-instagram',
      prefilledText: 'Hola, vi el reel de Instagram y quiero la promo',
      initialTag: 'lead_instagram',
    })

    assert.strictEqual(link.slug, 'promo-instagram')

    // Registrar clic
    const waLink = growthManager.registerClick('promo-instagram')
    assert.ok(waLink?.includes('https://wa.me/573017543786?text='))
    assert.ok(waLink?.includes('Instagram'))

    // Validar conteo de clics
    const refreshed = growthManager.getLinkBySlug('promo-instagram')
    assert.strictEqual(refreshed?.clicks, 1)

    // Detección automática al entrar el mensaje
    const match = growthManager.matchIncomingText('Hola, vi el reel de Instagram y quiero la promo')
    assert.ok(match)
    assert.strictEqual(match?.slug, 'promo-instagram')
    assert.strictEqual(match?.initialTag, 'lead_instagram')
  })

  it('SP2-04: CRM Stage Trigger reacciona a cambios de etapa en el Pipeline Kanban', async () => {
    const { crmTriggers, db } = createAgenticServer({ dbPath: ':memory:' })

    const res = await crmTriggers.handleStageChange({
      clientId: 'cl_100',
      clientPhone: '573005556677',
      clientName: 'Mariana Gómez',
      opportunityId: 'opp_50',
      fromStage: 'NUEVO',
      toStage: 'PROPUESTA_ENVIADA',
      dealValue: 1500000,
    })

    assert.strictEqual(res.triggered, true)
    assert.strictEqual(res.action, 'send_message')
    assert.ok(res.messageSent?.includes('Mariana Gómez'))
    assert.ok(res.messageSent?.includes('propuesta ya fue generada'))

    // Mensaje registrado en bandeja de salida
    const outboxMsg = db.prepare('SELECT * FROM inbox_messages WHERE contact_phone = ?').get('573005556677') as any
    assert.ok(outboxMsg)
    assert.strictEqual(outboxMsg.direction, 'outbound')
  })

  it('SP2-05: Payment Gateway genera links de cobro y procesa confirmación de webhook', () => {
    const { paymentManager, db } = createAgenticServer({ dbPath: ':memory:' })

    const tx = paymentManager.createPaymentLink({
      contactPhone: '573009998877',
      amount: 250000,
      currency: 'COP',
      description: 'Suscripción Plan Pro ALBRA',
      gateway: 'wompi',
    })

    assert.strictEqual(tx.status, 'PENDING')
    assert.ok(tx.paymentLink.includes('wompi.co'))
    assert.ok(tx.paymentLink.includes('amount-in-cents=25000000'))

    // Simular webhook de aprobación de pago
    const approvedTx = paymentManager.handlePaymentWebhook(tx.id, 'APPROVED')
    assert.strictEqual(approvedTx?.status, 'APPROVED')

    // Confirmar que el contacto fue etiquetado como CLIENTE_PAGADO
    const tagRow = db.prepare('SELECT * FROM contact_tags WHERE contact_phone = ? AND tag_name = ?').get('573009998877', 'CLIENTE_PAGADO')
    assert.ok(tagRow, 'El contacto debe tener la etiqueta CLIENTE_PAGADO')
  })
})
