/* app.js — panel de control operativo de WhatsPower (SPA sin dependencias).
   Consume /api/dashboard/*; la sesión es la cookie HttpOnly del Studio. */

const state = {
  org: localStorage.getItem('wp_org') || 'org_albra',
  route: location.pathname,
  overview: null,
  shellReady: false,
  settings: null,
  timer: null,
  tab: 'flows',
  inboxFilter: 'all',
  inboxSearch: '',
  contactQuery: '',
  contactTag: '',
  conversation: null,
  gateShown: false,
}

/* ------------------------------------------------------------------ utils */
const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/** Una lista sólo si de verdad lo es: una respuesta rara no debe romper la pantalla. */
function arr(value) {
  return Array.isArray(value) ? value : []
}

/** true cuando la API no devolvió los datos esperados (por ejemplo, un HTML
 *  servido sin servidor detrás). Así la pantalla avisa en vez de quedarse rota. */
function looksRaw(data) {
  return !data || typeof data !== 'object' || data.raw !== undefined
}

/** Aviso único para las pantallas que se abren sin la API detrás. */
const OFFLINE_NOTE = '<div class="card" style="margin-bottom:16px"><div class="card-body">' +
  '<strong>Esta página no está conectada al servidor</strong>' +
  '<div class="small muted" style="margin-top:6px">Los datos aparecerán cuando la API responda JSON. Si abriste el HTML exportado, arráncalo con «npm start»; si el servidor está en marcha, revisa que /api/dashboard responda datos.</div>' +
  '</div></div>'

function n(value) {
  const num = Number(value || 0)
  return num.toLocaleString('es-ES')
}

function money(value) {
  return Number(value || 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })
}

function when(ms) {
  const at = Number(ms)
  if (!at || !Number.isFinite(at)) return '—'
  const diff = Date.now() - at
  if (diff < 0) return new Date(at).toLocaleString('es-ES')
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'ahora'
  if (min < 60) return min + ' min'
  const hours = Math.floor(min / 60)
  if (hours < 24) return hours + ' h'
  const days = Math.floor(hours / 24)
  if (days < 7) return days + ' d'
  return new Date(at).toLocaleDateString('es-ES')
}

function clock(ms) {
  const at = Number(ms)
  // Si el dato no es una fecha utilizable se deja el hueco vacío antes que
  // escribir «Invalid Date» delante del usuario.
  if (!at || !Number.isFinite(at)) return ''
  return new Date(at).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function toast(message, isError) {
  const el = $('#toast')
  if (!el) return
  el.textContent = message
  el.className = 'toast show' + (isError ? ' err' : '')
  clearTimeout(state.toastTimer)
  state.toastTimer = setTimeout(() => { el.className = 'toast' }, 4200)
}

async function api(path, options = {}) {
  const res = await fetch('/api/dashboard' + path, {
    method: options.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json', 'X-Org-Id': state.org }, options.headers || {}),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
  })
  const raw = await res.text()
  let data = null
  try { data = raw ? JSON.parse(raw) : null } catch { data = { raw } }
  if (res.status === 401) {
    showGate('La sesión de administración caducó o no está iniciada.')
    throw new Error('Sesión no iniciada')
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || ('Error ' + res.status)
    throw new Error(msg)
  }
  return data
}

/**
 * Cabecera de cada pantalla: qué es esta página y para qué sirve.
 * Va en el contenido (no en la barra superior) para que el titular de la página
 * sea el de verdad: 40 px, con su subtítulo de 24 px y una línea de 16 px.
 */
const PAGE_META = {
  '/dashboard': {
    eyebrow: 'Resumen',
    title: 'Inicio',
    sub: 'Tu operación de WhatsApp de un vistazo',
    desc: 'Lo que está pasando ahora mismo: quién escribe, qué flujo responde solo y qué conversación espera a una persona.',
  },
  '/dashboard/automations': {
    eyebrow: 'Automatizaciones',
    title: 'Automatizaciones',
    sub: 'Flujos, secuencias y reglas del CRM',
    desc: 'Lo que responde sin que nadie toque nada, con el orden y la espera que definas.',
  },
  '/dashboard/contacts': {
    eyebrow: 'Contactos',
    title: 'Contactos',
    sub: 'Personas, etiquetas y bajas',
    desc: 'Quién habló contigo, con qué etiqueta quedó y quién pidió no recibir más mensajes.',
  },
  '/dashboard/inbox': {
    eyebrow: 'Bandeja',
    title: 'Bandeja de entrada',
    sub: 'Conversaciones que necesitan a una persona',
    desc: 'Responde a mano, toma el control de la conversación y devuélvesela al bot cuando termines.',
  },
  '/dashboard/broadcasts': {
    eyebrow: 'Difusiones',
    title: 'Difusiones',
    sub: 'Un mensaje a una audiencia concreta',
    desc: 'Primero mira a cuántos llegaría y a quién se salta por estar de baja; después confirma el envío.',
  },
  '/dashboard/growth': {
    eyebrow: 'Crecimiento',
    title: 'Herramientas de crecimiento',
    sub: 'Enlaces que abren conversaciones',
    desc: 'Cada enlace abre el chat con el texto escrito y la etiqueta puesta, para saber de dónde viene cada persona.',
  },
  '/dashboard/settings': {
    eyebrow: 'Ajustes',
    title: 'Ajustes',
    sub: 'Cómo está configurado este panel',
    desc: 'El transporte en uso, la organización activa y el registro de todo lo que se ha hecho aquí.',
  },
}

function pageMeta() {
  return PAGE_META[state.route] || PAGE_META['/dashboard']
}

function shortcuts() {
  return '<ul class="view-list">' +
    '<li><button class="linklike" data-shortcut="/dashboard/inbox">Atiende la bandeja</button> y responde a quien está esperando.</li>' +
    '<li><button class="linklike" data-shortcut="/dashboard/automations">Revisa tus flujos</button> para que el bot no repita preguntas.</li>' +
    '<li><button class="linklike" data-shortcut="/dashboard/broadcasts">Prepara una difusión</button> y confírmala solo después de ver la audiencia.</li>' +
    '</ul>'
}

function viewHead() {
  const m = pageMeta()
  return '<header class="view-head">' +
    '<div class="eyebrow">' + esc(m.eyebrow) + '</div>' +
    '<h1>' + esc(m.title) + '</h1>' +
    '<h2>' + esc(m.sub) + '</h2>' +
    '<p class="lede">' + esc(m.desc) + '</p>' +
    (state.route === '/dashboard' ? shortcuts() : '') +
    '</header>'
}

function setView(html) {
  const view = $('#view')
  if (view) view.innerHTML = state.shellReady ? viewHead() + html : html
  window.scrollTo({ top: 0 })
}

function skeleton(text) {
  return '<div class="content"><div class="empty"><strong>' + esc(text || 'Cargando…') + '</strong><span class="small">Un momento.</span></div></div>'
}

function backendBadge(settings) {
  if (!settings || !settings.transports) return '<span class="badge">sin conexión</span>'
  const t = settings.transports || {}
  if (t.mode === 'mock' || !t.realDispatch) {
    return '<span class="badge warn" title="Los mensajes se simulan: no salen a WhatsApp">modo simulación</span>'
  }
  return '<span class="badge ok">envío real activo</span>'
}

/* ------------------------------------------------------------------ gate */
function showGate(message) {
  state.shellReady = false
  const root = $('#root')
  const boot = $('#boot')
  if (boot) boot.classList.add('hidden')
  if (state.gateShown) {
    const err = $('#gate-error')
    if (err && message) err.textContent = message
    return
  }
  state.gateShown = true
  if (root) root.classList.remove('hidden')
  const mount = root || document.body
  mount.innerHTML = `
    <div class="gate gate-hero">
      <div class="gate-card">
        <div class="brand" style="padding:0 0 18px">
          <div class="brand-mark">WP</div>
          <div><div class="brand-name">WhatsPower</div><div class="brand-sub">Panel de control</div></div>
        </div>
        <div class="gate-eyebrow">CRM ALBRA · Nivel 2</div>
        <h1>WhatsPower, el panel de conversaciones</h1>
        <h2>Automatiza WhatsApp y atiende a mano cuando toque</h2>
        <p>Flujos, contactos y bandeja en un solo sitio. El programa atiende lo repetido y te pasa la conversación cuando hace falta una persona.</p>
        <ul class="gate-list">
          <li>Flujos con disparadores por palabra clave y respuestas con espera</li>
          <li>Contactos con etiquetas, campos propios y bajas respetadas</li>
          <li>Bandeja compartida con asignación y registro de cada acción</li>
        </ul>
        <div class="field">
          <label class="label" for="gate-org">Organización</label>
          <input class="input" id="gate-org" value="${esc(state.org)}" autocomplete="organization">
        </div>
        <div class="field">
          <label class="label" for="gate-secret">Credencial administrativa</label>
          <input class="input" id="gate-secret" type="password" placeholder="INTERNAL_API_SECRET" autocomplete="current-password">
        </div>
        <div class="tiny muted" id="gate-error" style="color:#b42318;min-height:16px"></div>
        <button class="btn btn-primary" id="gate-go" style="width:100%;justify-content:center">Entrar</button>
        <p class="gate-note">¿Prefieres el diseñador de flujos? <a href="/studio">Abrir Flow Studio</a></p>
      </div>
    </div>`
  const submit = async () => {
    const secret = ($('#gate-secret') || {}).value || ''
    const org = (($('#gate-org') || {}).value || '').trim()
    if (!secret) { $('#gate-error').textContent = 'Escribe la credencial.'; return }
    const btn = $('#gate-go')
    if (btn) { btn.disabled = true; btn.textContent = 'Comprobando…' }
    try {
      const res = await fetch('/studio/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ secret }),
      })
      if (!res.ok) throw new Error('Credencial rechazada')
      state.org = org || state.org
      localStorage.setItem('wp_org', state.org)
      state.gateShown = false
      document.body.classList.remove('nav-open')
      await boot_app()
    } catch (e) {
      if ($('#gate-error')) $('#gate-error').textContent = e.message
      if (btn) { btn.disabled = false; btn.textContent = 'Entrar' }
    }
  }
  const go = $('#gate-go')
  if (go) go.addEventListener('click', submit)
  const secretInput = $('#gate-secret')
  if (secretInput) secretInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
}

