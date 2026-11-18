#!/usr/bin/env node
/**
 * e2e-3-servicios.mjs — E2E AUTOCONTENIDO del ecosistema completo (3 servicios):
 *   CRM-ALBRA + WHATSPOWER + WHATSPOWER-ULTRA (puertos libres elegidos al vuelo)
 *
 * NO depende de scripts externos ni de archivos fuera de los repos: levanta los
 * tres servicios con bases de datos TEMPORALES y secretos generados en runtime,
 * ejecuta el flujo completo y limpia todo al terminar. Multiplataforma
 * (Windows y Linux) usando solo Node: sin bash, sin /tmp fijo, sin tee.
 *
 * Flujo verificado (todo en simulación, ALLOW_REAL_DISPATCH=false, jamás envíos reales):
 *   E1  Salud de los 3 servicios.
 *   E2  Configuración WhatsApp de la org en el CRM (appSecret de prueba generado).
 *   E3  Flujo creado en WHATSPOWER (trigger keyword + crm_action + send_message).
 *   E4  Mensaje entrante Meta firmado → CRM valida → puente → WHATSPOWER procesa →
 *       flujo ejecuta crm_action → CLIENTE creado en el CRM.
 *   E5  Lock de conversación en WHATSPOWER para un teléfono (mensaje sin keyword).
 *   E6  Consentimiento registrado en ULTRA para un contacto (FASE 2).
 *   E7  Campaña ULTRA con 3 contactos: bloqueado por lock / SKIPPED_NO_CONSENT /
 *       salvaguarda de despacho → SENT=0 (jamás SENT con ALLOW_REAL_DISPATCH=false).
 *
 * Uso (comando único, desde cualquiera de los tres repos):
 *   npm run e2e:3
 * Requisitos:
 *   - Node >= 22 en el PATH (el CRM genera el cliente Prisma la primera vez si falta).
 *   - node_modules instalados en los tres repos (npm install en cada uno).
 * Variables opcionales:
 *   E2E_CRM_DIR / E2E_WP_DIR / E2E_ULTRA_DIR → rutas explícitas de los repos
 *   (por defecto se autodescubren buscando package.json por su campo "name").
 * Seguridad: los secretos del E2E se generan con crypto.randomBytes y JAMÁS se
 * imprimen; los teléfonos son ficticios del bloque reservado 573000000xxx.
 */
import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const IS_WIN = process.platform === 'win32'
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NAMES = { crm: 'crm-albra-saas', wp: 'whatspower', ultra: 'whatspower-ultra' }

// ——— Descubrimiento de repos hermanos (por package.json "name") ———
function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
}
function findRepo(role, envVar) {
  if (process.env[envVar]) {
    const p = path.resolve(process.env[envVar])
    if (!fs.existsSync(path.join(p, 'package.json'))) throw new Error(`${envVar}=${p} no contiene package.json`)
    return p
  }
  const bases = new Set([path.dirname(REPO_ROOT), path.dirname(path.dirname(REPO_ROOT)), path.dirname(path.dirname(path.dirname(REPO_ROOT)))])
  for (const base of bases) {
    for (const entry of safeReaddir(base)) {
      const pkg = path.join(base, entry, 'package.json')
      try {
        if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name === NAMES[role]) return path.join(base, entry)
      } catch { /* no legible */ }
    }
  }
  throw new Error(`No se encontró el repo "${NAMES[role]}" (${role}). Instálalo junto a este repo o define ${envVar}.`)
}

// ——— Utilidades ———
const hex = (n) => randomBytes(n).toString('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}
async function jfetch(url, opts = {}, timeoutMs = 60000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) })
  let json = null
  try { json = await res.json() } catch { /* cuerpo no JSON */ }
  return { status: res.status, json, text: json ? '' : await res.text().catch(() => '') }
}
async function waitHealthy(name, url, timeoutMs, logFile) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await jfetch(url, {}, 4000)
      if (r.status === 200) return
    } catch { /* aún arrancando */ }
    await sleep(1500)
  }
  throw new Error(`${name} no respondió /api/health en ${timeoutMs} ms (log: ${logFile})`)
}
async function pollUntil(label, fn, timeoutMs, intervalMs = 2000) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    last = await fn()
    if (last.ok) return last
    await sleep(intervalMs)
  }
  return last
}

