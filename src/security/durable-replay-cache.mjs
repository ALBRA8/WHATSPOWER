/**
 * S4 (WP + ULTRA) — Cache durable de replay (jti) y rate limit PERSISTENTES.
 *
 * Problema del plan: el jti de un solo uso y los contadores de rate limit viven
 * en memoria de proceso → un reinicio los borra y un replay/ráfaga tras reinicio
 * tiene éxito. Solución: persistir en SQLite con el patrón DurableReplayCache
 * probado en el CRM (dbRateLimit con `INSERT ... ON CONFLICT DO UPDATE` atómico).
 *
 * Soporta node:sqlite (Node >= 22.5 nativo) y better-sqlite3 indistintamente.
 *
 * Uso:
 *   const cache = createDurableReplayCache({ dbPath: './data/security-cache.db' })
 *   if (!cache.claimJti(jti, ttlMs))  → replay: rechazar (409)
 *   const rl = cache.rateLimit(key, limit, windowMs) → { ok, retryAfter, remaining }
 *   cache.close()
 *
 * Propiedades verificadas (tests/kits/s4-durable-replay-cache.test.ts):
 *  - claim: primer canje true, segundo false, expirado vuelve a canjear (TTL)
 *  - DURABLE: cierra y reabre la BD → el jti sigue quemado y el contador intacto
 *  - rateLimit: límite exacto, ventana nueva reinicia, retryAfter > 0 al exceder
 */
import { createRequire } from 'module'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

const require = createRequire(import.meta.url)

function getDatabaseConstructor() {
  try {
    const { DatabaseSync } = require('node:sqlite')
    if (DatabaseSync) return DatabaseSync
  } catch {}
  try {
    const b = require('better-sqlite3')
    return b.default || b
  } catch {}
  throw new Error('No SQLite implementation found (neither node:sqlite nor better-sqlite3)')
}

const Database = getDatabaseConstructor()

export class DurableReplayCacheError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DurableReplayCacheError'
  }
}

/**
 * Fábrica de la cache durable.
 * @param {{ dbPath?: string, retentionMs?: number }} opts
 */
export function createDurableReplayCache({ dbPath, retentionMs = 6 * 60 * 60 * 1000 } = {}) {
  if (!dbPath) {
    throw new DurableReplayCacheError('dbPath es requerido (fail-closed: sin persistencia no hay cache durable)')
  }
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  if (typeof db.pragma === 'function') {
    db.pragma('journal_mode = WAL')
  } else {
    db.exec('PRAGMA journal_mode = WAL;')
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS SsoJtiUsed (
      jti TEXT PRIMARY KEY,
      usedAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS RateLimitBucket (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      resetAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sso_jti_expires ON SsoJtiUsed (expiresAt);
    CREATE INDEX IF NOT EXISTS idx_rl_reset ON RateLimitBucket (resetAt);
  `)

  // Purga perezosa (5 % de las llamadas): jti vencidos y cubos vencidos.
  function maybePurge(now) {
    if (Math.random() >= 0.05) return
    db.prepare('DELETE FROM SsoJtiUsed WHERE expiresAt <= ?').run(now)
    db.prepare('DELETE FROM RateLimitBucket WHERE resetAt <= ?').run(now)
  }

  return {
    /**
     * Canje de un jti de un solo uso. TRUE solo la PRIMERA vez dentro del TTL;
     * después (y en otro proceso tras reinicio) devuelve FALSE.
     * La unicidad la garantiza la PRIMARY KEY: dos procesos que compiten por el
     * mismo jti no pueden ambos insertar (SQLite serializa escrituras).
     * Un jti cuyo TTL ya venció se puede canjear de nuevo (el token que lo
     * contenía ya expiró: la protección de replay solo cubre la vida del token,
     * mismo criterio de retención que el SSO del CRM).
     */
    claimJti(jti, ttlMs = 90_000, nowMs = Date.now()) {
      if (!jti || typeof jti !== 'string') throw new DurableReplayCacheError('jti inválido')
      const expiresAt = nowMs + Math.max(1, ttlMs)
      db.prepare('DELETE FROM SsoJtiUsed WHERE jti = ? AND expiresAt <= ?').run(jti, nowMs)
      try {
        db.prepare('INSERT INTO SsoJtiUsed (jti, usedAt, expiresAt) VALUES (?, ?, ?)').run(jti, nowMs, expiresAt)
        maybePurge(nowMs)
        return true
      } catch {
        // Violación de unicidad: jti ya canjeado y vigente (en este o en otro proceso).
        return false
      }
    },

    /**
     * Contador de rate limit PERSISTENTE y atómico: un único statement hace
     * upsert + incremento + reinicio de ventana (patrón dbRateLimit del CRM).
     * N instancias que compartan la BD computan exactamente lo mismo.
     */
    rateLimit(key, limit, windowMs, nowMs = Date.now()) {
      if (!key || typeof key !== 'string') throw new DurableReplayCacheError('key inválida')
      const windowMsClamped = Math.max(1000, windowMs)
      const resetAt = nowMs + windowMsClamped
      const row = db.prepare(`
        INSERT INTO RateLimitBucket (key, count, resetAt)
        VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET
          count = CASE WHEN RateLimitBucket.resetAt <= ? THEN 1 ELSE RateLimitBucket.count + 1 END,
          resetAt = CASE WHEN RateLimitBucket.resetAt <= ? THEN ? ELSE RateLimitBucket.resetAt END
        RETURNING count, resetAt
      `).get(key, resetAt, nowMs, nowMs, resetAt)
      maybePurge(nowMs)
      const count = row.count
      if (count > limit) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((row.resetAt - nowMs) / 1000)), remaining: 0 }
      }
      return { ok: true, retryAfter: 0, remaining: limit - count }
    },

    close() {
      db.close()
    },
  }
}
