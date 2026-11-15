// Ejecuta el cliente real del panel (src/dashboard/dashboard-client.js) dentro de
// una página falsa, con `fetch` devolviendo HTML en vez de JSON, y comprueba que
// cada pantalla avisa ("no está conectada al servidor") en lugar de romperse.
//
// Qué demuestra: que las funciones de pintado no lanzan con una respuesta que no
// es la esperada. Qué NO demuestra: cómo se ve el panel en un navegador de verdad.
//
// Uso: node scripts/smoke-offline.mjs
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync('src/dashboard/dashboard-client.js', 'utf8')

/* --- página falsa mínima: cada selector devuelve siempre el mismo nodo --- */
function makeNode(name) {
  return {
    __name: name,
    innerHTML: '',
    textContent: '',
    value: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, contains() { return false }, toggle() {} },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null },
    appendChild() {},
    remove() {},
    focus() {},
    click() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
  }
}

const nodes = new Map()
const pick = (selector) => {
  if (!nodes.has(selector)) nodes.set(selector, makeNode(selector))
  return nodes.get(selector)
}
const html = (selector) => String(pick(selector).innerHTML || '')

const documentStub = {
  body: makeNode('body'),
  documentElement: makeNode('html'),
  querySelector: (selector) => pick(selector),
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => makeNode('created'),
}

/* --- respuestas: JSON correcto o HTML sin API --- */
let answer = { status: 200, body: '<!doctype html><html><body>sin API</body></html>' }
const setJson = (value) => { answer = { status: 200, body: JSON.stringify(value) } }
const setHtml = () => { answer = { status: 200, body: '<!doctype html><html><body>sin API</body></html>' } }

const locationStub = { pathname: '/dashboard', search: '', hash: '', href: 'http://127.0.0.1/dashboard', assign() {} }

const context = vm.createContext({
  document: documentStub,
  location: locationStub,
  history: { replaceState() {}, pushState() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: async () => ({ status: answer.status, ok: answer.status < 400, text: async () => answer.body }),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  navigator: { userAgent: 'smoke' },
})
// `window` responde a cualquier método con un no-op: el cliente sólo lo usa para
// escuchar popstate y leer tamaños, y aquí no hay navegador.
context.window = new Proxy({ location: locationStub, innerWidth: 1440, innerHeight: 900 }, {
  get(target, prop) {
    if (prop in target) return target[prop]
    return () => {}
  },
})
context.globalThis = context

vm.runInContext(source, context, { filename: 'dashboard-client.js' })

const checks = []
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail || '' }) }

const OFFLINE = 'no está conectada al servidor'

// Se deja terminar boot_app(), que también se topa con el HTML.
await new Promise((resolve) => setTimeout(resolve, 60))

/* 1 — contactos */
setHtml()
pick('#c-body').innerHTML = ''
let threw = null
try { await context.paintContacts() } catch (e) { threw = e }
check('contactos: no lanza con HTML en vez de JSON', !threw, threw ? threw.message : '')
check('contactos: avisa de que no hay servidor', html('#c-body').includes(OFFLINE), html('#c-body').slice(0, 90))

/* 2 — bandeja */
pick('#conv-list').innerHTML = ''
threw = null
try { await context.paintConversations() } catch (e) { threw = e }
check('bandeja: no lanza con HTML en vez de JSON', !threw, threw ? threw.message : '')
check('bandeja: avisa de que no hay servidor', html('#conv-list').includes(OFFLINE), html('#conv-list').slice(0, 90))

/* 3 — conversación abierta (hilo) */
pick('#thread').innerHTML = ''
threw = null
try { await context.openConversation('600111222', true) } catch (e) { threw = e }
check('hilo: no lanza con HTML en vez de JSON', !threw, threw ? threw.message : '')
check('hilo: avisa de que no hay servidor', html('#thread').includes(OFFLINE), html('#thread').slice(0, 90))

