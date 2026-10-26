import { test } from 'node:test'
import assert from 'node:assert'
import { createAgenticServer } from '../src/server.ts'

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

    // 2. GET /api/flows
    const resFlows = await fetch('http://localhost:3015/api/flows')
    assert.strictEqual(resFlows.status, 200)
    const flows = await resFlows.json()
    assert.ok(flows.length >= 1)
    assert.ok(flows[0].name.includes('Calificación'))

    // 3. POST /api/flows/simulate
    const resSim = await fetch('http://localhost:3015/api/flows/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+573009991122', messageText: 'precio', name: 'Simulada' })
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
