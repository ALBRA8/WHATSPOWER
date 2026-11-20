/**
 * S7 (WP + ULTRA) — Credenciales por organización cifradas en reposo.
 *
 * Problema del plan: tokens Meta/credenciales en variables de entorno planas.
 * Solución: port fiel del cifrado v1 probado en el CRM (src/lib/crypto.ts):
 * AES-256-GCM con clave derivada (SHA-256) de una variable EXTERNA, formato
 * `v1:iv:tag:ciphertext`, migración de valores legacy en claro y lookup por
 * SHA-256 (A2-23) para índices sobre secretos cifrados.
 *
 * Uso:
 *   const enc = encryptOrgSecret(tokenMeta)            // guardar en BD
 *   const plain = decryptOrgSecret(enc)                // usar al despachar
 *   migrateOrgSecret(row.tokenEnc)                     // migrar legacy → v1
 *   const h = sha256HexOrg(plain)                      // índice de lookup
 *
 * La clave NUNCA vive en la BD ni en el repo: llega por entorno
 * (CRM_ENCRYPTION_KEY o CRM_APP_SECRET, `openssl rand -hex 32`).
 * Sin clave: lanza (fail-closed), jamás inventa clave.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export class OrgCryptoError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OrgCryptoError'
  }
}

function getKey() {
  const raw = process.env.CRM_ENCRYPTION_KEY || process.env.CRM_APP_SECRET
  if (!raw) {
    throw new OrgCryptoError('[org-crypto] CRM_ENCRYPTION_KEY o CRM_APP_SECRET no configurados (`openssl rand -hex 32`)')
  }
  return createHash('sha256').update(raw).digest()
}

export function encryptOrgSecret(plain) {
  if (!plain) return null
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

export function decryptOrgSecret(payload) {
  if (!payload) return null
  try {
    if (!payload.startsWith('v1:')) return payload // valor plano legacy (migrar)
    const [, ivB64, tagB64, dataB64] = payload.split(':')
    const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    // Ciphertext adulterado o clave distinta → null (fail-closed); el llamador decide.
    return null
  }
}

export function sha256HexOrg(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

export function isLegacyPlaintextOrg(payload) {
  if (!payload || typeof payload !== 'string' || payload.trim() === '') return false
  return !payload.startsWith('v1:')
}

export function migrateOrgSecret(payload) {
  if (!payload) return { isLegacy: false, encrypted: null, plain: null }
  if (payload.startsWith('v1:')) {
    return { isLegacy: false, encrypted: payload, plain: decryptOrgSecret(payload) }
  }
  return { isLegacy: true, encrypted: encryptOrgSecret(payload), plain: payload }
}

/** Comparación timing-safe para verify tokens / credenciales descifradas. */
export function safeEqualsOrg(provided, expected) {
  if (!provided || !expected) return false
  const a = Buffer.from(String(provided))
  const b = Buffer.from(String(expected))
  return a.length === b.length && timingSafeEqual(a, b)
}
