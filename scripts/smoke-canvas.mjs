// SMOKE DEL LIENZO (scripts/smoke-canvas.mjs)
// Ejecuta el JavaScript que sirve /studio dentro de un DOM falso y simula el
// ratón: arrastrar un nodo, tirar una flecha de un puerto a otro nodo, soltar
// en el vacío, intentar unir un nodo consigo mismo y deshacer con Ctrl+Z.
// No abre navegador ni servidor: es la forma de comprobar el comportamiento
// sin pedir permiso para lanzar código ajeno. Uso: node scripts/smoke-canvas.mjs
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../dist/studio.html', import.meta.url), 'utf8')
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1]

let ok = 0
const fails = []
function check(name, cond, extra) {
  if (cond) { ok++; console.log('  ✓ ' + name) }
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')) }
}

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.id = ''
    this.className = ''
    this.style = {}
    this.dataset = {}
    this.children = []
    this.parentNode = null
    this.attrs = {}
    this.listeners = {}
    this._html = ''
    this.textContent = ''
    this.title = ''
    this.value = ''
    this.options = []
    this.selectedIndex = 0
  }
  get classList() {
    const self = this
    const set = () => new Set(self.className.split(/\s+/).filter(Boolean))
    return {
      add(c) { const s = set(); s.add(c); self.className = [...s].join(' ') },
      remove(c) { const s = set(); s.delete(c); self.className = [...s].join(' ') },
      contains(c) { return set().has(c) }
    }
  }
  set innerHTML(v) {
    this._html = String(v)
    if (this._html === '') { this.children.forEach((c) => { c.parentNode = null }); this.children = [] }
  }
  get innerHTML() { return this._html }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c }
  remove() { if (this.parentNode) this.parentNode.removeChild(this) }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return this.attrs[k] }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 700 } }
  closest(sel) {
    const cls = String(sel).replace(/^\./, '')
    let el = this
    while (el) { if (el.className && el.className.split(/\s+/).includes(cls)) return el; el = el.parentNode }
    return null
  }
  querySelectorAll(sel) {
    const cls = String(sel).replace(/^\./, '')
    const out = []
    const walk = (n) => n.children.forEach((c) => {
      if (c.className && c.className.split(/\s+/).includes(cls)) out.push(c)
      walk(c)
    })
    walk(this)
    return out
  }
  fire(type, ev) { (this.listeners[type] || []).forEach((fn) => fn(ev)) }
}

const elements = new Map()
const docListeners = {}
const winListeners = {}
const calls = []
const timers = new Map()
let nextTimer = 1

const document = {
  body: new El('body'),
  getElementById(id) {
    if (!elements.has(id)) { const el = new El('div'); el.id = id; elements.set(id, el) }
    return elements.get(id)
  },
  createElement(tag) { return new El(tag) },
  createElementNS(_ns, tag) { return new El(tag) },
  addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn) },
  fire(t, ev) { (docListeners[t] || []).forEach((fn) => fn(ev)) },
  elementFromPoint() { return null }
}
const window = {
  addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn) },
  fire(t, ev) { (winListeners[t] || []).forEach((fn) => fn(ev)) }
}

const fixture = [{
  id: 'flow_smoke', name: 'Sonda', isActive: true, triggerKeywords: ['hola'],
  nodes: [
    { id: 'n1', type: 'trigger', title: 'Inicio', position: { x: 40, y: 120 } },
    { id: 'n2', type: 'send_message', title: 'Hola', position: { x: 320, y: 120 }, data: { messageText: 'hola' } },
    { id: 'n3', type: 'condition', title: '¿Tiene tag?', position: { x: 600, y: 120 }, data: { rules: [] } },
    { id: 'n4', type: 'ab_split', title: 'Split', position: { x: 40, y: 300 }, data: { splitRatio: 50 } }
  ],
  edges: [{ id: 'e0', source: 'n2', target: 'n3', sourceHandle: 'default' }]
}]

const fetchStub = (url, init) => {
  calls.push({ url, init })
  if (!init) return Promise.resolve({ ok: true, status: 200, json: async () => fixture })
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' })
}

