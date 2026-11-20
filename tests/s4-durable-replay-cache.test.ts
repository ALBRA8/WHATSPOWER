import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDurableReplayCache, DurableReplayCacheError } from '../src/security/durable-replay-cache.mjs'

/**
 * Kit S4 (WP+ULTRA) — cache durable de replay (jti) + rate limit persistente.
 * Propiedades: unicidad del canje, DURABILIDAD tras cerrar y reabrir la BD,
 * límite exacto del contador atómico compartido entre "instancias".
 */
describe('kit S4 — durable-replay-cache', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const tmpDb = () => {
    const d = mkdtempSync(join(tmpdir(), 's4kit-'))
    dirs.push(d)
    return join(d, 'security-cache.db')
  }

  it('sin dbPath lanza (fail-closed)', () => {
    assert.throws(() => createDurableReplayCache({} as any), DurableReplayCacheError)
  })

  it('claimJti: primer canje true, replay false, jti distinto true', () => {
    const cache = createDurableReplayCache({ dbPath: tmpDb() })
    try {
      assert.equal(cache.claimJti('jti-1', 90_000, 1000), true)
      assert.equal(cache.claimJti('jti-1', 90_000, 1000), false) // replay
      assert.equal(cache.claimJti('jti-2', 90_000, 1000), true)
    } finally {
      cache.close()
    }
  })

  it('DURABLE: tras reabrir la BD el jti sigue quemado (replay post-reinicio bloqueado)', () => {
    const dbPath = tmpDb()
    const first = createDurableReplayCache({ dbPath })
    assert.equal(first.claimJti('jti-restart', 600_000, 5000), true)
    first.close()

    const second = createDurableReplayCache({ dbPath })
    try {
      assert.equal(second.claimJti('jti-restart', 600_000, 5000), false)
    } finally {
      second.close()
    }
  })

  it('claimJti expirado por TTL vuelve a canjear (jti nuevo con ventana nueva)', () => {
    const cache = createDurableReplayCache({ dbPath: tmpDb() })
    try {
      assert.equal(cache.claimJti('jti-ttl', 1_000, 1000), true)
      assert.equal(cache.claimJti('jti-ttl', 1_000, 1000), false) // dentro del TTL
      assert.equal(cache.claimJti('jti-ttl', 1_000, 5_000), true) // TTL vencido
    } finally {
      cache.close()
    }
  })

  it('rateLimit: límite exacto, exceso con retryAfter, ventana vencida reinicia', () => {
    const cache = createDurableReplayCache({ dbPath: tmpDb() })
    try {
      const r1 = cache.rateLimit('login:1.2.3.4', 3, 60_000, 1000)
      assert.equal(r1.ok, true)
      assert.equal(r1.remaining, 2)
      const r2 = cache.rateLimit('login:1.2.3.4', 3, 60_000, 1000)
      assert.equal(r2.ok, true)
      assert.equal(r2.remaining, 1)
      const r3 = cache.rateLimit('login:1.2.3.4', 3, 60_000, 1000)
      assert.equal(r3.ok, true)
      assert.equal(r3.remaining, 0)
      const r4 = cache.rateLimit('login:1.2.3.4', 3, 60_000, 1000)
      assert.equal(r4.ok, false)
      assert.ok(r4.retryAfter > 0)
      // Ventana nueva (now >= resetAt) reinicia el contador
      const r5 = cache.rateLimit('login:1.2.3.4', 3, 60_000, 70_000)
      assert.equal(r5.ok, true)
      assert.equal(r5.remaining, 2)
    } finally {
      cache.close()
    }
  })

  it('DURABLE entre "instancias": dos caches sobre la misma BD comparten el cómputo', () => {
    const dbPath = tmpDb()
    const a = createDurableReplayCache({ dbPath })
    const b = createDurableReplayCache({ dbPath })
    try {
      assert.equal(a.rateLimit('shared-key', 2, 60_000, 1000).ok, true)
      assert.equal(b.rateLimit('shared-key', 2, 60_000, 1000).ok, true)
      assert.equal(a.rateLimit('shared-key', 2, 60_000, 1000).ok, false) // límite compartido: 2 ya consumidas
    } finally {
      a.close()
      b.close()
    }
  })
})
