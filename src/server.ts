import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { createDatabase, purgeExpiredSecurityRows } from './db.ts'
import { ConversationRouter } from './engine/router.ts'
import { MockTransportSender, HttpAlbraTransportSender } from './adapters/transport.ts'
import { MockCrmClient, HttpCrmClient } from './adapters/crm-client.ts'
import { renderStudioHtml } from './studio/studio-html.ts'
import { TeamManager } from './state/team-manager.ts'
import { CannedResponseManager } from './engine/canned-responses.ts'
import { GrowthToolsManager } from './engine/growth-tools.ts'
import { CrmTriggerListener } from './engine/crm-triggers.ts'
import { PaymentGatewayManager, PaymentError } from './payments/payment-gateway.ts'
import type { InboundEvent, TransportSender, CrmClientInterface } from './types.ts'
import {
  checkWebhookSecurity,
  verifyWebhookWithOrg,
  parseWebhookSecrets,
  resolveAdminIdentity,
  orgHeaderAllowed,
  readBody,
  PersistentReplayStore,
  RateLimiter,
  clientIp,
  maskPhone,
  productionConfigProblems,
  type InternalIdentity,
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
  const crm = options?.crm
    ?? (process.env.CRM_API_KEY
      ? new HttpCrmClient(process.env.CRM_BASE_URL || 'http://localhost:3000', process.env.CRM_API_KEY)
      : (isProduction
        ? (() => { throw new Error('CRM_API_KEY no configurada: en producción el puente CRM no puede usar MockCrmClient silenciosamente (configura CRM_API_KEY)') })()
        : (console.warn('[Capa 2A AVISO] CRM en modo Mock — SOLO desarrollo. Configura CRM_API_KEY para el puente real.'), new MockCrmClient())))

  // Secretos de webhook v1.1.0:
  //  - WEBHOOK_SECRETS="orgId:secreto,..." → el secreto que valida el HMAC VINCULA la org.
  //  - Legado AGENTIC_2A_WEBHOOK_SECRET/WEBHOOK_SECRET (o override options.webhookSecret)
  //    → modo de transición: la organización viene del payload autenticado por HMAC.
  const perOrgWebhookSecrets = parseWebhookSecrets(process.env.WEBHOOK_SECRETS)
  const legacyWebhookSecret = options?.webhookSecret
    || process.env.AGENTIC_2A_WEBHOOK_SECRET
    || process.env.WEBHOOK_SECRET

  const router = new ConversationRouter(db, transport, crm)
  const teamManager = new TeamManager(db)
  const cannedManager = new CannedResponseManager(db)
  const growthManager = new GrowthToolsManager(db, options?.businessPhone || '573001234567')
  const crmTriggers = new CrmTriggerListener(db, router.getFlowEngine())
  const paymentManager = new PaymentGatewayManager(db)

  // Anti-replay PERSISTENTE (sobrevive reinicios; purga >600s) — instancia única por BD.
  const inboundReplay = new PersistentReplayStore(db)
  const paymentsReplay = new PersistentReplayStore(db)

  // Rate limiting por ruta (contrato §7): 429 + Retry-After.
  const rateLimiter = new RateLimiter()

  // Purga de antigüedad al arrancar + cada hora (idempotencia >7d, replay lo hace su store).
  purgeExpiredSecurityRows(db)
  router.purgeExpiredIdempotency()
  const purgeTimer = setInterval(() => {
    purgeExpiredSecurityRows(db)
    router.purgeExpiredIdempotency()
  }, 60 * 60 * 1000)
  purgeTimer.unref?.()

  function json(res: ServerResponse, status: number, payload: unknown, extraHeaders?: Record<string, string>): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders })
    res.end(JSON.stringify(payload))
  }

  /** Respuesta 429 uniforme con Retry-After (contrato §7). */
  function tooManyRequests(res: ServerResponse, retryAfterSec: number): void {
    json(res, 429, { error: 'Too Many Requests: límite de tasa excedido' }, { 'Retry-After': String(retryAfterSec) })
  }

  /** Respuesta 5xx genérica: el detalle SOLO va al log del servidor (contrato §7). */
  function generic500(res: ServerResponse, scope: string, err: unknown): void {
    console.error(`[Capa 2A ERROR] ${scope}:`, err instanceof Error ? err.message : err)
    json(res, 500, { error: 'Error interno del servidor' })
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    // ==========================================================
    // PUERTA DE AUTENTICACIÓN (contrato v1.1.0 §1-§2)
    // Toda ruta /api/* es administrativa y exige credencial interna:
    //  - INTERNAL_API_KEYS="orgId:secreto[:rol],..." (por organización), o
    //  - legado INTERNAL_API_SECRET → org "default", rol admin.
    // Fail-closed 503 sin credenciales configuradas; 401 con credenciales inválidas.
    // X-Org-Id solo puede RESTRINGIR (debe coincidir con la org de la credencial).
    // SALVO: /api/health (público), /api/inbound (HMAC v2 propio) y
    // /api/payments/webhook (HMAC de la pasarela).
    // ==========================================================
    const isPublicApiPath = url.pathname === '/api/health'
      || url.pathname === '/api/inbound'
      || url.pathname === '/api/payments/webhook'

    let identity: InternalIdentity | undefined
    if (url.pathname.startsWith('/api/') && !isPublicApiPath) {
      const rl = rateLimiter.check(`admin:${clientIp(req)}`, 120)
      if (!rl.allowed) { tooManyRequests(res, rl.retryAfterSec); return }
      const resolution = resolveAdminIdentity(req.headers['authorization'])
      if (!resolution.ok) {
        if (resolution.status === 503) {
          json(res, 503, { error: resolution.error })
        } else {
          console.warn(`[Seguridad 2A ALERTA] Acceso administrativo no autorizado: ${req.method} ${url.pathname} (IP: ${clientIp(req)})`)
          json(res, 401, { error: resolution.error })
        }
        return
      }
      identity = resolution.identity
      if (!orgHeaderAllowed(req.headers['x-org-id'], identity!)) {
        console.warn(`[Seguridad 2A ALERTA] X-Org-Id ajeno a la credencial: ${req.method} ${url.pathname} (org: ${identity!.orgId})`)
        json(res, 403, { error: 'Forbidden: la organización solicitada no corresponde a la credencial' })
        return
      }
    }

    // WhatsPower Flow Studio (Lienzo visual ManyChat) — autenticado (cualquier rol).
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/studio')) {
      const resolution = resolveAdminIdentity(req.headers['authorization'])
      if (!resolution.ok) {
        json(res, resolution.status, { error: resolution.error })
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderStudioHtml())
      return
    }

    // API REST de Flujos
    if (req.method === 'GET' && url.pathname === '/api/flows') {
      const flows = router.getFlowEngine().listFlows()
      json(res, 200, flows)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/flows') {
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const flow = JSON.parse(rb.body)
        router.getFlowEngine().saveFlow(flow)
        json(res, 200, { ok: true, id: flow.id })
      } catch {
        json(res, 400, { error: 'JSON de flujo inválido' })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/flows/simulate') {
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const { phone, messageText, name } = JSON.parse(rb.body)
        const stepRes = await router.getFlowEngine().evaluateStep(identity!.orgId, phone, messageText, { name })
        json(res, 200, stepRes)
      } catch {
        json(res, 400, { error: 'Solicitud de simulación inválida' })
      }
      return
    }

    // 0. Visor de QR auto-refrescable — PROTEGIDO (reparación integral): jamás se
    // sirve la página de vinculación a un anónimo.
    if (req.method === 'GET' && url.pathname === '/qr') {
      const resolution = resolveAdminIdentity(req.headers['authorization'])
      if (!resolution.ok) {
        json(res, resolution.status, { error: resolution.error })
        return
      }
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
  </style>
</head>
<body>
  <div class="card">
    <h1>Vincular WhatsApp en Vivo</h1>
    <p>Este código QR se refresca automáticamente cada segundo para evitar expiración. Sesión autenticada como administrador.</p>

    <div class="qr-container" id="qrContainer">
      <div style="color: #64748b; font-size: 14px;">Generando código QR...</div>
    </div>

    <div>
      <div id="statusBadge" class="badge badge-waiting">
        <span class="pulse"></span> <span id="statusText">Sincronizando con WhatsApp...</span>
      </div>
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
    // El token llega por el localStorage (colocado por el operador tras autenticarse);
    // la página NUNCA se sirve a anónimos y /qr/data tampoco responde a anónimos.
    async function updateQR() {
      try {
        const token = localStorage.getItem('wp_qr_token') || '';
        const res = await fetch('/qr/data', { headers: { 'Authorization': 'Bearer ' + token } });
        if (!res.ok) return;
        const data = await res.json();
        const container = document.getElementById('qrContainer');
        const badge = document.getElementById('statusBadge');
        const text = document.getElementById('statusText');

        if (data.status === 'connected') {
          container.innerHTML = '<div style="color:#059669; font-weight:bold; font-size:18px; padding:40px;">✅ ¡Dispositivo Conectado!<br><br><span style="font-size:15px; color:#334155;">' + (data.phone ? '+' + data.phone : '') + '</span></div>';
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
      } catch (err) {
        console.error(err);
      }
    }
    updateQR();
    setInterval(updateQR, 1500);
  </script>
</body>
</html>`)
      return
    }

    // Datos del QR — PROTEGIDO (reparación integral): exige identidad de administrador.
    // Jamás se devuelve información de QR/phone a usuarios anónimos.
    if (req.method === 'GET' && url.pathname === '/qr/data') {
      const resolution = resolveAdminIdentity(req.headers['authorization'])
      if (!resolution.ok) {
        json(res, resolution.status, { error: resolution.error })
        return
      }
      if (resolution.identity!.role !== 'admin') {
        json(res, 403, { error: 'Forbidden: la vinculación de dispositivos exige rol admin' })
        return
      }
      const rl = rateLimiter.check(`qr:${clientIp(req)}`, 30)
      if (!rl.allowed) { tooManyRequests(res, rl.retryAfterSec); return }
      try {
        // FAIL-CLOSED (rotación 2026-10-27): sin secret configurado no se consulta el daemon
        const daemonSecret = process.env.INTERNAL_API_SECRET
        if (!daemonSecret) {
          json(res, 503, { error: 'Service Unavailable: INTERNAL_API_SECRET no configurado' })
          return
        }
        const daemonRes = await fetch(`${process.env.WHATSAPP_DAEMON_URL || 'http://localhost:3002'}/qr`, {
          headers: { 'Authorization': 'Bearer ' + daemonSecret }
        })
        const data = await daemonRes.json()
        json(res, 200, data)
      } catch (err) {
        generic500(res, 'qr/data', err)
      }
      return
    }

    // 1. Healthcheck
    if (req.method === 'GET' && url.pathname === '/api/health') {
      json(res, 200, { status: 'ok', service: 'albra-agentic-2a' })
      return
    }

    // 2. Consulta de Locks para Capa 2B (GET /api/internal/locks/:phone) — scoped por org.
    if (req.method === 'GET' && url.pathname.startsWith('/api/internal/locks/')) {
      const phone = decodeURIComponent(url.pathname.replace('/api/internal/locks/', ''))
      const lock = router.getLockManager().getLock(phone, identity!.orgId)
      json(res, 200, { phone, locked: Boolean(lock), lock })
      return
    }

    // 3.1 Consulta de Supresión para Capa 2B (GET /api/internal/suppression/:phone) — scoped.
    if (req.method === 'GET' && url.pathname.startsWith('/api/internal/suppression/')) {
      const rawPhone = decodeURIComponent(url.pathname.replace('/api/internal/suppression/', ''))
      const digits = rawPhone.replace(/\D/g, '')
      const phone = (digits.length === 10 && digits.startsWith('3')) ? `57${digits}` : digits
      const suppressed = router.getSuppressionStore().isSuppressed(phone, identity!.orgId)
      json(res, 200, { phone, suppressed })
      return
    }

    // 3.2 Registro Administrativo de Supresión (POST) — scoped por org.
    if (req.method === 'POST' && url.pathname.startsWith('/api/internal/suppression/')) {
      const rawPhone = decodeURIComponent(url.pathname.replace('/api/internal/suppression/', ''))
      const digits = rawPhone.replace(/\D/g, '')
      const phone = (digits.length === 10 && digits.startsWith('3')) ? `57${digits}` : digits
      if (!phone || phone.length < 10) {
        json(res, 400, { error: 'Bad Request: Teléfono inválido o ambiguo' })
        return
      }

      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      let reason = 'Baja administrativa / CRM'
      try {
        if (rb.body) {
          const parsed = JSON.parse(rb.body)
          if (parsed.reason) reason = String(parsed.reason).slice(0, 200)
        }
      } catch { /* motivo por defecto */ }

      router.getSuppressionStore().addSuppression(phone, reason, identity!.orgId)
      console.log(`[Seguridad 2A AUDIT] Registro de supresión para ${maskPhone(phone)} (org: ${identity!.orgId}, Motivo: "${reason}", IP: ${clientIp(req)}, Time: ${new Date().toISOString()})`)
      json(res, 200, { phone, suppressed: true, reason })
      return
    }

    // 3.3 Eliminación Administrativa de Supresión (DELETE) — SOLO rol admin (contrato §2).
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/internal/suppression/')) {
      if (identity!.role !== 'admin') {
        console.warn(`[Seguridad 2A ALERTA] Intento de eliminar baja sin rol admin (org: ${identity!.orgId}, IP: ${clientIp(req)})`)
        json(res, 403, { error: 'Forbidden: eliminar supresiones exige rol admin' })
        return
      }
      const rawPhone = decodeURIComponent(url.pathname.replace('/api/internal/suppression/', ''))
      const digits = rawPhone.replace(/\D/g, '')
      const phone = (digits.length === 10 && digits.startsWith('3')) ? `57${digits}` : digits
      if (!phone || phone.length < 10) {
        json(res, 400, { error: 'Bad Request: Teléfono inválido o ambiguo' })
        return
      }

      const wasSuppressed = router.getSuppressionStore().isSuppressed(phone, identity!.orgId)
      router.getSuppressionStore().removeSuppression(phone, identity!.orgId)
      console.log(`[Seguridad 2A AUDIT] Eliminación autorizada de supresión para ${maskPhone(phone)} (org: ${identity!.orgId}, Estaba suprimido: ${wasSuppressed}, IP: ${clientIp(req)}, Time: ${new Date().toISOString()})`)
      json(res, 200, { phone, suppressed: false, removed: true, wasSuppressed })
      return
    }

    // 4. Liberación de Lock (POST /api/internal/locks/:phone/release) — SOLO rol admin,
    // scoped a la organización de la credencial.
    if (req.method === 'POST' && url.pathname.endsWith('/release') && url.pathname.startsWith('/api/internal/locks/')) {
      if (identity!.role !== 'admin') {
        json(res, 403, { error: 'Forbidden: liberar locks exige rol admin' })
        return
      }
      const phone = decodeURIComponent(url.pathname.replace('/api/internal/locks/', '').replace('/release', ''))
      router.getLockManager().releaseLock(phone, identity!.orgId)
      json(res, 200, { phone, released: true })
      return
    }

    // 5. Inbound Webhook (POST /api/inbound) — HMAC v2 (contrato §3):
    // firma sobre timestamp.body, ventana ±300s, anti-replay PERSISTENTE, secretos
    // por organización (WEBHOOK_SECRETS) con el secreto VINCULANDO la org.
    if (req.method === 'POST' && url.pathname === '/api/inbound') {
      const rl = rateLimiter.check(`inbound:${clientIp(req)}`, 60)
      if (!rl.allowed) { tooManyRequests(res, rl.retryAfterSec); return }
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const signature = req.headers['x-signature-sha256'] as string | undefined
        const timestampHeader = req.headers['x-timestamp'] as string | undefined
        const eventIdHeader = req.headers['x-event-id'] as string | undefined

        // Pre-parseo SOLO para conocer el orgId declarado (la verificación HMAC es previa
        // a cualquier efecto; el orgId del payload se valida DESPUÉS contra el secreto).
        let declaredOrgId: string | undefined
        let eventId: string | undefined
        let parsedEvent: InboundEvent | undefined
        try {
          parsedEvent = JSON.parse(rb.body) as InboundEvent
          declaredOrgId = parsedEvent.orgId
          eventId = parsedEvent.eventId
        } catch {
          json(res, 400, { error: 'Payload JSON inválido' })
          return
        }

        const sec = verifyWebhookWithOrg(rb.body, signature, timestampHeader, declaredOrgId, {
          perOrgSecrets: perOrgWebhookSecrets,
          legacySecret: legacyWebhookSecret,
          replay: inboundReplay,
        })
        if (!sec.ok) {
          json(res, sec.status, { error: sec.error })
          return
        }

        // Organización resuelta SIEMPRE de la credencial verificada (contrato §1):
        //  - con WEBHOOK_SECRETS: org vinculada al secreto (403 si el payload declara otra).
        //  - modo de transición (secreto legado): org del payload autenticado por HMAC.
        const orgId = sec.boundOrgId || declaredOrgId || 'default'
        if (!eventId) eventId = eventIdHeader || undefined
        if (!eventId || !orgId || !parsedEvent!.contact?.phone || !parsedEvent!.message?.text) {
          json(res, 400, { error: 'Payload de evento inbound incompleto' })
          return
        }
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(orgId)) {
          json(res, 400, { error: 'orgId inválido' })
          return
        }
        if (!/^[a-zA-Z0-9._-]{1,128}$/.test(eventId)) {
          json(res, 400, { error: 'eventId inválido' })
          return
        }

        const event: InboundEvent = { ...parsedEvent!, eventId, orgId }
        const result = await router.processInbound(event)
        json(res, 200, result)
      } catch (err) {
        generic500(res, 'inbound', err)
      }
      return
    }

    // ==========================================
    // EXTENSIONES: EQUIPO, CANNED, GROWTH, PAGOS
    // (todas scoped a la organización de la credencial)
    // ==========================================

    // 1. Team & Round-Robin
    if (req.method === 'GET' && url.pathname === '/api/team/agents') {
      json(res, 200, teamManager.getActiveAgents())
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/team/agents') {
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const data = JSON.parse(rb.body)
        const agent = teamManager.registerAgent(data)
        json(res, 200, agent)
      } catch {
        json(res, 400, { error: 'Datos de agente inválidos' })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/team/assign') {
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const { phone, strategy } = JSON.parse(rb.body)
        const agent = strategy === 'least_loaded'
          ? teamManager.assignLeastLoaded(phone, identity!.orgId)
          : teamManager.assignRoundRobin(phone, identity!.orgId)
        json(res, 200, { assignedAgent: agent })
      } catch {
        json(res, 400, { error: 'Solicitud de asignación inválida' })
      }
      return
    }

    // 2. Canned Responses (/canned)
    if (req.method === 'GET' && url.pathname === '/api/canned') {
      json(res, 200, cannedManager.listAll())
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/canned') {
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const item = cannedManager.createResponse(JSON.parse(rb.body))
        json(res, 200, item)
      } catch {
        json(res, 400, { error: 'Datos de respuesta canned inválidos' })
      }
      return
    }

    // 3. Growth Links & Ref URLs (/ref/:slug)
    if (req.method === 'GET' && url.pathname.startsWith('/ref/')) {
      const slug = url.pathname.replace('/ref/', '')
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
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const link = growthManager.createGrowthLink(JSON.parse(rb.body))
        json(res, 200, link)
      } catch {
        json(res, 400, { error: 'Datos de enlace de crecimiento inválidos' })
      }
      return
    }

    // 4. CRM Stage Change Trigger
    if (req.method === 'POST' && url.pathname === '/api/crm/stage-change') {
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const event = JSON.parse(rb.body)
        const result = await crmTriggers.handleStageChange(event, identity!.orgId)
        json(res, 200, result)
      } catch {
        json(res, 400, { error: 'Evento de cambio de etapa inválido' })
      }
      return
    }

    // 5. Payment Links & Webhooks
    if (req.method === 'POST' && url.pathname === '/api/payments/create-link') {
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const tx = paymentManager.createPaymentLink(JSON.parse(rb.body), identity!.orgId)
        json(res, 200, tx)
      } catch (e) {
        if (e instanceof PaymentError && e.code === 'GATEWAY_NOT_CONFIGURED') {
          json(res, 503, { error: 'Service Unavailable: pasarela real no configurada (fail-closed)' })
        } else {
          json(res, 400, { error: 'Datos de pago inválidos' })
        }
      }
      return
    }

    // Webhook de la pasarela de pagos: HMAC v2 (PAYMENTS_WEBHOOK_SECRET) + timestamp +
    // anti-replay persistente. Máquina de estados estricta (contrato §6).
    if (req.method === 'POST' && url.pathname === '/api/payments/webhook') {
      const rl = rateLimiter.check(`payments:${clientIp(req)}`, 60)
      if (!rl.allowed) { tooManyRequests(res, rl.retryAfterSec); return }
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
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
        console.warn(`[Seguridad 2A ALERTA] Webhook de pagos rechazado: ${sec.error} (IP: ${clientIp(req)})`)
        json(res, sec.status, { error: sec.error })
        return
      }
      try {
        const { transactionId, status } = JSON.parse(rb.body)
        if (!transactionId || typeof transactionId !== 'string') {
          json(res, 400, { error: 'transactionId obligatorio' })
          return
        }
        // El webhook de la pasarela opera sobre la organización dueña de la cuenta de
        // la pasarela (por despliegue): org 'default'. Pasarelas por organización
        // requerirían secretos de webhook por org (documentado en el contrato).
        const tx = paymentManager.handlePaymentWebhook(transactionId, String(status || ''), 'default')
        json(res, 200, { ok: true, transaction: tx })
      } catch (e) {
        if (e instanceof PaymentError) {
          if (e.code === 'INVALID_STATUS') json(res, 400, { error: 'status fuera de la whitelist de transiciones válidas' })
          else if (e.code === 'NOT_FOUND') json(res, 404, { error: 'transacción no encontrada' })
          else if (e.code === 'ILLEGAL_TRANSITION') json(res, 409, { error: 'Conflicto: transición de estado ilegal (terminal intocable)' })
          else json(res, 400, { error: 'Solicitud de pago inválida' })
        } else {
          json(res, 400, { error: 'Payload de webhook de pago inválido' })
        }
      }
      return
    }

    json(res, 404, { error: 'Ruta no encontrada' })
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
  server.listen(PORT, () => {
    console.log(`[Capa 2A] Servidor Agéntico escuchando en http://localhost:${PORT}`)
  })
}
