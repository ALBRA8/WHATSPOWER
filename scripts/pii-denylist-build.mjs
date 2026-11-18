#!/usr/bin/env node
/**
 * pii-denylist-build.mjs
 * Construye la denylist de PII SOLO como HMAC-SHA256(sal_aleatoria + valor_normalizado),
 * firmados con una clave secreta ("pepper") que NUNCA se compromete ni se imprime.
 * Los valores en claro jamás se muestran ni quedan en archivos del repo.
 *
 * REQUIERE el pepper (sin él no se genera hashlist HMAC):
 *   - variable de entorno PII_PEPPER, o
 *   - archivo local scripts/pii-pepper.local (en .gitignore; primera línea no vacía,
 *     admite # comentarios y el prefijo PII_PEPPER=).
 *   Generación recomendada: openssl rand -hex 32 (mínimo 32 caracteres).
 *
 * Fuentes de valores (elige una):
 *   --from-git <ruta>@<revision>  Extrae los valores del check-pii.mjs ANTIGUO guardado en el
 *                                 historial de git (formato FORBIDDEN_PATTERNS con regex literales).
 *                                 Así el operador reconstruye su lista localmente, sin publicar nada.
 *   --from-file <archivo>         Líneas "tipo:valor" (name|handle|lid|phone); admite # comentarios.
 *   --from-stdin                  Lo mismo, por stdin.
 *
 * Salida:
 *   --out <archivo>   (por defecto scripts/pii-hashlist.json)
 *   El archivo incluye solo: version, algorithm, note, pepperCheck (verificación de que el
 *   escáner tiene el pepper correcto) y las entradas {type, salt, hmac}. El pepper NO se
 *   escribe en ningún archivo de salida y jamás se imprime: el reporte solo muestra conteos.
 *
 * Ejemplo de reconstrucción local sin publicar:
 *   PII_PEPPER="<secreto>" node scripts/pii-denylist-build.mjs --from-git "scripts/check-pii.mjs@<revision-antigua>" --out scripts/pii-hashlist.json
 *
 * Lista local opcional (gitignore, nunca se compromete): scripts/pii-denylist.local.txt
 * con líneas "tipo:valor", o export PII_DENYLIST_FILE=/ruta/privada/lista.txt
 */
import { execSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const PEPPER_FILE = path.join(SCRIPTS_DIR, 'pii-pepper.local')
const TYPES = new Set(['name', 'handle', 'lid', 'phone'])
// Mensaje canónico de verificación del pepper (debe coincidir con check-pii.mjs)
const PEPPER_VERIFY_MSG = 'pii-hashlist:verificacion-de-pepper:v2'
const MIN_PEPPER_LEN = 32

// ——— Normalización (idéntica a check-pii.mjs) ———
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

// ——— Pepper (idéntico a check-pii.mjs); nunca se imprime ———
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
    /* archivo ausente */
  }
  return null
}

const hmacHex = (pepper, salt, value) => createHmac('sha256', pepper).update(salt + value, 'utf8').digest('hex')

function parseOldScanner(text) {
  const blockMatch = text.match(/const FORBIDDEN_PATTERNS = \[([\s\S]*?)\n\]/)
  if (!blockMatch) throw new Error('No se encontró FORBIDDEN_PATTERNS en el archivo indicado')
  const block = blockMatch[1]
  const rules = [...block.matchAll(/\{\s*name:\s*'([^']+)',\s*regex:\s*\/([\s\S]*?)\/([a-z]*)\s*\}/g)]
  const values = []
  for (const [, name, source] of rules) {
    if (name === 'NOMBRE_OPERADOR') {
      const raw = source.replace(/\\b/g, '').replace(/\\s\+/g, ' ')
      values.push({ type: 'name', value: normName(raw) })
    } else if (name === 'USUARIO_TIKTOK') {
      values.push({ type: 'handle', value: normHandle(source.replace(/\\b/g, '')) })
    } else if (name === 'LID_REAL_WHATSAPP') {
      values.push({ type: 'lid', value: normDigits(source) })
    } else if (/^TELEFONO_REAL_/.test(name)) {
      const raw = source.replace(/^\\b\(\?:57\)\?/, '').replace(/\\b/g, '')
      const p = normPhone(raw)
      if (p) values.push({ type: 'phone', value: p })
    } else {
      console.warn(`[denylist-build] AVISO: regla "${name}" sin parser conocido; se omite`)
    }
  }
  return values.filter((v) => v.value)
}

function parseValuesText(text, label) {
  const values = []
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return
    const idx = t.indexOf(':')
    if (idx <= 0) throw new Error(`${label}:${i + 1} sin formato "tipo:valor"`)
    const type = t.slice(0, idx).trim()
    const raw = t.slice(idx + 1).trim()
    if (!TYPES.has(type)) throw new Error(`${label}:${i + 1} tipo desconocido "${type}" (use name|handle|lid|phone)`)
    const n = normValue(type, raw)
    if (!n) throw new Error(`${label}:${i + 1} valor no normalizable para el tipo "${type}"`)
    values.push({ type, value: n })
  })
  return values
}

