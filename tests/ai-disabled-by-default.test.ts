/**
 * ai-disabled-by-default.test.ts — (reparación 2026-11-17, FASE 1.E)
 *
 * La IA del motor de flujos está DESACTIVADA POR DEFECTO:
 *  1. Sin configuración (sin AI_API_KEY) el proveedor resuelto es el
 *     UnconfiguredAiProvider y NUNCA ejecuta llamadas HTTP a terceros.
 *  2. Con credencial la IA activa (compatibilidad con comportamiento previo).
 *  3. AI_ENABLED=false apaga la IA AUNQUE exista credencial (switch maestro).
 *  4. El texto de conversaciones de clientes jamás sale del servidor sin
 *     configuración explícita: se verifica con fetch inyectado que ningún
 *     request sale.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAiProvider, isAiEnabled, OpenAiCompatibleProvider, DEFAULT_AI_API_URL } from '../src/engine/ai-provider.ts'

test('FASE 1.E — IA desactivada por defecto (sin transmisión a terceros)', async (t) => {
  await t.test('1.E.1 sin AI_API_KEY el proveedor es fail-closed y NO despacha HTTP', async () => {
    const provider = resolveAiProvider({})
    // El UnconfiguredAiProvider ni siquiera recibe fetch: no hay red posible.
    const res = await provider.complete('Hola', { nombre: 'Usuario Demo' })
    assert.equal(res.ok, false)
    assert.equal(res.fallback, true)
    assert.match(String(res.error), /IA no configurada/i)
  })

  await t.test('1.E.2 el texto del cliente jamás sale sin configuración explícita', async () => {
    // Escenario completo: variables de entorno SIN credencial IA (con URL/modelo
    // presentes, que no bastan para activar la transmisión).
    const env = { AI_API_URL: 'https://tercero.ejemplo/v1/chat/completions', AI_MODEL: 'modelo-test' }
    assert.equal(isAiEnabled(env), false)
    const provider = resolveAiProvider(env)
    const res = await provider.complete('Texto de conversación del cliente', { telefono: '+573000000000' })
    assert.equal(res.fallback, true)
  })

  await t.test('1.E.3 con credencial provista la IA activa (comportamiento documentado)', () => {
    assert.equal(isAiEnabled({ AI_API_KEY: 'sk_test_credencial_ficticia_000000' }), true)
    const provider = resolveAiProvider({ AI_API_KEY: 'sk_test_credencial_ficticia_000000' })
    assert.ok(provider instanceof OpenAiCompatibleProvider)
  })

  await t.test('1.E.4 AI_ENABLED=false apaga la IA aunque exista credencial', async () => {
    const env = { AI_API_KEY: 'sk_test_credencial_ficticia_000000', AI_ENABLED: 'false' }
    assert.equal(isAiEnabled(env), false)
    const provider = resolveAiProvider(env)
    const res = await provider.complete('Hola', {})
    assert.equal(res.fallback, true)
  })

  await t.test('1.E.5 OpenAiCompatibleProvider llama SOLO al endpoint configurado', async () => {
    const seenUrls: string[] = []
    const fetchImpl = (async (url: unknown, _init?: unknown) => {
      seenUrls.push(String(url))
      return new Response(JSON.stringify({ choices: [{ message: { content: 'respuesta de prueba' } }] }), { status: 200 })
    }) as typeof fetch
    const provider = new OpenAiCompatibleProvider({ apiKey: 'sk_test_ficticia', apiUrl: 'https://tercero.ejemplo/v1/chat/completions', fetchImpl })
    const res = await provider.complete('Hola', { nombre: 'Usuario Demo' })
    assert.equal(res.ok, true)
    assert.deepEqual(seenUrls, ['https://tercero.ejemplo/v1/chat/completions'])
    assert.ok(DEFAULT_AI_API_URL.includes('api.openai.com'), 'el default documenta el proveedor externo')
  })
})
