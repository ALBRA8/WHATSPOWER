import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { createHmac } from 'node:crypto'
import { createDatabase } from './db.ts'
import { ConversationRouter } from './engine/router.ts'
import { MockTransportSender, HttpAlbraTransportSender } from './adapters/transport.ts'
import { MockCrmClient, HttpCrmClient } from './adapters/crm-client.ts'
import { renderStudioHtml } from './studio/studio-html.ts'
import { TeamManager } from './state/team-manager.ts'
import { CannedResponseManager } from './engine/canned-responses.ts'
import { GrowthToolsManager } from './engine/growth-tools.ts'
import { CrmTriggerListener } from './engine/crm-triggers.ts'
import { PaymentGatewayManager } from './payments/payment-gateway.ts'
import type { InboundEvent, TransportSender, CrmClientInterface } from './types.ts'
import {
  isAuthorizedBearer,
  checkWebhookSecurity,
  readBody,
  DurableReplayCache,
  RateLimiter,
  issueStudioSession,
  resolveStudioSession,
  productionConfigProblems,
} from './security.ts'

try {
  process.loadEnvFile()
} catch {}

export function createAgenticServer(options?: {
  dbPath?: string
  transport?: TransportSender
  crm?: CrmClientInterface
  webhookSecret?: string
  businessPhone?: string
  /** Ruta del anti-replay durable; ':memory:' para tests. Default: env REPLAY_DB_PATH o <repo>/db/replay-cache.db */
  replayDbPath?: string
}) {
  const db = createDatabase(options?.dbPath)
  // MOCK vs REAL (orden de cierre): el transporte se decide por TRANSPORT env con decisión
  // explícita. En producción NO se admite Mock silencioso: exige ALLOW_MOCK_TRANSPORT=true.
  const isProduction = process.env.NODE_ENV === 'production'
  const transport: TransportSender = options?.transport ?? (() => {
    const mode = process.env.TRANSPORT || (isProduction ? undefined : 'mock')
    if (!mode) {
      throw new Error('TRANSPORT no configurado: en producción define TRANSPORT=http (real) o TRANSPORT=mock con ALLOW_MOCK_TRANSPORT=true (decisión explícita)')
    }
    if (mode === 'http') {
      const daemonSecret = process.env.INTERNAL_API_SECRET
      if (!daemonSecret) throw new Error('TRANSPORT=http exige INTERNAL_API_SECRET configurado (falla segura, no se envía nada sin él)')
      if (process.env.ALLOW_REAL_DISPATCH !== 'true') {
        console.warn('[Capa 2A AVISO] TRANSPORT=http con ALLOW_REAL_DISPATCH=false: los envíos quedarán BLOQUEADOS por la salvaguarda.')
      }
      return new HttpAlbraTransportSender(process.env.WHATSAPP_DAEMON_URL || 'http://localhost:3002', daemonSecret)
    }
    if (mode === 'mock') {
      if (isProduction && process.env.ALLOW_MOCK_TRANSPORT !== 'true') {
        throw new Error('TRANSPORT=mock rechazado en producción sin ALLOW_MOCK_TRANSPORT=true (prohibido el Mock silencioso)')
      }
      if (isProduction) console.warn('[Capa 2A AVISO] Transporte en modo MOCK por decisión explícita (ALLOW_MOCK_TRANSPORT=true): NO se enviarán mensajes reales.')
      return new MockTransportSender()
    }
    throw new Error(`TRANSPORT inválido: "${mode}" (valores válidos: http | mock)`)
  })()
  // CRM Actions Bridge: cliente HTTP real hacia CRM-ALBRA cuando hay API key configurada;
  // en producción sin CRM_API_KEY se falla al arranque (prohibido el Mock silencioso).
  // (segunda reparación §3.B) Credenciales POR ORGANIZACIÓN: CRM_API_KEYS es un
  // JSON {orgId: "albra_..."}; CRM_API_KEY sigue soportada para una sola org.
  const crmApiKeysByOrg: Record<string, string> = (() => {
    try {
      const raw = process.env.CRM_API_KEYS
      if (!raw) return {}
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      throw new Error('CRM_API_KEYS mal formada: debe ser JSON {orgId: "albra_..."}')
    }
  })()
  const crm = options?.crm
    ?? ((process.env.CRM_API_KEY || Object.keys(crmApiKeysByOrg).length > 0)
      ? new HttpCrmClient(process.env.CRM_BASE_URL || 'http://localhost:3000', process.env.CRM_API_KEY || '', crmApiKeysByOrg)
      : (isProduction
        ? (() => { throw new Error('CRM_API_KEY no configurada: en producción el puente CRM no puede usar MockCrmClient silenciosamente (configura CRM_API_KEY o CRM_API_KEYS)') })()
        : (console.warn('[Capa 2A AVISO] CRM en modo Mock — SOLO desarrollo. Configura CRM_API_KEY/CRM_API_KEYS para el puente real.'), new MockCrmClient())))
  // Secret dual: AGENTIC_2A_WEBHOOK_SECRET (documentado en README) tiene prioridad sobre WEBHOOK_SECRET (legacy).
  // FAIL-CLOSED (rotación 2026-10-27): eliminado fallback hardcodeado del webhookSecret
  // (un valor publicado en el repo permitía forjar firmas). Sin secret configurado, verifyHmac rechaza todo.
  const webhookSecret = options?.webhookSecret
    || process.env.AGENTIC_2A_WEBHOOK_SECRET
    || process.env.WEBHOOK_SECRET

  const router = new ConversationRouter(db, transport, crm)
  const teamManager = new TeamManager(db)
  const cannedManager = new CannedResponseManager(db)
  const growthManager = new GrowthToolsManager(db, options?.businessPhone || '573001234567')
  const crmTriggers = new CrmTriggerListener(db, router.getFlowEngine())
  const paymentManager = new PaymentGatewayManager(db)

  function verifyHmac(payload: string, signatureHeader?: string): boolean {
    if (!webhookSecret || !signatureHeader) return false
    const expected = createHmac('sha256', webhookSecret).update(payload).digest('hex')
    return expected === signatureHeader
  }
  void verifyHmac // conservado por compatibilidad de firma pública; la validación dura usa checkWebhookSecurity

  // Anti-replay DURABLE (reparación integral 2026-11-06): sobrevive reinicios;
  // en tests con dbPath ':memory:' se usa ':memory:' para no compartir estado.
  const replayPath = options?.replayDbPath ?? (options?.dbPath === ':memory:' ? ':memory:' : undefined)
  const inboundReplay = new DurableReplayCache(replayPath)
  const paymentsReplay = new DurableReplayCache(replayPath)

  // Rate limiting de endpoints públicos (tercera reparación 4.F)
  const inboundRate = new RateLimiter(120, 60_000)
  const paymentsRate = new RateLimiter(60, 60_000)
  const refRate = new RateLimiter(300, 60_000)
  const studioLoginRate = new RateLimiter(10, 60_000)
  /** Extrae la IP del cliente (sin confiar ciegamente en X-Forwarded-For: se usa solo
   *  como clave de rate-limit, jamás como decisión de autorización). */
  function clientKey(req: IncomingMessage): string {
    const fwd = req.headers['x-forwarded-for']
    return (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown'
  }
  /** Org obligatoria desde el header X-Org-Id (nunca del body — no se infiere de datos no confiables). */
  function requireOrgHeader(req: IncomingMessage): string | null {
    const orgId = String(req.headers['x-org-id'] || '').trim()
    return orgId && /^[a-zA-Z0-9_-]{1,64}$/.test(orgId) ? orgId : null
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    // Canje de sesión del Studio (4.F): el operador envía el secreto UNA vez;
    // el backend responde con cookie HttpOnly de corta vida. El secreto de larga
    // vida JAMÁS vuelve al navegador (antes vivía en sessionStorage: un XSS lo leía).
    if (req.method === 'POST' && url.pathname === '/studio/login') {
      if (!studioLoginRate.allow(`studiologin:${clientKey(req)}`)) {
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Demasiados intentos. Inténtalo más tarde.' }))
        return
      }
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      let secret = ''
      try { secret = String(JSON.parse(rb.body).secret || '') } catch {}
      const internalSecret = process.env.INTERNAL_API_SECRET
      if (!internalSecret || !isAuthorizedBearer(secret ? `Bearer ${secret}` : undefined, internalSecret)) {
        console.warn(`[Seguridad 2A ALERTA] Studio login fallido (IP: ${req.socket.remoteAddress})`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Credencial administrativa inválida' }))
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': issueStudioSession(internalSecret),
      })
      res.end(JSON.stringify({ ok: true, sessionTtlSeconds: 3600 }))
      return
    }

    // ==========================================================
    // PUERTA DE AUTENTICACIÓN (orden de cierre 2026-11-06)
    // Toda ruta /api/* es administrativa y exige Bearer INTERNAL_API_SECRET
    // (comparación timing-safe) O cookie de sesión del Studio (HttpOnly),
    // SALVO: /api/health (público), /api/inbound (protegida por HMAC+timestamp+
    // replay propio) y /api/payments/webhook (protegida por HMAC de la pasarela).
    // Fail-closed: sin secret configurado responde 503, nunca acepta.
    // ==========================================================
    const isPublicApiPath = url.pathname === '/api/health'
      || url.pathname === '/api/inbound'
      || url.pathname === '/api/payments/webhook'
    if (url.pathname.startsWith('/api/') && !isPublicApiPath) {
      const internalSecret = process.env.INTERNAL_API_SECRET
      if (!internalSecret) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Service Unavailable: INTERNAL_API_SECRET no configurado (fail-closed)' }))
        return
      }
      const bearerOk = isAuthorizedBearer(req.headers['authorization'], internalSecret)
      const sessionOk = resolveStudioSession(req.headers.cookie as string | undefined, internalSecret)
      if (!bearerOk && !sessionOk) {
        console.warn(`[Seguridad 2A ALERTA] Acceso administrativo no autorizado: ${req.method} ${url.pathname} (IP: ${req.socket.remoteAddress})`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid internal secret' }))
        return
      }
    }

    // ============================================================
    // PUERTA DE QR (reparación integral 2026-11-06):
    // /qr y /qr/data NUNCA entregan el QR a anónimos. El QR de WhatsApp permite
    // secuestrar la sesión: exige Bearer INTERNAL_API_SECRET. La página /qr sin
    // clave muestra un pedido de clave en cliente (la clave nunca va en URL).
    // ============================================================
    if (url.pathname === '/qr/data') {
      // STRICT: el QR (permite secuestrar la sesión WhatsApp) JAMÁS sale a anónimos.
      // GET /qr sirve solo el shell sin datos; la sesión se canjea por cookie HttpOnly.
      const internalSecret = process.env.INTERNAL_API_SECRET
      if (!internalSecret) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Service Unavailable: INTERNAL_API_SECRET no configurado (fail-closed)' }))
        return
      }
      // La puerta de QR también acepta la cookie de sesión del Studio (4.F)
      const bearerOk = isAuthorizedBearer(req.headers['authorization'], internalSecret || '')
      const sessionOk = resolveStudioSession(req.headers.cookie as string | undefined, internalSecret)
      if (!bearerOk && !sessionOk) {
        console.warn(`[Seguridad 2A ALERTA] Acceso a QR sin autenticación: ${req.method} ${url.pathname} (IP: ${req.socket.remoteAddress})`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized: el QR exige autenticación administrativa (Bearer)' }))
        return
      }
    }

    // WhatsPower Flow Studio (Lienzo visual ManyChat)
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/studio')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderStudioHtml())
      return
    }

    // API REST de Flujos — organización OBLIGATORIA en el header X-Org-Id (4.B):
    // el listado, la creación y la ejecución operan exclusivamente dentro de ESA org.
    if (req.method === 'GET' && url.pathname === '/api/flows') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const flows = router.getFlowEngine().listFlows(orgId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(flows))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/flows') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const flow = JSON.parse(rb.body)
        if (!flow?.id || typeof flow.id !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'flow.id es obligatorio' }))
          return
        }
        // La org SIEMPRE del header autenticado; un orgId del body contradictorio se rechaza.
        if (flow.orgId && flow.orgId !== orgId) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'orgId del body no coincide con X-Org-Id (la organización no se infiere de datos no confiables)' }))
          return
        }
        router.getFlowEngine().saveFlow(orgId, flow)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, id: flow.id, organizationId: orgId }))
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/flows/simulate') {
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const { phone, messageText, name, orgId } = JSON.parse(rb.body)
        if (!orgId || typeof orgId !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'orgId es obligatorio (aislamiento multi-organización)' }))
          return
        }
        const stepRes = await router.getFlowEngine().evaluateStep(orgId, phone, messageText, { name })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(stepRes))
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // 0. Visor de QR auto-refrescable en vivo para vinculación de WhatsApp
    if (req.method === 'GET' && url.pathname === '/qr') {
      // Shell SIN datos: el QR solo se obtiene de /qr/data CON Bearer válido.
      // (reparación integral 2026-11-06 — el QR jamás se sirve a anónimos)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vinculación WhatsApp en Vivo — CRM ALBRA</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #1e293b; border-radius: 16px; padding: 32px; max-width: 460px; width: 100%; text-align: center; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); border: 1px solid #334155; }
    h1 { font-size: 20px; margin-top: 0; margin-bottom: 8px; color: #38bdf8; }
    p { font-size: 14px; color: #94a3b8; margin-bottom: 24px; line-height: 1.5; }
    .qr-container { background: #ffffff; padding: 16px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 20px; min-width: 280px; min-height: 280px; }
    img { width: 280px; height: 280px; display: block; border-radius: 8px; }
    .badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 9999px; font-size: 13px; font-weight: 500; }
    .badge-waiting { background: #422006; color: #fde047; border: 1px solid #ca8a04; }
    .badge-connected { background: #064e3b; color: #6ee7b7; border: 1px solid #059669; }
    .pulse { width: 8px; height: 8px; border-radius: 50%; background: #eab308; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(1.2); } 100% { opacity: 1; transform: scale(1); } }
    .steps { text-align: left; background: #0f172a; padding: 16px; border-radius: 8px; font-size: 13px; color: #cbd5e1; margin-top: 20px; line-height: 1.6; }
    .steps ol { margin: 0; padding-left: 20px; }
    input, button { font-size: 14px; }
    input { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #f8fafc; box-sizing: border-box; }
    button { margin-top: 12px; padding: 10px 18px; border-radius: 8px; border: 0; background: #0284c7; color: #fff; font-weight: 600; cursor: pointer; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="card" id="gate">
    <h1>Vista protegida</h1>
    <p>Introduce el secreto administrativo (INTERNAL_API_SECRET). Se envía como header Bearer, jamás en la URL ni en logs.</p>
    <input id="key" type="password" placeholder="Secreto administrativo" />
    <button id="btn">Abrir visor</button>
    <p id="gateErr" style="color:#f87171;display:none"></p>
  </div>

  <div class="card hidden" id="viewer">
    <h1>Vincular WhatsApp en Vivo</h1>
    <p>Este código QR se refresca automáticamente cada segundo para evitar expiración.</p>
    <div class="qr-container" id="qrContainer"><div style="color:#64748b;font-size:14px;">Generando código QR...</div></div>
    <div>
      <div id="statusBadge" class="badge badge-waiting"><span class="pulse"></span> <span id="statusText">Sincronizando con WhatsApp...</span></div>
    </div>
    <div class="steps">
      <strong>Instrucciones:</strong>
      <ol>
        <li>Abre WhatsApp en tu teléfono.</li>
        <li>Ve a <strong>Ajustes / Tres puntos &gt; Dispositivos vinculados</strong>.</li>
        <li>Toca en <strong>Vincular un dispositivo</strong>.</li>
        <li>Apunta la cámara a este código QR.</li>
      </ol>
    </div>
  </div>

  <script>
    // (tercera reparación 4.F) La clave se canjea UNA vez por cookie HttpOnly
    // (/studio/login); jamás se guarda en sessionStorage (antes un XSS podía leerla
    // y robar la sesión de WhatsApp a través del QR).
    async function fetchQR() {
      return fetch('/qr/data', { credentials: 'same-origin' });
    }
    async function updateQR() {
      try {
        const res = await fetchQR();
        if (res.status === 401) { location.reload(); return; }
        if (!res.ok) return;
        const data = await res.json();
        const container = document.getElementById('qrContainer');
        const badge = document.getElementById('statusBadge');
        const text = document.getElementById('statusText');
        if (data.status === 'connected') {
          container.innerHTML = '<div style="color:#059669;font-weight:bold;font-size:18px;padding:40px;">✅ ¡Dispositivo Conectado!<br><br><span style="font-size:15px;color:#334155;">' + (data.phone ? '+' + data.phone : '') + '</span></div>';
          badge.className = 'badge badge-connected';
          badge.innerHTML = '<span>🟢 WhatsApp Conectado Exitosamente</span>';
          return;
        }
        if (data.qr) {
          container.innerHTML = '<img src="' + data.qr + '" alt="QR WhatsApp">';
          text.textContent = 'QR activo (Refresco en vivo)';
        } else {
          text.textContent = 'Esperando actualización de QR...';
        }
      } catch (err) { console.error(err); }
    }
    function startViewer() {
      document.getElementById('gate').classList.add('hidden');
      document.getElementById('viewer').classList.remove('hidden');
      updateQR();
      setInterval(updateQR, 1500);
    }
    (async function init() {
      const probe = await fetchQR();
      if (probe.ok) { startViewer(); return; }
      document.getElementById('btn').addEventListener('click', async () => {
        const k = document.getElementById('key').value;
        const err = document.getElementById('gateErr');
        const loginRes = await fetch('/studio/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: k }) });
        if (loginRes.ok) { startViewer(); }
        else { err.style.display = 'block'; err.textContent = 'Clave inválida (' + loginRes.status + ')'; }
      });
    })();
  </script>
</body>
</html>`)
      return
    }

    if (req.method === 'GET' && url.pathname === '/qr/data') {
      try {
        // FAIL-CLOSED (rotación 2026-10-27): sin secret configurado no se consulta el daemon
        const daemonSecret = process.env.INTERNAL_API_SECRET
        if (!daemonSecret) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Service Unavailable: INTERNAL_API_SECRET no configurado' }))
          return
        }
        const daemonRes = await fetch(`${process.env.WHATSAPP_DAEMON_URL || 'http://localhost:3002'}/qr`, {
          headers: { 'Authorization': 'Bearer ' + daemonSecret }
        })
        const data = await daemonRes.json()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // 1. Healthcheck
    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', service: 'albra-agentic-2a' }))
      return
    }

    // 2. Consulta de Locks para Capa 2B (GET /api/internal/locks/:phone)
    if (req.method === 'GET' && url.pathname.startsWith('/api/internal/locks/')) {
      const phone = decodeURIComponent(url.pathname.replace('/api/internal/locks/', ''))
      // (segunda reparación §3.A) El lock es POR organización: la org viaja en
      // x-org-id (fail-closed si falta).
      const orgId = String(req.headers['x-org-id'] || '')
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const lock = router.getLockManager().getLock(phone, orgId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // (contrato v2) La respuesta CONFIRMA la organización consultada: el cliente
      // (Capa 2B) debe verificar este eco y rechazar respuestas sin/mismatch.
      res.end(JSON.stringify({ phone, locked: Boolean(lock), lock, organizationId: orgId }))
      return
    }

    // 3.1 Consulta de Supresión para Capa 2B (GET /api/internal/suppression/:phone)
    if (req.method === 'GET' && url.pathname.startsWith('/api/internal/suppression/')) {
      const rawPhone = decodeURIComponent(url.pathname.replace('/api/internal/suppression/', ''))
      const digits = rawPhone.replace(/\D/g, '')
      const phone = (digits.length === 10 && digits.startsWith('3')) ? `57${digits}` : digits
      const orgId = String(req.headers['x-org-id'] || '')
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const suppressed = router.getSuppressionStore().isSuppressed(orgId, phone)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // (contrato v2) Eco de organización para verificación del cliente (5.A)
      res.end(JSON.stringify({ phone, suppressed, organizationId: orgId }))
      return
    }

    // 3.2 Registro Administrativo de Supresión (POST /api/internal/suppression/:phone)
    if (req.method === 'POST' && url.pathname.startsWith('/api/internal/suppression/')) {
      // FAIL-CLOSED + comparación timing-safe (4.F): sin secret configurado se rechaza siempre
      const internalSecret = process.env.INTERNAL_API_SECRET
      if (!isAuthorizedBearer(req.headers['authorization'], internalSecret || '')) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid internal secret' }))
        return
      }

      const rawPhone = decodeURIComponent(url.pathname.replace('/api/internal/suppression/', ''))
      const digits = rawPhone.replace(/\D/g, '')
      const phone = (digits.length === 10 && digits.startsWith('3')) ? `57${digits}` : digits
      if (!phone || phone.length < 10) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Bad Request: Teléfono inválido o ambiguo' }))
        return
      }

      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      let reason = 'Baja administrativa / CRM'
      try {
        if (rb.body) {
          const parsed = JSON.parse(rb.body)
          if (parsed.reason) reason = String(parsed.reason).slice(0, 200)
        }
      } catch {}

      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      router.getSuppressionStore().addSuppression(orgId, phone, reason)
      console.log(`[Seguridad 2A AUDIT] Registro de supresión para: ${phone.slice(0, 4)}***${phone.slice(-2)} (org: ${orgId}, Motivo: "${reason}", IP: ${req.socket.remoteAddress}, Time: ${new Date().toISOString()})`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ phone, suppressed: true, reason, organizationId: orgId }))
      return
    }

    // 3.3 Eliminación Administrativa de Supresión (DELETE /api/internal/suppression/:phone)
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/internal/suppression/')) {
      // FAIL-CLOSED + comparación timing-safe (4.F)
      const internalSecret = process.env.INTERNAL_API_SECRET
      if (!isAuthorizedBearer(req.headers['authorization'], internalSecret || '')) {
        console.warn(`[Seguridad 2A ALERTA] Intento no autorizado de eliminar baja en: ${url.pathname} (IP: ${req.socket.remoteAddress}, Auth: ${req.headers['authorization'] ? 'Inválida' : 'Ausente'})`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid internal secret' }))
        return
      }

      const rawPhone = decodeURIComponent(url.pathname.replace('/api/internal/suppression/', ''))
      const digits = rawPhone.replace(/\D/g, '')
      const phone = (digits.length === 10 && digits.startsWith('3')) ? `57${digits}` : digits
      if (!phone || phone.length < 10) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Bad Request: Teléfono inválido o ambiguo' }))
        return
      }

      const orgId = String(req.headers['x-org-id'] || '')
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const wasSuppressed = router.getSuppressionStore().isSuppressed(orgId, phone)
      router.getSuppressionStore().removeSuppression(orgId, phone)
      console.log(`[Seguridad 2A AUDIT] Eliminación autorizada de supresión para: ${phone.slice(0, 4)}***${phone.slice(-2)} (org: ${orgId}, Estaba suprimido: ${wasSuppressed}, IP: ${req.socket.remoteAddress}, Time: ${new Date().toISOString()})`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ phone, suppressed: false, removed: true, wasSuppressed, organizationId: orgId }))
      return
    }

    // 4. Liberación de Lock (POST /api/internal/locks/:phone/release)
    if (req.method === 'POST' && url.pathname.endsWith('/release') && url.pathname.startsWith('/api/internal/locks/')) {
      const phone = decodeURIComponent(url.pathname.replace('/api/internal/locks/', '').replace('/release', ''))
      const orgId = String(req.headers['x-org-id'] || '')
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      router.getLockManager().releaseLock(phone, orgId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ phone, released: true }))
      return
    }

    // 4.bis Reconciliación de eventos UNCERTAIN (tercera reparación 4.C):
    // POST /api/internal/idempotency/reconcile — body {key} | {all: true}.
    // JAMÁS es un reintento ciego: re-ejecuta el ciclo reutilizando el journal
    // (efectos DONE se saltan; ningún mensaje ya enviado se reenvía).
    if (req.method === 'POST' && url.pathname === '/api/internal/idempotency/reconcile') {
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const body = JSON.parse(rb.body || '{}') as { key?: string; all?: boolean }
        if (body.key && typeof body.key === 'string') {
          const result = await router.reconcileEvent(body.key)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, key: body.key, result }))
          return
        }
        if (body.all === true) {
          const pending = router.listUncertainEvents(25)
          const outcomes: Array<{ key: string; ok: boolean; error?: string }> = []
          for (const ev of pending) {
            try {
              await router.reconcileEvent(ev.key)
              outcomes.push({ key: ev.key, ok: true })
            } catch (e: any) {
              outcomes.push({ key: ev.key, ok: false, error: String(e?.message || e) })
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, reconciled: outcomes.filter((o) => o.ok).length, outcomes }))
          return
        }
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Body requerido: {key} o {all:true} (lista previa vía GET .../uncertain)' }))
      } catch (e: any) {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
      }
      return
    }

    // 4.ter Listado de eventos UNCERTAIN pendientes (GET /api/internal/idempotency/uncertain)
    if (req.method === 'GET' && url.pathname === '/api/internal/idempotency/uncertain') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ uncertain: router.listUncertainEvents(100) }))
      return
    }

    // 5. Inbound Webhook (POST /api/inbound)
    // Endurecido (orden de cierre): firma HMAC OBLIGATORIA siempre + timestamp OBLIGATORIO
    // en ventana ±5min + caché anti-replay + comparación timing-safe. Sin excepción en dev:
    // el puente del CRM ya firma (X-Signature-SHA256 + X-Timestamp).
    if (req.method === 'POST' && url.pathname === '/api/inbound') {
      // Rate limiting (4.F): ventana por IP
      if (!inboundRate.allow(`inbound:${clientKey(req)}`)) {
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Demasiadas peticiones (rate limit)' }))
        return
      }
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const signature = req.headers['x-signature-sha256'] as string | undefined
        const timestampHeader = req.headers['x-timestamp'] as string | undefined

        const sec = checkWebhookSecurity(rb.body, signature, timestampHeader, webhookSecret, inboundReplay)
        if (!sec.ok) {
          res.writeHead(sec.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: sec.error }))
          return
        }

        const event = JSON.parse(rb.body) as InboundEvent
        if (!event.eventId || !event.orgId || !event.contact?.phone || !event.message?.text) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Payload de evento inbound incompleto' }))
          return
        }
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(event.orgId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'orgId inválido' }))
          return
        }

        const result = await router.processInbound(event)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // ==========================================
    // EXTENSIONES: EQUIPO, CANNED, GROWTH, PAGOS
    // ==========================================

    // 1. Team & Round-Robin — agentes POR ORGANIZACIÓN (4.A)
    if (req.method === 'GET' && url.pathname === '/api/team/agents') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(teamManager.getActiveAgents(orgId)))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/team/agents') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const data = JSON.parse(rb.body)
        const agent = teamManager.registerAgent(orgId, data)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(agent))
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/team/assign') {
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const { phone, strategy } = JSON.parse(rb.body)
        // (4.A) La organización viene del HEADER autenticado; el body NO decide la org.
        const orgId = requireOrgHeader(req)
        if (!orgId) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
          return
        }
        const agent = strategy === 'least_loaded'
          ? teamManager.assignLeastLoaded(orgId, phone)
          : teamManager.assignRoundRobin(orgId, phone)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ assignedAgent: agent }))
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // 2. Canned Responses (/canned) — POR ORGANIZACIÓN (4.A)
    if (req.method === 'GET' && url.pathname === '/api/canned') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(cannedManager.listAll(orgId)))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/canned') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const item = cannedManager.createResponse(orgId, JSON.parse(rb.body))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(item))
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // 3. Growth Links & Ref URLs (/ref/:slug)
    if (req.method === 'GET' && url.pathname.startsWith('/ref/')) {
      const slug = url.pathname.replace('/ref/', '')
      if (!refRate.allow(`ref:${clientKey(req)}`)) {
        res.writeHead(429, { 'Content-Type': 'text/plain' })
        res.end('Demasiadas peticiones')
        return
      }
      const redirectUrl = growthManager.registerClick(slug)
      if (redirectUrl) {
        res.writeHead(302, { Location: redirectUrl })
        res.end()
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Enlace de crecimiento no encontrado')
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/growth/links') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const link = growthManager.createGrowthLink(orgId, JSON.parse(rb.body))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(link))
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // 4. CRM Stage Change Trigger
    if (req.method === 'POST' && url.pathname === '/api/crm/stage-change') {
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const event = JSON.parse(rb.body)
        const result = await crmTriggers.handleStageChange(event)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // 5. Payment Links & Webhooks
    if (req.method === 'POST' && url.pathname === '/api/payments/create-link') {
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const parsed = JSON.parse(rb.body)
        if (!parsed.orgId || typeof parsed.orgId !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'orgId es obligatorio: los pagos pertenecen a una organización' }))
          return
        }
        const tx = paymentManager.createPaymentLink(parsed)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(tx))
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // Webhook de la pasarela de pagos: exige HMAC propio (PAYMENTS_WEBHOOK_SECRET) +
    // timestamp + anti-replay. Fail-closed: sin secret configurado, 503.
    if (req.method === 'POST' && url.pathname === '/api/payments/webhook') {
      // Rate limiting (4.F)
      if (!paymentsRate.allow(`pay:${clientKey(req)}`)) {
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Demasiadas peticiones (rate limit)' }))
        return
      }
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      const sec = checkWebhookSecurity(
        rb.body,
        req.headers['x-signature-sha256'] as string | undefined,
        req.headers['x-timestamp'] as string | undefined,
        process.env.PAYMENTS_WEBHOOK_SECRET,
        paymentsReplay,
      )
      if (!sec.ok) {
        console.warn(`[Seguridad 2A ALERTA] Webhook de pagos rechazado: ${sec.error} (IP: ${req.socket.remoteAddress})`)
        res.writeHead(sec.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: sec.error }))
        return
      }
      try {
        // Contrato v2 de pagos (reparación integral 2026-11-06): eventId único,
        // validación de amount/currency/org/reference y máquina de estados legal.
        const payload = JSON.parse(rb.body)
        const result = paymentManager.handlePaymentWebhook({
          eventId: payload.eventId,
          transactionId: payload.transactionId,
          status: payload.status,
          amount: payload.amount,
          currency: payload.currency,
          reference: payload.reference,
          orgId: payload.orgId,
        })
        if (!result.ok) {
          const statusByCode: Record<string, number> = {
            INVALID_EVENT: 400,
            TXN_NOT_FOUND: 404,
            VALIDATION_MISMATCH: 409,
            ILLEGAL_TRANSITION: 409,
          }
          res.writeHead(statusByCode[result.code] || 400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, code: result.code, error: result.message }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, transaction: result.transaction, idempotent: result.idempotent === true }))
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Ruta no encontrada' }))
  })

  return {
    server,
    db,
    router,
    transport,
    crm,
    teamManager,
    cannedManager,
    growthManager,
    crmTriggers,
    paymentManager,
  }
}

// Auto-arranque si se ejecuta directamente con node
if (process.argv[1]?.includes('server.ts')) {
  // Guard fail-fast de entorno en producción (orden de cierre): sin secretos robustos
  // o con Mock no explícito, el servicio NO arranca. Lista variables, jamás valores.
  if (process.env.NODE_ENV === 'production') {
    const problems = productionConfigProblems()
    if (problems.length > 0) {
      console.error('[Capa 2A ✋] Arranque bloqueado por configuración insegura/incompleta:')
      for (const p of problems) console.error(`  - ${p}`)
      process.exit(1)
    }
  }
  const PORT = Number(process.env.PORT || 3003)
  const { server } = createAgenticServer()
  server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`[Capa 2A] Servidor Agéntico escuchando en http://localhost:${PORT}`)
  })
}
