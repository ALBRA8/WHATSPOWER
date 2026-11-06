import { test } from 'node:test'
import assert from 'node:assert'
import { createAgenticServer } from '../src/server.ts'

// Orden de cierre 2026-11-06: las rutas /api/* exigen Bearer INTERNAL_API_SECRET.
// El secreto de test se define en el entorno antes de crear el servidor.
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'wp_test_internal_secret_min24chars_000'
const AUTH = { 'Authorization': `Bearer ${process.env.INTERNAL_API_SECRET}` }

test('SUITE: WhatsPower Studio HTTP API & Web Interface', async () => {
  const { server } = createAgenticServer({ dbPath: ':memory:' })
  await new Promise<void>((resolve) => server.listen(3015, () => resolve()))

  try {
    // 1. GET /studio
    const resStudio = await fetch('http://localhost:3015/studio')
    assert.strictEqual(resStudio.status, 200)
    const html = await resStudio.text()
    assert.ok(html.includes('WhatsPower Flow Studio'))
    assert.ok(html.includes('Simulador'))

    // 1b. GET /api/flows SIN auth → 401 (contrato nuevo)
    const resAnon = await fetch('http://localhost:3015/api/flows')
    assert.strictEqual(resAnon.status, 401)

    // 1c. GET /api/flows autenticado SIN x-org-id → 400 (tercera reparación 4.B)
    const resNoOrg = await fetch('http://localhost:3015/api/flows', { headers: AUTH })
    assert.strictEqual(resNoOrg.status, 400)

    // 2. GET /api/flows autenticado CON org (seed perezosa por-org al listar)
    const resFlows = await fetch('http://localhost:3015/api/flows', { headers: { ...AUTH, 'X-Org-Id': 'org_test' } })
    assert.strictEqual(resFlows.status, 200)
    const flows = await resFlows.json()
    assert.ok(flows.length >= 1)
    assert.ok(flows[0].name.includes('Calificación'))
    // Aislamiento: cada org tiene SU espacio de flujos (la seed de org_otra es una copia propia)
    const resFlowsB = await fetch('http://localhost:3015/api/flows', { headers: { ...AUTH, 'X-Org-Id': 'org_otra' } })
    const flowsB = await resFlowsB.json()
    assert.ok(Array.isArray(flowsB) && flowsB.length >= 1)
    // POST un flujo privado en org_test y verificar que org_otra NO lo ve
    const resPriv = await fetch('http://localhost:3015/api/flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH, 'X-Org-Id': 'org_test' },
      body: JSON.stringify({ id: 'flow_privado_api', name: 'Privado API', triggerKeywords: ['privado'], isActive: true, nodes: [], edges: [] }),
    })
    assert.strictEqual(resPriv.status, 200)
    const flowsB2 = await (await fetch('http://localhost:3015/api/flows', { headers: { ...AUTH, 'X-Org-Id': 'org_otra' } })).json()
    assert.ok(flowsB2.every((f: { id: string }) => f.id !== 'flow_privado_api'), 'org_otra no ve el flujo privado de org_test')

    // 3. POST /api/flows/simulate autenticado
    const resSim = await fetch('http://localhost:3015/api/flows/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ orgId: 'org_test', phone: '+573009991122', messageText: 'precio', name: 'Simulada' })
    })
    assert.strictEqual(resSim.status, 200)
    const simData = await resSim.json()
    assert.strictEqual(simData.handled, true)
    const msg0 = simData.messagesToSend[0]
    const text0 = typeof msg0 === 'string' ? msg0 : msg0.text
    assert.ok(text0.includes('¡Hola Simulada!'))
  } finally {
    server.close()
  }
})
