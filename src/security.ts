/**
 * security.ts — Primitivas de seguridad de Capa 2A (reparación integral v1.1.0, 2026-11-06)
 *
 * Reglas del proyecto:
 *  - Comparación de secretos SIEMPRE en tiempo constante (timingSafeEqual).
 *  - Fail-closed: sin secret configurado, todo acceso administrativo se rechaza (503).
 *  - HMAC v2 (contrato INTEGRATION_CONTRACT.md §3): hex = HMAC-SHA256(secret, timestamp + "." + rawBody).
 *    El timestamp entra en la MAC: modificarlo invalida la firma (anti-replay real).
 *  - Anti-replay PERSISTENTE en SQLite (sobrevive reinicios del proceso).
 *  - Identidades multi-organización: INTERNAL_API_KEYS="orgId:secreto[:rol],...".
 *    El legado INTERNAL_API_SECRET resuelve a la organización "default" con rol admin.
 *  - Los mensajes de error NUNCA revelan valores de secretos; los logs jamás teléfonos completos.
 */
import { createHmac, timingSafeEqual, createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/**
 * Comparación en tiempo constante de dos cadenas.
 * Evita el oracle de timing de las comparaciones `===` sobre secretos.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) {
    // compara contra sí misma para gastar el mismo tiempo y luego rechaza
    timingSafeEqual(ba, ba)
    return false
  }
  return timingSafeEqual(ba, bb)
}

/** Valida el header `Authorization: Bearer <secret>` contra el secret esperado. */
export function isAuthorizedBearer(authHeader: string | undefined, expectedSecret: string | undefined): boolean {
  if (!expectedSecret || !authHeader) return false
  const prefix = 'Bearer '
  if (!authHeader.startsWith(prefix)) return false
  return safeEqual(authHeader.slice(prefix.length), expectedSecret)
}

// ===========================================================================
// IDENTIDADES MULTI-ORGANIZACIÓN (contrato §1)
// ===========================================================================

export type InternalRole = 'admin' | 'agent'

export interface InternalIdentity {
  orgId: string
  role: InternalRole
  source: 'keys' | 'legacy'
}

interface InternalKeyEntry {
  orgId: string
  secret: string
  role: InternalRole
}

/**
 * Parsea INTERNAL_API_KEYS con formato "orgId:secreto[:rol],orgId:secreto[:rol]".
 * Entradas malformadas se ignoran (con aviso del operador vía valor de retorno de errores).
 */
export function parseInternalKeys(raw: string | undefined): { entries: InternalKeyEntry[]; skipped: number } {
  const entries: InternalKeyEntry[] = []
  let skipped = 0
  if (!raw) return { entries, skipped }
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const pieces = trimmed.split(':')
    if (pieces.length < 2 || pieces.length > 3) { skipped++; continue }
    const [orgId, secret, role] = pieces
    if (!orgId || !secret || !/^[a-zA-Z0-9_-]{1,64}$/.test(orgId)) { skipped++; continue }
    if (secret.length < 16) { skipped++; continue } // secretos débiles se rechazan al parsear
    const r: InternalRole = role === 'admin' ? 'admin' : 'agent'
    entries.push({ orgId, secret, role: r })
  }
  return { entries, skipped }
}

export interface IdentityResolution {
  ok: boolean
  status: number
  identity?: InternalIdentity
  error?: string
}

/**
 * Resuelve la identidad del llamador de una ruta administrativa.
 * 1. INTERNAL_API_KEYS (por organización) — comparación timing-safe entrada por entrada.
 * 2. Legado INTERNAL_API_SECRET → organización "default", rol admin.
 * Fail-closed: sin ninguna credencial configurada → 503 (jamás acepta).
 */
