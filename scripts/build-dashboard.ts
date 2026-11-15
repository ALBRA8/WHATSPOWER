/**
 * build-dashboard.ts — exporta el panel operativo a dist/ como sitio navegable.
 *
 * El panel se sirve en vivo desde el servidor propio (/dashboard), así que aquí
 * sólo se materializa la misma cáscara: el HTML de src/dashboard/dashboard-html.ts
 * más los recursos app.js / app.css, con las rutas de recursos vueltas relativas
 * para que dist/ se pueda abrir con cualquier servidor de archivos.
 *
 * Aviso honesto que también queda escrito en el HTML: las cifras, los contactos y
 * las acciones viven en /api/dashboard/*, así que el export necesita el servidor
 * de la misma instalación; no lleva datos dentro.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dashboardAsset, renderDashboardHtml } from '../src/dashboard/dashboard-html.ts'
import { renderStudioHtml } from '../src/studio/studio-html.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
mkdirSync(join(dist, 'assets'), { recursive: true })

// 1. Panel: la misma cáscara, con los recursos al lado y una nota de alcance.
const note =
  '  <!-- Export estático del panel WhatsPower. Es sólo la interfaz: los datos y las acciones\n' +
  '       se piden a /api/dashboard/* del servidor de esta instalación (organización en X-Org-Id).\n' +
  '       Sin ese servidor, la pantalla muestra el acceso y no carga cifras. -->'
const html = renderDashboardHtml()
  .replace('/dashboard/assets/', 'assets/')
  .replaceAll('/dashboard/assets/', 'assets/')
  .replace('  <meta name="viewport"', note + '\n  <meta name="viewport"')
writeFileSync(join(dist, 'index.html'), html, 'utf8')

// 2. Recursos del panel, tal como los sirve el servidor.
for (const name of ['app.js', 'app.css']) {
  const asset = dashboardAsset(name)
  if (!asset) throw new Error(`No se pudo leer el recurso del panel: ${name}`)
  writeFileSync(join(dist, 'assets', name), asset.body, 'utf8')
}

// 3. Lienzo de flujos (una sola página, sin dependencias): mismo criterio.
writeFileSync(join(dist, 'studio.html'), renderStudioHtml(), 'utf8')

const files = ['index.html', 'studio.html', 'assets/app.js', 'assets/app.css']
let total = 0
for (const f of files) {
  const size = statSync(join(dist, f)).size
  total += size
  console.log(`  ${f.padEnd(16)} ${String(size).padStart(8)} bytes`)
}
console.log(`\nSitio en dist/ (${files.length} archivos, ${total} bytes).`)
console.log('Abrir con un servidor de archivos; los datos vienen de /api/dashboard/* de esta instalación.')