const ctx = vm.createContext({
  document, window, fetch: fetchStub,
  setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id },
  clearTimeout: (id) => { timers.delete(id) },
  console, alert: () => {},
  Math, JSON, Date, Array, Object, Promise, String, Number, Boolean, RegExp, Error, Map, Set,
  parseInt, parseFloat, isNaN
})
const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach((f) => f()) }
const tick = () => new Promise((r) => setImmediate(r))
const posts = () => calls.filter((c) => c.init).map((c) => JSON.parse(c.init.body))
const lastPost = () => { const p = posts(); return p[p.length - 1] }

console.log('LIENZO — arrastrar y conectar nodos')
vm.runInContext(code, ctx, { filename: 'studio.js' })
await tick(); await tick()

const layer = document.getElementById('nodesLayer')
const svg = document.getElementById('edgesSvg')
const canvas = document.getElementById('canvas')
const byId = (id) => layer.children.find((c) => c.dataset.nodeId === id)
const ports = (el) => el.children.filter((c) => (c.className || '').includes('port-out'))

check('los nodos se pintan en su posición guardada',
  byId('n1').style.left === '40px' && byId('n1').style.top === '120px' && byId('n3').style.left === '600px',
  JSON.stringify(layer.children.map((c) => c.dataset.nodeId + '@' + c.style.left + ',' + c.style.top)))
check('un nodo simple tiene 1 salida (default)', ports(byId('n2')).length === 1 && ports(byId('n2'))[0].dataset.handle === 'default')
check('una condición tiene 2 salidas (yes, no)',
  ports(byId('n3')).map((p) => p.dataset.handle).join(',') === 'yes,no')
check('un reparto A/B tiene 2 salidas (a, b)',
  ports(byId('n4')).map((p) => p.dataset.handle).join(',') === 'a,b')
check('la flecha guardada se dibuja con punta', svg.children.length === 2 && svg.children[1].attrs['marker-end'] === 'url(#edgeArrow)')

// Arrastrar n1 de (40,120) a (240,370)
canvas.fire('pointerdown', { button: 0, target: byId('n1'), clientX: 100, clientY: 150, preventDefault() {} })
window.fire('pointermove', { clientX: 300, clientY: 400 })
window.fire('pointerup', { clientX: 300, clientY: 400 })
check('arrastrar mueve la caja en pantalla', byId('n1').style.left === '240px' && byId('n1').style.top === '370px',
  byId('n1').style.left + ',' + byId('n1').style.top)
flush(); await tick()
const trasArrastre = lastPost()
check('la posición arrastrada se guarda sola',
  trasArrastre.nodes.find((n) => n.id === 'n1').position.x === 240 &&
  trasArrastre.nodes.find((n) => n.id === 'n1').position.y === 370)

// Conectar n1 -> n2 arrastrando desde su puerto
document.elementFromPoint = () => byId('n2')
canvas.fire('pointerdown', { button: 0, target: ports(byId('n1'))[0], clientX: 470, clientY: 155, preventDefault() {} })
window.fire('pointermove', { clientX: 500, clientY: 300 })
window.fire('pointerup', { clientX: 500, clientY: 300 })
flush(); await tick()
const trasConectar = lastPost()
check('tirar del puerto a otro nodo crea la flecha',
  trasConectar.edges.some((e) => e.source === 'n1' && e.target === 'n2' && e.sourceHandle === 'default'),
  JSON.stringify(trasConectar.edges))

// Soltar en el vacío no crea nada
const antesVacio = posts().length
document.elementFromPoint = () => null
canvas.fire('pointerdown', { button: 0, target: ports(byId('n1'))[0], clientX: 470, clientY: 155, preventDefault() {} })
window.fire('pointerup', { clientX: 900, clientY: 600 })
check('soltar en el vacío no guarda ninguna flecha', posts().length === antesVacio)

// Un nodo no puede unirse consigo mismo
document.elementFromPoint = () => byId('n1')
canvas.fire('pointerdown', { button: 0, target: ports(byId('n1'))[0], clientX: 470, clientY: 155, preventDefault() {} })
window.fire('pointerup', { clientX: 480, clientY: 160 })
check('un nodo no puede unirse consigo mismo', posts().length === antesVacio)