/* ------------------------------------------------------------------ shell */
const NAV = [
  { path: '/dashboard', label: 'Inicio', icon: '🏠' },
  { path: '/dashboard/automations', label: 'Automatizaciones', icon: '⚡' },
  { path: '/dashboard/contacts', label: 'Contactos', icon: '👥' },
  { path: '/dashboard/inbox', label: 'Bandeja', icon: '💬', badge: 'open' },
  { path: '/dashboard/broadcasts', label: 'Difusiones', icon: '📣' },
  { path: '/dashboard/growth', label: 'Herramientas de crecimiento', icon: '🔗' },
  { path: '/dashboard/settings', label: 'Ajustes', icon: '⚙️' },
]

function shell() {
  const counts = (state.overview && state.overview.kpis) || {}
  const navItems = NAV.map((item) => {
    const active = state.route === item.path || (item.path !== '/dashboard' && state.route.startsWith(item.path))
    const badge = item.badge === 'open' && counts.handoffs ? '<span class="count">' + n(counts.handoffs) + '</span>' : ''
    return '<button class="nav-item' + (active ? ' active' : '') + '" data-nav="' + item.path + '">' +
      '<span class="ico">' + item.icon + '</span><span>' + esc(item.label) + '</span>' + badge + '</button>'
  })
  const dailyNav = navItems.slice(0, 4).join('')
  const growthNav = navItems.slice(4).join('')

  const root = $('#root')
  root.classList.remove('hidden')
  const boot = $('#boot')
  if (boot) boot.remove()
  state.shellReady = true
  root.innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar" aria-label="Navegación del panel">
        <div class="brand">
          <div class="brand-mark">WP</div>
          <div><div class="brand-name">WhatsPower</div><div class="brand-sub">CRM ALBRA · automatización</div></div>
        </div>
        <nav class="nav">
          <div class="nav-group">Trabajo diario</div>
          ${dailyNav}
          <div class="nav-group">Crecer</div>
          ${growthNav}
        </nav>
        <div class="sidebar-foot">
          <div class="org-chip">
            <span class="dot ${state.overview && state.overview.kpis ? 'ok' : 'warn'}"></span>
            <div><strong>${esc(state.org)}</strong><br><span class="tiny">organización activa</span></div>
          </div>
          <a href="/studio" class="btn btn-sm" style="width:100%;justify-content:center">Abrir Flow Studio ↗</a>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <button class="btn btn-sm menu-btn" id="menu-btn" aria-label="Abrir o cerrar el menú" aria-expanded="false" aria-controls="sidebar">☰</button>
          <div class="page-title" id="page-title"></div>
          <div class="spacer"></div>
          <span class="hint">${esc(state.org)}</span>
          ${backendBadge(state.settings)}
        </header>
        <div id="view"></div>
      </main>
    </div>`

  $$('[data-nav]').forEach((btn) => btn.addEventListener('click', () => {
    document.body.classList.remove('nav-open')
    const toggle = $('#menu-btn')
    if (toggle) toggle.setAttribute('aria-expanded', 'false')
    navigate(btn.getAttribute('data-nav'))
  }))
  const menu = $('#menu-btn')
  if (menu) {
    // El botón ☰ dice también si el menú está abierto (aria-expanded): un lector
    // de pantalla necesita saber el estado, no solo que hay un botón.
    menu.addEventListener('click', () => {
      const open = document.body.classList.toggle('nav-open')
      menu.setAttribute('aria-expanded', open ? 'true' : 'false')
    })
  }

  // Los atajos de la cabecera de página usan data-shortcut para no disparar dos
  // veces la navegación junto con los botones que cada vista ya engancha.
  document.addEventListener('click', (ev) => {
    const target = ev.target && ev.target.closest && ev.target.closest('[data-shortcut]')
    if (!target) return
    ev.preventDefault()
    navigate(target.getAttribute('data-shortcut'))
  })
}

function navigate(path, replace) {
  if (path === state.route && $('#view') && $('#view').innerHTML) return
  state.route = path
  if (replace) history.replaceState({}, '', path)
  else history.pushState({}, '', path)
  if (state.timer) { clearInterval(state.timer); state.timer = null }
  render()
}

const VIEWS = [
  { path: '/dashboard', title: 'Inicio', view: () => viewHome() },
  { path: '/dashboard/automations', title: 'Automatizaciones', view: () => viewAutomations() },
  { path: '/dashboard/contacts', title: 'Contactos', view: () => viewContacts() },
  { path: '/dashboard/inbox', title: 'Bandeja de entrada', view: () => viewInbox() },
  { path: '/dashboard/broadcasts', title: 'Difusiones', view: () => viewBroadcasts() },
  { path: '/dashboard/growth', title: 'Herramientas de crecimiento', view: () => viewGrowth() },
  { path: '/dashboard/settings', title: 'Ajustes', view: () => viewSettings() },
]

async function render() {
  const found = VIEWS.slice().reverse().find((v) => state.route === v.path || state.route.startsWith(v.path + '/')) || VIEWS[0]
  const title = $('#page-title')
  if (title) title.textContent = found.title
  $$('[data-nav]').forEach((btn) => {
    const p = btn.getAttribute('data-nav')
    btn.classList.toggle('active', p === found.path)
  })
  try {
    await found.view()
  } catch (e) {
    if (e && e.message === 'Sesión no iniciada') return
    setView('<div class="content"><div class="empty"><strong>No se pudo cargar esta sección</strong><span class="small">' + esc(e.message) + '</span></div></div>')
  }
}

/* ------------------------------------------------------------------ inicio */
async function viewHome() {
  setView(skeleton('Preparando el resumen'))
  const overview = await api('/overview')
  state.overview = overview
  // Si el servidor no devolvió el resumen (por ejemplo, un HTML exportado sin API
  // detrás), la portada se dibuja igual con guiones y un aviso: se ve qué hay y
  // cómo arrancar el servidor, en vez de una pantalla rota.
  const live = !!(overview && typeof overview === 'object' && overview.kpis)
  const offline = live
    ? ''
    : '<div class="card" style="margin-bottom:16px"><div class="card-body">' +
      '<strong>Esta página no está conectada al servidor</strong>' +
      '<div class="small muted" style="margin-top:6px">Las cifras aparecerán cuando la API responda. Si abriste el HTML exportado, arráncalo con «npm start»; si el servidor ya está en marcha, revisa que /api/dashboard/overview devuelva JSON.</div>' +
      '</div></div>'
  const shown = (v) => (live ? n(v) : '—')
  const k = live ? overview.kpis || {} : {}
  // Cada lista se comprueba antes de usarla: una tabla antigua o un campo que
  // falte no debe dejar la portada en blanco.
  const seriesList = Array.isArray(overview && overview.series) ? overview.series : []
  const recentList = Array.isArray(overview && overview.recent) ? overview.recent : []
  const flowsList = Array.isArray(overview && overview.flows) ? overview.flows : []
  const tagsList = Array.isArray(overview && overview.topTags) ? overview.topTags : []
  const paymentsList = Array.isArray(overview && overview.payments) ? overview.payments : []

  const max = Math.max(1, ...seriesList.map((d) => (Number(d.inbound) || 0) + (Number(d.outbound) || 0)))
  const bars = seriesList.map((d) => {
    const inH = Math.round(((Number(d.inbound) || 0) / max) * 100)
    const outH = Math.round(((Number(d.outbound) || 0) / max) * 100)
    return '<div class="bar" title="' + esc(d.day) + ': ' + d.inbound + ' entrada / ' + d.outbound + ' salida">' +
      '<span class="out" style="height:' + outH + '%"></span><span style="height:' + inH + '%"></span></div>'
  }).join('')

  const recent = recentList.length
    ? recentList.map((m) => '<div class="kv"><span>' + esc(m.contact_phone) + ' · ' + (m.direction === 'inbound' ? 'entrada' : 'salida') + '</span><span title="' + esc(m.text) + '">' + esc(String(m.text || '').slice(0, 42)) + '</span></div>').join('')
    : '<div class="empty"><strong>Sin mensajes todavía</strong><span class="small">Cuando llegue el primer mensaje aparecerá aquí.</span></div>'

  const flows = flowsList.length
    ? flowsList.slice(0, 6).map((f) => '<div class="kv"><span>' + esc(f.name) + '</span><span>' +
      (f.isActive ? '<span class="badge ok">activo</span>' : '<span class="badge">borrador</span>') + ' · ' + f.nodes + ' nodos</span></div>').join('')
    : '<div class="tiny muted">Aún no hay flujos. Crea el primero en Automatizaciones.</div>'

  const tags = tagsList.length
    ? tagsList.map((t) => '<span class="badge tag">' + esc(t.tag) + ' · ' + n(t.count) + '</span>').join('')
    : '<span class="tiny muted">Sin etiquetas en uso.</span>'

  const payments = paymentsList.map((p) => '<div class="kv"><span>' + esc(p.status) + '</span><span>' + n(p.count) + ' · ' + money(p.total) + '</span></div>').join('')

  setView(`
    <div class="content">
      ${offline}
      <div class="kpis">
        <div class="card kpi"><div class="k-label">Contactos</div><div class="k-value">${shown(k.contacts)}</div><div class="k-foot">${shown(k.suppressed)} dados de baja</div></div>
        <div class="card kpi"><div class="k-label">Conversaciones activas (24 h)</div><div class="k-value">${shown(k.activeConversations)}</div><div class="k-foot">${shown(k.handoffs)} esperan a una persona</div></div>
        <div class="card kpi"><div class="k-label">Mensajes hoy</div><div class="k-value">${shown(k.messagesToday)}</div><div class="k-foot">${shown(k.inboundToday)} entrada · ${shown(k.outboundToday)} salida</div></div>
        <div class="card kpi"><div class="k-label">Automatizaciones</div><div class="k-value">${shown(k.activeFlows)}/${shown(k.flows)}</div><div class="k-foot">flujos activos</div></div>
      </div>

      <div class="grid-2" style="margin-top:16px">
        <div class="card">
          <div class="card-head"><h2>Mensajes de los últimos 14 días</h2><div class="spacer"></div><span class="badge">${shown((k.inboundToday || 0) + (k.outboundToday || 0))} hoy</span></div>
          <div class="card-body">
            <div class="chart">${bars || '<span class="tiny muted">Aquí se verá el vaivén de mensajes de las dos últimas semanas.</span>'}</div>
            <div class="chart-legend"><span><i class="legend-dot"></i>entrada</span><span><i class="legend-dot out"></i>salida</span></div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Actividad reciente</h2><div class="spacer"></div><button class="btn btn-sm" data-go="/dashboard/inbox">Ver bandeja</button></div>
          <div class="card-body tight" style="padding:14px 18px">${recent}</div>
        </div>
      </div>

      <div class="grid-3" style="margin-top:16px">
        <div class="card">
          <div class="card-head"><h2>Flujos</h2><div class="spacer"></div><button class="btn btn-sm" data-go="/dashboard/automations">Gestionar</button></div>
          <div class="card-body">${flows}</div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Etiquetas más usadas</h2></div>
          <div class="card-body"><div class="chips">${tags}</div></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Secuencias y pagos</h2></div>
          <div class="card-body">
            <div class="kv"><span>Inscripciones activas</span><span>${shown(k.scheduledSequences)}</span></div>
            <div class="kv"><span>Enlaces de crecimiento</span><span>${shown(k.growthLinks)}</span></div>
            <div class="kv"><span>Contactos esperando</span><span>${shown(k.waitingFlows)}</span></div>
            <div class="kv"><span>Próxima espera</span><span>${k.nextWaitAt ? clock(k.nextWaitAt) : '—'}</span></div>
            ${payments}
          </div>
        </div>
      </div>
    </div>`)

  $$('[data-go]').forEach((btn) => btn.addEventListener('click', () => navigate(btn.getAttribute('data-go'))))
  $$('[data-nav]').forEach((btn) => {
    const p = btn.getAttribute('data-nav')
    btn.classList.toggle('active', p === '/dashboard')
    const badge = btn.querySelector('.count')
    if (badge) badge.textContent = n(k.handoffs)
  })
}

/* ------------------------------------------------------------------ automatizaciones */
async function viewAutomations() {
  setView(`
    <div class="content">
      <div class="toolbar">
        <div class="segmented" id="aut-tabs">
          <button data-tab="flows" class="active">Flujos</button>
          <button data-tab="sequences">Secuencias</button>
          <button data-tab="rules">Reglas del CRM</button>
        </div>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="aut-new">Crear</button>
      </div>
      <div id="aut-body">${skeleton('Cargando automatizaciones')}</div>
    </div>`)

  $$('#aut-tabs button').forEach((btn) => btn.addEventListener('click', () => {
    state.tab = btn.getAttribute('data-tab')
    $$('#aut-tabs button').forEach((b) => b.classList.toggle('active', b === btn))
    paintAutomations()
  }))
  $('#aut-new').addEventListener('click', () => {
    if (state.tab === 'flows') createFlow()
    else if (state.tab === 'sequences') sequenceModal()
    else ruleModal()
  })
  await paintAutomations()
}

async function paintAutomations() {
  const body = $('#aut-body')
  if (!body) return
  body.innerHTML = skeleton('Cargando')
  try {
    if (state.tab === 'flows') {
      const flows = await api('/flows')
      if (looksRaw(flows)) { body.innerHTML = OFFLINE_NOTE; return }
      if (!flows.length) {
        body.innerHTML = '<div class="card"><div class="empty"><strong>Sin flujos todavía</strong><span class="small">Un flujo responde solo cuando el contacto escribe una palabra clave.</span><br><br><button class="btn btn-primary" data-new-flow>Crear el primer flujo</button></div></div>'
        $('[data-new-flow]').addEventListener('click', createFlow)
        return
      }
      body.innerHTML = '<div class="card"><div class="table-wrap"><table class="table"><thead><tr>' +
        '<th scope="col">Flujo</th><th scope="col">Disparadores</th><th scope="col">Nodos</th><th scope="col">Estado</th><th scope="col"></th></tr></thead><tbody>' +
        flows.map((f) => '<tr>' +
          '<td><strong>' + esc(f.name) + '</strong><br><span class="tiny muted mono">' + esc(f.id) + '</span></td>' +
          '<td>' + (f.triggerKeywords && f.triggerKeywords.length ? f.triggerKeywords.map((k) => '<span class="badge tag">' + esc(k) + '</span> ').join('') : '<span class="tiny muted">sin palabras clave</span>') + '</td>' +
          '<td class="num">' + n(f.nodeCount) + '</td>' +
          '<td>' + (f.isActive ? '<span class="badge ok">activo</span>' : '<span class="badge">borrador</span>') + '</td>' +
          '<td><div class="actions">' +
            '<a class="btn btn-sm" href="/studio?flow=' + encodeURIComponent(f.id) + '" target="_blank" rel="noopener">Abrir</a>' +
            '<button class="btn btn-sm" data-toggle="' + esc(f.id) + '">' + (f.isActive ? 'Desactivar' : 'Activar') + '</button>' +
            '<button class="btn btn-sm" data-dup="' + esc(f.id) + '">Duplicar</button>' +
            '<button class="btn btn-sm btn-danger" data-del="' + esc(f.id) + '">Borrar</button>' +
          '</div></td></tr>').join('') +
        '</tbody></table></div></div>'
      $$('[data-toggle]', body).forEach((b) => b.addEventListener('click', async () => {
        try { await api('/flows/' + encodeURIComponent(b.getAttribute('data-toggle')) + '/toggle', { method: 'POST' }); toast('Estado del flujo actualizado'); paintAutomations() } catch (e) { toast(e.message, true) }
      }))
      $$('[data-dup]', body).forEach((b) => b.addEventListener('click', async () => {
        try { await api('/flows/' + encodeURIComponent(b.getAttribute('data-dup')) + '/duplicate', { method: 'POST' }); toast('Flujo duplicado como borrador'); paintAutomations() } catch (e) { toast(e.message, true) }
      }))
      $$('[data-del]', body).forEach((b) => b.addEventListener('click', async () => {
        const ok = await confirmModal('¿Borrar este flujo?', 'Las conversaciones en curso que lo usan dejarán de recibir respuestas. No se puede deshacer.')
        if (!ok) return
        try { await api('/flows/' + encodeURIComponent(b.getAttribute('data-del')), { method: 'DELETE' }); toast('Flujo borrado'); paintAutomations() } catch (e) { toast(e.message, true) }
      }))
      return
    }

    if (state.tab === 'sequences') {
      const data = await api('/sequences')
      if (looksRaw(data)) { body.innerHTML = OFFLINE_NOTE; return }
      const seqs = arr(data.sequences)
      const flows = await api('/flows')
      state.flowsCache = flows
      if (!seqs.length) {
        body.innerHTML = '<div class="card"><div class="empty"><strong>Sin secuencias</strong><span class="small">Una secuencia envía mensajes espaciados en el tiempo (goteo) sin que nadie intervenga.</span><br><br><button class="btn btn-primary" data-new-seq>Crear secuencia</button></div></div>'
        $('[data-new-seq]').addEventListener('click', () => sequenceModal())
        return
      }
      body.innerHTML = '<div class="grid-3">' + seqs.map((s) => '<div class="flow-card">' +
        '<div class="row"><h3>' + esc(s.name) + '</h3><div class="right">' + (s.isActive ? '<span class="badge ok">activa</span>' : '<span class="badge">pausada</span>') + '</div></div>' +
        '<p>' + arr(s.steps).length + ' pasos · ' + n(s.enrolled) + ' contactos dentro</p>' +
        '<ol class="small muted" style="margin:0 0 12px 16px;padding:0">' +
          arr(s.steps).map((st) => '<li>' + (st.delay_minutes ? 'espera ' + st.delay_minutes + ' min → ' : 'al inscribir → ') + esc(String(st.message_text || '').slice(0, 60)) + '</li>').join('') +
        '</ol>' +
        '<div class="row"><button class="btn btn-sm" data-seq-toggle="' + esc(s.id) + '">' + (s.isActive ? 'Pausar' : 'Activar') + '</button>' +
        '<button class="btn btn-sm btn-primary" data-seq-enroll="' + esc(s.id) + '">Inscribir contacto</button></div>' +
      '</div>').join('') + '</div>'
      $$('[data-seq-toggle]', body).forEach((b) => b.addEventListener('click', async () => {
        try { await api('/sequences/' + encodeURIComponent(b.getAttribute('data-seq-toggle')) + '/toggle', { method: 'POST' }); paintAutomations() } catch (e) { toast(e.message, true) }
      }))
      $$('[data-seq-enroll]', body).forEach((b) => b.addEventListener('click', () => enrollModal(b.getAttribute('data-seq-enroll'))))
      return
    }

    const [rules, flows, seqs] = await Promise.all([api('/rules'), api('/flows'), api('/sequences')])
    const list = rules.rules || []
    body.innerHTML = '<div class="card"><div class="card-head"><h2>Cuando el CRM cambia de etapa</h2></div>' +
      (list.length
        ? '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Etapa</th><th scope="col">Acción</th><th scope="col">Destino</th><th scope="col">Estado</th><th scope="col"></th></tr></thead><tbody>' +
          list.map((r) => '<tr><td><strong>' + esc(r.stage) + '</strong></td><td>' + esc(r.action) + '</td><td>' +
            esc(r.template_message || r.target_flow_id || r.target_sequence_id || '—') + '</td><td>' +
            (r.enabled ? '<span class="badge ok">activa</span>' : '<span class="badge">apagada</span>') + '</td>' +
            '<td><div class="actions"><button class="btn btn-sm btn-danger" data-rule-del="' + esc(r.id) + '">Quitar</button></div></td></tr>').join('') +
          '</tbody></table></div>'
        : '<div class="empty"><strong>Todavía no hay reglas propias</strong><span class="small">Mientras no definas ninguna, se usan los valores internos por defecto.</span></div>') +
      '<div class="card-body tiny muted">Disponibles: ' + n(flows.length) + ' flujos y ' + n(seqs.length) + ' secuencias.</div></div>'
    $$('[data-rule-del]', body).forEach((b) => b.addEventListener('click', async () => {
      try { await api('/rules/' + encodeURIComponent(b.getAttribute('data-rule-del')), { method: 'DELETE' }); paintAutomations() } catch (e) { toast(e.message, true) }
    }))
  } catch (e) {
    if (e.message !== 'Sesión no iniciada') body.innerHTML = '<div class="card"><div class="empty"><strong>Error</strong><span class="small">' + esc(e.message) + '</span></div></div>'
  }
}

async function createFlow() {
  toast('Los flujos nuevos se crean en el Flow Studio; se abre en otra pestaña.')
  window.open('/studio', '_blank', 'noopener')
}

// Foco de los diálogos. Sin esto, con el teclado se seguía tabulando por la página
// de detrás y quien usa lector de pantalla no sabía que había un diálogo abierto.
// `lastFocus` guarda el botón que lo abrió para devolverle el foco al cerrar.
let lastFocus = null

function dialogRoot() {
  const back = document.querySelector('.modal-backdrop') || document.querySelector('.drawer-backdrop')
  return back ? back.querySelector('.modal') || back.querySelector('.drawer') : null
}

function focusablesIn(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return []
  return Array.from(root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'))
    .filter((el) => !el.disabled && el.getAttribute('aria-hidden') !== 'true')
}

function focusFirstIn(root) {
  const items = focusablesIn(root)
  const target = items.find((el) => !/^✕/.test(String(el.textContent || '').trim())) || items[0]
  if (target && typeof target.focus === 'function') target.focus()
}

function rememberFocus() {
  if (lastFocus) return
  const active = typeof document !== 'undefined' ? document.activeElement : null
  if (active && active !== document.body) lastFocus = active
}

function restoreFocus() {
  const el = lastFocus
  lastFocus = null
  if (el && typeof el.focus === 'function') el.focus()
}

function closeModal() {
  const root = $('#modal-root')
  if (root) root.innerHTML = ''
  restoreFocus()
}

function labelFromHtml(html, fallback) {
  const m = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(html || '')
  const text = m ? m[1].replace(/<[^>]*>/g, '').trim() : ''
  return text || fallback
}

function openModal(html, label) {
  const root = $('#modal-root')
  rememberFocus()
  root.innerHTML = '<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-label="' +
    esc(label || labelFromHtml(html, 'Diálogo')) + '">' + html + '</div></div>'
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', closeModal))
  root.querySelector('.modal-backdrop').addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) closeModal() })
  focusFirstIn(dialogRoot())
}

function confirmModal(title, text) {
  return new Promise((resolve) => {
    openModal('<div class="card-body"><h2 style="font-size:16px;margin-bottom:8px">' + esc(title) + '</h2><p class="small muted">' + esc(text || '') + '</p>' +
      '<div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" id="confirm-yes">Sí, continuar</button></div></div>', title)
    $('#confirm-yes').addEventListener('click', () => { closeModal(); resolve(true) })
    const back = $('.modal-backdrop')
    if (back) back.addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) resolve(false) })
  })
}

function sequenceModal() {
  openModal(`
    <div class="card-body">
      <h2 style="font-size:17px;margin-bottom:4px">Nueva secuencia</h2>
      <p class="small muted" style="margin-top:0">Cada paso se envía después de la espera indicada.</p>
      <div class="field"><label class="label">Nombre</label><input class="input" id="seq-name" placeholder="Bienvenida y seguimiento"></div>
      <div class="steps-editor" id="seq-steps">
        <div class="step-row">
          <input class="input" data-delay placeholder="0 min" value="0">
          <input class="input" data-text placeholder="Mensaje del paso 1">
          <button class="btn btn-sm btn-danger" data-remove-step aria-label="Quitar este paso de la secuencia">✕</button>
        </div>
      </div>
      <button class="btn btn-sm" id="seq-add-step" style="margin:10px 0 16px">+ Añadir paso</button>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" id="seq-save">Guardar secuencia</button></div>
    </div>`)
  $('#seq-add-step').addEventListener('click', () => {
    const row = document.createElement('div')
    row.className = 'step-row'
    row.innerHTML = '<input class="input" data-delay placeholder="1440 min" value="1440"><input class="input" data-text placeholder="Siguiente mensaje"><button class="btn btn-sm btn-danger" data-remove-step aria-label="Quitar este paso de la secuencia">✕</button>'
    row.querySelector('[data-remove-step]').addEventListener('click', () => row.remove())
    $('#seq-steps').appendChild(row)
  })
  $$('[data-remove-step]').forEach((b) => b.addEventListener('click', () => { if ($$('#seq-steps .step-row').length > 1) b.closest('.step-row').remove() }))
  $('#seq-save').addEventListener('click', async () => {
    const name = $('#seq-name').value.trim()
    const steps = $$('#seq-steps .step-row').map((row) => ({
      delayMinutes: Number(String(row.querySelector('[data-delay]').value).replace(',', '.')) || 0,
      messageText: row.querySelector('[data-text]').value.trim(),
    })).filter((s) => s.messageText)
    if (!name || !steps.length) { toast('Pon un nombre y al menos un mensaje', true); return }
    try {
      await api('/sequences', { method: 'POST', body: { name, steps } })
      closeModal(); toast('Secuencia guardada'); paintAutomations()
    } catch (e) { toast(e.message, true) }
  })
}

function enrollModal(sequenceId) {
  openModal(`
    <div class="card-body">
      <h2 style="font-size:17px;margin-bottom:12px">Inscribir un contacto</h2>
      <div class="field"><label class="label">Teléfono (con prefijo, sin +)</label><input class="input" id="enroll-phone" placeholder="34600111222"></div>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" id="enroll-go">Inscribir</button></div>
    </div>`)
  $('#enroll-go').addEventListener('click', async () => {
    const phone = $('#enroll-phone').value.replace(/[^\d]/g, '')
    if (!phone) { toast('Escribe un teléfono', true); return }
    try {
      await api('/sequences/' + encodeURIComponent(sequenceId) + '/enroll', { method: 'POST', body: { phone } })
      closeModal(); toast('Contacto inscrito'); paintAutomations()
    } catch (e) { toast(e.message, true) }
  })
}

function ruleModal() {
  const flows = state.flowsCache || []
  openModal(`
    <div class="card-body">
      <h2 style="font-size:17px;margin-bottom:4px">Nueva regla por etapa</h2>
      <p class="small muted" style="margin-top:0">Cuando el CRM mueva una oportunidad a esa etapa, el sistema actúa solo.</p>
      <div class="field"><label class="label">Etapa del CRM</label>
        <select class="select" id="rule-stage">
          <option value="nuevo">nuevo</option><option value="contactado">contactado</option>
          <option value="interesado">interesado</option><option value="negociacion">negociación</option>
          <option value="ganado">ganado</option><option value="perdido">perdido</option>
        </select></div>
      <div class="field"><label class="label">Acción</label>
        <select class="select" id="rule-action">
          <option value="send_message">Enviar un mensaje</option>
          <option value="start_flow">Arrancar un flujo</option>
          <option value="enroll_sequence">Inscribir en una secuencia</option>
        </select></div>
      <div class="field" id="rule-msg-wrap"><label class="label">Mensaje</label><textarea class="textarea" id="rule-msg" placeholder="Hola {{nombre}}, ya estamos preparando tu propuesta."></textarea></div>
      <div class="field hidden" id="rule-flow-wrap"><label class="label">Flujo</label>
        <select class="select" id="rule-flow">${flows.map((f) => '<option value="' + esc(f.id) + '">' + esc(f.name) + '</option>').join('')}</select></div>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" id="rule-save">Guardar regla</button></div>
    </div>`)
  $('#rule-action').addEventListener('change', (e) => {
    const startFlow = e.target.value === 'start_flow'
    const enroll = e.target.value === 'enroll_sequence'
    $('#rule-msg-wrap').classList.toggle('hidden', startFlow || enroll)
    $('#rule-flow-wrap').classList.toggle('hidden', !startFlow)
  })
  $('#rule-save').addEventListener('click', async () => {
    const action = $('#rule-action').value
    const body = { stage: $('#rule-stage').value, action }
    if (action === 'send_message') body.templateMessage = $('#rule-msg').value.trim()
    if (action === 'start_flow') body.targetFlowId = $('#rule-flow').value
    if (action === 'enroll_sequence') { toast('Elige primero una secuencia en Automatizaciones → Secuencias', true) }
    try {
      await api('/rules', { method: 'POST', body })
      closeModal(); toast('Regla guardada'); state.tab = 'rules'
      $$('#aut-tabs button').forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === 'rules'))
      paintAutomations()
    } catch (e) { toast(e.message, true) }
  })
}

/* ------------------------------------------------------------------ contactos */
async function viewContacts() {
  setView(`
    <div class="content">
      <div class="toolbar">
        <input class="input" id="c-search" placeholder="Buscar por teléfono, etiqueta o dato" value="${esc(state.contactQuery)}">
        <select class="select" id="c-tag"><option value="">Todas las etiquetas</option></select>
        <div class="spacer"></div>
        <span class="badge" id="c-total">—</span>
      </div>
      <div class="card" id="c-body">${skeleton('Cargando contactos')}</div>
    </div>`)
  let debounce = null
  $('#c-search').addEventListener('input', (e) => {
    state.contactQuery = e.target.value
    clearTimeout(debounce)
    debounce = setTimeout(paintContacts, 260)
  })
  $('#c-tag').addEventListener('change', (e) => { state.contactTag = e.target.value; paintContacts() })
  await paintContacts()
}

async function paintContacts() {
  const body = $('#c-body')
  if (!body) return
  try {
    const q = encodeURIComponent(state.contactQuery || '')
    const tag = encodeURIComponent(state.contactTag || '')
    const data = await api('/contacts?q=' + q + '&tag=' + tag + '&limit=100')
    if (looksRaw(data)) { body.innerHTML = OFFLINE_NOTE; return }
    const contacts = arr(data.contacts)
    const total = $('#c-total')
    if (total) total.textContent = n(data.total) + ' contactos'
    const tagSelect = $('#c-tag')
    if (tagSelect) {
      const current = state.contactTag
      tagSelect.innerHTML = '<option value="">Todas las etiquetas</option>' + (data.tags || []).map((t) => '<option value="' + esc(t) + '"' + (t === current ? ' selected' : '') + '>' + esc(t) + '</option>').join('')
    }
    if (!contacts.length) {
      body.innerHTML = '<div class="empty"><strong>Sin contactos que coincidan</strong><span class="small">Los contactos aparecen solos cuando alguien escribe, o al importar desde el CRM.</span></div>'
      return
    }
    body.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th scope="col">Contacto</th><th scope="col">Etiquetas</th><th scope="col">Mensajes</th><th scope="col">Última actividad</th><th scope="col">Estado</th><th scope="col"></th></tr></thead><tbody>' +
      contacts.map((c) => {
        const statusBadges = []
        if (c.suppressed) statusBadges.push('<span class="badge danger">dado de baja</span>')
        if (c.lockState === 'HANDOFF_HUMAN') statusBadges.push('<span class="badge warn">con persona</span>')
        if (!statusBadges.length) statusBadges.push('<span class="badge">disponible</span>')
        return '<tr>' +
          '<td><strong class="phone">' + esc(c.phone) + '</strong>' + (c.agentId ? '<br><span class="tiny muted">asesor asignado</span>' : '') + '</td>' +
          '<td>' + (arr(c.tags).length ? arr(c.tags).map((t) => '<span class="badge tag">' + esc(t) + '</span> ').join('') : '<span class="tiny muted">—</span>') + '</td>' +
          '<td class="num">' + n(c.messageCount) + '</td>' +
          '<td>' + when(c.lastMessageAt) + '</td>' +
          '<td>' + statusBadges.join(' ') + '</td>' +
          '<td><div class="actions"><button class="btn btn-sm" data-contact="' + esc(c.phone) + '">Ver ficha</button>' +
          '<button class="btn btn-sm" data-chat="' + esc(c.phone) + '">Abrir chat</button></div></td></tr>'
      }).join('') + '</tbody></table></div>'
    $$('[data-contact]', body).forEach((b) => b.addEventListener('click', () => contactDrawer(b.getAttribute('data-contact'))))
    $$('[data-chat]', body).forEach((b) => b.addEventListener('click', () => {
      state.pendingConversation = b.getAttribute('data-chat')
      navigate('/dashboard/inbox')
    }))
  } catch (e) {
    if (e.message !== 'Sesión no iniciada') body.innerHTML = '<div class="empty"><strong>Error</strong><span class="small">' + esc(e.message) + '</span></div>'
  }
}

async function contactDrawer(phone) {
  const root = $('#modal-root')
  rememberFocus()
  root.innerHTML = '<div class="drawer-backdrop"><div class="drawer" role="dialog" aria-modal="true" aria-label="Ficha del contacto">' + skeleton('Cargando ficha') + '</div></div>'
  root.querySelector('.drawer-backdrop').addEventListener('click', (e) => { if (e.target.classList.contains('drawer-backdrop')) closeModal() })
  try {
    const [data, seqs] = await Promise.all([api('/contacts/' + encodeURIComponent(phone)), api('/sequences')])
    const c = data.contact || {}
    const fields = Object.entries(c.fields || {})
    const enroll = (c.enrollments || []).map((e) => '<div class="kv"><span>' + esc(e.sequenceId) + '</span><span>' + esc(e.status) + '</span></div>').join('')
    root.innerHTML = '<div class="drawer-backdrop"><div class="drawer" role="dialog" aria-modal="true" aria-label="Ficha del contacto">' +
      '<div class="drawer-head"><h2>' + esc(phone) + '</h2><div class="spacer"></div><button class="btn btn-sm" data-close aria-label="Cerrar la ficha del contacto">✕</button></div>' +
      '<div class="chips" style="margin-bottom:14px">' +
        (c.suppressed ? '<span class="badge danger">dado de baja</span>' : '<span class="badge ok">puede recibir mensajes</span>') +
        (c.lockState === 'HANDOFF_HUMAN' ? '<span class="badge warn">atendido por persona</span>' : '') +
        '<span class="badge">' + n(c.messageCount) + ' mensajes</span></div>' +

      '<h3>Etiquetas</h3><div class="tag-list" id="dr-tags">' +
        (arr(c.tags).length ? arr(c.tags).map((t) => '<span class="badge tag">' + esc(t) + ' <button class="btn-ghost" style="border:none;background:none;cursor:pointer;color:#b42318;padding:0 0 0 4px" data-untag="' + esc(t) + '" aria-label="Quitar la etiqueta ' + esc(t) + '">✕</button></span>').join('') : '<span class="tiny muted">sin etiquetas</span>') +
      '</div>' +
      '<div class="inline" style="margin-top:8px"><input class="input" id="dr-tag-input" placeholder="nueva etiqueta" style="max-width:180px"><button class="btn btn-sm" id="dr-tag-add">Añadir</button></div>' +

      '<h3>Datos personalizados</h3>' +
      (fields.length ? fields.map(([k, v]) => '<div class="kv"><span>' + esc(k) + '</span><span>' + esc(v) + '</span></div>').join('') : '<div class="tiny muted">Sin datos guardados.</div>') +
      '<div class="inline" style="margin-top:8px"><input class="input" id="dr-field-key" placeholder="campo" style="max-width:130px"><input class="input" id="dr-field-val" placeholder="valor" style="max-width:150px"><button class="btn btn-sm" id="dr-field-add">Guardar</button></div>' +

      '<h3>Secuencias</h3>' +
      (enroll || '<div class="tiny muted">No está en ninguna secuencia.</div>') +
      '<div class="inline" style="margin-top:8px"><select class="select" id="dr-seq" style="max-width:210px">' +
        ((seqs.sequences || []).map((s) => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('') || '<option value="">sin secuencias</option>') +
      '</select><button class="btn btn-sm" id="dr-seq-go">Inscribir</button></div>' +

      '<h3>Conversación</h3>' +
      '<div class="small muted" style="max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:10px">' +
        (arr(data.messages).length ? arr(data.messages).slice(-25).map((m) => '<div style="margin-bottom:6px"><strong>' + (m.direction === 'inbound' ? '→' : '←') + '</strong> ' + esc(String(m.text || '').slice(0, 120)) + ' <span class="tiny muted">' + clock(m.created_at) + '</span></div>').join('') : '<span class="tiny muted">Sin mensajes.</span>') +
      '</div>' +

      '<h3>Permisos</h3>' +
      '<div class="row"><button class="btn btn-sm ' + (c.suppressed ? '' : 'btn-danger') + '" id="dr-supp">' + (c.suppressed ? 'Reactivar envíos' : 'Dar de baja (no enviar más)') + '</button>' +
      '<button class="btn btn-sm" id="dr-chat">Abrir chat</button></div>' +
      '<p class="tiny muted" style="margin-top:14px">Una baja queda registrada con fecha y motivo; reactivar borra la supresión de esta organización.</p>' +
    '</div></div>'

    $$('[data-close]', root).forEach((b) => b.addEventListener('click', closeModal))
    root.querySelector('.drawer-backdrop').addEventListener('click', (e) => { if (e.target.classList.contains('drawer-backdrop')) closeModal() })
    focusFirstIn(dialogRoot())

    $('#dr-tag-add').addEventListener('click', async () => {
      const tag = $('#dr-tag-input').value.trim()
      if (!tag) return
      try { await api('/contacts/' + encodeURIComponent(phone) + '/tags', { method: 'POST', body: { tag } }); toast('Etiqueta añadida'); contactDrawer(phone); paintContacts() } catch (e) { toast(e.message, true) }
    })
    $$('[data-untag]').forEach((b) => b.addEventListener('click', async () => {
      try { await api('/contacts/' + encodeURIComponent(phone) + '/tags', { method: 'POST', body: { tag: b.getAttribute('data-untag'), op: 'remove' } }); contactDrawer(phone); paintContacts() } catch (e) { toast(e.message, true) }
    }))
    $('#dr-field-add').addEventListener('click', async () => {
      const key = $('#dr-field-key').value.trim()
      const value = $('#dr-field-val').value
      if (!key) { toast('Indica el nombre del campo', true); return }
      try { await api('/contacts/' + encodeURIComponent(phone) + '/fields', { method: 'POST', body: { key, value } }); toast('Dato guardado'); contactDrawer(phone) } catch (e) { toast(e.message, true) }
    })
    $('#dr-seq-go').addEventListener('click', async () => {
      const sequenceId = $('#dr-seq').value
      if (!sequenceId) return
      try { await api('/contacts/' + encodeURIComponent(phone) + '/enroll', { method: 'POST', body: { sequenceId } }); toast('Inscrito'); contactDrawer(phone) } catch (e) { toast(e.message, true) }
    })
    $('#dr-supp').addEventListener('click', async () => {
      const makeSuppressed = !c.suppressed
      if (makeSuppressed) {
        const ok = await confirmModal('¿Dar de baja a este contacto?', 'Dejará de recibir cualquier mensaje automático o difusión.')
        if (!ok) { contactDrawer(phone); return }
      }
      try {
        await api('/contacts/' + encodeURIComponent(phone) + '/suppression', { method: 'POST', body: { suppressed: makeSuppressed, reason: 'Baja manual desde el panel' } })
        toast(makeSuppressed ? 'Contacto dado de baja' : 'Envíos reactivados')
        contactDrawer(phone); paintContacts()
      } catch (e) { toast(e.message, true) }
    })
    $('#dr-chat').addEventListener('click', () => { closeModal(); state.pendingConversation = phone; navigate('/dashboard/inbox') })
  } catch (e) {
    if (e.message !== 'Sesión no iniciada') root.innerHTML = '<div class="drawer-backdrop"><div class="drawer"><div class="empty"><strong>Error</strong><span class="small">' + esc(e.message) + '</span></div></div></div>'
  }
}

/* ------------------------------------------------------------------ bandeja */
async function viewInbox() {
  setView(`
    <div class="content wide">
      <div class="toolbar">
        <div class="segmented" id="in-tabs">
          <button data-filter="all" class="${state.inboxFilter === 'all' ? 'active' : ''}">Todas</button>
          <button data-filter="open" class="${state.inboxFilter === 'open' ? 'active' : ''}">Con persona</button>
        </div>
        <input class="input" id="in-search" placeholder="Buscar teléfono o etiqueta" value="${esc(state.inboxSearch)}">
        <div class="spacer"></div>
        <span class="badge" id="in-totals">—</span>
      </div>
      <div class="inbox">
        <div class="inbox-col list-col">
          <div class="inbox-head"><strong class="small">Conversaciones</strong><div class="spacer"></div><span class="tiny muted" id="in-count">—</span></div>
          <div class="conv-list" id="conv-list">${skeleton('Cargando conversaciones')}</div>
        </div>
        <div class="inbox-col thread-col">
          <div class="inbox-head" id="thread-head"><span class="small muted">Elige una conversación</span></div>
          <div class="thread" id="thread"><div class="empty"><strong>Ninguna conversación abierta</strong><span class="small">Selecciona un contacto a la izquierda.</span></div></div>
          <div class="composer hidden" id="composer">
            <textarea class="textarea" id="reply-text" placeholder="Escribe una respuesta… (Ctrl+Enter para enviar)"></textarea>
            <div class="stack" style="gap:6px">
              <button class="btn btn-primary" id="reply-send">Enviar</button>
              <button class="btn btn-sm" id="reply-canned">Respuestas</button>
            </div>
          </div>
        </div>
        <div class="inbox-col side-panel" id="side-panel"><div class="tiny muted">Ficha del contacto</div></div>
      </div>
    </div>`)

  $$('#in-tabs button').forEach((b) => b.addEventListener('click', () => {
    state.inboxFilter = b.getAttribute('data-filter')
    $$('#in-tabs button').forEach((x) => x.classList.toggle('active', x === b))
    paintConversations()
  }))
  let debounce = null
  $('#in-search').addEventListener('input', (e) => {
    state.inboxSearch = e.target.value
    clearTimeout(debounce)
    debounce = setTimeout(paintConversations, 260)
  })
  await paintConversations()
  if (state.pendingConversation) {
    const phone = state.pendingConversation
    state.pendingConversation = null
    openConversation(phone)
  }
}

async function paintConversations() {
  const list = $('#conv-list')
  if (!list) return
  try {
    const data = await api('/inbox?filter=' + encodeURIComponent(state.inboxFilter) + '&q=' + encodeURIComponent(state.inboxSearch || ''))
    const totals = $('#in-totals')
    if (looksRaw(data)) { list.innerHTML = OFFLINE_NOTE; return }
    const rows = arr(data.conversations)
    const head = data.totals || {}
    if (totals) totals.textContent = n(head.all) + ' con mensajes · ' + n(head.open) + ' con persona'
    const count = $('#in-count')
    if (count) count.textContent = n(rows.length)
    if (!rows.length) {
      list.innerHTML = '<div class="empty"><strong>Bandeja vacía</strong><span class="small">Cuando alguien escriba por WhatsApp aparecerá aquí.</span></div>'
      return
    }
    list.innerHTML = rows.map((c) => {
      const active = state.conversation === c.phone ? ' active' : ''
      const flag = c.lockState === 'HANDOFF_HUMAN' ? '<span class="badge warn tiny">persona</span>' : ''
      return '<div class="conv' + active + '" data-open="' + esc(c.phone) + '">' +
        '<div class="row1"><span class="who">' + esc(c.phone) + '</span>' + flag + '<span class="when">' + when(c.lastMessageAt) + '</span></div>' +
        '<div class="preview">' + (c.lastDirection === 'outbound' ? 'Tú: ' : '') + esc(String(c.lastMessage || '').slice(0, 60)) + '</div>' +
      '</div>'
    }).join('')
    $$('[data-open]', list).forEach((el) => el.addEventListener('click', () => openConversation(el.getAttribute('data-open'))))
    if (state.timer) clearInterval(state.timer)
    state.timer = setInterval(() => {
      if (state.route === '/dashboard/inbox' && !document.hidden) {
        paintConversationsQuiet()
        if (state.conversation) openConversation(state.conversation, true)
      }
    }, 15000)
  } catch (e) {
    if (e.message !== 'Sesión no iniciada') list.innerHTML = '<div class="empty"><strong>Error</strong><span class="small">' + esc(e.message) + '</span></div>'
  }
}

async function paintConversationsQuiet() {
  try {
    const data = await api('/inbox?filter=' + encodeURIComponent(state.inboxFilter) + '&q=' + encodeURIComponent(state.inboxSearch || ''))
    const list = $('#conv-list')
    if (!list) return
    if (looksRaw(data)) return
    list.innerHTML = arr(data.conversations).map((c) => {
      const active = state.conversation === c.phone ? ' active' : ''
      const flag = c.lockState === 'HANDOFF_HUMAN' ? '<span class="badge warn tiny">persona</span>' : ''
      return '<div class="conv' + active + '" data-open="' + esc(c.phone) + '">' +
        '<div class="row1"><span class="who">' + esc(c.phone) + '</span>' + flag + '<span class="when">' + when(c.lastMessageAt) + '</span></div>' +
        '<div class="preview">' + (c.lastDirection === 'outbound' ? 'Tú: ' : '') + esc(String(c.lastMessage || '').slice(0, 60)) + '</div>' +
      '</div>'
    }).join('')
    $$('[data-open]', list).forEach((el) => el.addEventListener('click', () => openConversation(el.getAttribute('data-open'))))
    const totals = $('#in-totals')
    const sum = data.totals || {}
    if (totals) totals.textContent = n(sum.all) + ' con mensajes · ' + n(sum.open) + ' con persona'
  } catch { /* silencio: el refresco automático no debe molestar */ }
}

async function openConversation(phone, quiet) {
  state.conversation = phone
  document.body.classList.add('conv-open')
  const head = $('#thread-head')
  const thread = $('#thread')
  const composer = $('#composer')
  try {
    const data = await api('/inbox/' + encodeURIComponent(phone))
    const messages = arr(data && data.messages)
    if (head) {
      head.innerHTML = '<button class="btn btn-sm menu-btn" id="back-list" aria-label="Volver a la lista de conversaciones">←</button>' +
        '<strong>' + esc(phone) + '</strong>' +
        (data.contact && data.contact.suppressed ? '<span class="badge danger">dado de baja</span>' : '') +
        (data.lock && data.lock.state === 'HANDOFF_HUMAN' ? '<span class="badge warn">con persona</span>' : '') +
        '<div class="spacer"></div><span class="tiny muted">' + (data.lock && data.lock.state === 'HANDOFF_HUMAN' ? 'el bot está en pausa' : 'el bot responde solo') + '</span>'
      const back = $('#back-list')
      if (back) back.addEventListener('click', () => document.body.classList.remove('conv-open'))
    }
    if (thread) {
      const previous = thread.scrollTop + thread.clientHeight >= thread.scrollHeight - 30
      thread.innerHTML = looksRaw(data) ? OFFLINE_NOTE : messages.length
        ? messages.map((m) => '<div class="bubble ' + (m.direction === 'inbound' ? 'in' : 'out') + '">' +
            esc(m.text) + '<span class="meta">' + clock(m.created_at) + '</span></div>').join('')
        : '<div class="empty"><strong>Sin mensajes</strong><span class="small">Puedes iniciar la conversación escribiendo abajo.</span></div>'
      if (!quiet || previous) thread.scrollTop = thread.scrollHeight
    }
    if (composer) {
      composer.classList.remove('hidden')
      const text = $('#reply-text')
      if (text && !text.dataset.bound) {
        text.dataset.bound = '1'
        text.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendReply()
        })
      }
      const send = $('#reply-send')
      if (send && !send.dataset.bound) {
        send.dataset.bound = '1'
        send.addEventListener('click', sendReply)
      }
      const cannedBtn = $('#reply-canned')
      if (cannedBtn && !cannedBtn.dataset.bound) {
        cannedBtn.dataset.bound = '1'
        cannedBtn.addEventListener('click', cannedPicker)
      }
    }
    paintSidePanel(data, phone)
    $$('[data-open]').forEach((el) => el.classList.toggle('active', el.getAttribute('data-open') === phone))
  } catch (e) {
    if (e.message !== 'Sesión no iniciada' && thread) thread.innerHTML = '<div class="empty"><strong>Error</strong><span class="small">' + esc(e.message) + '</span></div>'
  }
}

function paintSidePanel(data, phone) {
  const panel = $('#side-panel')
  if (!panel) return
  const c = data.contact || {}
  const agentOptions = (data.agents || []).map((a) => '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>').join('')
  panel.innerHTML =
    '<h3>Contacto</h3>' +
    '<div class="kv"><span>Teléfono</span><span>' + esc(phone) + '</span></div>' +
    '<div class="kv"><span>Mensajes</span><span>' + n(c.messageCount) + '</span></div>' +
    '<div class="kv"><span>Última actividad</span><span>' + when(c.lastMessageAt) + '</span></div>' +
    '<div class="kv"><span>Etiquetas</span><span>' + (c.tags && c.tags.length ? esc(c.tags.join(', ')) : '—') + '</span></div>' +
    '<div class="kv"><span>Estado</span><span>' + (c.suppressed ? 'dado de baja' : c.lockState === 'HANDOFF_HUMAN' ? 'con persona' : 'bot activo') + '</span></div>' +
    '<div class="kv"><span>Asesor</span><span>' + esc((data.assignment && data.assignment.agentName) || 'sin asignar') + '</span></div>' +
    '<h3>Acciones</h3>' +
    '<div class="stack" style="gap:8px">' +
      (c.lockState === 'HANDOFF_HUMAN'
        ? '<button class="btn btn-sm" id="sp-release">Devolver al bot</button>'
        : '<button class="btn btn-sm btn-primary" id="sp-handoff">Tomar el control</button>') +
      '<div class="inline"><select class="select" id="sp-agent" style="max-width:160px"><option value="">Asignar a…</option>' + agentOptions + '</select></div>' +
      '<button class="btn btn-sm" id="sp-contact">Ver ficha completa</button>' +
    '</div>' +
    '<p class="tiny muted" style="margin-top:14px">Tomar el control pausa las respuestas automáticas 15 minutos.</p>'

  const handoff = $('#sp-handoff')
  if (handoff) handoff.addEventListener('click', async () => {
    try { await api('/inbox/' + encodeURIComponent(phone) + '/handoff', { method: 'POST', body: {} }); toast('Has tomado el control'); openConversation(phone) } catch (e) { toast(e.message, true) }
  })
  const release = $('#sp-release')
  if (release) release.addEventListener('click', async () => {
    try { await api('/inbox/' + encodeURIComponent(phone) + '/release', { method: 'POST', body: {} }); toast('El bot vuelve a responder'); openConversation(phone) } catch (e) { toast(e.message, true) }
  })
  const agent = $('#sp-agent')
  if (agent) agent.addEventListener('change', async () => {
    const agentId = agent.value
    if (!agentId) return
    try { await api('/inbox/' + encodeURIComponent(phone) + '/assign', { method: 'POST', body: { strategy: 'agent', agentId } }); toast('Asignado'); openConversation(phone) } catch (e) { toast(e.message, true) }
  })
  const card = $('#sp-contact')
  if (card) card.addEventListener('click', () => contactDrawer(phone))
}

async function sendReply() {
  const phone = state.conversation
  const box = $('#reply-text')
  if (!phone || !box) return
  const text = box.value.trim()
  if (!text) return
  const sendBtn = $('#reply-send')
  if (sendBtn) sendBtn.disabled = true
  try {
    const res = await api('/inbox/' + encodeURIComponent(phone) + '/reply', { method: 'POST', body: { text } })
    box.value = ''
    toast(res.ok ? 'Mensaje enviado (' + (res.outcome || 'SENT') + ')' : 'Envío no confirmado: ' + (res.error || ''), !res.ok)
    openConversation(phone)
    paintConversationsQuiet()
  } catch (e) {
    toast(e.message, true)
  } finally {
    if (sendBtn) sendBtn.disabled = false
  }
}

async function cannedPicker() {
  try {
    const res = await fetch('/api/canned?org=' + encodeURIComponent(state.org), { headers: { 'X-Org-Id': state.org }, credentials: 'same-origin' })
    const list = await res.json()
    if (!Array.isArray(list) || !list.length) { toast('No hay respuestas guardadas (créalas en Ajustes)'); return }
    openModal('<div class="card-body"><h2 style="font-size:16px;margin-bottom:10px">Respuestas guardadas</h2>' +
      list.map((r) => '<div class="kv" style="cursor:pointer" data-pick="' + esc(r.content) + '"><span class="mono">/' + esc(r.shortcut) + '</span><span>' + esc(String(r.content).slice(0, 60)) + '</span></div>').join('') +
      '<div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-close>Cerrar</button></div></div>')
    $$('[data-pick]').forEach((el) => el.addEventListener('click', () => {
      const box = $('#reply-text')
      if (box) box.value = el.getAttribute('data-pick')
      closeModal()
    }))
  } catch (e) { toast('No se pudieron cargar las respuestas', true) }
}

/* ------------------------------------------------------------------ difusiones */
async function viewBroadcasts() {
  setView(skeleton('Cargando difusiones'))
  const [settings, contacts, history] = await Promise.all([api('/settings'), api('/contacts?limit=1'), api('/broadcasts')])
  state.settings = settings
  const tags = contacts.tags || []
  const simulated = !settings.transports.realDispatch || settings.transports.mode === 'mock'
  const rows = (history.broadcasts || []).map((b) => {
    let detail = {}
    try { detail = JSON.parse(b.detail || '{}') } catch { detail = {} }
    const badge = b.status === 'SENT' ? 'ok' : b.status === 'PARTIAL' ? 'warn' : 'danger'
    return '<tr><td class="mono tiny">' + esc(b.id.slice(0, 14)) + '</td><td>' + esc(String(detail.text || '').slice(0, 48)) + '</td>' +
      '<td>' + esc(detail.tag || 'toda la audiencia') + '</td><td class="num">' + n(detail.sent) + '/' + n(detail.recipients) + '</td>' +
      '<td><span class="badge ' + badge + '">' + esc(b.status) + '</span></td><td>' + clock(b.created_at) + '</td></tr>'
  }).join('')

  setView(`
    <div class="content">
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>Nueva difusión</h2><div class="spacer"></div>${simulated ? '<span class="badge warn">se simula</span>' : '<span class="badge ok">envío real</span>'}</div>
          <div class="card-body">
            <div class="field">
              <label class="label">Audiencia</label>
              <select class="select" id="bc-audience">
                <option value="">Toda la audiencia (sin dados de baja)</option>
                ${tags.map((t) => '<option value="' + esc(t) + '">Etiqueta: ' + esc(t) + '</option>').join('')}
              </select>
            </div>
            <div class="field">
              <label class="label">Mensaje</label>
              <textarea class="textarea" id="bc-text" maxlength="1024" placeholder="Hola, te escribimos para contarte…"></textarea>
              <div class="tiny muted" style="text-align:right"><span id="bc-count">0</span>/1024</div>
            </div>
            <div class="row">
              <button class="btn" id="bc-preview">Calcular audiencia</button>
              <div class="spacer"></div>
              <button class="btn btn-primary" id="bc-send">Enviar difusión</button>
            </div>
            <div class="small muted" id="bc-result" style="margin-top:12px"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Buenas prácticas</h2></div>
          <div class="card-body small muted">
            <p style="margin-top:0">• Envía solo a quien espera tu mensaje: los contactos dados de baja se excluyen siempre.</p>
            <p>• Las difusiones no pausan el bot; si el contacto responde, sus flujos siguen funcionando.</p>
            <p>• Una difusión no sustituye a una secuencia: aquí se manda una vez, a todos, ahora.</p>
            <p style="margin-bottom:0">• El resultado real de cada envío queda registrado abajo (nada se marca como entregado si no lo fue).</p>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>Historial</h2><div class="spacer"></div><span class="badge">${n((history.broadcasts || []).length)}</span></div>
        ${rows ? '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">ID</th><th scope="col">Mensaje</th><th scope="col">Audiencia</th><th scope="col">Enviados</th><th scope="col">Estado</th><th scope="col">Fecha</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty"><strong>Todavía no has enviado difusiones</strong><span class="small">La primera aparecerá aquí con su resultado real.</span></div>'}
      </div>
    </div>`)

  const text = $('#bc-text')
  text.addEventListener('input', () => { $('#bc-count').textContent = text.value.length })

  $('#bc-preview').addEventListener('click', async () => {
    const tag = $('#bc-audience').value
    try {
      const res = await api('/broadcast', { method: 'POST', body: { text: text.value || 'x', tag, dryRun: true } })
      $('#bc-result').innerHTML = 'Llegaría a <strong>' + n(res.recipients) + '</strong> contactos (' + n(res.audience) + ' en la audiencia, ' + n(res.skippedSuppressed) + ' excluidos por baja).'
    } catch (e) { toast(e.message, true) }
  })

  $('#bc-send').addEventListener('click', async () => {
    const body = text.value.trim()
    const tag = $('#bc-audience').value
    if (!body) { toast('Escribe el mensaje', true); return }
    const ok = await confirmModal('¿Enviar esta difusión ahora?', 'Se enviará a la audiencia seleccionada. Los contactos dados de baja quedan excluidos.')
    if (!ok) return
    const btn = $('#bc-send')
    btn.disabled = true
    try {
      // confirm: true es la señal explícita que exige el servidor para enviar de verdad.
      const res = await api('/broadcast', { method: 'POST', body: { text: body, tag, confirm: true } })
      $('#bc-result').innerHTML = '<span class="badge ' + (res.status === 'SENT' ? 'ok' : res.status === 'PARTIAL' ? 'warn' : 'danger') + '">' + esc(res.status) + '</span> ' +
        n(res.sent) + ' enviados · ' + n(res.rejected) + ' rechazados · ' + n(res.uncertain) + ' sin confirmar'
      toast('Difusión procesada: ' + res.sent + ' enviados')
      setTimeout(() => viewBroadcasts(), 800)
    } catch (e) {
      toast(e.message, true)
    } finally {
      btn.disabled = false
    }
  })
}

/* ------------------------------------------------------------------ crecimiento */
async function viewGrowth() {
  setView(skeleton('Cargando enlaces y QR'))
  const [data, settings] = await Promise.all([api('/growth'), api('/settings')])
  const links = data.links || []
  const origin = location.origin
  setView(`
    <div class="content">
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>Enlaces de entrada</h2><div class="spacer"></div><span class="badge">${n(links.length)}</span></div>
          <div class="card-body">
            <div class="field"><label class="label">Nombre corto del enlace (slug)</label><input class="input" id="gw-slug" placeholder="promo-verano"></div>
            <div class="grid-3" style="gap:10px">
              <div class="field"><label class="label">Etiqueta inicial</label><input class="input" id="gw-tag" placeholder="lead-frio"></div>
              <div class="field"><label class="label">Flujo de destino</label><select class="select" id="gw-flow"><option value="">(ninguno)</option>${(settings.flows || []).map((f) => '<option value="' + esc(f.id) + '">' + esc(f.name) + '</option>').join('')}</select></div>
            </div>
            <div class="field"><label class="label">Texto que llega prellenado</label><input class="input" id="gw-text" value="Hola, vengo de un enlace"></div>
            <button class="btn btn-primary" id="gw-create">Crear enlace</button>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Código QR</h2></div>
          <div class="card-body small muted">
            <p style="margin-top:0">El QR apunta a la página de entrada de WhatsApp Business y abre la conversación con tu número.</p>
            <a class="btn" href="/qr" target="_blank" rel="noopener">Abrir generador de QR ↗</a>
            <p class="tiny" style="margin-bottom:0">Los enlaces /ref/nombre-corto registran el clic y aplican la etiqueta inicial.</p>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>Enlaces creados</h2></div>
        ${links.length ? '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Enlace</th><th scope="col">Etiqueta</th><th scope="col">Flujo</th><th scope="col">Clics</th><th scope="col">Creado</th></tr></thead><tbody>' +
          links.map((l) => '<tr><td><a href="' + esc(origin) + '/ref/' + esc(l.slug) + '" target="_blank" rel="noopener">' + esc(origin) + '/ref/' + esc(l.slug) + '</a></td>' +
            '<td>' + esc(l.initial_tag || '—') + '</td><td class="mono tiny">' + esc(l.target_flow_id || '—') + '</td>' +
            '<td class="num">' + n(l.clicks) + '</td><td>' + clock(Number(l.created_at) * 1000) + '</td></tr>').join('') +
          '</tbody></table></div>'
        : '<div class="empty"><strong>Sin enlaces todavía</strong><span class="small">Crea uno para medir de dónde llegan tus contactos.</span></div>'}
      </div>
    </div>`)

  $('#gw-create').addEventListener('click', async () => {
    const slug = $('#gw-slug').value.trim()
    if (!slug) { toast('Escribe un nombre corto', true); return }
    try {
      await api('/growth', { method: 'POST', body: { slug, initialTag: $('#gw-tag').value.trim(), targetFlowId: $('#gw-flow').value || undefined, prefilledText: $('#gw-text').value } })
      toast('Enlace creado'); viewGrowth()
    } catch (e) { toast(e.message, true) }
  })
}

/* ------------------------------------------------------------------ ajustes */
async function viewSettings() {
  setView(skeleton('Cargando ajustes'))
  const data = await api('/settings')
  state.settings = data
  if (looksRaw(data)) { setView(OFFLINE_NOTE); return }
  const t = data.transports || {}
  const counts = data.counts || {}
  const agents = (data.agents || []).map((a) => '<tr><td><strong>' + esc(a.name) + '</strong><br><span class="tiny muted">' + esc(a.email) + '</span></td><td>' + esc(a.role) + '</td><td>' + (a.phone ? esc(a.phone) : '—') + '</td><td><span class="badge ok">activo</span></td></tr>').join('')
  const canned = (data.canned || []).map((c) => '<tr><td class="mono">/' + esc(c.shortcut) + '</td><td>' + esc(String(c.content).slice(0, 90)) + '</td></tr>').join('')

  setView(`
    <div class="content">
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>Canal de WhatsApp</h2></div>
          <div class="card-body">
            <div class="kv"><span>Transporte</span><span><span class="badge ${t.mode === 'mock' ? 'warn' : 'ok'}">${esc(t.mode)}</span></span></div>
            <div class="kv"><span>Envío real permitido</span><span>${t.realDispatch ? '<span class="badge ok">sí</span>' : '<span class="badge warn">no (simulación)</span>'}</span></div>
            <div class="kv"><span>Webhook del CRM</span><span>${t.webhookConfigured ? '<span class="badge ok">configurado</span>' : '<span class="badge">sin secreto</span>'}</span></div>
            <div class="kv"><span>Pagos</span><span>${esc(t.paymentsMode)}</span></div>
            <div class="kv"><span>Organización</span><span class="mono">${esc(data.org)}</span></div>
            <p class="tiny muted" style="margin-bottom:0">El transporte se cambia en la configuración del servidor (.env). El panel solo informa de lo que está activo.</p>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Equipo</h2><div class="spacer"></div><button class="btn btn-sm" id="team-new">Añadir asesor</button></div>
          <div class="card-body tight">
            ${agents ? '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Asesor</th><th scope="col">Rol</th><th scope="col">Teléfono</th><th scope="col"></th></tr></thead><tbody>' + agents + '</tbody></table></div>'
            : '<div class="empty"><strong>Sin asesores</strong><span class="small">Añade a las personas que atenderán la bandeja.</span></div>'}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>Respuestas guardadas</h2><div class="spacer"></div><button class="btn btn-sm" id="canned-new">Nueva respuesta</button></div>
        ${canned ? '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Atajo</th><th scope="col">Texto</th></tr></thead><tbody>' + canned + '</tbody></table></div>'
        : '<div class="empty"><strong>Sin respuestas guardadas</strong><span class="small">Ahorran tiempo en la bandeja: escribe /atajo en el buscador de respuestas.</span></div>'}
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>Datos y cumplimiento</h2></div>
        <div class="card-body">
          <div class="kv"><span>Contactos</span><span>${n(counts.contacts)}</span></div>
          <div class="kv"><span>Dados de baja</span><span>${n(counts.suppressed)}</span></div>
          <div class="kv"><span>Secuencias</span><span>${n(counts.sequences)}</span></div>
          <div class="inline" style="margin-top:12px">
            <a class="btn btn-sm" href="/qr" target="_blank" rel="noopener">Generador de QR</a>
            <a class="btn btn-sm" href="/studio" target="_blank" rel="noopener">Flow Studio</a>
            <a class="btn btn-sm" href="/api/health" target="_blank" rel="noopener">Salud del servidor</a>
          </div>
          <p class="tiny muted" style="margin-bottom:0">Los datos de un contacto se pueden consultar y borrar por la API de cumplimiento (/api/compliance/contact-data).</p>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>Registro de actividad</h2><span class="small muted">Quién hizo qué: acción, resultado e IP de origen</span></div>
        <div class="card-body" id="audit-body"><span class="small muted">Cargando registro…</span></div>
      </div>
    </div>`)

  // La auditoría solo la ve administración; si un asesor entra, se le explica sin drama.
  api('/audit?limit=25').then((page) => {
    const host = $('#audit-body')
    if (!host) return
    const rows = (page.entries || []).map((e) => '<tr><td class="mono tiny">' + clock(Number(e.created_at)) + '</td>' +
      '<td>' + esc(e.actor) + ' <span class="tiny muted">(' + esc(e.actor_role) + ')</span></td>' +
      '<td class="mono tiny">' + esc(e.action) + '</td><td>' + esc(e.subject || '—') + '</td>' +
      '<td><span class="badge ' + (e.outcome === 'ok' ? 'ok' : e.outcome === 'denied' ? 'danger' : 'warn') + '">' + esc(e.outcome) + '</span></td></tr>').join('')
    host.innerHTML = rows
      ? '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Cuándo</th><th scope="col">Quién</th><th scope="col">Acción</th><th scope="col">Sujeto</th><th scope="col">Resultado</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<p class="tiny muted" style="margin:10px 0 0">' + n(page.total) + ' acciones registradas en esta organización.</p>'
      : '<div class="empty"><strong>Todavía sin acciones</strong><span class="small">Cada respuesta, difusión o cambio de baja quedará aquí.</span></div>'
  }).catch((e) => {
    const host = $('#audit-body')
    if (host) host.innerHTML = '<p class="small muted" style="margin:0">' + esc(e.message) + '</p>'
  })

  $('#team-new').addEventListener('click', () => {
    openModal('<div class="card-body"><h2 style="font-size:16px;margin-bottom:10px">Añadir asesor</h2>' +
      '<div class="field"><label class="label">Nombre</label><input class="input" id="ag-name"></div>' +
      '<div class="field"><label class="label">Email</label><input class="input" id="ag-email" type="email"></div>' +
      '<div class="field"><label class="label">Teléfono (opcional)</label><input class="input" id="ag-phone"></div>' +
      '<div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" id="ag-save">Guardar</button></div></div>')
    $('#ag-save').addEventListener('click', async () => {
      try {
        await fetch('/api/team/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Org-Id': state.org },
          credentials: 'same-origin',
          body: JSON.stringify({ name: $('#ag-name').value.trim(), email: $('#ag-email').value.trim(), phone: $('#ag-phone').value.trim() || undefined, role: 'agent' }),
        }).then(async (r) => { if (!r.ok) throw new Error('No se pudo crear (revisa email y nombre)') })
        closeModal(); toast('Asesor añadido'); viewSettings()
      } catch (e) { toast(e.message, true) }
    })
  })

  $('#canned-new').addEventListener('click', () => {
    openModal('<div class="card-body"><h2 style="font-size:16px;margin-bottom:10px">Nueva respuesta guardada</h2>' +
      '<div class="field"><label class="label">Atajo (sin la barra)</label><input class="input" id="cn-shortcut" placeholder="precios"></div>' +
      '<div class="field"><label class="label">Texto</label><textarea class="textarea" id="cn-content" placeholder="Te paso la lista de precios actualizada…"></textarea></div>' +
      '<div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" id="cn-save">Guardar</button></div></div>')
    $('#cn-save').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/canned', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Org-Id': state.org },
          credentials: 'same-origin',
          body: JSON.stringify({ shortcut: $('#cn-shortcut').value.trim(), content: $('#cn-content').value.trim() }),
        })
        if (!res.ok) throw new Error('No se pudo guardar (atajo repetido o vacío)')
        closeModal(); toast('Respuesta guardada'); viewSettings()
      } catch (e) { toast(e.message, true) }
    })
  })
}

/* ------------------------------------------------------------------ arranque */
window.addEventListener('popstate', () => {
  state.route = location.pathname
  if (state.timer) { clearInterval(state.timer); state.timer = null }
  render()
})

async function boot_app() {
  try {
    const settings = await api('/settings')
    state.settings = settings
  } catch (e) {
    if (e.message === 'Sesión no iniciada') return
    /* seguimos: el panel puede funcionar aunque /settings falle */
  }
  if (!$('#root') || !$('#root').querySelector('.shell')) shell()
  else shell()
  const path = location.pathname
  state.route = VIEWS.some((v) => path === v.path || path.startsWith(v.path + '/')) ? path : '/dashboard'
  if (state.route !== path) history.replaceState({}, '', state.route)
  await render()
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal()
  // Tab dentro de un diálogo no se escapa a la página de detrás.
  if (e.key !== 'Tab') return
  const dialog = dialogRoot()
  if (!dialog) return
  const items = focusablesIn(dialog)
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === dialog)) {
    e.preventDefault()
    if (typeof last.focus === 'function') last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    if (typeof first.focus === 'function') first.focus()
  }
})

boot_app().catch((e) => {
  if (e && e.message === 'Sesión no iniciada') return
  showGate('No se pudo abrir el panel: ' + (e && e.message ? e.message : 'error desconocido'))
})
