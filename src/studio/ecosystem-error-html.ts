/**
 * ecosystem-error-html.ts — Página de error del canje SSO (2026-11-17).
 *
 * Cuando el canje del enlace de ecosistema falla (403/404/429) el operador ve
 * UNA PANTALLA REAL con el motivo (caducado / ya usado / no configurado /
 * demasiados intentos) y un enlace para reintentar desde el CRM. Jamás un JSON
 * crudo ni un body vacío: la regla del encargo es que un fallo de SSO nunca
 * deje al dueño sin saber qué hacer.
 *
 * Seguridad: NO revela el motivo técnico completo (firma/formato) más allá de
 * lo estrictamente necesario; no emite cookies; el enlace de vuelta apunta al
 * CRM configurado (CRM_BASE_URL, por defecto http://127.0.0.1:3000).
 */
export function crmBaseUrl(): string {
  const raw = process.env.CRM_BASE_URL || 'http://127.0.0.1:3000'
  // El valor viene de configuración del servidor (confiable), pero se sanea
  // igualmente: solo se permiten caracteres de una URL http(s) simple.
  const clean = raw.replace(/[^A-Za-z0-9:/.\-_?=&]/g, '')
  return clean.endsWith('/') ? clean.slice(0, -1) : clean
}

export function renderEcosystemErrorHtml(opts: { title: string; detail: string }): string {
  const crm = crmBaseUrl()
  const esc = (v: string) =>
    v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(opts.title)} — Ecosistema ALBRA</title>
  <style>
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #090d16; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 32px; max-width: 460px; text-align: center; }
    .logo { width: 40px; height: 40px; background: linear-gradient(135deg, #10b981, #2563eb); border-radius: 8px; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 18px; }
    h1 { font-size: 18px; margin: 0 0 10px; }
    p { font-size: 14px; color: #9ca3af; line-height: 1.6; margin: 0 0 22px; }
    a.btn { display: inline-block; background: #2563eb; color: #fff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; }
    a.btn:hover { background: #1d4ed8; }
    .hint { font-size: 12px; color: #6b7280; margin-top: 18px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">A</div>
    <h1>${esc(opts.title)}</h1>
    <p>${esc(opts.detail)}</p>
    <a class="btn" href="${esc(crm)}">Volver al CRM y reintentar</a>
    <p class="hint">Ecosistema ALBRA · CRM: ${esc(crm)}</p>
  </div>
</body>
</html>`
}

/** Mapea el motivo técnico del verificador a un mensaje operativo para el dueño. */
export function ecosystemErrorCopy(reason: string, jtiUsed: boolean): { title: string; detail: string } {
  if (jtiUsed) {
    return {
      title: 'El enlace ya fue utilizado',
      detail: 'Cada enlace del ecosistema abre una sola vez. Vuelve al CRM y abre de nuevo la capa desde el botón Ecosistema.',
    }
  }
  if (reason.includes('expirado')) {
    return {
      title: 'El enlace ha caducado',
      detail: 'Los enlaces del ecosistema duran 90 segundos por seguridad. Vuelve al CRM y vuelve a abrir la capa: se genera un enlace nuevo al instante.',
    }
  }
  if (reason.includes('no configurado')) {
    return {
      title: 'Acceso de ecosistema no configurado',
      detail: 'Este servicio no tiene ECOSYSTEM_SSO_SECRET configurado, así que el canje está deshabilitado (fail-closed). Configúralo con el MISMO valor en los tres servicios.',
    }
  }
  return {
    title: 'El enlace no es válido',
    detail: 'El enlace de ecosistema no pasó la verificación de firma o formato. Vuelve al CRM y genera un enlace nuevo desde el botón Ecosistema.',
  }
}
