import { createHash, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/**
 * B3 — IDENTIDAD DE SERVICIO POR ORGANIZACIÓN (Capa 2A).
 *
 * Problema reproducido: los endpoints de integración 2A↔2B
 * (/api/internal/locks, /api/internal/suppression) autorizaban con el secreto
 * GLOBAL (INTERNAL_API_SECRET) y tomaban la organización del header x-org-id
 * del llamador: un solo secreto compartido sustituía la validación de
 * organización — cualquiera con ese secreto podía leer/escribir el estado de
 * CUALQUIER organización (acceso cruzado).
 *
 * Contrato nuevo (fail-closed):
 *  - Cada organización tiene CREDENCIALES DE SERVICIO propias, registradas
 *    (hash SHA-256) en service_credentials.
 *  - Las peticiones de servicio deben traer X-Org-Id + Bearer <credencial de
 *    ESA organización>. La credencial se valida CONTRA ESA organización.
 *  - El secreto global YA NO autoriza estas rutas (fallback eliminado).
 *  - Sin credencial registrada para la org, sin Bearer, con credencial
 *    inválida o de OTRA organización → rechazo (401/403), jamás permisivo.
 *  - Nunca se registran ni loguean valores de credenciales (solo hashes).
 */

/** Hash determinista de la credencial (solo el hash vive en la BD). */
/**
 * Espacio RESERVADO para datos históricos sin atribución (reparación integral §4):
 * ninguna organización real puede llamarse '__legacy__' ni operar como tal.
 * Todas las vías de identidad/autorización lo RECHAZAN (fail-safe).
 */
export const FORBIDDEN_LEGACY_ORG = '__legacy__'

/** True si el orgId está prohibido como organización operable (espacio legacy). */
export function isForbiddenLegacyOrg(orgId: string | null | undefined): boolean {
  return typeof orgId === 'string' && orgId.trim() === FORBIDDEN_LEGACY_ORG
}

export function hashOrgCredential(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex')
}

/** Registra (idempotente) una credencial de servicio para una organización. */
export function registerOrgServiceCredential(db: DatabaseSync, orgId: string, credential: string, label?: string): void {
  if (isForbiddenLegacyOrg(orgId)) throw new Error('registerOrgServiceCredential: la organización reservada __legacy__ no admite credenciales (§4)')
  if (!orgId || typeof orgId !== 'string') throw new Error('registerOrgServiceCredential: orgId obligatorio')
  if (!credential || typeof credential !== 'string' || credential.length < 16) {
    throw new Error('registerOrgServiceCredential: credencial obligatoria (≥16 caracteres)')
  }
  db.prepare(`
    INSERT INTO service_credentials (org_id, credential_hash, label, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(org_id, credential_hash) DO NOTHING
  `).run(orgId, hashOrgCredential(credential), label ?? null, Math.floor(Date.now() / 1000))
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * Verifica la credencial de servicio presentada CONTRA la organización
 * declarada. Fail-closed: sin org, sin credencial, sin credenciales
 * registradas para esa org, o credencial de otra organización → false.
 * Comparación timing-safe sobre hashes.
 */
export function verifyOrgServiceCredential(db: DatabaseSync, orgId: string, presented: string | null | undefined): boolean {
  if (isForbiddenLegacyOrg(orgId)) return false // §4: fail-safe, jamás operable
  if (!orgId || typeof orgId !== 'string' || !presented || typeof presented !== 'string') return false
  const rows = db.prepare('SELECT credential_hash FROM service_credentials WHERE org_id = ?').all(orgId) as Array<{ credential_hash: string }>
  if (rows.length === 0) return false // sin credenciales registradas → el secreto global NO sustituye
  const presentedHash = hashOrgCredential(presented)
  return rows.some((r) => safeEqualHex(r.credential_hash, presentedHash))
}

/** Extrae la identidad de servicio de la petición: { orgId, credential } o null. */
export function extractOrgServiceAuth(headers: Record<string, string | string[] | undefined>): { orgId: string; credential: string } | null {
  const orgId = String(Array.isArray(headers['x-org-id']) ? headers['x-org-id'][0] : headers['x-org-id'] || '').trim()
  const auth = Array.isArray(headers['authorization']) ? headers['authorization'][0] : headers['authorization'] || ''
  const match = /^Bearer\s+(.+)$/i.exec(String(auth).trim())
  const credential = match?.[1]?.trim() || ''
  if (!orgId || !credential) return null
  return { orgId, credential }
}

/**
 * B2 (hardening de reconciliación): una clave de idempotencia `orgId::eventId`
 * pertenece a la organización que la emitió (formato construido por el router:
 * `${orgId}::${eventId}`, con orgId validado SIN ':'). Fail-closed: claves
 * malformadas (sin separador) o vacías → false.
 */
export function idempotencyKeyBelongsToOrg(key: string, orgId: string): boolean {
  if (!key || !orgId || typeof key !== 'string' || typeof orgId !== 'string') return false
  const sep = key.indexOf('::')
  if (sep <= 0) return false
  return key.slice(0, sep) === orgId
}

/**
 * Provisión por entorno (operación sin BD manual): ORG_SERVICE_CREDENTIALS con
 * formato "orgId:credencial,orgId2:credencial2". Los valores NUNCA se loguean;
 * en el arranque se registran solo sus hashes.
 */
export function provisionOrgServiceCredentialsFromEnv(db: DatabaseSync, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORG_SERVICE_CREDENTIALS || ''
  if (!raw.trim()) return 0
  let count = 0
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':')
    if (idx <= 0) continue
    const orgId = pair.slice(0, idx).trim()
    const credential = pair.slice(idx + 1).trim()
    if (!orgId || !credential) continue
    if (isForbiddenLegacyOrg(orgId)) {
      // §4: el espacio legacy no recibe credenciales (ni siquiera por env).
      console.warn('[org-auth] ORG_SERVICE_CREDENTIALS: entrada __legacy__ RECHAZADA (espacio histórico no operable)')
      continue
    }
    registerOrgServiceCredential(db, orgId, credential, 'provisioned-via-env')
    count++
  }
  return count
}
