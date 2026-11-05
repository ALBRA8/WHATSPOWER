/**
 * security.ts — Primitivas de seguridad de Capa 2A (orden de cierre 2026-11-06)
 *
 * Reglas del proyecto:
 *  - Comparación de secretos SIEMPRE en tiempo constante (timingSafeEqual).
 *  - Fail-closed: sin secret configurado, todo acceso administrativo se rechaza.
 *  - Los mensajes de error NUNCA revelan valores de secretos.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

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

/** Ventana de tolerancia de timestamp para webhooks (±5 minutos). */
export const TIMESTAMP_WINDOW_MS = 300_000

/** Caché anti-replay en memoria: huellas de peticiones ya vistas y su expiración. */
export class ReplayCache {
  private seen = new Map<string, number>()

  /** Devuelve true si la huella es NUEVA (y la registra); false si es replay. */
  public register(fingerprint: string, ttlMs: number = TIMESTAMP_WINDOW_MS * 2): boolean {
    this.prune()
    if (this.seen.has(fingerprint)) return false
    this.seen.set(fingerprint, Date.now() + ttlMs)
    return true
  }

  private prune(): void {
    const now = Date.now()
    for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k)
  }

  public get size(): number {
    return this.seen.size
  }
}

export interface HmacCheckResult {
  ok: boolean
  status: number
  error?: string
}

/**
 * Verificación dura de webhook: firma HMAC-SHA256 obligatoria + timestamp obligatorio
 * dentro de ventana + caché anti-replay. Comparaciones timing-safe.
 *
 * Formato esperado:
 *   x-signature-sha256: <hex hmac sha256 del body crudo>
 *   x-timestamp: <epoch ms>
 */
export function checkWebhookSecurity(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: string | undefined,
  replay: ReplayCache,
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
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  if (!safeEqual(expected, signature)) {
    return { ok: false, status: 401, error: 'Firma HMAC inválida' }
  }
  if (!replay.register(`${reqTime}:${expected}`)) {
    return { ok: false, status: 401, error: 'Petición duplicada (replay detectado)' }
  }
  return { ok: true, status: 200 }
}

/** Límite de tamaño de body para mitigar DoS. */
export const MAX_BODY_BYTES = 1_048_576

/** Lee el body con tope de tamaño; rechaza con 413 si se excede. */
export function readBody(req: import('node:http').IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<{ ok: true; body: string } | { ok: false; tooLarge: true }> {
  return new Promise((resolve) => {
    let body = ''
    let size = 0
    let rejected = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        rejected = true
        resolve({ ok: false, tooLarge: true })
        req.destroy()
        return
      }
      body += chunk
    })
    req.on('end', () => { if (!rejected) resolve({ ok: true, body }) })
    req.on('error', () => { if (!rejected) resolve({ ok: true, body }) })
  })
}

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
  if (!env.AGENTIC_2A_WEBHOOK_SECRET && !env.WEBHOOK_SECRET) {
    problems.push('AGENTIC_2A_WEBHOOK_SECRET (o WEBHOOK_SECRET legacy): ausente (obligatorio en producción)')
  } else {
    const ws = env.AGENTIC_2A_WEBHOOK_SECRET || env.WEBHOOK_SECRET || ''
    if (ws.length < 24) problems.push('Secreto de webhook: demasiado corto (mínimo 24 caracteres)')
    for (const w of weakDefaults) {
      if (ws.toLowerCase().includes(w.toLowerCase())) { problems.push('Secreto de webhook: contiene un valor débil o publicado conocido'); break }
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
  return problems
}
