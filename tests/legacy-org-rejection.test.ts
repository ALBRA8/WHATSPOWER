/**
 * legacy-org-rejection.test.ts — REPARACIÓN INTEGRAL §4 (mandato 2026-11-06)
 *
 * '__legacy__' es el espacio RESERVADO de los datos históricos sin atribución
 * (filas previas a la migración v3 multi-org). NINGUNA organización real puede
 * operarlo. Esta batería demuestra que NINGUNA vía — header, credencial de
 * servicio, credencial INTERNAL_API_KEYS, secreto de webhook por organización,
 * provisión por entorno ni endpoint administrativo — alcanza los datos legacy.
 *
 * Las credenciales usadas aquí son de prueba y jamás se imprimen.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createAgenticServer } from '../src/server.ts'
import { MockTransportSender } from '../src/adapters/transport.ts'
import { MockCrmClient } from '../src/adapters/crm-client.ts'
import {
  registerOrgServiceCredential,
  provisionOrgServiceCredentialsFromEnv,
  verifyOrgServiceCredential,
  FORBIDDEN_LEGACY_ORG,
} from '../src/org-auth.ts'
import { createDatabase } from '../src/db.ts'
import { parseInternalKeys, parseWebhookSecrets } from '../src/security.ts'

const LEGACY = FORBIDDEN_LEGACY_ORG // '__legacy__'
const REAL_ORG = 'org_real_1'

async function listenEphemeral(server: any): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}

describe('§4 — __legacy__ es inalcanzable por cualquier vía de identidad', () => {
  test('L1: registerOrgServiceCredential RECHAZA __legacy__ (lanza, no registra)', () => {
    const db = createDatabase(':memory:')
    assert.throws(
      () => registerOrgServiceCredential(db, LEGACY, 'credencial_larga_de_prueba_0001'),
      /__legacy__/,
      'registrar credencial para el espacio legacy está prohibido',
    )
    const rows = db.prepare('SELECT COUNT(*) AS n FROM service_credentials WHERE org_id = ?').get(LEGACY) as { n: number }
    assert.strictEqual(Number(rows.n), 0, 'no existe credencial alguna para __legacy__')
  })

  test('L2: provisionOrgServiceCredentialsFromEnv OMITE __legacy__ (con aviso), registra las reales', () => {
    const db = createDatabase(':memory:')
    const prev = process.env.ORG_SERVICE_CREDENTIALS
    process.env.ORG_SERVICE_CREDENTIALS = `${LEGACY}:credencial_larga_de_prueba_0001,${REAL_ORG}:credencial_larga_de_prueba_0002`
    try {
      const n = provisionOrgServiceCredentialsFromEnv(db)
      assert.strictEqual(n, 1, 'solo la organización REAL se provisiona')
      const legacyRows = db.prepare('SELECT COUNT(*) AS n FROM service_credentials WHERE org_id = ?').get(LEGACY) as { n: number }
      assert.strictEqual(Number(legacyRows.n), 0, '__legacy__ sigue sin credenciales')
      assert.strictEqual(verifyOrgServiceCredential(db, LEGACY, 'credencial_larga_de_prueba_0001'), false, 'verificación para __legacy__ → fail-closed')
    } finally {
      if (prev === undefined) delete process.env.ORG_SERVICE_CREDENTIALS
      else process.env.ORG_SERVICE_CREDENTIALS = prev
    }
  })

  test('L3: parseInternalKeys ignora entradas de __legacy__ (ninguna credencial INTERNAL_API_KEYS la opera)', () => {
    const { entries } = parseInternalKeys(`${LEGACY}:secreto_largo_prueba_000001:admin,${REAL_ORG}:secreto_largo_prueba_000002:admin`)
    assert.strictEqual(entries.length, 1, 'solo la org real queda parseada')
    assert.strictEqual(entries[0].orgId, REAL_ORG)
    assert.ok(!entries.some((e) => e.orgId === LEGACY), 'ninguna entrada __legacy__')
  })

  test('L4: parseWebhookSecrets ignora __legacy__ (ningún secreto de webhook la vincula)', () => {
    const bindings = parseWebhookSecrets(`${LEGACY}:secreto_webhook_largo_0001,${REAL_ORG}:secreto_webhook_largo_0002`)
    assert.ok(!bindings.some((b: any) => b.orgId === LEGACY), 'ningún binding de webhook para __legacy__')
  })

  test('L5: X-Org-Id: __legacy__ → 400 en rutas por-org; jamás 2xx (datos legacy inalcanzables)', async () => {
    const prevKeys = process.env.INTERNAL_API_KEYS
    process.env.INTERNAL_API_KEYS = `${REAL_ORG}:clave_real_larga_prueba_01:admin`
    try {
      const { server, db } = createAgenticServer({ dbPath: ':memory:', transport: new MockTransportSender(), crm: new MockCrmClient() })
      // Sembrar datos en el espacio legacy (como dejaría la migración de una BD v2)
      db.prepare(`INSERT INTO suppression_list (organization_id, phone, reason, created_at) VALUES (?, ?, ?, ?)`)
        .run(LEGACY, '573000000001', 'histórico', Math.floor(Date.now() / 1000))
      const base = await listenEphemeral(server)
      try {
        // Operador central (secreto global) intentando seleccionar __legacy__
        const prevSecret = process.env.INTERNAL_API_SECRET
        process.env.INTERNAL_API_SECRET = 'secreto_global_de_prueba_min24chars'
        try {
          for (const path of ['/api/flows', '/api/team/agents', '/api/canned', '/api/growth/links']) {
            const res = await fetch(`${base}${path}`, { headers: { 'X-Org-Id': LEGACY, 'Authorization': 'Bearer secreto_global_de_prueba_min24chars' } })
            assert.ok(res.status !== 200, `${path} con X-Org-Id __legacy__ JAMÁS responde 2xx (obtenido ${res.status})`)
          }
          // Rutas de servicio por organización con __legacy__
          const svc = await fetch(`${base}/api/internal/locks/573000000001`, { headers: { 'X-Org-Id': LEGACY, 'Authorization': 'Bearer credencial_inexistente_00001' } })
          assert.ok(svc.status !== 200, 'servicio con __legacy__ jamás 2xx')
        } finally {
          if (prevSecret === undefined) delete process.env.INTERNAL_API_SECRET
          else process.env.INTERNAL_API_SECRET = prevSecret
        }
        // La fila legacy sigue INTACTA y ajena a cualquier org real
        const row = db.prepare('SELECT organization_id FROM suppression_list WHERE phone = ?').get('573000000001') as { organization_id: string }
        assert.strictEqual(row.organization_id, LEGACY, 'los datos legacy permanecen sin reatribución (§4: no se inventa pertenencia)')
      } finally { server.close() }
    } finally {
      if (prevKeys === undefined) delete process.env.INTERNAL_API_KEYS
      else process.env.INTERNAL_API_KEYS = prevKeys
    }
  })

  test('L6: stage-change con orgId __legacy__ en el body → 403 (contradicción con identidad)', async () => {
    const prevKeys = process.env.INTERNAL_API_KEYS
    process.env.INTERNAL_API_KEYS = `${REAL_ORG}:clave_real_larga_prueba_01:admin`
    try {
      const { server } = createAgenticServer({ dbPath: ':memory:', transport: new MockTransportSender(), crm: new MockCrmClient() })
      const base = await listenEphemeral(server)
      try {
        const res = await fetch(`${base}/api/crm/stage-change`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer clave_real_larga_prueba_01' },
          body: JSON.stringify({ orgId: LEGACY, clientPhone: '573000000002', toStage: 'NUEVO', fromStage: 'INICIAL', opportunityId: 'opp_1' }),
        })
        assert.strictEqual(res.status, 403, 'el body no puede atribuir el evento al espacio legacy')
      } finally { server.close() }
    } finally {
      if (prevKeys === undefined) delete process.env.INTERNAL_API_KEYS
      else process.env.INTERNAL_API_KEYS = prevKeys
    }
  })
})