export function resolveAdminIdentity(
  authHeader: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): IdentityResolution {
  const { entries } = parseInternalKeys(env.INTERNAL_API_KEYS)
  const legacy = env.INTERNAL_API_SECRET
  if (entries.length === 0 && !legacy) {
    return { ok: false, status: 503, error: 'Service Unavailable: INTERNAL_API_KEYS/INTERNAL_API_SECRET no configurados (fail-closed)' }
  }
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Unauthorized: Missing or invalid internal secret' }
  }
  const presented = authHeader.slice('Bearer '.length)
  for (const e of entries) {
    if (safeEqual(presented, e.secret)) {
      return { ok: true, status: 200, identity: { orgId: e.orgId, role: e.role, source: 'keys' } }
    }
  }
  if (legacy && safeEqual(presented, legacy)) {
    return { ok: true, status: 200, identity: { orgId: 'default', role: 'admin', source: 'legacy' } }
  }
  return { ok: false, status: 401, error: 'Unauthorized: Missing or invalid internal secret' }
}

/** La cabecera X-Org-Id solo puede RESTRINGIR (debe coincidir con la org de la credencial). */
export function orgHeaderAllowed(xOrgId: string | undefined | string[], identity: InternalIdentity): boolean {
  if (xOrgId === undefined) return true
  const value = Array.isArray(xOrgId) ? xOrgId[0] : xOrgId
  return value === identity.orgId
}

// ===========================================================================
// WEBHOOK HMAC v2 (contrato §3)
// ===========================================================================

/** Ventana de tolerancia de timestamp para webhooks (±5 minutos). */
export const TIMESTAMP_WINDOW_MS = 300_000

/** hex = HMAC-SHA256(secret, timestamp + "." + rawBody) — el timestamp entra en la MAC. */
export function computeHmacV2(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')
}

/** Huella de replay: (timestamp exacto firmado, MAC esperada). */
export function replayFingerprint(timestamp: string, expectedMac: string): string {
  return `${timestamp}:${expectedMac}`
}

export interface HmacCheckResult {
  ok: boolean
  status: number
  error?: string
}

/**
 * Verificación dura de webhook v2: firma HMAC-SHA256 sobre timestamp.body OBLIGATORIA +
 * timestamp en ventana ±300s + anti-replay PERSISTENTE + comparación timing-safe.
 * Se acepta prefijo "v2=" explícito o hex desnudo (transición), SIEMPRE sobre timestamp.body.
 */
export function checkWebhookSecurity(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: string | undefined,
  replay: { register: (fingerprint: string) => boolean },
  now: number = Date.now(),
): HmacCheckResult {
  if (!secret) {
    return { ok: false, status: 503, error: 'Service Unavailable: secreto de webhook no configurado' }
  }
  if (!signature || !timestamp) {
    return { ok: false, status: 401, error: 'Firma HMAC y timestamp son obligatorios' }
  }
  const reqTime = Number(timestamp) || new Date(timestamp).getTime()
  if (!Number.isFinite(reqTime) || Math.abs(now - reqTime) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, status: 401, error: 'Timestamp expirado o fuera de ventana de tolerancia (replay protection)' }
  }
  const presented = signature.trim().replace(/^v2=/i, '')
  const expected = computeHmacV2(secret, timestamp, rawBody)
  if (!safeEqual(expected, presented)) {
    return { ok: false, status: 401, error: 'Firma HMAC inválida' }
  }
  if (!replay.register(replayFingerprint(timestamp, expected))) {
    return { ok: false, status: 401, error: 'Petición duplicada (replay detectado)' }
  }
  return { ok: true, status: 200 }
}

// ===========================================================================
// SECRETOS DE WEBHOOK POR ORGANIZACIÓN (contrato §3)
// ===========================================================================

export interface WebhookSecretBinding {
  orgId: string
  secret: string
}

/**
 * Parsea WEBHOOK_SECRETS="orgId:secreto,orgId:secreto". El secreto que valida el
 * HMAC VINCULA la organización. El legado (AGENTIC_2A_WEBHOOK_SECRET/WEBHOOK_SECRET)
 * queda disponible como secreto único de transición (vincula la org del payload).
 */
