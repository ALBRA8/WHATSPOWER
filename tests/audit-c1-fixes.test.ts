/**
 * (auditoría 2026-11-11 — ciclo 1) Pruebas de las correcciones WHATSPOWER.
 * Sin prueba verificable no se declara resuelto (regla de la orden maestra):
 *  - A2-11: rate limit DURABLE (durableRateLimit) — bloquea al superar el
 *    límite, es independiente por clave y sobrevive reabrir la BD.
 *  - A1-03: replay de un evento ya procesado devuelve duplicate sin re-ejecutar.
 *  - A1-05: evento sin teléfono de cliente válido → SKIPPED_NO_PHONE auditable.
 *  - A1-04: '__legacy__' es espacio reservado — parseOrgCredentials lo ignora.
 *  - A1-02: el registro sentLog del transporte Meta tiene tope (sin fuga).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, durableRateLimit } from '../src/db.ts'
import { CrmTriggerListener } from '../src/engine/crm-triggers.ts'
import { parseOrgCredentials } from '../src/org-wa-registry.ts'
import { MetaCloudOrgTransport } from '../src/adapters/meta-cloud-org-transport.ts'

describe('audit ciclo 1 — WHATSPOWER', () => {
  describe('A2-11: rate limit durable', () => {
    test('bloquea al superar el límite, con Retry-After, y es independiente por clave', () => {
      const db = createDatabase(':memory:')
      const key = 'inbound:1.2.3.4'
      for (let i = 0; i < 3; i++) {
        assert.equal(durableRateLimit(db, key, 3, 60_000).allowed, true)
      }
      const blocked = durableRateLimit(db, key, 3, 60_000)
      assert.equal(blocked.allowed, false)
      assert.ok(blocked.retryAfterSec >= 1, 'retryAfterSec debe ser >= 1')
      // Otra clave (otra IP) sigue su propio contador.
      assert.equal(durableRateLimit(db, 'inbound:5.6.7.8', 3, 60_000).allowed, true)
    })

    test('sobrevive reabrir la misma BD (durable, no memoria de proceso)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'wp-rl-'))
      const path = join(dir, 'rl.db')
      const db1 = createDatabase(path)
      for (let i = 0; i < 5; i++) durableRateLimit(db1, 'k', 5, 60_000)
      db1.close()
      const db2 = createDatabase(path)
      assert.equal(durableRateLimit(db2, 'k', 5, 60_000).allowed, false)
      db2.close()
    })
  })

  describe('A1-03/A1-05: idempotencia y validación honesta en crm-triggers', () => {
    function newListener() {
      const db = createDatabase(':memory:')
      // El flujo probado (dedup y validación de teléfono) no toca el FlowEngine.
      return new CrmTriggerListener(db, {} as never, undefined)
    }

    test('evento sin teléfono válido → SKIPPED_NO_PHONE auditable (A1-05)', async () => {
      const listener = newListener()
      const res = await listener.handleStageChange({
        orgId: 'org-t',
        clientId: 'c1',
        clientPhone: '',
        opportunityId: 'o1',
        fromStage: 'nuevo',
        toStage: 'contactado',
        eventId: 'ev-no-phone-1',
      })
      assert.equal(res.status, 'SKIPPED_NO_PHONE')
      assert.equal(res.triggered, false)
    })

    test('replay del mismo eventId devuelve duplicate sin re-ejecutar (A1-03)', async () => {
      const listener = newListener()
      const ev = {
        orgId: 'org-d',
        clientId: 'c1',
        clientPhone: '+573001112233',
        opportunityId: 'o1',
        fromStage: 'a',
        toStage: 'b',
        eventId: 'ev-dup-1',
      }
      const r1 = await listener.handleStageChange(ev)
      const r2 = await listener.handleStageChange(ev)
      assert.equal(r1.duplicate, undefined)
      assert.equal(r2.duplicate, true)
      assert.equal(r2.eventKey, 'ev-dup-1')
    })
  })

  describe('A1-04: org reservada __legacy__', () => {
    test('parseOrgCredentials ignora entradas de __legacy__', () => {
      const entries = parseOrgCredentials(
        'org-a:111000111:token-aaaaaaaaaaaaaaaa,__legacy__:222000222:token-bbbbbbbbbbbbbbbb'
      )
      assert.equal(entries.length, 1)
      assert.equal(entries[0].orgId, 'org-a')
    })
  })

  describe('A1-02: tope del registro sentLog', () => {
    test('tras muchos envíos, sentLog queda acotado (sin fuga de memoria)', async () => {
      process.env.WA_ORG_CREDENTIALS = 'org-a:111000111:token-ORG-A-0123456789abcdef'
      process.env.ALLOW_REAL_DISPATCH = 'true'
      let n = 0
      const stub = (async () =>
        new Response(JSON.stringify({ messages: [{ id: `wamid.TEST-${++n}` }] }), {
          status: 200,
        })) as unknown as typeof fetch
      const transport = new MetaCloudOrgTransport({ fetchImpl: stub })
      for (let i = 0; i < 505; i++) {
        await transport.sendMessage('+573001112233', `hola ${i}`, `idem-${i}`, `stage-${i}`, 'org-a')
      }
      const log = (transport as unknown as { sentLog: unknown[] }).sentLog
      assert.ok(log.length <= 500, `sentLog debe quedar acotado, llegó a ${log.length}`)
    })
  })
})
