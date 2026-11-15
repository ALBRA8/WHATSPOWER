#!/usr/bin/env node
/**
 * scan-secrets.mjs — Escáner de secretos para CRM-ALBRA (CP-Sec-01 / ORDEN CIERRE P0)
 *
 * Detecta en el árbol de trabajo (y opcionalmente en todo el historial) patrones de:
 *   - JWT (estructura header.payload.signature en base64url)
 *   - Tokens de proveedores: GitHub PAT, AWS, Slack, Google, Stripe, OpenAI, Anthropic, Meta
 *   - Claves privadas embebidas (PEM)
 *   - API keys personalizadas del proyecto (prefijo albra_, wp_, ultra_)
 *   - Secretos de configuración: password/secret/token/apiKey con valor literal de alta entropía
 *
 * Reglas:
 *   - NUNCA imprime el valor completo: solo tipo, archivo, línea y vista previa enmascarada.
 *   - Ignora valores de ejemplo/placeholder y fixtures de prueba marcados.
 *   - Salida: exit 0 limpio; exit 1 con hallazgos (salvo --report-only).
 *
 * Uso:
 *   node scripts/scan-secrets.mjs                 # escanea el árbol versionado (git ls-files)
 *   node scripts/scan-secrets.mjs --history      # escanea además todo el historial git
 *   node scripts/scan-secrets.mjs --path <ruta>  # escanea un archivo o directorio concreto
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'

const ALLOW_MARK = 'scan-secrets:allow'

/** Patrones de detección. Cada uno: id, descripción, regex, y captura del valor (grupo 1 si existe). */
export const PATTERNS = [
  { id: 'JWT', desc: 'Token JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { id: 'GITHUB_PAT', desc: 'Token de acceso personal de GitHub', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { id: 'AWS_ACCESS_KEY', desc: 'Access key de AWS', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'SLACK_TOKEN', desc: 'Token de Slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'GOOGLE_API_KEY', desc: 'API key de Google', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { id: 'STRIPE_SECRET', desc: 'Clave secreta de Stripe', re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: 'OPENAI_KEY', desc: 'API key de OpenAI', re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'ANTHROPIC_KEY', desc: 'API key de Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'META_TOKEN', desc: 'Token de acceso de Meta/Facebook', re: /\bEAAG[0-9A-Za-z_-]{20,}\b/g },
  { id: 'PRIVATE_KEY', desc: 'Clave privada embebida', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'ALBRA_API_KEY', desc: 'API key del proyecto (albra_)', re: /\balbra_[a-z0-9]{6,}-[A-Za-z0-9_-]{8,}\b/g },
  { id: 'WP_API_KEY', desc: 'API key del proyecto (wp_)', re: /\bwp_[A-Za-z0-9]{24,}\b/g },
  { id: 'ULTRA_API_KEY', desc: 'API key del proyecto (ultra_)', re: /\bultra_[A-Za-z0-9]{24,}\b/g },
  {
    id: 'CONFIG_SECRET', desc: 'Secreto de configuración literal',
    re: /(?:password|passwd|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token)["']?\s*[:=]\s*["']([A-Za-z0-9_+/=.,:!#$%^&*()-]{16,})["']/gi,
  },
]

/**
 * Valores dummy conocidos (lista EXACTA de literales, no prefijos anchos).
 * Reparación integral B7: se retiraron los prefijos genéricos (^test_, ^mock,
 * ^fake, ^sample, ^e2e_, ^smoke_) porque un secreto REAL con ese prefijo pasaba
 * desapercibido. Los fixtures legítimos se excluyen con el marcador explícito
 * `scan-secrets:allow` en la línea (verificable en revisión).
 */
const DUMMY_HINTS = [
  /^REDACTED$/i, /^placeholder$/i, /^your[_-]/i, /^example[_-]/i, /^change?me$/i, /^dummy/i,
  /^xxx+$/i, /^<[^>]+>$/, /^\$\{.*\}$/, /^albra-dev-token$/i, /^changeme$/i, /^lorem/i,
  /^secret[_-]?key[_-]?123$/i, /scan-secrets-dummy/i, /^min24/, /^min32/,
  /^REPL[EAC]/i, /^E2e2$/, /^ci-dummy/i, /^cortito$/i,
  /SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED/, /^cambia[-_ ]?esto$/i, /^claveinc/i,
  /^crm[-_]e2e[-_]/i, /^e2e[-_]dummy/i, /^FB-PAGE[-_]?TOKEN/i, /^aaaa+$/i,
]

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'db', 'upload', 'repos', '.vercel', 'skills', 'crm_albra_mirrored'])
const SKIP_FILE_RE = /\.(png|jpe?g|gif|webp|pdf|zip|gz|ico|woff2?|ttf|db|sqlite3?|lock|log)$/i
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'dev.log'])

