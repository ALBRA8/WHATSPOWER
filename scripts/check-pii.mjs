#!/usr/bin/env node
/**
 * check-pii.mjs
 * Valida que no existan datos personales (nombres de operadores, teléfonos reales, LIDs reales)
 * ni números colombianos fuera de la lista blanca de números ficticios en el árbol rastreado.
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const FORBIDDEN_PATTERNS = [
  { name: 'NOMBRE_OPERADOR', regex: /\bJohan\s+Bravo\b/i },
  { name: 'USUARIO_TIKTOK', regex: /\bjohanbravo0830\b/i },
  { name: 'LID_REAL_WHATSAPP', regex: /\b215779257634953\b/ },
  { name: 'TELEFONO_REAL_1', regex: /\b(?:57)?3017543786\b/ },
  { name: 'TELEFONO_REAL_2', regex: /\b(?:57)?3163301286\b/ },
  { name: 'TELEFONO_REAL_3', regex: /\b(?:57)?3019876543\b/ },
]

// Lista blanca de prefijos/números ficticios autorizados en pruebas
const ALLOWED_PHONE_PREFIXES = [
  '57300', '300',
  '573100', '3100',
  '573110', '3110',
  '573111', '3111',
  '573222', '3222',
  '573444', '3444',
  '573777', '3777',
  '573999', '3999',
]

const ALLOWED_EXACT_PHONES = new Set([
  '573109998877',
  '573109998888',
  '573112223344',
  '573112233445',
  '573115550102',
  '573155550106', '3155550106',
  '573156665577',
  '573159876543',
  '573199998877',
  '573201234567',
  '573204445566',
  '573209998877',
  '573222333444',
])

const COLOMBIAN_PHONE_REGEX = /\b(573\d{9}|3\d{9})\b/g

const EXCLUDE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.db', '.sqlite', '.map', '.woff', '.woff2', '.ttf'
])

const EXCLUDE_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'
])

function isAllowedPhone(phone) {
  if (phone.startsWith('15') || phone.startsWith('16') || phone.startsWith('17') || phone.startsWith('18') || phone.startsWith('19') || phone.startsWith('20')) {
    // Unix timestamp en segundos (ej. 1700000000)
    return true
  }
  if (ALLOWED_EXACT_PHONES.has(phone)) return true
  for (const prefix of ALLOWED_PHONE_PREFIXES) {
    if (phone.startsWith(prefix)) return true
  }
  return false
}

function main() {
  const root = process.cwd()
  let trackedFiles = []
  try {
    const stdout = execSync('git ls-files', { cwd: root, encoding: 'utf-8' })
    trackedFiles = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch (err) {
    console.error('[check:pii] Error ejecutando git ls-files:', err.message)
    process.exit(1)
  }

  const violations = []

  for (const relPath of trackedFiles) {
    const ext = path.extname(relPath).toLowerCase()
    const base = path.basename(relPath)
    if (EXCLUDE_EXTS.has(ext) || EXCLUDE_FILES.has(base)) continue

    const fullPath = path.join(root, relPath)
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
      const lineNum = i + 1

      // 1. Prohibiciones específicas
      for (const rule of FORBIDDEN_PATTERNS) {
        if (rule.regex.test(line)) {
          violations.push({
            file: relPath,
            line: lineNum,
            rule: rule.name,
            text: line.trim().slice(0, 100),
          })
        }
      }

      // 2. Teléfonos no autorizados
      let match
      while ((match = COLOMBIAN_PHONE_REGEX.exec(line)) !== null) {
        const phone = match[1]
        if (!isAllowedPhone(phone)) {
          violations.push({
            file: relPath,
            line: lineNum,
            rule: `TELEFONO_NO_AUTORIZADO: ${phone}`,
            text: line.trim().slice(0, 100),
          })
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error(`\n[check:pii] ❌ SE ENCONTRARON ${violations.length} VIOLACIONES DE PII / TELÉFONOS REALES:\n`)
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.rule}] -> ${v.text}`)
    }
    console.error('\nPor favor corrija o justifique estas coincidencias antes de hacer commit.\n')
    process.exit(1)
  }

  console.log('[check:pii] ✅ Árbol limpio: 0 datos personales o teléfonos no autorizados encontrados.')
}

main()
