import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTransportPolicy, TransportPolicyError, TRANSPORTS } from '../src/safety/transport-policy.mjs'

/**
 * Kit I6 (WP+ULTRA) — transporte por política por organización, fin de la
 * variable global TRANSPORT. Fail-closed: mala config → error tipado.
 */
describe('kit I6 — transport-policy', () => {
  it('política explícita por org gana sobre el default', () => {
    const policy = createTransportPolicy(JSON.stringify({ 'org-a': 'cloud_api', 'org-b': 'baileys', '*': 'baileys' }))
    assert.deepEqual(policy.resolve('org-a'), { transport: 'cloud_api', source: 'org_policy' })
    assert.deepEqual(policy.resolve('org-b'), { transport: 'baileys', source: 'org_policy' })
    assert.deepEqual(policy.resolve('org-desconocida'), { transport: 'baileys', source: 'default' })
  })

  it('org sin entrada y sin "*" → error (jamás caer a la global)', () => {
    const policy = createTransportPolicy(JSON.stringify({ 'org-a': 'cloud_api' }))
    assert.throws(() => policy.resolve('org-b'), TransportPolicyError)
  })

  it('fail-closed en carga: valor desconocido o JSON inválido → error tipado', () => {
    assert.throws(() => createTransportPolicy(JSON.stringify({ 'org-a': 'sms' })), /transporte desconocido "sms"/)
    assert.throws(() => createTransportPolicy('{no-json'), /no es JSON válido/)
    assert.throws(() => createTransportPolicy('[1,2]'), /debe ser un objeto/)
    assert.throws(() => createTransportPolicy('', { requireExplicit: true }), /no configurado/)
  })

  it('orgId vacío → error (jamás una variable global implícita)', () => {
    const policy = createTransportPolicy(JSON.stringify({ '*': 'baileys' }))
    assert.throws(() => policy.resolve(''), /orgId requerido/)
  })

  it('los transportes válidos son los del ecosistema', () => {
    assert.deepEqual(TRANSPORTS, ['cloud_api', 'baileys'])
  })
})