export function parseWebhookSecrets(raw: string | undefined): WebhookSecretBinding[] {
  if (!raw) return []
  const out: WebhookSecretBinding[] = []
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    const idx = trimmed.indexOf(':')
    if (idx <= 0) continue
    const orgId = trimmed.slice(0, idx)
    const secret = trimmed.slice(idx + 1)
    if (!orgId || !secret || !/^[a-zA-Z0-9_-]{1,64}$/.test(orgId) || secret.length < 16) continue
    out.push({ orgId, secret })
  }
  return out
}

export interface WebhookVerification {
  ok: boolean
  status: number
  error?: string
  /** Organización vinculada al secreto que validó la firma (modo per-org). */
  boundOrgId?: string
  /** true si la organización se tomó del payload (modo de transición con secreto único). */
  orgFromPayload?: boolean
}

/**
 * Verificación v2 con resolución de organización por secreto.
 * Con WEBHOOK_SECRETS configurado: se prueba cada secreto (timing-safe) y el válido
 * vincula la organización; un orgId del payload distinto → 403.
 * Con solo secreto legado: la organización viene del payload autenticado por HMAC.
 */
export function verifyWebhookWithOrg(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  payloadOrgId: string | undefined,
  options: {
    perOrgSecrets: WebhookSecretBinding[]
    legacySecret?: string
    replay: { register: (fingerprint: string) => boolean }
    now?: number
  },
): WebhookVerification {
  const { perOrgSecrets, legacySecret, replay, now } = options
  if (perOrgSecrets.length === 0 && !legacySecret) {
    return { ok: false, status: 503, error: 'Service Unavailable: secreto de webhook no configurado' }
  }
  if (!signature || !timestamp) {
    return { ok: false, status: 401, error: 'Firma HMAC y timestamp son obligatorios' }
  }
  const reqTime = Number(timestamp) || new Date(timestamp).getTime()
  if (!Number.isFinite(reqTime) || Math.abs((now ?? Date.now()) - reqTime) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, status: 401, error: 'Timestamp expirado o fuera de ventana de tolerancia (replay protection)' }
  }
  const presented = signature.trim().replace(/^v2=/i, '')
  for (const binding of perOrgSecrets) {
    const expected = computeHmacV2(binding.secret, timestamp, rawBody)
    if (safeEqual(expected, presented)) {
      if (!replay.register(replayFingerprint(timestamp, expected))) {
        return { ok: false, status: 401, error: 'Petición duplicada (replay detectado)' }
      }
      if (payloadOrgId && payloadOrgId !== binding.orgId) {
        return { ok: false, status: 403, error: 'orgId del payload no coincide con la organización del secreto' }
      }
      return { ok: true, status: 200, boundOrgId: binding.orgId }
    }
  }
  if (legacySecret) {
    const expected = computeHmacV2(legacySecret, timestamp, rawBody)
    if (safeEqual(expected, presented)) {
      if (!replay.register(replayFingerprint(timestamp, expected))) {
        return { ok: false, status: 401, error: 'Petición duplicada (replay detectado)' }
      }
      return { ok: true, status: 200, orgFromPayload: true }
    }
  }
  return { ok: false, status: 401, error: 'Firma HMAC inválida' }
}

// ===========================================================================
// ANTI-REPLAY PERSISTENTE (contrato §3: sobrevive reinicios, purga >600s)
// ===========================================================================

export const REPLAY_TTL_MS = TIMESTAMP_WINDOW_MS * 2 // 600s

