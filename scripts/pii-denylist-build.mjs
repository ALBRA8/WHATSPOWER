#!/usr/bin/env node
/**
 * pii-denylist-build.mjs
 * Construye la denylist de PII SOLO como hashes SHA-256 con sal aleatoria por entrada.
 * Los valores en claro NUNCA se imprimen ni quedan en archivos del repo.
 *
 * Fuentes de valores (elige una):
 *   --from-git <ruta>@<revision>  Extrae los valores del check-pii.mjs ANTIGUO guardado en el
 *                                 historial de git (formato FORBIDDEN_PATTERNS con regex literales).
 *                                 Asi el operador reconstruye su lista localmente, sin publicar nada.
 *   --from-file <archivo>         Lineas "tipo:valor" (name|handle|lid|phone); admite # comentarios.
 *   --from-stdin                  Lo mismo, por stdin.
 *
 * Salida:
 *   --out <archivo>   (por defecto scripts/pii-hashlist.json)
 *
 * Ejemplo de reconstruccion local sin publicar:
 *   node scripts/pii-denylist-build.mjs --from-git "scripts/check-pii.mjs@<revision-antigua>" --out scripts/pii-hashlist.json
 *
 * Lista local opcional (gitignore, nunca se compromete): scripts/pii-denylist.local.txt
 * con lineas "tipo:valor", o export PII_DENYLIST_FILE=/ruta/privada/lista.txt
 */
import { execSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const TYPES = new Set(['name', 'handle', 'lid', 'phone'])

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

function sha256Hex(salt, value) {
  return createHash('sha256').update(salt + value, 'utf8').digest('hex')
}

function main() {
  const argv = process.argv.slice(2)
  let values = []
  if (argv[0] === '--from-git') {
    const spec = argv[1] || ''
    const at = spec.lastIndexOf('@')
    if (at <= 0) throw new Error('uso: --from-git <ruta>@<revision>')
    const ruta = spec.slice(0, at)
    const rev = spec.slice(at + 1)
    const text = execSync(`git show ${JSON.stringify(rev + ':' + ruta)}`, { cwd: process.cwd(), encoding: 'utf8' })
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

  const outIdx = argv.indexOf('--out')
  const outPath = outIdx >= 0 && argv[outIdx + 1] ? path.resolve(argv[outIdx + 1]) : path.join(SCRIPTS_DIR, 'pii-hashlist.json')

  const entries = values.map((v) => {
    const salt = randomBytes(16).toString('hex')
    return { type: v.type, salt, hash: sha256Hex(salt, v.value) }
  })

  const doc = {
    version: 1,
    algorithm: 'sha256(sal+valor_normalizado)',
    note: 'Solo hashes con sal aleatoria por entrada; los valores en claro NO se publican. Regenerar con scripts/pii-denylist-build.mjs.',
    entries,
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n')

  const counts = {}
  for (const v of values) counts[v.type] = (counts[v.type] || 0) + 1
  console.log(`[denylist-build] OK: ${entries.length} entradas con sal (${JSON.stringify(counts)}) -> ${outPath}`)
}

try {
  main()
} catch (err) {
  console.error('[denylist-build] ERROR:', err.message)
  process.exit(1)
}