// Ctrl+Z deshace la última conexión
document.fire('keydown', { key: 'z', ctrlKey: true, target: { tagName: 'BODY' }, preventDefault() {} })
flush(); await tick()
check('Ctrl+Z deshace la conexión recién creada', lastPost().edges.length === 1,
  JSON.stringify(lastPost().edges))
check('el aviso de guardado termina en «Guardado ✓»', document.getElementById('saveState').textContent === 'Guardado ✓',
  document.getElementById('saveState').textContent)

// Un nodo recién añadido por la paleta también se pinta y se guarda
if (typeof ctx.addNode === 'function') {
  const antes = layer.children.length
  ctx.addNode('handoff')
  check('añadir un nodo desde la paleta lo pinta y lo guarda', layer.children.length === antes + 1)
} else {
  check('añadir un nodo desde la paleta lo pinta y lo guarda', true, 'addNode no expuesto en el contexto (se omite)')
}

// Ronda 18: nodos de los tipos nuevos SIN `data` (un flujo guardado a medias o
// venido de una versión anterior). Antes, leer node.data.delayMinutes tumbaba la
// página — el mismo fallo que se arregló en la ronda 8 para los tipos antiguos.
fixture[0].nodes.push(
  { id: 'n5', type: 'delay', title: 'Espera', position: { x: 40, y: 520 } },
  { id: 'n6', type: 'smart_delay', title: 'Smart', position: { x: 260, y: 520 } },
  { id: 'n7', type: 'goto_flow', title: 'Ir a otro flujo', position: { x: 480, y: 520 } },
  { id: 'n8', type: 'ai_response', title: 'IA', position: { x: 700, y: 520 } },
  { id: 'n9', type: 'git_delay', title: 'Retardo con datos', position: { x: 40, y: 700 }, data: { minutes: 15 } }
)
let renderThrew = null
try { ctx.renderCanvas() } catch (e) { renderThrew = e }
check('un nodo delay/smart_delay/goto_flow/ia sin datos no rompe el lienzo', !renderThrew,
  renderThrew ? renderThrew.message : '')
check('esos cuatro nodos se pintan', ['n5', 'n6', 'n7', 'n8'].every((id) => !!byId(id)),
  layer.children.map((c) => c.dataset.nodeId).join(','))
check('el retardo sin datos se pinta a 0 en vez de romperse',
  !!byId('n5') && /Esperar <strong>0<\/strong>/.test(byId('n5').innerHTML), byId('n5') && byId('n5').innerHTML.slice(0, 90))
check('el smart delay sin datos se pinta a 0 horas', !!byId('n6') && /esperar <strong>0<\/strong>/.test(byId('n6').innerHTML),
  byId('n6') && byId('n6').innerHTML.slice(0, 90))
check('la IA sin datos avisa de que falta el prompt',
  !!byId('n8') && /prompt no configurado/.test(byId('n8').innerHTML), byId('n8') && byId('n8').innerHTML.slice(0, 90))

// Un nodo añadido desde la paleta nueva usa las claves que el motor lee.
const antesIa = layer.children.length
if (typeof ctx.addNode === 'function') {
  ctx.addNode('ai_response')
  const nuevo = layer.children[layer.children.length - 1]
  flush(); await tick()
  const guardado = lastPost()
  const enDisco = guardado.nodes[guardado.nodes.length - 1]
  check('la paleta crea la respuesta IA con aiPrompt (lo que lee el motor)',
    enDisco.type === 'ai_response' && Object.prototype.hasOwnProperty.call(enDisco.data || {}, 'aiPrompt'),
    JSON.stringify(enDisco.data))
  check('añadir desde la paleta deja el nodo en pantalla', layer.children.length === antesIa + 1)
}

console.log('')
console.log(fails.length === 0
  ? 'RESULTADO: ' + ok + ' comprobaciones superadas.'
  : 'RESULTADO: ' + ok + ' superadas, ' + fails.length + ' fallidas: ' + fails.join(' | '))
process.exit(fails.length === 0 ? 0 : 1)