/** Anti-replay en SQLite: huellas de peticiones ya vistas. Instancia única por BD. */
export class PersistentReplayStore {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.prune()
  }

  /** Devuelve true si la huella es NUEVA (y la registra); false si es replay. */
  public register(fingerprint: string): boolean {
    const now = Date.now()
    // INSERT atómico: PK duplicada ⇒ replay. (SQLite serializa escrituras: seguro bajo concurrencia.)
    try {
      this.db.prepare('INSERT INTO webhook_replay (fingerprint, seen_at) VALUES (?, ?)').run(fingerprint, now)
    } catch {
      return false
    }
    this.prune()
    return true
  }

  private prune(): void {
    const cutoff = Date.now() - REPLAY_TTL_MS
    this.db.prepare('DELETE FROM webhook_replay WHERE seen_at < ?').run(cutoff)
  }
}

// ===========================================================================
// RATE LIMITING (contrato §7) — ventana deslizante en memoria por clave
// ===========================================================================

export interface RateLimitResult {
  allowed: boolean
  retryAfterSec: number
}

export class RateLimiter {
  private hits = new Map<string, number[]>()

  public check(key: string, limit: number, windowMs: number = 60_000): RateLimitResult {
    const now = Date.now()
    const arr = (this.hits.get(key) || []).filter((t) => now - t < windowMs)
    if (arr.length >= limit) {
      this.hits.set(key, arr)
      const oldest = arr[0] || now
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000))
      return { allowed: false, retryAfterSec }
    }
    arr.push(now)
    this.hits.set(key, arr)
    return { allowed: true, retryAfterSec: 0 }
  }
}

/** IP del cliente: x-forwarded-for solo se respeta con TRUST_PROXY==='true' (contrato §7). */
export function clientIp(req: import('node:http').IncomingMessage): string {
  if (process.env.TRUST_PROXY === 'true') {
    const xff = req.headers['x-forwarded-for']
    if (typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0].trim()
    }
  }
  return req.socket.remoteAddress || 'unknown'
}

/** Enmascara un teléfono para logs (nunca el número completo). */
export function maskPhone(phone: string): string {
  const clean = String(phone || '')
  if (clean.length <= 4) return '***'
  return `${clean.slice(0, 4)}****${clean.slice(-2)}`
}

// ===========================================================================
// LECTURA SEGURA DE BODY (contrato §7)
// ===========================================================================

/** Límite de tamaño de body para mitigar DoS. */
export const MAX_BODY_BYTES = 1_048_576
/** Tope de drenaje: tras rechazar con 413 se lee y descarta hasta esta cantidad para
 *  poder ENTREGAR el 413 antes de cerrar (jamás cuerpo parcial procesado). */
const DRAIN_LIMIT_BYTES = 8 * 1_048_576

export type ReadBodyResult = { ok: true; body: string } | { ok: false; tooLarge?: boolean; streamError?: boolean }

