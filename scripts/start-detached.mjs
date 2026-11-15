// Arranca el servidor de WHATSPOWER (Nivel 2) completamente desacoplado del
// shell padre (doble fork, detached + unref): sobrevive al cierre de sesión
// del sandbox. Mismo patrón que el start-dev-detached.mjs del CRM.
//
// Uso: node scripts/start-detached.mjs   (desde la raíz del repo WHATSPOWER)
import { spawn } from 'child_process'
import { openSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = openSync(join(repoRoot, 'server.log'), 'a')
const child = spawn('node', ['--experimental-strip-types', 'src/server.ts'], {
  cwd: repoRoot,
  detached: true,
  stdio: ['ignore', out, out],
})
child.unref()
console.log('spawned pid', child.pid, '→ log:', join(repoRoot, 'server.log'))
