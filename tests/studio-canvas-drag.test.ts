/**
 * LIENZO INTERACTIVO (ronda 8) — el usuario dijo: «los flujos conversacionales
 * no los puedo mover, quedan estáticos». Antes de este cambio, renderCanvas()
 * pintaba las cajas en posiciones guardadas y no había ni un solo manejador de
 * arrastre: solo la paleta podía crear nodos, y siempre en rejilla.
 *
 * Esta suite comprueba dos cosas distintas:
 *   A. CABLEADO (leído en el HTML servido): hay arrastre, puertos de salida,
 *      creación de flechas, guardado automático y deshacer.
 *   B. PERSISTENCIA (servidor real + SQLite en memoria): la posición movida y
 *      la flecha nueva vuelven tal cual al volver a pedir los flujos. Sin esto
 *      el arrastre sería decorativo: al recargar se perdería.
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { renderStudioHtml } from '../src/studio/studio-html.ts'
import { createAgenticServer } from '../src/server.ts'

process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'wp_test_internal_secret_min24chars_000'
const AUTH = { Authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` }

test('CANVAS-01: el lienzo servido escucha arrastre (pointerdown/move/up) y mueve la posición del nodo', () => {
  const html = renderStudioHtml()
  assert.match(html, /canvas\.addEventListener\('pointerdown'/, 'falta pointerdown en el lienzo')
  assert.match(html, /window\.addEventListener\('pointermove'/, 'falta pointermove (el arrastre seguiría fuera del lienzo)')
  assert.match(html, /window\.addEventListener\('pointerup'/, 'falta pointerup: el nodo se quedaría pegado al ratón')
  assert.match(html, /function startDrag\s*\(/, 'falta la función que inicia el arrastre')
  assert.match(html, /function onDragMove\s*\(/, 'falta la función que mueve el nodo')
  assert.match(html, /dragState\.node\.position = \{ x: x, y: y \}/, 'el arrastre debe escribir la posición en el nodo')
  assert.match(html, /dragState\.el\.style\.left = x \+ 'px'/, 'el arrastre debe mover la caja en pantalla')
  assert.match(html, /renderEdges\(\)/, 'al mover un nodo hay que redibujar las flechas')
})

test('CANVAS-02: cada nodo tiene puertos de salida y arrastrar de uno a otro crea la flecha', () => {
  const html = renderStudioHtml()
  assert.match(html, /function appendPorts\s*\(/, 'falta pintar los puertos en cada nodo')
  assert.match(html, /function outPorts\s*\(/, 'falta decidir cuántas salidas tiene cada tipo')
  // Una condición tiene dos salidas (Sí / No) y un reparto A/B tiene dos ramas:
  // son los sourceHandle que el motor ya usa para elegir camino.
  assert.match(html, /handle: 'yes', label: 'Sí'/, 'la condición debe ofrecer la salida yes')
  assert.match(html, /handle: 'no', label: 'No'/, 'la condición debe ofrecer la salida no')
  assert.match(html, /handle: 'a', label: 'A'/, 'el reparto A/B debe ofrecer la rama a')
  assert.match(html, /handle: 'b', label: 'B'/, 'el reparto A/B debe ofrecer la rama b')
  assert.match(html, /port-out/, 'los puertos deben ser clicables (clase port-out)')
  assert.match(html, /function startLink\s*\(/, 'falta empezar la flecha desde un puerto')
  assert.match(html, /function connectNodes\s*\(/, 'falta crear la conexión entre dos nodos')
  assert.match(html, /sourceHandle: handle/, 'la flecha nueva debe llevar su sourceHandle')
  assert.match(html, /marker-end/, 'la flecha debe verse con punta')
  // Reglas de cordura: nada de unirse a sí mismo ni duplicar la misma salida.
  assert.match(html, /Un nodo no puede unirse consigo mismo/)
  assert.match(html, /ya están unidos por esa salida/)
})

test('CANVAS-03: mover y conectar se guarda solo, se puede deshacer y borrar', () => {
  const html = renderStudioHtml()
  assert.match(html, /id="saveState"/, 'falta el aviso de guardado en la barra')
  assert.match(html, /function scheduleSave\s*\(/, 'falta el guardado automático (con retardo)')
  assert.match(html, /async function persistFlow\s*\(/, 'falta la petición que guarda el flujo')
  assert.match(html, /fetch\('\/api\/flows'/, 'el guardado debe ir a /api/flows')
  assert.match(html, /function snapshot\s*\(/, 'falta la foto previa para deshacer')
  assert.match(html, /function undo\s*\(/, 'falta deshacer')
  assert.match(html, /ev\.key === 'z'/, 'deshacer debe escuchar Ctrl+Z')
  assert.match(html, /function deleteEdge\s*\(/, 'falta borrar una flecha')
  assert.match(html, /function deleteNode\s*\(/, 'falta borrar un nodo')
  assert.match(html, /ev\.key === 'Delete'/, 'Supr debe borrar lo seleccionado')
  // La caja arrastrada a la izquierda de todo tiene x = 0: no debe volver a 100.
  assert.match(html, /function nodePos\s*\(/, 'falta el lector de posición que respeta x = 0')
  assert.equal(/\(node\.position\?\.x \|\| 100\)/.test(html), false, 'x = 0 no puede caer al valor por defecto')
  // Estilos que hacen visible el arrastre y los puertos.
  assert.match(html, /\.node \{ cursor: grab/, 'el nodo debe mostrar la manita de agarrar')
  assert.match(html, /body\.is-dragging/, 'hace falta el estado visual de arrastre')
  assert.match(html, /\.port-out/, 'los puertos necesitan estilo')
})

test('CANVAS-04: la posición movida y la flecha nueva sobreviven al recargar (servidor real)', async () => {
  const { server } = createAgenticServer({ dbPath: ':memory:' })
  await new Promise<void>((resolve) => server.listen(0, () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `http://127.0.0.1:${port}`
  const org = 'org_canvas'

  try {
    const cabeceras = { 'Content-Type': 'application/json', ...AUTH, 'X-Org-Id': org }
    const flow = {
      id: 'flow_arrastrable',
      name: 'Flujo arrastrable',
      triggerKeywords: ['mover'],
      isActive: true,
      nodes: [
        { id: 'n1', type: 'trigger', title: 'Inicio', position: { x: 40, y: 120 } },
        { id: 'n2', type: 'send_message', title: 'Hola', position: { x: 320, y: 120 }, data: { messageText: 'hola' } },
      ],
      edges: [] as Array<{ id: string; source: string; target: string; sourceHandle?: string }>,
    }

    const creado = await fetch(`${base}/api/flows`, { method: 'POST', headers: cabeceras, body: JSON.stringify(flow) })
    assert.strictEqual(creado.status, 200)

    // El usuario arrastra n1 a otra esquina y lo une a n2 (equivalente a soltar).
    flow.nodes[0].position = { x: 640, y: 420 }
    flow.edges.push({ id: 'e_prueba', source: 'n1', target: 'n2', sourceHandle: 'default' })
    const guardado = await fetch(`${base}/api/flows`, { method: 'POST', headers: cabeceras, body: JSON.stringify(flow) })
    assert.strictEqual(guardado.status, 200)

    // Recargar la página = volver a pedir los flujos.
    const lista = await (await fetch(`${base}/api/flows`, { headers: { ...AUTH, 'X-Org-Id': org } })).json() as Array<{
      id: string
      nodes: Array<{ id: string; position?: { x: number; y: number } }>
      edges: Array<{ source: string; target: string; sourceHandle?: string }>
    }>
    const leido = lista.find((f) => f.id === 'flow_arrastrable')
    assert.ok(leido, 'el flujo guardado debe volver al listar')
    const n1 = leido!.nodes.find((n) => n.id === 'n1')
    assert.deepStrictEqual(n1?.position, { x: 640, y: 420 }, 'la posición arrastrada debe quedar guardada')
    assert.strictEqual(leido!.edges.length, 1, 'la flecha nueva debe quedar guardada')
    assert.strictEqual(leido!.edges[0].source, 'n1')
    assert.strictEqual(leido!.edges[0].target, 'n2')
    assert.strictEqual(leido!.edges[0].sourceHandle, 'default', 'sin sourceHandle el motor no sabe qué camino tomar')
  } finally {
    server.close()
  }
})
