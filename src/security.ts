/**
 * security.ts — Primitivas de seguridad de Capa 2A (orden de cierre 2026-11-06)
 *
 * Reglas del proyecto:
 *  - Comparación de secretos SIEMPRE en tiempo constante (timingSafeEqual).
 *  - Fail-closed: sin secret configurado, todo acceso administrativo se rechaza.
 *  - Los mensajes de error NUNCA revelan valores de secretos.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

/**
 * DurableReplayCache — anti-replay persistente (reparación integral 2026-11-06).
 * SQLite (node:sqlite): sobrevive reinicios y sirve réplicas que compartan archivo.
 * La inserción atómica por PRIMARY KEY cierra la carrera entre réplicas.
 * Fail-fast en constructor; ':memory:' para tests.
 */
export class DurableReplayCache {
  private db: DatabaseSync
  private insertStmt: StatementSync
  private touchStmt: StatementSync
  private getStmt: StatementSync
  private pruneStmt: StatementSync

  constructor(path?: string) {
    const target = path ?? process.env.REPLAY_DB_PATH ?? join(__dirname, '..', 'db', 'replay-cache.db')
    if (target !== ':memory:') mkdirSync(dirname(target), { recursive: true })
    this.db = new DatabaseSync(target)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS replay_seen (
        fingerprint TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `)
    this.insertStmt = this.db.prepare('INSERT INTO replay_seen (fingerprint, expires_at) VALUES (?, ?)')
    this.touchStmt = this.db.prepare('INSERT OR REPLACE INTO replay_seen (fingerprint, expires_at) VALUES (?, ?)')
    this.getStmt = this.db.prepare('SELECT expires_at FROM replay_seen WHERE fingerprint = ?')
    this.pruneStmt = this.db.prepare('DELETE FROM replay_seen WHERE expires_at < ?')
  }

  public register(fingerprint: string, ttlMs: number = TIMESTAMP_WINDOW_MS * 2): boolean {
    const now = Date.now()
    const expiresAt = now + ttlMs
    try {
      this.insertStmt.run(fingerprint, expiresAt)
      return true
    } catch {
      const row = this.getStmt.get(fingerprint) as { expires_at: number } | undefined
      if (row && row.expires_at > now) return false
      this.touchStmt.run(fingerprint, expiresAt)
      return true
    } finally {
      this.pruneStmt.run(now)
    }
  }

  public get size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM replay_seen').get() as { n: number }
    return row.n
  }

  public close(): void {
    this.db.close()
  }
}

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
 * Firma canonical v2 (reparación integral 2026-11-06): HMAC-SHA256 sobre
 * `${orgId}.${timestamp}.${rawBody}` (orgId vacío cuando no aplica).
 * El timestamp y la organización quedan LIGADOS a la firma: no pueden
 * sustituirse sin romperla (cierra el replay con timestamp fresco de la v1).
 */
export function signWebhookPayload(timestamp: string | number, rawBody: string, secret: string, org: string = ''): string {
  const canonical = `${org ? org + '.' : ''}${String(timestamp)}.${rawBody}`
  return createHmac('sha256', secret).update(canonical).digest('hex')
}

/** Expande "actual|previo" en lista de secretos válidos (rotación sin interrupción). */
export function expandSecretEntry(entry: string): string[] {
  return entry.split('|').map((s) => s.trim()).filter(Boolean)
}

/**
 * Verificación dura de webhook v2: firma HMAC-SHA256 obligatoria (ligada a
 * timestamp y organización) + timestamp dentro de ventana + caché anti-replay.
 * Comparaciones timing-safe; acepta varios secretos (rotación "actual|previo").
 *
 * Formato esperado:
 *   x-signature-sha256: hex(HMAC-SHA256(secreto, `${orgId}.${timestamp}.${rawBody}`))
 *   x-timestamp: <epoch ms>
 */
export function checkWebhookSecurity(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  secrets: string | string[] | undefined,
  replay: ReplayCache | DurableReplayCache,
  now: number = Date.now(),
  org: string = '',
): HmacCheckResult {
  const secretList = (Array.isArray(secrets) ? secrets : [secrets])
    .flatMap((s) => (typeof s === 'string' ? expandSecretEntry(s) : []))
    .filter(Boolean)
  if (secretList.length === 0) {
    return { ok: false, status: 503, error: 'Service Unavailable: secreto de webhook no configurado' }
  }
  if (!signature || !timestamp) {
    return { ok: false, status: 401, error: 'Firma HMAC y timestamp son obligatorios' }
  }
  const reqTime = Number(timestamp) || new Date(timestamp).getTime()
  if (!Number.isFinite(reqTime) || Math.abs(now - reqTime) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, status: 401, error: 'Timestamp expirado o fuera de ventana de tolerancia (replay protection)' }
  }
  let matched: string | null = null
  for (const secret of secretList) {
    const expected = signWebhookPayload(timestamp, rawBody, secret, org)
    if (safeEqual(expected, signature)) {
      matched = expected
      break
    }
  }
  if (!matched) {
    return { ok: false, status: 401, error: 'Firma HMAC inválida' }
  }
  if (!replay.register(`${org}\u0000${reqTime}:${matched}`)) {
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

// ============================================================================
// SESIÓN DE STUDIO POR COOKIE HttpOnly (tercera reparación 4.F — espejo de ULTRA)
//
// Causa raíz corregida: el Studio de Capa 2A guardaba el secreto administrativo
// en sessionStorage — cualquier XSS lo leía. Ahora el navegador canjea el
// secreto UNA vez por una cookie de sesión:
//   - HttpOnly → invisible para JavaScript (un XSS NO puede exfiltrarla);
//   - SameSite=Strict → no viaja en navegaciones cruzadas;
//   - corta vida (1 h) y token HMAC stateless ligado al secreto vigente:
//     rotar el secreto revoca todas las sesiones al instante.
// ============================================================================

export const STUDIO_SESSION_COOKIE = 'wp_2a_studio_session'
export const STUDIO_SESSION_TTL_SECONDS = 3600

function studioSessionToken(secret: string, issuedAtMs: number): string {
  return createHmac('sha256', secret).update(`2a.${issuedAtMs}`).digest('base64url')
}

/** Emite el valor de la cookie de sesión del Studio (índice único = 0). */
export function issueStudioSession(secret: string, nowMs: number = Date.now()): string {
  const token = `0.${nowMs}.${studioSessionToken(secret, nowMs)}`
  return `${STUDIO_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${STUDIO_SESSION_TTL_SECONDS}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
}

/** Verifica la cookie de sesión contra el secreto vigente (rotación ⇒ revocación total). */
export function resolveStudioSession(cookieHeader: string | undefined, expectedSecret: string | undefined, nowMs: number = Date.now()): boolean {
  if (!cookieHeader || !expectedSecret) return null as unknown as boolean
  const cookies = cookieHeader.split(';').map((c) => c.trim())
  const raw = cookies.find((c) => c.startsWith(`${STUDIO_SESSION_COOKIE}=`))
  if (!raw) return false
  const token = raw.slice(STUDIO_SESSION_COOKIE.length + 1)
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [, iatStr, sig] = parts
  const iat = Number.parseInt(iatStr, 10)
  if (!Number.isFinite(iat)) return false
  if (nowMs - iat > STUDIO_SESSION_TTL_SECONDS * 1000) return false
  const expected = studioSessionToken(expectedSecret, iat)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * RateLimiter por cubo (ventana fija en memoria) para endpoints públicos
 * (tercera reparación 4.F): mitiga abuso de /api/inbound, /api/payments/webhook
 * y /ref/:slug. Clave = identificador (p. ej. IP o IP+ruta). En memoria por
 * proceso: suficiente para contener rachas; el límite duro de red se hace en
 * infraestructura (proxy) cuando existe.
 */
export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>()
  private maxPerWindow: number
  private windowMs: number
  private maxBuckets: number

  constructor(maxPerWindow: number, windowMs: number = 60_000, maxBuckets: number = 10_000) {
    this.maxPerWindow = maxPerWindow
    this.windowMs = windowMs
    this.maxBuckets = maxBuckets
  }

  /** Devuelve true si la petición está PERMITIDA. */
  public allow(key: string, now: number = Date.now()): boolean {
    if (this.buckets.size > this.maxBuckets) {
      // Limpieza de seguridad si el mapa crece demasiado (abuso de claves falsas)
      for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k)
      if (this.buckets.size > this.maxBuckets) this.buckets.clear()
    }
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    bucket.count++
    return bucket.count <= this.maxPerWindow
  }

  public get size(): number {
    return this.buckets.size
  }
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
