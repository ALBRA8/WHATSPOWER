/**
 * dashboard-html.ts — carcasa del panel (SPA servida por el servidor propio).
 * Los recursos (app.js / app.css) viven junto a este archivo y se leen al vuelo:
 * no hay paso de compilación ni dependencias externas.
 */
import { readFileSync } from 'node:fs'

const ASSETS: Record<string, { file: string; type: string }> = {
  'app.js': { file: 'dashboard-client.js', type: 'text/javascript; charset=utf-8' },
  'app.css': { file: 'dashboard.css', type: 'text/css; charset=utf-8' },
}

export function dashboardAsset(name: string): { body: string; type: string } | null {
  const entry = ASSETS[name]
  if (!entry) return null
  try {
    return { body: readFileSync(new URL(`./${entry.file}`, import.meta.url), 'utf8'), type: entry.type }
  } catch {
    return null
  }
}

export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>WhatsPower — Panel de control</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23146ef5'/%3E%3Cpath d='M9 21l4-10 3 7 2-4 5 7' stroke='white' stroke-width='2' fill='none' stroke-linejoin='round'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="/dashboard/assets/app.css">
</head>
<body>
  <main id="boot" class="gate gate-hero">
    <div class="gate-card">
      <div class="gate-eyebrow">CRM ALBRA · Nivel 2</div>
      <h1>WhatsPower, el panel de conversaciones</h1>
      <h2>Automatiza WhatsApp y atiende a mano cuando toque</h2>
      <p>Un solo sitio para los flujos, los contactos y la bandeja del equipo. Estamos comprobando la sesión administrativa del servidor.</p>
      <ul class="gate-list">
        <li>Flujos que responden solos y pasan la conversación a una persona cuando hace falta.</li>
        <li>Contactos con etiquetas, campos propios y bajas que se respetan.</li>
        <li>Difusiones que calculan la audiencia antes de enviar nada.</li>
      </ul>
      <p class="gate-note">Si la sesión ya está abierta, el panel aparece en un segundo.</p>
    </div>
  </main>
  <div id="root" class="hidden"></div>
  <div id="modal-root"></div>
  <footer class="app-foot">
    <div class="app-foot-in">
      <span><strong>WhatsPower</strong> · automatización conversacional de CRM ALBRA</span>
      <span class="app-foot-links">
        <a href="/studio">Lienzo de flujos</a>
        <a href="/qr">Vincular WhatsApp</a>
      </span>
      <span class="small">Los datos viven en esta instalación; cada consulta va con su organización (X-Org-Id).</span>
    </div>
  </footer>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script type="module" src="/dashboard/assets/app.js"></script>
</body>
</html>`
}
