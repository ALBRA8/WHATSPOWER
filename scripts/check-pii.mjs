#!/usr/bin/env node
/**
 * check-pii.mjs — guardián anti-PII del árbol rastreado por git.
 *
 * Este archivo NO contiene datos reales. Diseño:
 *
 * 1) DENYLIST CON HMAC: los valores prohibidos del operador no viven aquí en texto plano
 *    ni como hash verificable sin clave. scripts/pii-hashlist.json (comprometido) guarda
 *    SOLO HMAC-SHA256(sal_aleatoria + valor_normalizado), firmados con una clave secreta
 *    ("pepper") que NUNCA se compromete: variable de entorno PII_PEPPER o archivo local
 *    scripts/pii-pepper.local (en .gitignore). Sin la clave NO se puede calcular el HMAC
 *    de un candidato, así que un intento de adivinación no es verificable offline y la
 *    hashlist publicada, sin el pepper, no revela ningún valor (a diferencia de un
 *    sha256(sal+valor) simple, que cualquiera puede comparar contra sus candidatos).
 *
 * 2) Estado del pepper (se informa SIEMPRE en voz alta; ver README):
 *    ok          → comprobación completa (hashlist + genéricos + lista local).
 *    ausente     → la comprobación de VALORES PROHIBIDOS de la hashlist queda DESACTIVADA;
 *                  se aplican solo los patrones genéricos (teléfonos no autorizados /
 *                  whitelist exacta) y la lista local opcional. NO falla (exit 0 si el
 *                  árbol está limpio), pero emite un aviso prominente y una anotación
 *                  ::warning:: visible en GitHub Actions.
 *    no-coincide → el pepper configurado NO corresponde a esta hashlist (se verifica con
 *                  la entrada pepperCheck, sin revelar la clave); mismo comportamiento que
 *                  "ausente", con un aviso que lo indica explícitamente en el reporte.
 *    hashlist-no-disponible / hashlist-obsoleta → avisos equivalentes; regenerar.
 *
 * 3) Lista local opcional (NUNCA se compromete): scripts/pii-denylist.local.txt con líneas
 *    "tipo:valor" (name|handle|lid|phone), o la ruta que apunte PII_DENYLIST_FILE. Es texto
 *    plano privado del operador: se compara en memoria y funciona incluso sin pepper.
 *
 * 4) WHITELIST EXACTA de números ficticios documentados (ver FICTITIOUS_*). Cualquier otro
 *    número colombiano de 10 dígitos que empiece por 3 se reporta. Las violaciones se
 *    imprimen SIEMPRE redactadas: nunca se muestra el valor que disparó la alerta.
 *    El pepper jamás se imprime ni queda en reportes o mensajes de commit.
 *
 * Reconstrucción local de la hashlist sin publicar valores:
 *   PII_PEPPER="<secreto>" node scripts/pii-denylist-build.mjs \
 *     --from-git "scripts/check-pii.mjs@<revision-antigua>" --out scripts/pii-hashlist.json
 *   (mismo pepper que usará el escáner; vea README "Denylist de PII con pepper (HMAC)")
 *
 * Tipos: name (nombre), handle (usuario de red), lid (LID de WhatsApp), phone (teléfono de 10 dígitos).
 */
import { execSync } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const HASHLIST_PATH = path.join(SCRIPTS_DIR, 'pii-hashlist.json')
const PEPPER_FILE = path.join(SCRIPTS_DIR, 'pii-pepper.local')
const LOCAL_DENYLIST_DEFAULT = path.join(SCRIPTS_DIR, 'pii-denylist.local.txt')
// Mensaje canónico de verificación del pepper (debe coincidir con pii-denylist-build.mjs)
const PEPPER_VERIFY_MSG = 'pii-hashlist:verificacion-de-pepper:v2'

// ——— Normalización (debe coincidir con pii-denylist-build.mjs) ———
const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const normName = (s) => stripAccents(s).toLowerCase().replace(/\s+/g, ' ').trim()
const normHandle = (s) => s.trim().replace(/^@+/, '').toLowerCase()
const normDigits = (s) => s.replace(/\D/g, '')
const normPhone = (s) => {
  let d = normDigits(s)
  if (d.length === 12 && d.startsWith('57')) d = d.slice(2)
  return d.length === 10 ? d : null
}
const normValue = (type, value) => {
  switch (type) {
    case 'name': return normName(value)
    case 'handle': return normHandle(value)
    case 'lid': return normDigits(value)
    case 'phone': return normPhone(value)
    default: return null
  }
}