/** Lee el body con tope de tamaño; 413 si se excede (drenando con tope); error de stream ⇒ rechazo. */
export function readBody(req: import('node:http').IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<ReadBodyResult> {
  return new Promise((resolve) => {
    let body = ''
    let size = 0
    let drained = 0
    let rejected = false
    let finished = false
    const settle = (r: ReadBodyResult) => { if (!finished) { finished = true; resolve(r) } }
    req.on('data', (chunk: Buffer) => {
      if (rejected) {
        drained += chunk.length
        if (drained > DRAIN_LIMIT_BYTES) { req.destroy(); settle({ ok: false, tooLarge: true }) }
        return
      }
      size += chunk.length
      if (size > maxBytes) {
        rejected = true
        // NO se procesa ningún cuerpo parcial: se marca el rechazo y se drena con tope.
        settle({ ok: false, tooLarge: true })
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (rejected) { req.destroy(); settle({ ok: false, tooLarge: true }); return }
      settle({ ok: true, body })
    })
    req.on('error', () => {
      // Un error de stream JAMÁS se procesa como éxito con cuerpo parcial.
      settle({ ok: false, streamError: true })
    })
  })
}

// ===========================================================================
// GUARD DE ENTORNO FAIL-FAST PARA PRODUCCIÓN
// ===========================================================================

/**
 * Guard de entorno fail-fast para producción.
 * Devuelve la lista de problemas (variables ausentes o débiles). NUNCA incluye valores.
 */
export function productionConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = []
  const weakDefaults = [
    'crm_albra_internal_secret_key_fixed_length_for_daemon_2026',
    'dev_secret_shared_albra_2a',
    'dev_shared_hmac_secret_albra_2a',
    'albra-dev-token',
    'changeme', 'cambia-esto', 'REPLACE_WITH', 'your_webhook_secret_here',
  ]

  const checkSecret = (name: string, min = 24) => {
    const v = env[name]
    if (!v) { problems.push(`${name}: ausente (obligatorio en producción)`); return }
    if (v.length < min) problems.push(`${name}: demasiado corto (mínimo ${min} caracteres)`)
    for (const w of weakDefaults) {
      if (v.toLowerCase().includes(w.toLowerCase())) { problems.push(`${name}: contiene un valor débil o publicado conocido`); break }
    }
  }

  checkSecret('INTERNAL_API_SECRET')
  if (!env.INTERNAL_API_KEYS) {
    problems.push('INTERNAL_API_KEYS: ausente (en producción se exigen claves por organización "orgId:secreto[:rol]"; INTERNAL_API_SECRET queda como acceso legado a la org "default")')
  }
  if (!env.AGENTIC_2A_WEBHOOK_SECRET && !env.WEBHOOK_SECRET && !env.WEBHOOK_SECRETS) {
    problems.push('AGENTIC_2A_WEBHOOK_SECRET (o WEBHOOK_SECRET legacy, o WEBHOOK_SECRETS por-org): ausente (obligatorio en producción)')
  } else {
    const ws = env.AGENTIC_2A_WEBHOOK_SECRET || env.WEBHOOK_SECRET || ''
    if (ws && ws.length < 24) problems.push('Secreto de webhook: demasiado corto (mínimo 24 caracteres)')
    for (const w of weakDefaults) {
      if (ws && ws.toLowerCase().includes(w.toLowerCase())) { problems.push('Secreto de webhook: contiene un valor débil o publicado conocido'); break }
    }
  }

  if (!env.CRM_API_KEY) problems.push('CRM_API_KEY: ausente (en producción el puente CRM no puede usar Mock silenciosamente)')
  if (!env.TRANSPORT) problems.push('TRANSPORT: ausente (usa TRANSPORT=mock con ALLOW_MOCK_TRANSPORT=true o TRANSPORT=http)')
  if (env.TRANSPORT === 'mock' && env.ALLOW_MOCK_TRANSPORT !== 'true') {
    problems.push('ALLOW_MOCK_TRANSPORT=true: requerido para aceptar MockTransportSender en producción (debe ser una decisión explícita)')
  }
  if (env.PAYMENTS_WEBHOOK_SECRET) {
    if (env.PAYMENTS_WEBHOOK_SECRET.length < 24) problems.push('PAYMENTS_WEBHOOK_SECRET: demasiado corto (mínimo 24 caracteres)')
  }
  // Contrato §6: el modo de pagos es obligatorio en producción.
  const mode = env.PAYMENTS_MODE
  if (!mode) {
    problems.push('PAYMENTS_MODE: ausente (obligatorio en producción: simulator|sandbox|production)')
  } else if (!['simulator', 'sandbox', 'production'].includes(mode)) {
    problems.push('PAYMENTS_MODE: valor no reconocido (válidos: simulator|sandbox|production)')
  } else if (mode === 'simulator') {
    problems.push('PAYMENTS_MODE=simulator: el simulador NO se admite como modo de producción (jamás se presenta como cobro real)')
  } else if (mode === 'production' && !env.PAYMENTS_WEBHOOK_SECRET) {
    problems.push('PAYMENTS_MODE=production exige PAYMENTS_WEBHOOK_SECRET configurado (fail-closed)')
  }
  return problems
}

/** Huella sha256-12 de un valor (para allowlists/baselines de secretos). Nunca devuelve el valor. */
export function fingerprintValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)
}
