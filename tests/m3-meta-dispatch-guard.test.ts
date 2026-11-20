import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideMetaDispatch } from '../src/safety/meta-dispatch-guard.mjs'

/**
 * Kit M3 (WP+ULTRA) — guard de despacho real por Meta: ventana 24 h, plantillas
 * y clasificador ANTES de la Graph API (rechazos 131047/131048 evitados).
 */
describe('kit M3 — meta-dispatch-guard', () => {
  const NOW = Date.parse('2026-11-20T12:00:00.000Z')
  const IN_WINDOW = NOW - 12 * 60 * 60 * 1000 // 12 h atrás
  const OUT_OF_WINDOW = NOW - 30 * 60 * 60 * 1000 // 30 h atrás

  it('plantilla APPROVED → send (las plantillas no dependen de la ventana)', () => {
    assert.deepEqual(decideMetaDispatch({ templateName: 'recordatorio_cita' }, { templateStatus: 'APPROVED', nowMs: NOW }), { decision: 'send' })
    assert.deepEqual(decideMetaDispatch({ templateName: 'promo' }, { templateStatus: 'APPROVED', lastInboundAt: new Date(OUT_OF_WINDOW), nowMs: NOW }), { decision: 'send' })
  })

  it('plantilla PENDING/REJECTED → skip template_not_approved; PAUSED → skip template_paused', () => {
    assert.deepEqual(decideMetaDispatch({ templateName: 'x' }, { templateStatus: 'PENDING', nowMs: NOW }), { decision: 'skip', reason: 'template_not_approved' })
    assert.deepEqual(decideMetaDispatch({ templateName: 'x' }, { templateStatus: 'REJECTED', nowMs: NOW }), { decision: 'skip', reason: 'template_not_approved' })
    assert.deepEqual(decideMetaDispatch({ templateName: 'x' }, { templateStatus: 'PAUSED', nowMs: NOW }), { decision: 'skip', reason: 'template_paused' })
    assert.deepEqual(decideMetaDispatch({ templateName: 'x' }, { templateStatus: null, nowMs: NOW }), { decision: 'skip', reason: 'template_not_approved' })
  })

  it('texto libre dentro de la ventana 24 h → send', () => {
    assert.deepEqual(decideMetaDispatch({ text: '¿en qué puedo ayudar?' }, { lastInboundAt: new Date(IN_WINDOW), nowMs: NOW }), { decision: 'send' })
    assert.deepEqual(decideMetaDispatch({ text: 'hola' }, { lastInboundAt: new Date(NOW - 24 * 60 * 60 * 1000), nowMs: NOW }), { decision: 'send' })
  })

  it('texto libre fuera de ventana → skip window_24h (jamás se inventa plantilla)', () => {
    assert.deepEqual(decideMetaDispatch({ text: 'seguimiento' }, { lastInboundAt: new Date(OUT_OF_WINDOW), nowMs: NOW }), { decision: 'skip', reason: 'window_24h' })
  })

  it('fail-closed: sin registro de último entrante → skip no_inbound_24h', () => {
    assert.deepEqual(decideMetaDispatch({ text: 'hola' }, { lastInboundAt: null, nowMs: NOW }), { decision: 'skip', reason: 'no_inbound_24h' })
    assert.deepEqual(decideMetaDispatch({ text: 'hola' }, { nowMs: NOW }), { decision: 'skip', reason: 'no_inbound_24h' })
    assert.deepEqual(decideMetaDispatch({ text: 'hola' }, { lastInboundAt: new Date('fecha-invalida'), nowMs: NOW }), { decision: 'skip', reason: 'no_inbound_24h' })
  })
})