/* 4 — automatizaciones (lista de flujos) */
vm.runInContext("state.tab = 'flows'", context)
pick('#aut-body').innerHTML = ''
threw = null
try { await context.paintAutomations() } catch (e) { threw = e }
check('flujos: no lanza con HTML en vez de JSON', !threw, threw ? threw.message : '')
check('flujos: avisa de que no hay servidor', html('#aut-body').includes(OFFLINE), html('#aut-body').slice(0, 90))

/* 5 — ajustes (lee data.transports: sobre undefined reventaba) */
setHtml()
pick('#view').innerHTML = ''
threw = null
try { await context.viewSettings() } catch (e) { threw = e }
check('ajustes: no lanza con HTML en vez de JSON', !threw, threw ? threw.message : '')
check('ajustes: avisa de que no hay servidor', html('#view').includes(OFFLINE), html('#view').slice(0, 90))

/* 6 — secuencias (lee data.sequences: sobre undefined reventaba) */
setHtml()
vm.runInContext("state.tab = 'sequences'", context)
pick('#aut-body').innerHTML = ''
threw = null
try { await context.paintAutomations() } catch (e) { threw = e }
check('secuencias: no lanza con HTML en vez de JSON', !threw, threw ? threw.message : '')
check('secuencias: avisa de que no hay servidor', html('#aut-body').includes(OFFLINE), html('#aut-body').slice(0, 90))

/* 7 — con datos buenos sigue funcionando (una lista vacía no es un error) */
setJson({ total: 0, tags: ['vip'], contacts: [] })
pick('#c-body').innerHTML = ''
threw = null
try { await context.paintContacts() } catch (e) { threw = e }
check('contactos: con JSON bueno no avisa de servidor', !threw && !html('#c-body').includes(OFFLINE), (threw && threw.message) || html('#c-body').slice(0, 90))

setJson({ conversations: [], totals: { all: 0, open: 0 } })
pick('#conv-list').innerHTML = ''
threw = null
try { await context.paintConversations() } catch (e) { threw = e }
check('bandeja: con JSON bueno pinta la bandeja vacía', !threw && html('#conv-list').includes('Bandeja vacía'), (threw && threw.message) || html('#conv-list').slice(0, 90))

setJson({ messages: [{ direction: 'inbound', text: 'hola', created_at: Date.now() - 60000 }] })
pick('#thread').innerHTML = ''
threw = null
try { await context.openConversation('600111222', true) } catch (e) { threw = e }
check('hilo: con JSON bueno pinta el mensaje', !threw && html('#thread').includes('hola'), (threw && threw.message) || html('#thread').slice(0, 90))

setJson({ transports: { mode: 'mock', realDispatch: false, webhookConfigured: false, paymentsMode: 'mock' }, agents: [], canned: [], org: 'demo' })
pick('#view').innerHTML = ''
threw = null
try { await context.viewSettings() } catch (e) { threw = e }
check('ajustes: con JSON bueno pinta el transporte', !threw && html('#view').includes('mock'), (threw && threw.message) || html('#view').slice(0, 90))

/* 8 — un contacto sin etiquetas no puede romper la lista ni la ficha */
setJson({ total: 1, tags: ['vip'], contacts: [{ phone: '600111222', tags: null, messageCount: 3, lastMessageAt: Date.now() - 3600000, lockState: 'BOT' }] })
pick('#c-body').innerHTML = ''
threw = null
try { await context.paintContacts() } catch (e) { threw = e }
check('contactos: un contacto sin etiquetas no rompe la lista', !threw && html('#c-body').includes('600111222'), (threw && threw.message) || html('#c-body').slice(0, 90))

/* 9 — el refresco silencioso de la bandeja, con JSON sin totales */
setJson({ conversations: [] })
pick('#conv-list').innerHTML = ''
pick('#in-totals').innerHTML = ''
threw = null
try { await context.paintConversationsQuiet() } catch (e) { threw = e }
check('bandeja: el refresco silencioso no lanza si faltan los totales', !threw, (threw && threw.message) || '')

