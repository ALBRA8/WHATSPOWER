import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { requireOrgServiceCredentials, OrgServiceCredentialsError } from '../src/security/org-bearer-auth.mjs'

/**
 * Kit S3 (WP) — Bearer por organización, fin del secreto operador global.
 * La org se deduce de la CREDENCIAL que matchea (jamás de un header creíble).
 */
describe('kit S3 — org-bearer-auth', () => {
  const CREDS = JSON.stringify({ 'org-a': 'credencial-org-a-0123456789abcdef', 'org-b': 'credencial-org-b-fedcba9876543210' })

  it('config ausente o inválida → error tipado (fail-closed)', () => {
    assert.throws(() => requireOrgServiceCredentials(undefined), OrgServiceCredentialsError)
    assert.throws(() => requireOrgServiceCredentials('no-es-json'), OrgServiceCredentialsError)
    assert.throws(() => requireOrgServiceCredentials('[]'), OrgServiceCredentialsError)
    assert.throws(() => requireOrgServiceCredentials('{"org-a":"corta"}'), OrgServiceCredentialsError)
  })

  it('autentica y deduce la org desde la credencial presentada', () => {
    const auth = requireOrgServiceCredentials(CREDS)
    assert.deepEqual(auth.authenticate('credencial-org-a-0123456789abcdef'), { orgId: 'org-a' })
    assert.deepEqual(auth.authenticate('credencial-org-b-fedcba9876543210'), { orgId: 'org-b' })
    assert.equal(auth.orgCount(), 2)
  })

  it('credencial inválida o vacía → null (sin revelar orgs existentes)', () => {
    const auth = requireOrgServiceCredentials(CREDS)
    assert.equal(auth.authenticate('otra-credencial-aleatoria-xyz'), null)
    assert.equal(auth.authenticate(''), null)
    assert.equal(auth.authenticate(undefined), null)
  })

  it('authorizeOrg: el pedido de otra org se rechaza (403 esperado en el handler)', () => {
    const auth = requireOrgServiceCredentials(CREDS)
    const res = auth.authenticate('credencial-org-a-0123456789abcdef')
    assert.equal(auth.authorizeOrg(res, 'org-a'), true)
    assert.equal(auth.authorizeOrg(res, 'org-b'), false)
    assert.equal(auth.authorizeOrg(null, 'org-a'), false)
  })

  it('cross-org: el Bearer de org-a jamás autoriza operaciones de org-b', () => {
    const auth = requireOrgServiceCredentials(CREDS)
    const res = auth.authenticate('credencial-org-a-0123456789abcdef')
    assert.equal(auth.authorizeOrg(res, 'org-b'), false)
  })
})