const sha256Hex = (salt, value) => createHash('sha256').update(salt + value, 'utf8').digest('hex')
const hmacHex = (pepper, salt, value) => createHmac('sha256', pepper).update(salt + value, 'utf8').digest('hex')

// ——— Pepper: variable de entorno PII_PEPPER o archivo local git-ignorado ———
// Nunca se imprime ni se registra; solo se usa como clave HMAC.
function loadPepper() {
  const env = (process.env.PII_PEPPER || '').trim()
  if (env) return env
  try {
    for (const raw of fs.readFileSync(PEPPER_FILE, 'utf8').split(/\r?\n/)) {
      let line = raw.trim()
      if (!line || line.startsWith('#')) continue
      if (/^PII_PEPPER=/i.test(line)) line = line.slice('PII_PEPPER='.length).trim()
      if (line) return line
    }
  } catch {
    /* archivo ausente: normal */
  }
  return null
}

// ——— Hashlist comprometida (formato v2: HMAC-SHA256 + pepperCheck) ———
function loadHashlist() {
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(HASHLIST_PATH, 'utf8'))
  } catch {
    return null
  }
  const algo = String((doc && doc.algorithm) || '')
  const entries = Array.isArray(doc && doc.entries) ? doc.entries.filter((e) => e && e.type && e.hmac) : []
  if (algo.startsWith('hmac-sha256')) {
    const pc = doc.pepperCheck
    if (entries.length > 0 && pc && pc.salt && pc.hmac) return { obsolete: false, entries, pepperCheck: pc }
    return null
  }
  // Formato antiguo (sha256 con sal pública): detectable pero inseguro; exigir regeneración
  if (entries.length > 0 || algo.includes('sha256')) return { obsolete: true, entries: [], pepperCheck: null }
  return null
}

// ——— WHITELIST EXACTA de números ficticios (documentados, sin datos reales) ———
// Rango de fábrica reservado para ejemplos y pruebas: 573000000000–573000000099
// (normalizado a 10 dígitos: 3000000000–3000000099).
const FICTITIOUS_RANGE_START = 3000000000
const FICTITIOUS_RANGE_END = 3000000099
// Números ficticios EXACTOS usados en pruebas, fixtures y documentación de este repo
// y de los otros niveles del ecosistema (unión verificada 2026-11-17).
// Para agregar uno nuevo: debe ser claramente ficticio y documentarse aquí con el test que lo usa.
const FICTITIOUS_EXACT = new Set([
  '3000000102', '3000000201', '3000000311', '3000000312', '3000000401', '3000000421',
  '3000000606', '3000000707', '3000000777', '3000000778', '3000000808', '3000000909',
  '3000001001', '3000001102', '3000001103', '3000001122', '3000001133', '3000001199',
  '3000001234', '3000007301', '3000007302', '3000007303', '3000007304', '3000007766',
  '3000009988', '3000111222', '3000123456', '3000333444', '3000555666', '3000654321',
  '3000777888', '3000987654', '3000990011', '3000999000', '3000999888', '3001110000',
  '3001110001', '3001110002', '3001110003', '3001110004', '3001111111', '3001112222',
  '3001112233', '3001112244', '3001112255', '3001112266', '3001119999', '3001234567',
  '3001234999', '3002222222', '3002223333', '3002223344', '3003333333', '3003334455',
  '3004440001', '3004440002', '3004440003', '3004440004', '3004445555', '3004445566',
  '3005550001', '3005550002', '3005554433', '3005556666', '3005556667', '3005556677',
  '3006667777', '3006667788', '3007770011', '3007776655', '3007778888', '3007778899',
  '3008880001', '3008889900', '3008889999', '3009876543', '3009990000', '3009990001',
  '3009990011', '3009990055', '3009991122', '3009998800', '3009998877', '3009998887',
  '3009999999', '3100000001', '3100000002', '3100000003', '3100000077', '3100000088',
  '3100000099', '3100000123', '3100000250', '3109998877', '3109998888', '3110000001',
  '3110000004', '3111000000', '3111000001', '3111000002', '3111222333', '3112223344',
  '3112233445', '3115550102', '3155550106', '3156665577', '3159876543', '3199998877',
  '3201234567', '3204445566', '3209998877', '3222000001', '3222333444', '3444555666',
  '3777888999', '3999111222', '3999888777',
])