/* 10 — la pestaña de reglas cuenta bien los flujos y las secuencias */
setJson([])
vm.runInContext("state.tab = 'rules'", context)
pick('#aut-body').innerHTML = ''
threw = null
try { await context.paintAutomations() } catch (e) { threw = e }
check('reglas: no lanza y ofrece montar una regla', !threw && html('#aut-body').length > 0, (threw && threw.message) || html('#aut-body').slice(0, 90))

/* 11 — orden y nombres accesibles en lo que se pinta */
setJson({ total: 1, tags: ['vip'], contacts: [{ phone: '600111222', tags: ['vip'], messageCount: 1, lastMessageAt: Date.now(), lockState: 'BOT' }] })
pick('#c-body').innerHTML = ''
threw = null
try { await context.paintContacts() } catch (e) { threw = e }
const table = html('#c-body')
check('tabla: cada cabecera dice de qué columna es (scope="col")', /<th scope="col">/.test(table) && !/<th>/.test(table), table.slice(0, 90))
check('tabla: ninguna cabecera se queda sin scope', (table.match(/<th scope="col">/g) || []).length === (table.match(/<th[ >]/g) || []).length, table.slice(0, 90))

/* 12 — ningún botón de solo un símbolo se queda sin nombre para el lector */
const CLIENT = readFileSync('src/dashboard/dashboard-client.js', 'utf8')
const iconOnly = (CLIENT.match(/<button[^>]*>[^<]*<\/button>/g) || []).filter((b) => {
  const inner = (b.match(/>([^<]*)<\/button>/) || [])[1] || ''
  return inner.replace(/[\s·✕←→×✎🗑↑↓⌄▾]/g, '').length < 2 && !/aria-label/.test(b)
})
check('botones de icono: todos llevan nombre (aria-label)', iconOnly.length === 0, iconOnly.join(' | ').slice(0, 120))

/* 13 — los diálogos se anuncian: abrir y cerrar sin perder nada */
const modalRoot = pick('#modal-root')
const backdropChild = makeNode('modal-backdrop')
const savedQs = modalRoot.querySelector
modalRoot.querySelector = (sel) => (sel === '.modal-backdrop' ? backdropChild : null)
let modalThrew = null
try { context.openModal('<h2>Nueva secuencia</h2><button>Guardar</button>') } catch (e) { modalThrew = e }
modalRoot.querySelector = savedQs
const modalHtml = html('#modal-root')
check('diálogo: no lanza al abrirse', !modalThrew, modalThrew ? modalThrew.message : '')
check('diálogo: se anuncia como diálogo modal', /role="dialog"/.test(modalHtml) && /aria-modal="true"/.test(modalHtml), modalHtml.slice(0, 110))
check('diálogo: toma su nombre del titular que lleva dentro', /aria-label="Nueva secuencia"/.test(modalHtml), modalHtml.slice(0, 160))
modalThrew = null
try { context.closeModal() } catch (e) { modalThrew = e }
check('diálogo: al cerrar se vacía sin lanzar', !modalThrew && html('#modal-root') === '', (modalThrew && modalThrew.message) || html('#modal-root').slice(0, 80))

/* 14 — el foco no se sale del diálogo (la comprobación del tabulador es estática:
   la página falsa no dispara keydown) */
check('diálogo: Tab queda atrapado dentro', /e\.key !== 'Tab'/.test(CLIENT) && /dialogRoot\(\)/.test(CLIENT), '')
check('diálogo: la ficha del contacto también es un diálogo', /class="drawer" role="dialog" aria-modal="true"/.test(CLIENT), '')

let fails = 0
for (const c of checks) {
  console.log((c.ok ? '  OK    ' : '  FALLA ') + c.name + (c.detail ? ' — ' + c.detail : ''))
  if (!c.ok) fails++
}
console.log(fails === 0
  ? 'SIN SERVIDOR: ' + checks.length + ' comprobaciones superadas.'
  : 'SIN SERVIDOR: ' + fails + ' fallidas de ' + checks.length + '.')
process.exit(fails ? 1 : 0)
