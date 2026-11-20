import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  encryptOrgSecret,
  decryptOrgSecret,
  sha256HexOrg,
  isLegacyPlaintextOrg,
  migrateOrgSecret,
  safeEqualsOrg,
  OrgCryptoError,
} from '../src/security/org-credentials-crypto.mjs'

/**
 * Kit S7 (WP+ULTRA) — credenciales por organización cifradas en reposo.
 * Port del formato v1 AES-256-GCM del CRM: roundtrip, detección de tamper,
 * fail-closed sin clave y migración legacy idempotente.
 */
describe('kit S7 — org-credentials-crypto', () => {
  const KEY = 'a'.repeat(64) // hex 32 bytes tras SHA-256
  afterEach(() => {
    delete process.env.CRM_ENCRYPTION_KEY
    delete process.env.CRM_APP_SECRET
  })

  it('roundtrip: cifra y descifra el token Meta de la org', () => {
    process.env.CRM_ENCRYPTION_KEY = KEY
    const enc = encryptOrgSecret('EAAG-meta-token-secreto')
    assert.match(enc, /^v1:/)
    assert.equal(decryptOrgSecret(enc), 'EAAG-meta-token-secreto')
  })

  it('cada cifrado usa IV aleatorio (dos cifrados del mismo valor difieren)', () => {
    process.env.CRM_ENCRYPTION_KEY = KEY
    const a = encryptOrgSecret('mismo-valor')
    const b = encryptOrgSecret('mismo-valor')
    assert.notEqual(a, b)
    assert.equal(decryptOrgSecret(a), decryptOrgSecret(b))
  })

  it('tamper del ciphertext → null (GCM detecta alteración, fail-closed)', () => {
    process.env.CRM_ENCRYPTION_KEY = KEY
    const enc = encryptOrgSecret('token-real') as string
    const parts = enc.split(':')
    const data = Buffer.from(parts[3], 'base64')
    data[0] = data[0] ^ 0xff
    const tampered = [parts[0], parts[1], parts[2], Buffer.from(data).toString('base64')].join(':')
    assert.equal(decryptOrgSecret(tampered), null)
  })

  it('clave distinta → null (jamás devuelve basura)', () => {
    process.env.CRM_ENCRYPTION_KEY = KEY
    const enc = encryptOrgSecret('token-real')
    process.env.CRM_ENCRYPTION_KEY = 'b'.repeat(64)
    assert.equal(decryptOrgSecret(enc), null)
  })

  it('sin clave configurada → error tipado (fail-closed, jamás clave inventada)', () => {
    assert.throws(() => encryptOrgSecret('x'), OrgCryptoError)
  })

  it('migración legacy: plano → v1, ya cifrado → intacto, nulo → no-op', () => {
    process.env.CRM_ENCRYPTION_KEY = KEY
    const legacy = migrateOrgSecret('token-plano-antiguo')
    assert.equal(legacy.isLegacy, true)
    assert.match(legacy.encrypted, /^v1:/)
    assert.equal(decryptOrgSecret(legacy.encrypted), 'token-plano-antiguo')

    const already = migrateOrgSecret(legacy.encrypted)
    assert.equal(already.isLegacy, false)
    assert.equal(already.encrypted, legacy.encrypted)

    assert.deepEqual(migrateOrgSecret(null), { isLegacy: false, encrypted: null, plain: null })
    assert.equal(isLegacyPlaintextOrg('token-plano'), true)
    assert.equal(isLegacyPlaintextOrg(legacy.encrypted), false)
  })

  it('hash de lookup + comparación timing-safe', () => {
    const h1 = sha256HexOrg('cred-org-a')
    assert.match(h1, /^[0-9a-f]{64}$/)
    assert.equal(sha256HexOrg('cred-org-a'), h1)
    assert.equal(safeEqualsOrg('cred-org-a', 'cred-org-a'), true)
    assert.equal(safeEqualsOrg('cred-org-a', 'cred-org-b'), false)
    assert.equal(safeEqualsOrg('', 'cred-org-a'), false)
  })
})
