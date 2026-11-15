/**
 * FASE 6 — hallazgo: la paleta del Flow Studio llama addNode('<tipo>') pero la
 * función NO existía (ReferenceError al hacer clic; el nodo jamás aparecía).
 *
 * Esta prueba verifica el CABLEADO del studio servido:
 *   1. Cada botón de la paleta (onclick="addNode('…')") tiene definición y
 *      default de datos en el HTML servido (NODE_PALETTE_DEFAULTS + function addNode).
 *   2. Cada tipo de nodo resultante es un FlowNodeType válido del motor
 *      (el mapeo action_tag→action corrige el tipo inválido de la paleta).
 *
 * Antes del fix: fail (function addNode ausente). Después: pass.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderStudioHtml } from '../src/studio/studio-html.ts'

test('STUDIO-ADDNODE-1: la paleta anuncia nodos pero la función addNode DEBE existir en el HTML servido', () => {
  const html = renderStudioHtml()
  const paletteCalls = [...html.matchAll(/onclick="addNode\('([^']+)'\)"/g)].map((m) => m[1])
  assert.ok(paletteCalls.length >= 7, `la paleta debe tener >=7 botones addNode, encontrados=${paletteCalls.length}`)
  assert.ok(/function addNode\s*\(/.test(html), 'function addNode( debe estar definida en el script servido')
  assert.ok(/NODE_PALETTE_DEFAULTS/.test(html), 'los defaults de nodos de la paleta deben estar definidos')
  for (const key of paletteCalls) {
    assert.ok(html.includes(`'${key}':`), `el tipo de paleta '${key}' debe tener entrada en NODE_PALETTE_DEFAULTS`)
  }
})

test('STUDIO-ADDNODE-2: todo tipo de nodo creado por la paleta es un FlowNodeType válido del motor', () => {
  const html = renderStudioHtml()
  const paletteCalls = [...html.matchAll(/onclick="addNode\('([^']+)'\)"/g)].map((m) => m[1])
  // Tipos válidos según src/engine/flow-types.ts (FlowNodeType)
  const VALID_NODE_TYPES = new Set([
    'trigger', 'send_message', 'user_input', 'condition', 'action', 'crm_action', 'ab_split', 'handoff',
    'delay', 'smart_delay', 'goto_flow', 'ai_response',
  ])
  // Extraer el mapeo clave → tipo servido:  '<clave>': { ... type: '<tipo>' ...
  for (const key of paletteCalls) {
    const start = html.indexOf(`'${key}': {`)
    assert.ok(start >= 0, `la clave '${key}' debe tener entrada en NODE_PALETTE_DEFAULTS`)
    // bloque = desde la entrada hasta el cierre de la siguiente clave o fin del objeto
    const nextKey = html.slice(start + 1).search(/'\w+': \{/)
    const block = html.slice(start, nextKey >= 0 ? start + 1 + nextKey : undefined)
    const typeMatch = block.match(/type:\s*'([a-z_]+)'/)
    const resolved = typeMatch ? typeMatch[1] : key // sin 'type:' explícito, el tipo ES la clave
    assert.ok(VALID_NODE_TYPES.has(resolved), `la clave '${key}' resuelve al tipo '${resolved}', que NO es un FlowNodeType válido`)
  }
})

test('STUDIO-ADDNODE-3: addNode crea un borrador de flujo si no hay ninguno seleccionado (no explota)', () => {
  const html = renderStudioHtml()
  // El comportamiento sin currentFlow debe crear un borrador local, no lanzar error.
  assert.ok(/if\s*\(!currentFlow\)[\s\S]{0,400}nodes:\s*\[\]/.test(html), 'addNode debe manejar la ausencia de flujo creando un borrador con nodes: []')
  assert.ok(/currentFlow\.nodes\.push\(node\)/.test(html), 'addNode debe añadir el nodo a currentFlow.nodes')
  assert.ok(/renderCanvas\(\)/.test(html.split('function addNode')[1]?.split('function ')[0] ?? ''), 'addNode debe repintar el lienzo con renderCanvas()')
})