/** Devuelve los hallazgos (tipo, vista previa enmascarada, línea) de un texto. */
export function scanText(text, source = 'inline') {
  const findings = []
  const lines = text.split('\n')
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0
    let m
    while ((m = pattern.re.exec(text)) !== null) {
      const raw = (m[1] ?? m[0]).trim()
      const lineNo = text.slice(0, m.index).split('\n').length
      const line = lines[lineNo - 1] ?? ''
      if (line.includes(ALLOW_MARK)) continue
      if (DUMMY_HINTS.some((h) => h.test(raw))) continue
      // Huella verificable (sha256-12 del valor): permite allowlists/baselines
      // EXPLÍCITOS sin almacenar ni imprimir el valor real.
      const fingerprint = createHash('sha256').update(raw).digest('hex').slice(0, 12)
      findings.push({ pattern: pattern.id, desc: pattern.desc, source, line: lineNo, preview: mask(raw), fingerprint })
      pattern.re.lastIndex = m.index + m[0].length // evita bucles en matches vacíos
    }
  }
  return findings
}

/** Enmascara: conserva los 4 primeros caracteres y la longitud, nunca el valor. */
export function mask(value) {
  return `${value.slice(0, 4)}…(${value.length} caracteres)`
}

function shouldSkip(relPath) {
  const parts = relPath.split(sep)
  if (parts.some((p) => SKIP_DIRS.has(p))) return true
  const base = parts[parts.length - 1]
  return SKIP_FILE_RE.test(base) || SKIP_FILES.has(base)
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = relative(process.cwd(), full)
    if (shouldSkip(rel)) continue
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

const ALLOWLIST_PATH = join('scripts', 'security', 'secret-allowlist.json')
const BASELINE_PATH = join('scripts', 'security', 'secret-baseline.json')

function loadJsonList(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/**
 * Allowlist del ÁRBOL (explícita y verificable): entradas {file, category,
 * fingerprint, reason}. El fingerprint es sha256-12 del valor — NUNCA el valor.
 * Un hallazgo se excluye SOLO si coincide archivo+categoría+huella.
 */
function filterAllowlist(findings) {
  const allow = loadJsonList(ALLOWLIST_PATH)
  const kept = []
  const excluded = []
  for (const f of findings) {
    const match = allow.find((a) => a.category === f.pattern && a.fingerprint === f.fingerprint &&
      (f.source.endsWith(a.file) || a.file === '*'))
    if (match) excluded.push({ ...f, reason: match.reason })
    else kept.push(f)
  }
  return { kept, excluded }
}

/**
 * Baseline HISTÓRICO (explícito y verificable): entradas {commit, category,
 * fingerprint, status, rotation}. El modo --history FALLA solo con hallazgos
 * NUEVOS; los conocidos se listan como avisos con su estado de rotación.
 */
function filterBaseline(findings) {
  const baseline = loadJsonList(BASELINE_PATH)
  const known = []
  const isNew = []
  for (const f of findings) {
    const commit = (f.source.match(/commit ([0-9a-f]+)/) || [])[1] || ''
    const match = baseline.find((b) => b.category === f.pattern && b.fingerprint === f.fingerprint &&
      (commit === '' || commit.startsWith(b.commit)))
    if (match) known.push({ ...f, status: match.status, rotation: match.rotation })
    else isNew.push(f)
  }
  return { known, isNew }
}

function scanWorkingTree() {
  let files
  try {
    files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch {
    files = [...walk(process.cwd())]
  }
  const findings = []
  for (const f of files) {
    if (shouldSkip(f) || !existsSync(f) || !statSync(f).isFile()) continue
    try {
      const text = readFileSync(f, 'utf8')
      findings.push(...scanText(text, f))
    } catch { /* binario o ilegible: omitir */ }
  }
  return findings
}

function scanHistory() {
  const findings = []
  // B7 (sin tope): TODO el historial (antes se limitaba a 400 commits).
  const commits = execSync('git rev-list --all', { encoding: 'utf8' }).split('\n').filter(Boolean)
  process.stderr.write(`Escaneando ${commits.length} commits del historial (contenido completo de archivos tocados)…\n`)
  const scanned = new Set()
  for (const c of commits) {
    try {
      // Contenido COMPLETO de los archivos creados/modificados en el commit
      // (no solo líneas añadidas: un secreto reubicado no escapa).
      const files = execSync(`git show ${c} --format= --name-only --diff-filter=AM`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n').filter(Boolean)
      for (const file of files) {
        const key = `${c.slice(0, 8)}:${file}`
        if (scanned.has(key)) continue
        scanned.add(key)
        try {
          const blob = execSync(`git show ${c}:${JSON.stringify(file)}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
          for (const f of scanText(blob, `commit ${c.slice(0, 8)} (${file})`)) findings.push(f)
        } catch { /* binario o ausente en ese commit */ }
      }
    } catch { /* commit vacío / merge */ }
  }
  return findings
}

function main() {
  const args = process.argv.slice(2)
  const reportOnly = args.includes('--report-only')
  const doHistory = args.includes('--history')
  const pathIdx = args.indexOf('--path')

  let findings = []
  if (pathIdx !== -1 && args[pathIdx + 1]) {
    const target = args[pathIdx + 1]
    const st = statSync(target)
    if (st.isFile()) findings = scanText(readFileSync(target, 'utf8'), target)
    else for (const f of walk(target)) findings.push(...scanText(readFileSync(f, 'utf8'), f))
    findings = filterAllowlist(findings).kept
  } else {
    // Árbol: allowlist explícita (los excluidos se listan como aviso).
    const { kept, excluded } = filterAllowlist(scanWorkingTree())
    findings = kept
    if (excluded.length > 0) {
      console.log(`ℹ ${excluded.length} hallazgo(s) excluidos por allowlist explícita (${ALLOWLIST_PATH}):`)
      for (const f of excluded) console.log(`  [${f.pattern}] ${f.source}:${f.line} — ${f.reason}`)
    }
    if (doHistory) {
      // Historial: baseline explícito; SOLO los NUEVOS son bloqueantes.
      const { known, isNew } = filterBaseline(scanHistory())
      if (known.length > 0) {
        console.log(`ℹ ${known.length} hallazgo(s) HISTÓRICOS conocidos (baseline ${BASELINE_PATH}):`)
        for (const f of known) console.log(`  [${f.pattern}] ${f.source} — estado: ${f.status}${f.rotation ? ` (${f.rotation})` : ''}`)
      }
      if (isNew.length > 0) {
        console.log(`\n✗ ${isNew.length} hallazgo(s) NUEVO(S) en el historial (no están en el baseline):\n`)
        for (const f of isNew) console.log(`  [${f.pattern}] ${f.source}:${f.line} — ${f.desc} — ${f.preview} — huella ${f.fingerprint}`)
        console.log('\nAcción: elimina el secreto y rótalo. Si es un falso positivo documentado, añádelo al baseline con motivo.')
        process.exit(1)
      }
      console.log('✓ Historial: sin hallazgos NUEVOS fuera del baseline.')
    }
  }

  if (findings.length === 0) {
    console.log('✓ Sin secretos detectados en el árbol.')
    process.exit(0)
  }
  console.log(`✗ ${findings.length} hallazgo(s) potencial(es) de secretos en el ÁRBOL:\n`)
  for (const f of findings) {
    console.log(`  [${f.pattern}] ${f.source}:${f.line} — ${f.desc} — vista previa: ${f.preview} — huella ${f.fingerprint}`)
  }
  console.log('\nAcción: elimina el secreto, rótalo si estuvo activo y usa variables de entorno.')
  console.log(`Para excluir un dummy de prueba: marcador de línea ${ALLOW_MARK} o allowlist explícita en ${ALLOWLIST_PATH}.`)
  process.exit(reportOnly ? 0 : 1)
}

if (process.argv[1] && process.argv[1].endsWith('scan-secrets.mjs')) main()