function isWhitelistedPhone(normalized10) {
  const n = Number(normalized10)
  if (n >= FICTITIOUS_RANGE_START && n <= FICTITIOUS_RANGE_END) return true
  return FICTITIOUS_EXACT.has(normalized10)
}

// ——— Lista local opcional (texto plano privado; se compara en memoria) ———
function addLocalValue(arr, type, raw) {
  if (!['name', 'handle', 'lid', 'phone'].includes(type)) {
    console.warn(`[check:pii] AVISO: tipo "${type}" desconocido en lista local; ignorado`)
    return
  }
  const n = normValue(type, raw)
  if (!n) {
    console.warn(`[check:pii] AVISO: valor de tipo "${type}" no normalizable en lista local; ignorado`)
    return
  }
  const salt = randomBytes(16).toString('hex')
  arr.push({ type, salt, hash: sha256Hex(salt, n) })
}

function loadLocalDenylist(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const entries = []
  if (text.trim().startsWith('{')) {
    const j = JSON.parse(text)
    for (const v of j.values || []) addLocalValue(entries, String(v.type), String(v.value ?? ''))
  } else {
    text.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim()
      if (!t || t.startsWith('#')) return
      const idx = t.indexOf(':')
      if (idx <= 0) {
        console.warn(`[check:pii] AVISO: línea ${i + 1} de ${path.basename(file)} sin "tipo:valor"; ignorada`)
        return
      }
      addLocalValue(entries, t.slice(0, idx).trim(), t.slice(idx + 1).trim())
    })
  }
  return entries
}

// ——— Candidatos por línea (con su span para redactar la salida) ———
// Teléfonos: 10 dígitos, con o sin prefijo 57. También alimenta la denylist de tipo phone.
const PHONE_RE = /\b(?:57)?\d{10}\b/g
// LIDs de WhatsApp: corridas largas de dígitos (15+).
const LID_RE = /\b\d{15,}\b/g
// Nombres: secuencias de 2+ palabras. Se generan candidatos por corrida completa y por
// cada par de palabras contiguas (así se detecta "Nombre Apellido" dentro de corridas más
// largas y en cualquier combinación de mayúsculas/minúsculas).
const NAME_RE = /(?:[A-Za-zÁÉÍÓÚÜÑáéíóúüñ']+)(?:\s+(?:[A-Za-zÁÉÍÓÚÜÑáéíóúüñ']+))+/g
// Handles/usuarios: tokens que empiezan por letra (o @) y contienen al menos un dígito.
const HANDLE_RE = /\b[a-z@][a-z0-9._@-]*\d[a-z0-9._@-]*\b/gi

function collectCandidates(line) {
  const out = []
  for (const m of line.matchAll(PHONE_RE)) {
    const n = normPhone(m[0])
    if (n) out.push({ type: 'phone', norm: n, start: m.index, end: m.index + m[0].length })
  }
  for (const m of line.matchAll(LID_RE)) {
    out.push({ type: 'lid', norm: normDigits(m[0]), start: m.index, end: m.index + m[0].length })
  }
  for (const m of line.matchAll(NAME_RE)) {
    const run = m[0]
    const words = run.split(/\s+/)
    if (words.length < 2) continue
    // Candidatas: n-gramas contiguos de 2 a 4 palabras (cubre "Nombre Apellido" dentro de
    // corridas más largas y nombres de 3-4 palabras). Guardas de volumen para líneas enormes.
    const capped = words.length > 24 ? words.slice(0, 24) : words
    for (let n = 2; n <= 4 && n <= capped.length; n++) {
      for (let i = 0; i + n <= capped.length; i++) {
        out.push({ type: 'name', norm: normName(capped.slice(i, i + n).join(' ')), start: m.index, end: m.index + run.length })
      }
    }
    if (words.length > 4 && words.length <= 8) {
      out.push({ type: 'name', norm: normName(run), start: m.index, end: m.index + run.length })
    }
  }
  for (const m of line.matchAll(HANDLE_RE)) {
    out.push({ type: 'handle', norm: normHandle(m[0]), start: m.index, end: m.index + m[0].length })
  }
  return out
}

