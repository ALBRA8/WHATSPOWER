import { test } from 'node:test'
import assert from 'node:assert'
import { FlowEngine } from '../src/engine/flow-engine.ts'
import { createDatabase } from '../src/db.ts'
import type { FlowDefinition, SequenceDefinition } from '../src/engine/flow-types.ts'

test('SUITE EXHAUSTIVA: WhatsPower como Clon 100% ManyChat', async (t) => {
  const db = createDatabase(':memory:')
  const engine = new FlowEngine(db)

  // -------------------------------------------------------------
  // MC-01: Sistema de Etiquetas (Tags)
  // -------------------------------------------------------------
  await t.test('MC-01: Gestión completa de Tags por contacto', () => {
    const phone = '+573001112233'
    assert.strictEqual(engine.hasTag(phone, 'vip'), false)

    engine.addTag(phone, 'vip')
    engine.addTag(phone, 'comprador')
    assert.strictEqual(engine.hasTag(phone, 'vip'), true)
    assert.strictEqual(engine.hasTag(phone, 'comprador'), true)
    assert.deepStrictEqual(engine.getTags(phone).sort(), ['comprador', 'vip'])

    engine.removeTag(phone, 'vip')
    assert.strictEqual(engine.hasTag(phone, 'vip'), false)
    assert.strictEqual(engine.hasTag(phone, 'comprador'), true)
  })

  // -------------------------------------------------------------
  // MC-02: Campos Personalizados (Custom Fields)
  // -------------------------------------------------------------
  await t.test('MC-02: Gestión de Custom Fields (Atributos de Contacto)', () => {
    const phone = '+573001112233'
    engine.setCustomField(phone, 'email', 'cliente@empresa.com')
    engine.setCustomField(phone, 'presupuesto', '1500')

    assert.strictEqual(engine.getCustomField(phone, 'email'), 'cliente@empresa.com')
    assert.strictEqual(engine.getCustomField(phone, 'presupuesto'), '1500')

    const all = engine.getAllCustomFields(phone)
    assert.strictEqual(all.email, 'cliente@empresa.com')
    assert.strictEqual(all.presupuesto, '1500')
  })

  // -------------------------------------------------------------
  // MC-03: User Input (Captura interactiva de respuestas)
  // -------------------------------------------------------------
  await t.test('MC-03: Nodo User Input captura respuesta y la guarda en Custom Field', async () => {
    const phone = '+573004445566'
    const inputFlow: FlowDefinition = {
      id: 'flow_capture_lead',
      name: 'Flujo de Captura de Correo',
      triggerKeywords: ['registro', 'inscribirme'],
      isActive: true,
      nodes: [
        { id: 't1', type: 'trigger', title: 'Trigger', data: { keywords: ['registro'] } },
        { id: 'inp1', type: 'user_input', title: 'Captura Email', data: { inputPrompt: '¿Cuál es tu correo para enviarte el brochure?', saveToCustomField: 'email' } },
        { id: 'msg1', type: 'send_message', title: 'Confirmación', data: { messageText: '¡Gracias! Hemos registrado tu correo: {{email}}.' } },
      ],
      edges: [
        { id: 'e1', source: 't1', target: 'inp1' },
        { id: 'e2', source: 'inp1', target: 'msg1' },
      ],
    }
    engine.saveFlow(inputFlow)

    // Paso 1: Contacto escribe "registro" -> Recibe el prompt de captura
    const step1 = await engine.evaluateStep(phone, 'quiero mi registro')
    assert.strictEqual(step1.handled, true)
    assert.ok(step1.messagesToSend[0].text.includes('¿Cuál es tu correo'))

    // Verificar que la sesión está esperando input para 'email'
    const sess = engine.getSession(phone)
    assert.ok(sess)
    assert.strictEqual(sess.waitingForInput, true)
    assert.strictEqual(sess.inputTargetField, 'email')

    // Paso 2: Contacto responde con su correo
    const step2 = await engine.evaluateStep(phone, 'juan@perez.com')
    assert.strictEqual(step2.handled, true)
    assert.ok(step2.messagesToSend[0].text.includes('juan@perez.com'))

    // Verificar que quedó guardado en el almacenamiento permanente de Custom Fields
    assert.strictEqual(engine.getCustomField(phone, 'email'), 'juan@perez.com')
  })

  // -------------------------------------------------------------
  // MC-04: Bifurcación Condicional (Condition Node)
  // -------------------------------------------------------------
  await t.test('MC-04: Nodo Condición bifurca según etiquetas del contacto', async () => {
    const phoneVip = '+573007778899'
    const phoneRegular = '+573000001122'
    engine.addTag(phoneVip, 'cliente_vip')

    const conditionFlow: FlowDefinition = {
      id: 'flow_vip_check',
      name: 'Verificación VIP',
      triggerKeywords: ['promocion', 'descuento'],
      isActive: true,
      nodes: [
        { id: 't1', type: 'trigger', title: 'Trigger', data: { keywords: ['promocion'] } },
        {
          id: 'c1',
          type: 'condition',
          title: '¿Es VIP?',
          data: {
            rules: [{ type: 'has_tag', value: 'cliente_vip' }],
          },
        },
        { id: 'mVip', type: 'send_message', title: 'Oferta VIP', data: { messageText: '🎉 Tienes un 30% de descuento exclusivo por ser VIP.' } },
        { id: 'mReg', type: 'send_message', title: 'Oferta Estándar', data: { messageText: '🏷️ Tienes un 10% de descuento en tu primera compra.' } },
      ],
      edges: [
        { id: 'e1', source: 't1', target: 'c1' },
        { id: 'eYes', source: 'c1', target: 'mVip', sourceHandle: 'yes' },
        { id: 'eNo', source: 'c1', target: 'mReg', sourceHandle: 'no' },
      ],
    }
    engine.saveFlow(conditionFlow)

    // Cliente VIP recibe 30%
    const resVip = await engine.evaluateStep(phoneVip, 'quiero una promocion')
    assert.strictEqual(resVip.handled, true)
    assert.ok(resVip.messagesToSend[0].text.includes('30% de descuento exclusivo'))

    // Cliente regular recibe 10%
    const resReg = await engine.evaluateStep(phoneRegular, 'quiero una promocion')
    assert.strictEqual(resReg.handled, true)
    assert.ok(resReg.messagesToSend[0].text.includes('10% de descuento'))
  })

  // -------------------------------------------------------------
  // MC-05: Acciones ManyChat (Add Tag, Remove Tag, Webhook)
  // -------------------------------------------------------------
  await t.test('MC-05: Nodo Acción ejecuta etiquetado y prepara Webhook', async () => {
    const phone = '+573008889900'
    const actionFlow: FlowDefinition = {
      id: 'flow_auto_tag',
      name: 'Flujo de Auto Tag y Webhook',
      triggerKeywords: ['comprar'],
      isActive: true,
      nodes: [
        { id: 't1', type: 'trigger', title: 'Trigger', data: { keywords: ['comprar'] } },
        { id: 'act1', type: 'action', title: 'Tag Interesado', data: { actionType: 'add_tag', tag: 'intencion_compra' } },
        {
          id: 'act2',
          type: 'action',
          title: 'Webhook Notificar',
          data: { actionType: 'http_webhook', webhookUrl: 'https://mi-servidor.com/webhook/compra' },
        },
        { id: 'msg1', type: 'send_message', title: 'Aviso', data: { messageText: 'Pedido iniciado.' } },
      ],
      edges: [
        { id: 'e1', source: 't1', target: 'act1' },
        { id: 'e2', source: 'act1', target: 'act2' },
        { id: 'e3', source: 'act2', target: 'msg1' },
      ],
    }
    engine.saveFlow(actionFlow)

    const res = await engine.evaluateStep(phone, 'quiero comprar ahora')
    assert.strictEqual(res.handled, true)
    assert.strictEqual(engine.hasTag(phone, 'intencion_compra'), true)
    assert.ok(res.webhookToCall)
    assert.strictEqual(res.webhookToCall.url, 'https://mi-servidor.com/webhook/compra')
    assert.ok(res.messagesToSend[0].text.includes('Pedido iniciado'))
  })

  // -------------------------------------------------------------
  // MC-06: Secuencias ManyChat (Drip Campaign / Goteo)
  // -------------------------------------------------------------
  await t.test('MC-06: Secuencia de goteo ManyChat e inscripción de contacto', () => {
    const seq: SequenceDefinition = {
      id: 'seq_onboarding_7dias',
      name: 'Secuencia Onboarding 3 Días',
      isActive: true,
      steps: [
        { id: 's1', stepOrder: 1, delayMinutes: 0, messageText: '¡Bienvenido a bordo! Paso 1 para configurar tu cuenta.' },
        { id: 's2', stepOrder: 2, delayMinutes: 1440, messageText: 'Día 2: ¿Pudiste vincular tu WhatsApp?' },
        { id: 's3', stepOrder: 3, delayMinutes: 2880, messageText: 'Día 3: Agenda tu llamada con un asesor comercial.' },
      ],
    }

    engine.saveSequence(seq)
    const phone = '+573112233445'
    engine.enrollContactInSequence(phone, seq.id)

    // Cancelar si compra o pide baja
    engine.cancelSequenceEnrollment(phone, seq.id)
  })

  // -------------------------------------------------------------
  // MC-07: A/B Split Testing
  // -------------------------------------------------------------
  await t.test('MC-07: A/B Split Testing divide tráfico por probabilidad', async () => {
    const abFlow: FlowDefinition = {
      id: 'flow_ab_test',
      name: 'Experimento A/B',
      triggerKeywords: ['testab'],
      isActive: true,
      nodes: [
        { id: 't1', type: 'trigger', title: 'Trigger', data: { keywords: ['testab'] } },
        { id: 'split1', type: 'ab_split', title: 'A/B Split 100/0', data: { splitRatio: 100 } }, // Forzar Camino A para test determinista
        { id: 'mA', type: 'send_message', title: 'Variante A', data: { messageText: 'Variante A triunfadora' } },
        { id: 'mB', type: 'send_message', title: 'Variante B', data: { messageText: 'Variante B' } },
      ],
      edges: [
        { id: 'e1', source: 't1', target: 'split1' },
        { id: 'ea', source: 'split1', target: 'mA', sourceHandle: 'a' },
        { id: 'eb', source: 'split1', target: 'mB', sourceHandle: 'b' },
      ],
    }
    engine.saveFlow(abFlow)

    const res = await engine.evaluateStep('+573005556677', 'testab')
    assert.strictEqual(res.handled, true)
    assert.ok(res.messagesToSend[0].text.includes('Variante A'))
  })
})
