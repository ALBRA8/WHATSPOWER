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
  const transport = options?.transport || new MockTransportSender()
  // CRM Actions Bridge: cliente HTTP real hacia CRM-ALBRA cuando hay API key configurada;
  // Mock solo en desarrollo sin credenciales (antes el server de producción usaba SIEMPRE Mock).
  const crm = options?.crm
    || (process.env.CRM_API_KEY
      ? new HttpCrmClient(process.env.CRM_BASE_URL || 'http://localhost:3000', process.env.CRM_API_KEY)
      : new MockCrmClient())
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

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    // WhatsPower Flow Studio (Lienzo visual ManyChat)
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/studio')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderStudioHtml())
      return
    }

    // API REST de Flujos
    if (req.method === 'GET' && url.pathname === '/api/flows') {
      const flows = router.getFlowEngine().listFlows()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(flows))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/flows') {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        try {
          const flow = JSON.parse(body)
          router.getFlowEngine().saveFlow(flow)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, id: flow.id }))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/flows/simulate') {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', async () => {
        try {
          const { phone, messageText, name } = JSON.parse(body)
          const stepRes = await router.getFlowEngine().evaluateStep(phone, messageText, { name })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(stepRes))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    // 0. Visor de QR auto-refrescable en vivo para vinculación de WhatsApp
    if (req.method === 'GET' && url.pathname === '/qr') {
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
    <p>Este código QR se refresca automáticamente cada segundo para evitar expiración.</p>
    
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
    async function updateQR() {
      try {
        const res = await fetch('/qr/data');
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

    if (req.method === 'GET' && url.pathname === '/qr/data') {
      try {
        // FAIL-CLOSED (rotación 2026-10-27): sin secret configurado no se consulta el daemon
        const daemonSecret = process.env.INTERNAL_API_SECRET
        if (!daemonSecret) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Service Unavailable: INTERNAL_API_SECRET no configurado' }))
          return
        }
        const daemonRes = await fetch('http://localhost:3002/qr', {
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
      const lock = router.getLockManager().getLock(phone)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ phone, locked: Boolean(lock), lock }))
      return
    }

    // 3.1 Consulta de Supresión para Capa 2B (GET /api/internal/suppression/:phone)
    if (req.method === 'GET' && url.pathname.startsWith('/api/internal/suppression/')) {
      const rawPhone = decodeURIComponent(url.pathname.replace('/api/internal/suppression/', ''))
      const digits = rawPhone.replace(/\D/g, '')
      const phone = (digits.length === 10 && digits.startsWith('3')) ? `57${digits}` : digits
      const suppressed = router.getSuppressionStore().isSuppressed(phone)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ phone, suppressed }))
      return
    }

    // 3.2 Registro Administrativo de Supresión (POST /api/internal/suppression/:phone)
    if (req.method === 'POST' && url.pathname.startsWith('/api/internal/suppression/')) {
      const authHeader = req.headers['authorization']
      // FAIL-CLOSED (rotación 2026-10-27): sin secret configurado se rechaza siempre
      const internalSecret = process.env.INTERNAL_API_SECRET
      if (!internalSecret || !authHeader || authHeader !== `Bearer ${internalSecret}`) {
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

      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        let reason = 'Baja administrativa / CRM'
        try {
          if (body) {
            const parsed = JSON.parse(body)
            if (parsed.reason) reason = parsed.reason
          }
        } catch {}

        router.getSuppressionStore().addSuppression(phone, reason)
        console.log(`[Seguridad 2A AUDIT] Registro de supresión para: ${phone} (Motivo: "${reason}", IP: ${req.socket.remoteAddress}, Time: ${new Date().toISOString()})`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ phone, suppressed: true, reason }))
      })
      return
    }

    // 3.3 Eliminación Administrativa de Supresión (DELETE /api/internal/suppression/:phone)
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/internal/suppression/')) {
      const authHeader = req.headers['authorization']
      // FAIL-CLOSED (rotación 2026-10-27): sin secret configurado se rechaza siempre
      const internalSecret = process.env.INTERNAL_API_SECRET
      if (!internalSecret || !authHeader || authHeader !== `Bearer ${internalSecret}`) {
        console.warn(`[Seguridad 2A ALERTA] Intento no autorizado de eliminar baja en: ${url.pathname} (IP: ${req.socket.remoteAddress}, Auth: ${authHeader ? 'Inválida' : 'Ausente'})`)
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

      const wasSuppressed = router.getSuppressionStore().isSuppressed(phone)
      router.getSuppressionStore().removeSuppression(phone)
      console.log(`[Seguridad 2A AUDIT] Eliminación autorizada de supresión para: ${phone} (Estaba suprimido: ${wasSuppressed}, IP: ${req.socket.remoteAddress}, Time: ${new Date().toISOString()})`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ phone, suppressed: false, removed: true, wasSuppressed }))
      return
    }

    // 4. Liberación de Lock (POST /api/internal/locks/:phone/release)
    if (req.method === 'POST' && url.pathname.endsWith('/release') && url.pathname.startsWith('/api/internal/locks/')) {
      const phone = decodeURIComponent(url.pathname.replace('/api/internal/locks/', '').replace('/release', ''))
      router.getLockManager().releaseLock(phone)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ phone, released: true }))
      return
    }

    // 5. Inbound Webhook (POST /api/inbound)
    if (req.method === 'POST' && url.pathname === '/api/inbound') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', async () => {
        try {
          const signature = req.headers['x-signature-sha256'] as string | undefined
          const timestampHeader = req.headers['x-timestamp'] as string | undefined

          // 1. Validación de Timestamp (descarte de peticiones con más de 300s de desfase / replay protection)
          if (timestampHeader) {
            const reqTime = Number(timestampHeader) || new Date(timestampHeader).getTime()
            const now = Date.now()
            if (Number.isFinite(reqTime) && Math.abs(now - reqTime) > 300_000) {
              res.writeHead(401, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Timestamp expirado o fuera de ventana de tolerancia (replay protection)' }))
              return
            }
          }

          // 2. Validación estricta de firma HMAC (siempre exigida si hay signature o en producción)
          if (signature || process.env.NODE_ENV === 'production') {
            if (!verifyHmac(body, signature)) {
              res.writeHead(401, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Firma HMAC inválida o ausente' }))
              return
            }
          }

          const event = JSON.parse(body) as InboundEvent
          if (!event.eventId || !event.orgId || !event.contact?.phone || !event.message?.text) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Payload de evento inbound incompleto' }))
            return
          }

          const result = await router.processInbound(event)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })
      return
    }

    // ==========================================
    // EXTENSIONES: EQUIPO, CANNED, GROWTH, PAGOS
    // ==========================================

    // 1. Team & Round-Robin
    if (req.method === 'GET' && url.pathname === '/api/team/agents') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(teamManager.getActiveAgents()))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/team/agents') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          const agent = teamManager.registerAgent(data)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(agent))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/team/assign') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const { phone, strategy } = JSON.parse(body)
          const agent = strategy === 'least_loaded'
            ? teamManager.assignLeastLoaded(phone)
            : teamManager.assignRoundRobin(phone)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ assignedAgent: agent }))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    // 2. Canned Responses (/canned)
    if (req.method === 'GET' && url.pathname === '/api/canned') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(cannedManager.listAll()))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/canned') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const item = cannedManager.createResponse(JSON.parse(body))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(item))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
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
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const link = growthManager.createGrowthLink(JSON.parse(body))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(link))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    // 4. CRM Stage Change Trigger
    if (req.method === 'POST' && url.pathname === '/api/crm/stage-change') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        try {
          const event = JSON.parse(body)
          const result = await crmTriggers.handleStageChange(event)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    // 5. Payment Links & Webhooks
    if (req.method === 'POST' && url.pathname === '/api/payments/create-link') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const tx = paymentManager.createPaymentLink(JSON.parse(body))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(tx))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/payments/webhook') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const { transactionId, status } = JSON.parse(body)
          const tx = paymentManager.handlePaymentWebhook(transactionId, status)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, transaction: tx }))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
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
  const PORT = Number(process.env.PORT || 3003)
  const { server } = createAgenticServer()
  server.listen(PORT, () => {
    console.log(`[Capa 2A] Servidor Agéntico escuchando en http://localhost:${PORT}`)
  })
}
