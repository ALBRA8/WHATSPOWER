/**
 * Humo del panel de control: arranca el servidor en memoria (transporte simulado),
 * recorre la SPA y la API nueva y cierra. No envía nada a ningún sitio.
 */
import { createAgenticServer } from '../src/server.ts'
import { MockTransportSender } from '../src/adapters/transport.ts'
import { MockCrmClient } from '../src/adapters/crm-client.ts'

process.env.TRANSPORT = 'mock'
process.env.ALLOW_MOCK_TRANSPORT = 'true'
process.env.INTERNAL_API_SECRET = 'smoke_dashboard_internal_secret_24chars' // scan-secrets:allow
process.env.ORG_SERVICE_CREDENTIALS = 'org_smoke:org_smoke_service_credential_16ch'

const transport = new MockTransportSender()
const { server } = createAgenticServer({ dbPath: ':memory:', transport, crm: new MockCrmClient(), webhookSecret: 'x'.repeat(32) })

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`
const org = 'org_smoke'
const auth = { Authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`, 'X-Org-Id': org }

let fails = 0
function check(name: string, ok: boolean, extra = '') {
  console.log((ok ? '  OK   ' : '  FALLO ') + name + (extra ? ' — ' + extra : ''))
  if (!ok) fails++
}

try {
  const shell = await fetch(base + '/dashboard')
  const html = await shell.text()
  check('GET /dashboard sirve la SPA', shell.status === 200 && html.includes('Panel de control'), 'status ' + shell.status)

  const asset = await fetch(base + '/dashboard/assets/app.js')
  const js = await asset.text()
  check('GET /dashboard/assets/app.js sirve el cliente', asset.status === 200 && js.includes('/api/dashboard'), 'bytes ' + js.length)

  const css = await fetch(base + '/dashboard/assets/app.css')
  check('GET /dashboard/assets/app.css sirve los estilos', css.status === 200 && (await css.text()).includes('--brand'))

  const deep = await fetch(base + '/dashboard/contacts')
  check('ruta interna de la SPA devuelve la cáscara', deep.status === 200 && (await deep.text()).includes('Panel de control'))

  const anon = await fetch(base + '/api/dashboard/overview', { headers: { 'X-Org-Id': org } })
  check('overview sin credencial → 401/503', anon.status === 401 || anon.status === 503, 'status ' + anon.status)

  const noOrg = await fetch(base + '/api/dashboard/overview', { headers: { Authorization: auth.Authorization } })
  check('overview sin x-org-id → 400', noOrg.status === 400, 'status ' + noOrg.status)

  const overview = await fetch(base + '/api/dashboard/overview', { headers: auth })
  const overviewBody: any = await overview.json()
  check('overview con credencial → 200 y KPIs', overview.status === 200 && typeof overviewBody.kpis?.contacts === 'number', 'status ' + overview.status)

  const tag = await fetch(base + '/api/dashboard/contacts/34600111222/tags', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: 'lead-frio' }),
  })
  const tagBody: any = await tag.json()
  check('añadir etiqueta a un contacto', tag.status === 200 && tagBody.tags.includes('lead-frio'), 'status ' + tag.status)

  const contacts = await fetch(base + '/api/dashboard/contacts', { headers: auth })
  const contactsBody: any = await contacts.json()
  check('el contacto derivado aparece en el listado', contacts.status === 200 && contactsBody.total >= 1, 'total ' + contactsBody.total)

  const reply = await fetch(base + '/api/dashboard/inbox/34600111222/reply', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hola, te atendemos ahora' }),
  })
  const replyBody: any = await reply.json()
  check('respuesta manual por la bandeja', reply.status === 200 && replyBody.ok === true, 'outcome ' + replyBody.outcome)

  const thread = await fetch(base + '/api/dashboard/inbox/34600111222', { headers: auth })
  const threadBody: any = await thread.json()
  check('el hilo guarda el mensaje saliente', thread.status === 200 && threadBody.messages.length >= 1, 'mensajes ' + threadBody.messages.length)

  const handoff = await fetch(base + '/api/dashboard/inbox/34600111222/handoff', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })
  const handoffBody: any = await handoff.json()
  check('tomar el control bloquea al bot', handoff.status === 200 && handoffBody.lockState === 'HANDOFF_HUMAN')

  const release = await fetch(base + '/api/dashboard/inbox/34600111222/release', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })
  check('devolver al bot', release.status === 200)

  const seq = await fetch(base + '/api/dashboard/sequences', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bienvenida', steps: [{ delayMinutes: 0, messageText: 'Hola' }, { delayMinutes: 60, messageText: '¿Seguimos?' }] }),
  })
  const seqBody: any = await seq.json()
  check('crear secuencia de 2 pasos', seq.status === 200 && seqBody.steps === 2, 'id ' + seqBody.id)

  const seqs = await fetch(base + '/api/dashboard/sequences', { headers: auth })
  const seqsBody: any = await seqs.json()
  check('la secuencia se lista con sus pasos', seqs.status === 200 && (seqsBody.sequences?.[0]?.steps?.length || 0) === 2)

  const enroll = await fetch(base + '/api/dashboard/sequences/' + seqBody.id + '/enroll', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '34600111222' }),
  })
  check('inscribir contacto en la secuencia', enroll.status === 200, 'status ' + enroll.status)

  const dry = await fetch(base + '/api/dashboard/broadcast', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Promo', tag: 'lead-frio', dryRun: true }),
  })
  const dryBody: any = await dry.json()
  check('difusión: cálculo de audiencia', dry.status === 200 && dryBody.recipients >= 1, 'destinatarios ' + dryBody.recipients)

  const broadcast = await fetch(base + '/api/dashboard/broadcast', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Promo', tag: 'lead-frio', confirm: true }),
  })
  const broadcastBody: any = await broadcast.json()
  check('difusión: envío simulado y registro', broadcast.status === 200 && broadcastBody.status === 'SENT', 'enviados ' + broadcastBody.sent)

  const history = await fetch(base + '/api/dashboard/broadcasts', { headers: auth })
  const historyBody: any = await history.json()
  check('historial de difusiones', history.status === 200 && historyBody.broadcasts.length >= 1)

  const rule = await fetch(base + '/api/dashboard/rules', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage: 'interesado', action: 'send_message', templateMessage: 'Te llamamos hoy' }),
  })
  check('guardar regla por etapa', rule.status === 200)

  const rules = await fetch(base + '/api/dashboard/rules', { headers: auth })
  const rulesBody: any = await rules.json()
  check('la regla por etapa se lista', rules.status === 200 && rulesBody.rules.length >= 1)

  const settings = await fetch(base + '/api/dashboard/settings', { headers: auth })
  const settingsBody: any = await settings.json()
  check('ajustes: transporte y equipo', settings.status === 200 && settingsBody.transports.mode === 'mock')

  const growth = await fetch(base + '/api/dashboard/growth', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'promo-smoke', initialTag: 'lead-frio' }),
  })
  check('crear enlace de crecimiento', growth.status === 200, 'status ' + growth.status)

  const blocked = await fetch(base + '/api/dashboard/inbox/34600111222/reply', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }),
  })
  check('respuesta vacía rechazada', blocked.status === 400, 'status ' + blocked.status)
} finally {
  server.close()
  console.log(fails === 0 ? '\nHUMO: todo correcto' : `\nHUMO: ${fails} comprobaciones fallidas`)
}

process.exit(fails === 0 ? 0 : 1)