// ——— Procesos hijos ———
const children = []
function spawnService(name, cmd, args, cwd, extraEnv, logFile) {
  for (const k of Object.keys(extraEnv)) if (extraEnv[k] === undefined) delete extraEnv[k]
  const out = fs.openSync(logFile, 'a')
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', out, out],
    windowsHide: true,
    detached: !IS_WIN, // grupo de proceso propio en POSIX para matar el árbol
  })
  children.push({ name, child })
  console.log(`[boot] ${name} pid=${child.pid} (log: ${path.basename(logFile)})`)
  return child
}
function runCapture(name, cmd, args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...extraEnv }, windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`${name} exit=${code}\n${out.slice(-800)}`)))
  })
}
function killAllChildren() {
  for (const { name, child } of children) {
    if (!child.pid || child.exitCode !== null) continue
    try {
      if (IS_WIN) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      }
    } catch { /* ya murió */ }
    console.log(`[cleanup] señal de parada enviada a ${name} (pid=${child.pid})`)
  }
  if (!IS_WIN) {
    setTimeout(() => {
      for (const { child } of children) {
        try { if (child.pid && child.exitCode === null) process.kill(-child.pid, 'SIGKILL') } catch { /* ya murió */ }
      }
    }, 3000).unref()
  }
}

// ——— Resultados ———
const results = []
function log(id, name, pass, detail) {
  results.push({ id, name, pass: Boolean(pass), detail: String(detail || '') })
  console.log(`${pass ? '✅' : '❌'} [${id}] ${name} — ${detail}`)
}

