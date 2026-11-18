/**
 * ecosystem-sso.ts — Contrato SSO del ecosistema ALBRA (2026-11-17).
 *
 * El CRM (capa 1) emite ENLACES de un solo uso para abrir las capas 2A/2B con
 * sesión de operador, sin debilitar las puertas endurecidas de cada servicio:
 *
 *   - Formato: `v1.<b64url(payload JSON)>.<b64url(HMAC-SHA256)>`
 *   - Payload: `{ scope:'studio-demo', jti, iat, exp }` — TTL de 90 segundos.
 *   - Receptor: EXIGE `ECOSYSTEM_SSO_SECRET` configurado (fail-closed: sin el
 *     secreto la ruta de canje NO existe → 404); verifica la firma en tiempo
 *     constante (`timingSafeEqual`), el scope, la expiración y la unicidad del
 *     `jti` (un solo canje por enlace).
 *   - NO es el login-demo anónimo: el token lo emite el CRM SOLO a una sesión
 *     autenticada (demo o real). Las reglas de `/studio/login` y del demo
 *     anónimo quedan intactas.
 *
 * El MISMO módulo (contrato idéntico) vive en los tres repositorios:
 * CRM-ALBRA (emisor), WHATSPOWER y WHATSPOWER-ULTRA (receptores).
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

export const ECOSYSTEM_SSO_SCOPE = 'studio-demo'
export const ECOSYSTEM_SSO_TTL_MS = 90_000
export const ECOSYSTEM_SSO_JTI_RETENTION_MS = 10 * 60_000

export interface EcosystemTokenPayload {
  scope: string
  jti: string
  iat: number
  exp: number
  orgId?: string
  role?: string
}

export function signEcosystemToken(
  secret: string,
  nowMs: number = Date.now(),
  ttlMs: number = ECOSYSTEM_SSO_TTL_MS,
  extra?: { orgId?: string; role?: string }
): string {
  if (!secret || secret.length < 16) {
    throw new Error('ECOSYSTEM_SSO_SECRET ausente o demasiado corto (mínimo 16 caracteres)')
  }
  const payload: EcosystemTokenPayload = {
    scope: ECOSYSTEM_SSO_SCOPE,
    jti: randomBytes(16).toString('hex'),
    iat: nowMs,
    exp: nowMs + ttlMs,
    ...(extra?.orgId ? { orgId: extra.orgId } : {}),
    ...(extra?.role ? { role: extra.role } : {}),
  }
  const body = `v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
  const mac = createHmac('sha256', secret).update(body).digest()
  return `${body}.${mac.toString('base64url')}`
}

export type EcosystemVerification =
  | { ok: true; payload: EcosystemTokenPayload }
  | { ok: false; reason: string }

export function verifyEcosystemToken(
  token: string,
  secret: string | undefined,
  nowMs: number = Date.now(),
  expectedOrgId?: string
): EcosystemVerification {
  if (!secret) return { ok: false, reason: 'ECOSYSTEM_SSO_SECRET no configurado (ruta deshabilitada)' }
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'formato inválido' }
  const [, payloadB64, macB64] = parts
  const expected = createHmac('sha256', secret).update(`v1.${payloadB64}`).digest()
  let given: Buffer
  try {
    given = Buffer.from(macB64, 'base64url')
  } catch {
    return { ok: false, reason: 'firma inválida' }
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'firma inválida' }
  }
  let payload: EcosystemTokenPayload
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as EcosystemTokenPayload
  } catch {
    return { ok: false, reason: 'payload inválido' }
  }
  if (!payload || payload.scope !== ECOSYSTEM_SSO_SCOPE || typeof payload.jti !== 'string' || typeof payload.exp !== 'number') {
    return { ok: false, reason: 'payload inválido' }
  }
  if (payload.exp <= nowMs) return { ok: false, reason: 'token expirado' }
  if (expectedOrgId && payload.orgId && payload.orgId !== expectedOrgId) {
    return { ok: false, reason: 'organización no autorizada' }
  }
  return { ok: true, payload }
}

/** Registro de un solo uso por jti (canje único; purga perezosa por retención). */
export class SingleUseJti {
  private seen = new Map<string, number>()
  private retentionMs: number

  constructor(retentionMs: number = ECOSYSTEM_SSO_JTI_RETENTION_MS) {
    this.retentionMs = retentionMs
  }

  /** Devuelve true si el jti se reclama por primera vez. */
  claim(jti: string, nowMs: number = Date.now()): boolean {
    for (const [k, t] of this.seen) if (nowMs - t > this.retentionMs) this.seen.delete(k)
    if (this.seen.has(jti)) return false
    this.seen.set(jti, nowMs)
    return true
  }

  get size(): number {
    return this.seen.size
  }
}