function redactSnippet(line, spans) {
  let out = line
  for (const { start, end } of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, start) + '[REDACTADO]' + out.slice(end)
  }
  return out.replace(/\d{4,}/g, (m) => `${m.slice(0, 2)}…`).trim().slice(0, 160)
}

const EXCLUDE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.db', '.sqlite', '.map', '.woff', '.woff2', '.ttf',
])
const EXCLUDE_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'])

function main() {
  // 1) Cargar pepper, hashlist comprometida y lista local opcional
  const pepper = loadPepper()
  const hashlist = loadHashlist()
  const localPath = process.env.PII_DENYLIST_FILE || LOCAL_DENYLIST_DEFAULT
  const localEntries = loadLocalDenylist(localPath)

  let hashStatus = 'hashlist-no-disponible'
  if (hashlist) {
    hashStatus = hashlist.obsolete
      ? 'hashlist-obsoleta'
      : (!pepper
          ? 'ausente'
          : (hmacHex(pepper, hashlist.pepperCheck.salt, PEPPER_VERIFY_MSG) === hashlist.pepperCheck.hmac ? 'ok' : 'no-coincide'))
  }

  // 2) Avisos SIEMPRE en voz alta (banner en stderr + anotación ::warning:: en Actions)
  const inCI = process.env.GITHUB_ACTIONS === 'true'
  const banner = (lines) => {
    const edge = '─'.repeat(74)
    console.error(`[check:pii] ┌${edge}`)
    for (const l of lines) console.error(`[check:pii] │ ${l}`)
    console.error(`[check:pii] └${edge}`)
  }
  const genericOnly = 'Se aplican solo los patrones genéricos (teléfonos no autorizados / whitelist exacta)' + (localEntries ? ' y la lista local.' : '.')
  switch (hashStatus) {
    case 'ausente':
      banner([
        'AVISO: pepper NO configurado (variable de entorno PII_PEPPER o archivo scripts/pii-pepper.local).',
        'La comprobación de VALORES PROHIBIDOS de la hashlist quedó DESACTIVADA.',
        genericOnly,
        'Active el pepper (secreto de GitHub Actions en CI, archivo local en desarrollo) para la comprobación completa.',
      ])
      if (inCI) console.log('::warning::check:pii sin PII_PEPPER: comprobación de valores prohibidos (hashlist) desactivada')
      break
    case 'no-coincide':
      banner([
        'AVISO: el pepper configurado NO corresponde a esta hashlist (falla la verificación pepperCheck).',
        'La comprobación de VALORES PROHIBIDOS de la hashlist quedó DESACTIVADA; este reporte lo indica.',
        genericOnly,
        'Causas típicas: pepper rotado sin regenerar la hashlist, o hashlist construida con otro pepper.',
        'Regenere la hashlist con scripts/pii-denylist-build.mjs usando el pepper correcto.',
      ])
      if (inCI) console.log('::warning::check:pii: PII_PEPPER no corresponde a esta hashlist: comprobación de valores prohibidos desactivada')
      break
    case 'hashlist-obsoleta':
      banner([
        'AVISO: scripts/pii-hashlist.json usa el formato antiguo sha256(sal+valor), adivinable sin clave.',
        'La comprobación de VALORES PROHIBIDOS quedó DESACTIVADA.',
        'Regenere con scripts/pii-denylist-build.mjs (requiere pepper; ver README).',
      ])
      if (inCI) console.log('::warning::check:pii: hashlist en formato antiguo sha256: regenerar con pii-denylist-build.mjs')
      break
    case 'hashlist-no-disponible':
      console.warn('[check:pii] AVISO: no se pudo cargar scripts/pii-hashlist.json (formato v2 HMAC); se usan solo los patrones genéricos' + (localEntries ? ' y la lista local' : ''))
      break
  }
  if (localEntries === null && process.env.PII_DENYLIST_FILE && hashStatus === 'ok') {
    console.warn('[check:pii] AVISO: PII_DENYLIST_FILE apunta a un archivo inexistente o ilegible; se continúa con la hashlist comprometida')
  }
  if (!localEntries && hashStatus !== 'ok') {
    console.warn('[check:pii] AVISO: sin denylist activa; se aplican SOLO los patrones genéricos')
  }

  const hashByType = { name: [], handle: [], lid: [], phone: [] }
  const localByType = { name: [], handle: [], lid: [], phone: [] }
  if (hashStatus === 'ok') {
    for (const e of hashlist.entries) if (hashByType[e.type]) hashByType[e.type].push(e)
  }
  for (const e of localEntries || []) if (localByType[e.type]) localByType[e.type].push(e)

  // 3) Archivos rastreados
  let trackedFiles = []
  try {
    const stdout = execSync('git ls-files', { cwd: process.cwd(), encoding: 'utf-8' })
    trackedFiles = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch (err) {
    console.error('[check:pii] Error ejecutando git ls-files:', err.message)
    process.exit(1)
  }

  // 4) Escaneo
  const violations = []
  const memo = new Map() // "tipo|norm" -> true (coincide con denylist activa)
  function isDenied(type, norm) {
    const key = `${type}|${norm}`
    let d = memo.get(key)
    if (d === undefined) {
      d = (hashStatus === 'ok' && hashByType[type].some((e) => hmacHex(pepper, e.salt || '', norm) === e.hmac)) ||
          localByType[type].some((e) => sha256Hex(e.salt, norm) === e.hash)
      memo.set(key, d)
    }
    return d
  }

  for (const relPath of trackedFiles) {
    const ext = path.extname(relPath).toLowerCase()
    const base = path.basename(relPath)
    if (EXCLUDE_EXTS.has(ext) || EXCLUDE_FILES.has(base)) continue
    const fullPath = path.join(process.cwd(), relPath)
    if (!fs.existsSync(fullPath)) continue
    let content = ''
    try {
      content = fs.readFileSync(fullPath, 'utf-8')
    } catch {
      continue
    }

    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      const lineNum = i + 1
      for (const c of collectCandidates(line)) {
        if (isDenied(c.type, c.norm)) {
          violations.push({ file: relPath, line: lineNum, rule: `DATO_PROHIBIDO:${c.type}`, spans: [{ start: c.start, end: c.end }], text: line })
        } else if (c.type === 'phone' && c.norm.startsWith('3') && !isWhitelistedPhone(c.norm)) {
          violations.push({ file: relPath, line: lineNum, rule: 'TELEFONO_NO_AUTORIZADO', spans: [{ start: c.start, end: c.end }], text: line })
        }
      }
    }
  }

  // 5) Reporte (siempre redactado; nunca se muestran valores ni el pepper)
  if (violations.length > 0) {
    console.error(`\n[check:pii] SE ENCONTRARON ${violations.length} VIOLACIONES DE PII / TELÉFONOS NO AUTORIZADOS:\n`)
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.rule}] ${redactSnippet(v.text, v.spans)}`)
    }
    console.error('\nCorrija estas coincidencias antes de hacer commit. Si un número ficticio nuevo es legítimo, agréguelo a FICTITIOUS_EXACT con su justificación.\n')
    process.exit(1)
  }

  const hCounts = Object.fromEntries(Object.entries(hashByType).map(([k, v]) => [k, v.length]))
  const lCount = Object.values(localByType).reduce((a, v) => a + v.length, 0)
  const pepperLabel = {
    'ok': 'ok',
    'ausente': 'ausente — comprobación de valores prohibidos desactivada',
    'no-coincide': 'no coincide con la hashlist — comprobación desactivada',
    'hashlist-obsoleta': 'hashlist obsoleta (regenerar)',
    'hashlist-no-disponible': 'hashlist no disponible',
  }[hashStatus]
  console.log(`[check:pii] OK: árbol limpio (denylist HMAC: ${hashStatus === 'ok' ? hashlist.entries.length : 0} entradas ${JSON.stringify(hCounts)}${lCount ? ` + ${lCount} locales` : ''}; pepper: ${pepperLabel}; whitelist: rango ${FICTITIOUS_RANGE_START}-${FICTITIOUS_RANGE_END} + ${FICTITIOUS_EXACT.size} exactos).`)
}

main()