// ——— Main ———
async function main() {
  console.log('=== E2E 3 SERVICIOS (autocontenido, multiplataforma) ===')
  const crmDir = findRepo('crm', 'E2E_CRM_DIR')
  const wpDir = findRepo('wp', 'E2E_WP_DIR')
  const ultraDir = findRepo('ultra', 'E2E_ULTRA_DIR')
  console.log(`[repos] CRM=${crmDir}`)
  console.log(`[repos] WHATSPOWER=${wpDir}`)
  console.log(`[repos] ULTRA=${ultraDir}`)

  for (const [role, dir] of [['CRM', crmDir], ['WHATSPOWER', wpDir], ['ULTRA', ultraDir]]) {
    if (!fs.existsSync(path.join(dir, 'node_modules'))) {
      throw new Error(`Faltan node_modules en ${role} (${dir}). Ejecuta "npm install" ahí primero.`)
    }
  }

  // Bases temporales y secretos de prueba (runtime; nunca se imprimen)
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e3-'))
  const crmDb = 'file:' + path.join(workdir, 'crm.db').replace(/\\/g, '/')
  const crmLog = path.join(workdir, 'crm.log')
  const wpLog = path.join(workdir, 'wp.log')
  const ultraLog = path.join(workdir, 'ultra.log')

  // 1) Preparar CRM: cliente Prisma (si falta) + migraciones en la BD temporal
  const prismaBin = path.join(crmDir, 'node_modules', 'prisma', 'build', 'index.js')
  const nextBin = path.join(crmDir, 'node_modules', 'next', 'dist', 'bin', 'next')
  if (!fs.existsSync(prismaBin) || !fs.existsSync(nextBin)) {
    throw new Error('El CRM no tiene next/prisma instalados (¿npm install?)')
  }
  if (!fs.existsSync(path.join(crmDir, 'node_modules', '.prisma', 'client'))) {
    console.log('[crm] generando cliente Prisma (una sola vez)...')
    await runCapture('prisma generate', process.execPath, [prismaBin, 'generate'], crmDir, { DATABASE_URL: crmDb })
  }
  console.log('[crm] aplicando migraciones en BD temporal...')
  await runCapture('prisma migrate deploy', process.execPath, [prismaBin, 'migrate', 'deploy'], crmDir, { DATABASE_URL: crmDb })

  // 2) Puertos libres y secretos de prueba
  const crmPort = await freePort()
  const wpPort = await freePort()
  const ultraPort = await freePort()
  const CRM = `http://127.0.0.1:${crmPort}`
  const WP = `http://127.0.0.1:${wpPort}`
  const ULTRA = `http://127.0.0.1:${ultraPort}`
  const APP_SECRET = hex(32)
  const APP_ENCRYPTION_KEY = hex(32)
  const META_APP_SECRET = hex(24)
  const WHATSPOWER_WEBHOOK_SECRET = hex(24)
  const ORG_SECRET_WP = hex(24)
  const ADMIN_KEY_ULTRA = hex(24)
  // Teléfonos FICTICIOS de prueba (bloque 573000000xxx reservado para E2E)
  const PHONE_LEAD = '573000007301'
  const PHONE_LOCK = '573000007302'
  const PHONE_NOCONSENT = '573000007303'
  const PHONE_OK = '573000007304'

  try {
    // 3) Arrancar el CRM primero (compila en dev) para obtener la org de la sesión demo
    spawnService('CRM', process.execPath, [nextBin, 'dev', '-p', String(crmPort)], crmDir, {
      NEXT_TELEMETRY_DISABLED: '1',
      DATABASE_URL: crmDb,
      APP_SECRET,
      APP_ENCRYPTION_KEY,
      DEMO_MODE: 'true',
      WHATSPOWER_ENABLED: 'true',
      WHATSPOWER_INBOUND_URL: `${WP}/api/inbound`,
      WHATSPOWER_WEBHOOK_SECRET,
    }, crmLog)
    await waitHealthy('CRM', `${CRM}/api/health`, 180000, crmLog)

    // 4) Sesión demo del CRM → org (del payload del token) + API key albra_ para WP→CRM
    const login = await pollUntil('sesión demo CRM', async () => {
      try {
        const r = await jfetch(`${CRM}/api/auth/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 90000)
        if (r.status === 200 && r.json?.token) return { ok: true, token: r.json.token }
        return { ok: false, status: r.status }
      } catch (e) { return { ok: false, err: e.message } }
    }, 180000, 6000)
    if (!login.ok) throw new Error(`No se pudo iniciar sesión demo en el CRM (${login.status || login.err})`)
    const JWT = login.token
    const payload = JSON.parse(Buffer.from(JWT.split('.')[1], 'base64url').toString('utf8'))
    const ORG = payload.orgId
    log('E0a', 'sesión demo del CRM (org obtenida del token)', Boolean(JWT && ORG), `org=${String(ORG).slice(0, 8)}…`)

    const keyRes = await jfetch(`${CRM}/api/settings/api-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'E2E 3 servicios (temporal)' }),
    }, 90000)
    const ALBRA_KEY = keyRes.json?.secret
    log('E0b', 'API key albra_ creada en el CRM para el puente WP→CRM', keyRes.status === 201 && Boolean(ALBRA_KEY), `status=${keyRes.status}`)
    if (!ALBRA_KEY) throw new Error('No se pudo crear la API key temporal en el CRM')

    // 5) Arrancar WHATSPOWER y ULTRA con credenciales de la org ya conocidas
    spawnService('WHATSPOWER', process.execPath, ['--experimental-strip-types', 'src/server.ts'], wpDir, {
      PORT: String(wpPort),
      HOST: '127.0.0.1',
      NODE_ENV: 'development',
      ALLOW_REAL_DISPATCH: 'false',
      INTERNAL_API_KEYS: `${ORG}:${ORG_SECRET_WP}:admin`,
      ORG_SERVICE_CREDENTIALS: `${ORG}:${ORG_SECRET_WP}`,
      CRM_BASE_URL: CRM,
      CRM_API_KEYS: JSON.stringify({ [ORG]: ALBRA_KEY }),
      WEBHOOK_SECRET: WHATSPOWER_WEBHOOK_SECRET,
      WP_DB_PATH: path.join(workdir, 'wp-operational.db'),
      WP_REPLAY_DB_PATH: path.join(workdir, 'wp-replay.db'),
    }, wpLog)
    spawnService('ULTRA', process.execPath, ['--experimental-strip-types', 'src/server.ts'], ultraDir, {
      PORT: String(ultraPort),
      HOST: '127.0.0.1',
      NODE_ENV: 'development',
      ALLOW_REAL_DISPATCH: 'false',
      ADMIN_API_KEYS: `${ORG}:${ADMIN_KEY_ULTRA}`,
      WHATSPOWER_ORG_CREDENTIALS: `${ORG}:${ORG_SECRET_WP}`,
      AGENTIC_2A_URL: WP,
      // Ventana de horario comercial ampliada SOLO para este E2E simulado
      // (ALLOW_REAL_DISPATCH=false: jamás hay envío real; sin esto, el guard
      // anti-ban dejaría los ítems en PENDING fuera de 8-18 Bogotá)
      BUSINESS_HOURS_START: '0',
      BUSINESS_HOURS_END: '24',
      ULTRA_DB_PATH: path.join(workdir, 'ultra-broadcast.db'),
      ULTRA_REPLAY_DB_PATH: path.join(workdir, 'ultra-replay.db'),
    }, ultraLog)
    await waitHealthy('WHATSPOWER', `${WP}/api/health`, 60000, wpLog)
    await waitHealthy('ULTRA', `${ULTRA}/api/health`, 60000, ultraLog)

    // E1: salud de los 3
    for (const [name, base] of [['CRM', CRM], ['WHATSPOWER', WP], ['ULTRA', ULTRA]]) {
      const r = await jfetch(`${base}/api/health`)
      log(`E1-${name}`, `health ${name}`, r.status === 200, `status=${r.status}`)
    }
    const authJwt = { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json' }

    // E2: configurar WhatsApp de la org en CRM (appSecret de prueba)
    const cfg = await jfetch(`${CRM}/api/whatsapp/config`, {
      method: 'PUT', headers: authJwt,
      body: JSON.stringify({ whatsappPhoneId: 'E2E-3S-PHONE-ID', metaAppSecret: META_APP_SECRET, enableWhatsApp: true }),
    }, 120000)
    log('E2', 'config WhatsApp org en CRM (appSecret de prueba)', cfg.status === 200 || cfg.status === 201, `status=${cfg.status}`)

    // E3: flujo en WHATSPOWER con crm_action create_client
    const flow = {
      id: `flow_e2e_3servicios_${Date.now()}`,
      name: 'E2E 3 Servicios (prueba)',
      triggerKeywords: ['e2e3'],
      isActive: true,
      nodes: [
        { id: 'n1', type: 'trigger', title: 'Trigger E2E3', position: { x: 0, y: 0 }, data: { keywords: ['e2e3'], matchType: 'contains' } },
        { id: 'n2', type: 'crm_action', title: 'Registrar cliente en CRM', position: { x: 200, y: 0 }, data: { crmAction: 'create_client', crmParams: { name: 'Cliente E2E 3 Servicios', phone: PHONE_LEAD } } },
        { id: 'n3', type: 'send_message', title: 'Respuesta', position: { x: 400, y: 0 }, data: { message: 'Flujo E2E3 ejecutado (respuesta simulada)' } },
      ],
    }
    const fRes = await jfetch(`${WP}/api/flows`, {
      method: 'POST',
      headers: { 'x-org-id': ORG, Authorization: `Bearer ${ORG_SECRET_WP}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(flow),
    })
    log('E3', 'flujo creado en WHATSPOWER', fRes.status === 200 || fRes.status === 201, `status=${fRes.status} body=${(fRes.json ? JSON.stringify(fRes.json) : fRes.text).slice(0, 120)}`)

    // E4: mensaje entrante Meta firmado → CRM → WP → flujo → CRM action
    const metaBody = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'E2E-3S-WABA',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '573000000000', phone_number_id: 'E2E-3S-PHONE-ID' },
            contacts: [{ wa_id: PHONE_LEAD, profile: { name: 'Lead E2E 3S' } }],
            messages: [{ from: PHONE_LEAD, id: `wamid.E2E3S${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), text: { body: 'hola E2E3 quiero info' }, type: 'text' }],
          },
        }],
      }],
    }
    const rawBody = JSON.stringify(metaBody)
    const metaSig = 'sha256=' + createHmac('sha256', META_APP_SECRET).update(rawBody, 'utf8').digest('hex')
    const hook = await jfetch(`${CRM}/api/whatsapp/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': metaSig }, body: rawBody,
    }, 120000)
    log('E4a', 'CRM acepta webhook Meta firmado', hook.status === 200, `status=${hook.status}`)

    const clientCheck = await pollUntil('cliente en CRM', async () => {
      const clients = await jfetch(`${CRM}/api/clients?q=${PHONE_LEAD}`, { headers: { Authorization: `Bearer ${JWT}` } })
      const list = Array.isArray(clients.json) ? clients.json : (clients.json?.clients || clients.json?.items || [])
      const created = list.find((c) => String(c.phone || '').includes(PHONE_LEAD))
      return { ok: Boolean(created), created, total: list.length }
    }, 60000, 2500)
    log('E4b', 'flujo ejecutó crm_action → cliente creado en CRM', clientCheck.ok, clientCheck.created ? `clientId=${clientCheck.created.id}` : `encontrados=${clientCheck.total}`)

    // E5: lock de conversación en WP vía mensaje entrante (sin keyword de flujo)
    const metaBodyLock = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'E2E-3S-WABA',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '573000000000', phone_number_id: 'E2E-3S-PHONE-ID' },
            contacts: [{ wa_id: PHONE_LOCK, profile: { name: 'Contacto con Lock' } }],
            messages: [{ from: PHONE_LOCK, id: `wamid.E2E3SLOCK${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), text: { body: 'mensaje sin keyword de flujo' }, type: 'text' }],
          },
        }],
      }],
    }
    const rawLock = JSON.stringify(metaBodyLock)
    const lockSig = 'sha256=' + createHmac('sha256', META_APP_SECRET).update(rawLock, 'utf8').digest('hex')
    const hookLock = await jfetch(`${CRM}/api/whatsapp/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': lockSig }, body: rawLock,
    }, 120000)
    log('E5a', 'mensaje entrante de PHONE_LOCK al CRM (activa flujo/lock en WP)', hookLock.status === 200, `status=${hookLock.status}`)
    const lockCheck = await pollUntil('lock en WP', async () => {
      const lk = await jfetch(`${WP}/api/internal/locks/${PHONE_LOCK}`, {
        headers: { 'x-org-id': ORG, Authorization: `Bearer ${ORG_SECRET_WP}` },
      })
      const body = lk.json || {}
      const locked = body.locked === true || body.isLocked === true || body.lock === true
      return { ok: lk.status === 200 && locked, status: lk.status, body }
    }, 45000, 2500)
    log('E5b', 'WP confirma lock activo para el teléfono (IN_FLOW_2A)', lockCheck.ok, `status=${lockCheck.status} body=${JSON.stringify(lockCheck.body).slice(0, 140)}`)

    // E6: consentimiento en ULTRA para PHONE_OK (FASE 2)
    const consent = await jfetch(`${ULTRA}/api/compliance/consent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_KEY_ULTRA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactPhone: PHONE_OK, whoAuthorized: 'operador-de-prueba', channel: 'whatsapp', textShown: 'Texto de consentimiento E2E (prueba)', source: 'e2e-3-servicios' }),
    })
    log('E6', 'consentimiento registrado en ULTRA', consent.status === 201 || consent.status === 200, `status=${consent.status}`)

    // E7: campaña ULTRA con los 3 contactos
    const csvContent = `phone,name\n${PHONE_LOCK},ConLock\n${PHONE_NOCONSENT},SinConsent\n${PHONE_OK},ConConsent`
    const camp = await jfetch(`${ULTRA}/api/campaigns`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_KEY_ULTRA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `E2E-3S-${Date.now()}`, templateSpintax: 'Mensaje de prueba E2E 3 servicios', csvContent }),
    })
    const campaign = camp.json?.campaign || camp.json
    log('E7a', 'campaña creada en ULTRA', camp.status === 201 || camp.status === 200, `status=${camp.status} id=${campaign?.id} body=${JSON.stringify(camp.json ?? camp.text).slice(0, 180)}`)

    if (campaign?.id) {
      // Activación: DRAFT→RUNNING se hace con /resume (decisión explícita del operador)
      const act = await jfetch(`${ULTRA}/api/campaigns/${campaign.id}/resume`, {
        method: 'POST', headers: { Authorization: `Bearer ${ADMIN_KEY_ULTRA}` },
      })
      log('E7a2', 'campaña activada (DRAFT→RUNNING vía /resume)', act.status === 200 || act.status === 201, `status=${act.status}`)
      const step = await jfetch(`${ULTRA}/api/campaigns/${campaign.id}/step`, {
        method: 'POST', headers: { Authorization: `Bearer ${ADMIN_KEY_ULTRA}` },
      })
      log('E7b', 'paso de despacho ejecutado', step.status === 200 || step.status === 202, `status=${step.status} body=${JSON.stringify(step.json).slice(0, 100)}`)

      // Pacing anti-ban: repetir pasos hasta que los 3 ítems salgan de PENDING (tope ~110 s)
      let items = []
      for (let round = 0; round < 15; round++) {
        await sleep(7000)
        await jfetch(`${ULTRA}/api/campaigns/${campaign.id}/step`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_KEY_ULTRA}` } })
        const detail = await jfetch(`${ULTRA}/api/campaigns/${campaign.id}`, { headers: { Authorization: `Bearer ${ADMIN_KEY_ULTRA}` } })
        items = detail.json?.items || detail.json?.campaign?.items || []
        const pending = items.filter((it) => /^PENDING$/i.test(String(it.status || it.state))).length
        if (pending === 0) break
      }
      log('E7b2', 'ciclos de pacing completados (ítems fuera de PENDING)', items.length > 0 && items.every((it) => !/^PENDING$/i.test(String(it.status || it.state))), `items=${items.length}`)
      const byPhone = {}
      for (const it of items) byPhone[String(it.phone || it.contactPhone)] = it.status || it.state

      const stLock = byPhone[PHONE_LOCK]
      const stNoConsent = byPhone[PHONE_NOCONSENT]
      const stOk = byPhone[PHONE_OK]
      const isSent = (s) => /^SENT\b/.test(String(s || ''))
      log('E7c', 'contacto con lock → NO despachado (lock respetado)', stLock && !isSent(stLock), `status=${stLock}`)
      log('E7d', 'contacto sin consentimiento → SKIPPED_NO_CONSENT (FASE 2)', stNoConsent && /NO_CONSENT/i.test(stNoConsent), `status=${stNoConsent}`)
      log('E7e', 'contacto válido → salvaguarda activa: jamás SENT', stOk && !isSent(stOk), `status=${stOk}`)

      const sentTotal = items.filter((it) => isSent(it.status || it.state)).length
      log('E7f', 'cero envíos reales en toda la campaña (ALLOW_REAL_DISPATCH=false)', sentTotal === 0, `SENT=${sentTotal}`)
      console.log('\nEstados por contacto:', JSON.stringify(byPhone))
    }

    const fails = results.filter((r) => !r.pass).length
    console.log(`\n=== E2E 3 SERVICIOS: ${results.length - fails}/${results.length} PASS ===`)
    process.exitCode = fails === 0 ? 0 : 1
  } finally {
    killAllChildren()
    await sleep(1500)
    try { fs.rmSync(workdir, { recursive: true, force: true }) } catch { /* en uso: el SO la limpiará */ }
    console.log('[cleanup] procesos detenidos y bases temporales eliminadas')
  }
}

main().catch((e) => {
  console.error('✋ E2E falló:', e?.message || e)
  killAllChildren()
  process.exit(1)
})
