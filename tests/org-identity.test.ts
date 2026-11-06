/**
 * CUARTA REPARACIÓN — B3: IDENTIDAD DE ORGANIZACIÓN EXTREMO A EXTREMO (Capa 2A).
 *
 * Problema reproducido: los endpoints de integración 2A↔2B
 * (/api/internal/locks, /api/internal/suppression) se autorizaban con el
 * secreto GLOBAL (INTERNAL_API_SECRET) y la organización la declaraba el
 * LLAMADOR en x-org-id: un solo secreto compartido sustituía la validación de
 * organización → cualquier poseedor del secreto podía leer/escribir el estado
 * de locks/supresión de CUALQUIER organización (acceso cruzado).
 *
 * Contrato nuevo (fail-closed, verificado aquí contra servidor REAL):
 *  W-B3-01  Con SOLO el secreto global → 403 en locks y suppression (el
 *           secreto global ya NO sustituye la validación de organización).
 *  W-B3-02  Con credencial de servicio de la org + X-Org-Id correcto → 200
 *           con eco de organización.
 *  W-B3-03  Credencial de org A + X-Org-Id de org B → 403 (acceso cruzado
 *           denegado) en GET/POST/DELETE y release.
 *  W-B3-04  Sin Bearer → 401; sin X-Org-Id → 401.
 *  W-B3-05  Escrituras (POST/DELETE supresión, release) exigen la misma
 *           identidad vinculada.
 *  W-B3-06  Una org SIN credenciales registradas → 403 aunque presente el
 *           secreto global (provisión explícita obligatoria).
 *
 * Servidor REAL (createAgenticServer) + provisión REAL por env
 * (ORG_SERVICE_CREDENTIALS). Las credenciales usadas aquí son de prueba y no
 * se imprimen jamás.
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { createServer } from 'node:http'
import { createAgenticServer } from '../src/server.ts'

const GLOBAL_SECRET = 'wp_b3_global_secret_min24chars_0000'
const CRED_A = 'org-alpha-service-credential-0000000001'
const CRED_B = 'org-beta-service-credential-000000000002'

async function listen(server: import('node:http').Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve(addr.port)
    })
  })
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  process.env.INTERNAL_API_SECRET = GLOBAL_SECRET
  // Provisión REAL por env (la misma que usa producción): credenciales por org.
  process.env.ORG_SERVICE_CREDENTIALS = `org_alpha:${CRED_A},org_beta:${CRED_B}`
  const { server } = createAgenticServer({ dbPath: ':memory:' })
  const port = await listen(server)
  const base = `http://127.0.0.1:${port}`
  try {
    await fn(base)
  } finally {
    server.close()
    delete process.env.ORG_SERVICE_CREDENTIALS
  }
}

test('W-B3-01: el secreto global YA NO autoriza lectura de locks/supresión (fallback eliminado)', async () => {
  await withServer(async (base) => {
    const locks = await fetch(`${base}/api/internal/locks/573001112233`, {
      headers: { Authorization: `Bearer ${GLOBAL_SECRET}`, 'X-Org-Id': 'org_alpha' },
    })
    assert.equal(locks.status, 403, 'secreto global + org declarada → 403 (el global no sustituye la validación)')

    const supp = await fetch(`${base}/api/internal/suppression/573001112233`, {
      headers: { Authorization: `Bearer ${GLOBAL_SECRET}`, 'X-Org-Id': 'org_alpha' },
    })
    assert.equal(supp.status, 403, 'secreto global en supresión → 403')
  })
})

test('W-B3-02: credencial de la organización correcta → 200 con eco de organización', async () => {
  await withServer(async (base) => {
    const locks = await fetch(`${base}/api/internal/locks/573001112233`, {
      headers: { Authorization: `Bearer ${CRED_A}`, 'X-Org-Id': 'org_alpha' },
    })
    assert.equal(locks.status, 200)
    const lockBody = (await locks.json()) as { organizationId: string; locked: boolean }
    assert.equal(lockBody.organizationId, 'org_alpha')
    assert.equal(lockBody.locked, false)

    const supp = await fetch(`${base}/api/internal/suppression/573001112233`, {
      headers: { Authorization: `Bearer ${CRED_B}`, 'X-Org-Id': 'org_beta' },
    })
    assert.equal(supp.status, 200)
    const suppBody = (await supp.json()) as { organizationId: string; suppressed: boolean }
    assert.equal(suppBody.organizationId, 'org_beta')
    assert.equal(suppBody.suppressed, false)
  })
})

test('W-B3-03: acceso CRUZADO denegado — credencial de A con org B → 403 en toda la familia', async () => {
  await withServer(async (base) => {
    const cross = { Authorization: `Bearer ${CRED_A}`, 'X-Org-Id': 'org_beta' }
    const locks = await fetch(`${base}/api/internal/locks/573001112233`, { headers: cross })
    assert.equal(locks.status, 403, 'credencial de A con org B → 403')

    const suppGet = await fetch(`${base}/api/internal/suppression/573001112233`, { headers: cross })
    assert.equal(suppGet.status, 403)

    const suppPost = await fetch(`${base}/api/internal/suppression/573001112233`, {
      method: 'POST',
      headers: { ...cross, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'intento cruzado' }),
    })
    assert.equal(suppPost.status, 403, 'escritura cruzada de supresión → 403')

    const suppDel = await fetch(`${base}/api/internal/suppression/573001112233`, { method: 'DELETE', headers: cross })
    assert.equal(suppDel.status, 403, 'borrado cruzado de supresión → 403')

    const release = await fetch(`${base}/api/internal/locks/573001112233/release`, { method: 'POST', headers: cross })
    assert.equal(release.status, 403, 'release cruzado → 403')

    // Verificación de NO efectos: org_beta NO quedó suprimida por el intento cruzado
    const verifyBeta = await fetch(`${base}/api/internal/suppression/573001112233`, {
      headers: { Authorization: `Bearer ${CRED_B}`, 'X-Org-Id': 'org_beta' },
    })
    const betaBody = (await verifyBeta.json()) as { suppressed: boolean }
    assert.equal(betaBody.suppressed, false, 'el intento cruzado no escribió nada')
  })
})

test('W-B3-04: sin Bearer o sin X-Org-Id → 401 (fail-closed)', async () => {
  await withServer(async (base) => {
    const noBearer = await fetch(`${base}/api/internal/locks/573001112233`, { headers: { 'X-Org-Id': 'org_alpha' } })
    assert.equal(noBearer.status, 401)

    const noOrg = await fetch(`${base}/api/internal/locks/573001112233`, { headers: { Authorization: `Bearer ${CRED_A}` } })
    assert.equal(noOrg.status, 401)
  })
})

test('W-B3-05: escrituras legítimas con identidad vinculada funcionan y quedan en SU org', async () => {
  await withServer(async (base) => {
    const post = await fetch(`${base}/api/internal/suppression/573004445566`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CRED_A}`, 'X-Org-Id': 'org_alpha', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'baja legítima org A' }),
    })
    assert.equal(post.status, 200)
    const postBody = (await post.json()) as { organizationId: string; suppressed: boolean }
    assert.equal(postBody.organizationId, 'org_alpha')
    assert.equal(postBody.suppressed, true)

    // La supresión es de org A: org B (con SU credencial) NO la ve
    const betaView = await fetch(`${base}/api/internal/suppression/573004445566`, {
      headers: { Authorization: `Bearer ${CRED_B}`, 'X-Org-Id': 'org_beta' },
    })
    const betaBody = (await betaView.json()) as { suppressed: boolean }
    assert.equal(betaBody.suppressed, false, 'la baja de org A no se ve desde org B')

    // DELETE legítimo con la identidad de A
    const del = await fetch(`${base}/api/internal/suppression/573004445566`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${CRED_A}`, 'X-Org-Id': 'org_alpha' },
    })
    assert.equal(del.status, 200)
  })
})

test('W-B3-06: org SIN credenciales registradas → 403 incluso con el secreto global (provisión explícita)', async () => {
  await withServer(async (base) => {
    const unknown = await fetch(`${base}/api/internal/locks/573001112233`, {
      headers: { Authorization: `Bearer ${GLOBAL_SECRET}`, 'X-Org-Id': 'org_sin_provision' },
    })
    assert.equal(unknown.status, 403, 'sin provisión de credencial la org no puede operar')
  })
})