function main() {
  // 1) Pepper obligatorio (no se imprime jamás; errores no revelan su contenido)
  const pepper = loadPepper()
  if (!pepper) {
    console.error('[denylist-build] ERROR: falta el pepper (variable de entorno PII_PEPPER o archivo scripts/pii-pepper.local).')
    console.error('[denylist-build] Sin pepper NO se genera hashlist HMAC. Genere uno con: openssl rand -hex 32')
    process.exit(2)
  }
  if (pepper.length < MIN_PEPPER_LEN) {
    console.error(`[denylist-build] ERROR: el pepper es demasiado corto (mínimo ${MIN_PEPPER_LEN} caracteres).`)
    console.error('[denylist-build] Genere uno robusto con: openssl rand -hex 32')
    process.exit(2)
  }

  // 2) Valores (nunca se imprimen; los errores solo citan tipo/línea, jamás el valor)
  const argv = process.argv.slice(2)
  let values = []
  if (argv[0] === '--from-git') {
    const spec = argv[1] || ''
    const at = spec.lastIndexOf('@')
    if (at <= 0) throw new Error('uso: --from-git <ruta>@<revision>')
    const ruta = spec.slice(0, at)
    const rev = spec.slice(at + 1)
    const text = execSync(`git show ${JSON.stringify(rev + ':' + ruta)}`, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
    values = parseOldScanner(text)
  } else if (argv[0] === '--from-file') {
    const file = argv[1]
    if (!file) throw new Error('uso: --from-file <archivo>')
    values = parseValuesText(fs.readFileSync(file, 'utf8'), file)
  } else if (argv[0] === '--from-stdin') {
    values = parseValuesText(fs.readFileSync(0, 'utf8'), 'stdin')
  } else {
    console.error('uso: pii-denylist-build.mjs (--from-git <ruta>@<rev> | --from-file <archivo> | --from-stdin) [--out <archivo>]')
    process.exit(2)
  }

  if (values.length === 0) throw new Error('no se obtuvo ningún valor de la fuente indicada')

  // 3) Entradas HMAC-SHA256(sal + valor_normalizado) con el pepper como clave
  const outIdx = argv.indexOf('--out')
  const outPath = outIdx >= 0 && argv[outIdx + 1] ? path.resolve(argv[outIdx + 1]) : path.join(SCRIPTS_DIR, 'pii-hashlist.json')

  const entries = values.map((v) => {
    const salt = randomBytes(16).toString('hex')
    return { type: v.type, salt, hmac: hmacHex(pepper, salt, v.value) }
  })
  // Entrada de verificación: permite al escáner comprobar que su pepper corresponde a esta
  // hashlist (estado "no-coincide") sin revelar la clave ni los valores.
  const pcSalt = randomBytes(16).toString('hex')
  const pepperCheck = { salt: pcSalt, hmac: hmacHex(pepper, pcSalt, PEPPER_VERIFY_MSG) }

  const doc = {
    version: 2,
    algorithm: 'hmac-sha256(pepper; sal+valor_normalizado)',
    note: 'Solo HMAC-SHA256 con pepper secreto (PII_PEPPER o scripts/pii-pepper.local, NUNCA commiteado). Sin la clave no es posible verificar candidatos: la hashlist publicada no revela valores. Regenerar con scripts/pii-denylist-build.mjs.',
    pepperCheck,
    entries,
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n')

  const counts = {}
  for (const v of values) counts[v.type] = (counts[v.type] || 0) + 1
  console.log(`[denylist-build] OK: ${entries.length} entradas HMAC (${JSON.stringify(counts)}) + verificación de pepper -> ${outPath}`)
  console.log('[denylist-build] Recordatorio: el pepper no se imprime ni se almacena en la hashlist; guárdelo en su gestor de contraseñas.')
}

try {
  main()
} catch (err) {
  console.error('[denylist-build] ERROR:', err.message)
  process.exit(1)
}
