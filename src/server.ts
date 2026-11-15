import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
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
import { MiniWebSocketServer } from './realtime/ws-server.ts'
import type { InboundEvent, TransportSender, CrmClientInterface } from './types.ts'

try {
  process.loadEnvFile()
} catch {}

// Límite máximo de bytes por cuerpo POST (1 MB). Previene DoS por agotamiento de memoria.
const MAX_BODY_BYTES = 1_000_000

/**
 * Lee el cuerpo de una petición POST respetando MAX_BODY_BYTES.
 * Aborta con Error si el payload excede el límite (el handler responde 413).
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length'] || 0)
    if (contentLength > MAX_BODY_BYTES) {
      reject(new Error('Payload demasiado grande: supera 1MB (Content-Length)'))
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let aborted = false

    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        reject(new Error('Payload demasiado grande: supera 1MB durante streaming'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (aborted) return
      resolve(Buffer.concat(chunks))
    })

    req.on('error', (err) => {
      if (!aborted) reject(err)
    })
  })
}

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

  // ============================================================
  // WEBSOCKET SERVER (push en tiempo real hacia el dashboard)
  // ============================================================
  const wsServer = new MiniWebSocketServer('/ws')
  wsServer.startPing(30_000)

  // Wrapper decorador sobre TransportSender que difunde eventos de mensajes salientes
  // a todos los clientes WebSocket conectados. Permite que el dashboard vea en vivo
  // los mensajes enviados por el bot (incluso los del flow engine y los deterministas).
  const wrappedTransport: TransportSender = {
    sendMessage: async (to: string, text: string, correlationId: string) => {
      const result = await transport.sendMessage(to, text, correlationId)
      if (result.ok) {
        wsServer.broadcast({
          type: 'message',
          payload: {
            direction: 'outbound',
            phone: to,
            text,
            correlationId,
            timestamp: Date.now(),
          },
        })
      }
      return result
    },
  }
  // Re-wireamos el router para que use el transport wrapper que difunde.
  ;(router as any).transport = wrappedTransport

  // Comparación constante en tiempo (timingSafeEqual) para evitar timing attacks
  // sobre el HMAC. La longitud debe coincidir antes de comparar byte a byte.
  function verifyHmac(payload: string, signatureHeader?: string): boolean {
    if (!webhookSecret || !signatureHeader) return false
    const expected = createHmac('sha256', webhookSecret).update(payload).digest('hex')
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(signatureHeader, 'utf8')
    if (a.length !== b.length) return false
    try {
      return timingSafeEqual(a, b)
    } catch {
      return false
    }
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
      try {
        const flow = JSON.parse((await readBody(req)).toString('utf8'))
        router.getFlowEngine().saveFlow(flow)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, id: flow.id }))
      } catch (e: any) {
        res.writeHead(e.message.includes('Payload demasiado grande') ? 413 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/flows/simulate') {
      try {
        const { phone, messageText, name } = JSON.parse((await readBody(req)).toString('utf8'))
        const stepRes = await router.getFlowEngine().evaluateStep(phone, messageText, { name })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(stepRes))
      } catch (e: any) {
        res.writeHead(e.message.includes('Payload demasiado grande') ? 413 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // API REST de Secuencias (drip campaigns / seguimientos)
    if (req.method === 'GET' && url.pathname === '/api/sequences') {
      const sequences = router.getFlowEngine().listSequences()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(sequences))
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

      let reason = 'Baja administrativa / CRM'
      try {
        const body = (await readBody(req)).toString('utf8')
        if (body) {
          const parsed = JSON.parse(body)
          if (parsed.reason) reason = parsed.reason
        }
      } catch {}

      router.getSuppressionStore().addSuppression(phone, reason)
      console.log(`[Seguridad 2A AUDIT] Registro de supresión para: ${phone} (Motivo: "${reason}", IP: ${req.socket.remoteAddress}, Time: ${new Date().toISOString()})`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ phone, suppressed: true, reason }))
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
      let raw: string
      try {
        raw = (await readBody(req)).toString('utf8')
      } catch (e: any) {
        res.writeHead(e.message.includes('Payload demasiado grande') ? 413 : 500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
        return
      }

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

        // 2. Validación estricta de firma HMAC.
        // Fail-closed: si hay webhookSecret configurado, SIEMPRE se exige firma válida.
        // (Antes solo se exigía en producción o si llegaba signature, lo que permitía bypass en desarrollo.)
        if (webhookSecret) {
          if (!verifyHmac(raw, signature)) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Firma HMAC inválida o ausente' }))
            return
          }
        }

        const event = JSON.parse(raw) as InboundEvent
        if (!event.eventId || !event.orgId || !event.contact?.phone || !event.message?.text) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Payload de evento inbound incompleto' }))
          return
        }

        const result = await router.processInbound(event)
        // Broadcast del evento inbound en tiempo real al dashboard
        wsServer.broadcast({
          type: 'message',
          payload: {
            direction: 'inbound',
            phone: event.contact.phone,
            text: event.message.text,
            correlationId: event.correlationId || event.eventId,
            timestamp: Date.now(),
            actionTaken: result.actionTaken,
          },
        })
        // Broadcast de eventos derivados: handoff cambia el estado del lock
        if (result.actionTaken === 'handoff_human') {
          wsServer.broadcast({
            type: 'lock',
            payload: { phone: event.contact.phone, state: 'HANDOFF_HUMAN' },
          })
        }
        // Opt-out registra baja en la suppression list
        if (result.actionTaken === 'suppression_opt_out') {
          wsServer.broadcast({
            type: 'suppression',
            payload: { phone: event.contact.phone, action: 'add', reason: 'Solicitud voluntaria' },
          })
        }
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

    // 1. Team & Round-Robin
    if (req.method === 'GET' && url.pathname === '/api/team/agents') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(teamManager.getActiveAgents()))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/team/agents') {
      try {
        const data = JSON.parse((await readBody(req)).toString('utf8'))
        const agent = teamManager.registerAgent(data)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(agent))
      } catch (e: any) {
        res.writeHead(e.message.includes('Payload demasiado grande') ? 413 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/team/assign') {
      try {
        const { phone, strategy } = JSON.parse((await readBody(req)).toString('utf8'))
        const agent = strategy === 'least_loaded'
          ? teamManager.assignLeastLoaded(phone)
          : teamManager.assignRoundRobin(phone)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ assignedAgent: agent }))
      } catch (e: any) {
        res.writeHead(e.message.includes('Payload demasiado grande') ? 413 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // 2. Canned Responses (/canned)
    if (req.method === 'GET' && url.pathname === '/api/canned') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(cannedManager.listAll()))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/canned') {
      try {
        const item = cannedManager.createResponse(JSON.parse((await readBody(req)).toString('utf8')))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(item))
      } catch (e: any) {
        res.writeHead(e.message.includes('Payload demasiado grande') ? 413 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
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
      try {
        const link = growthManager.createGrowthLink(JSON.parse((await readBody(req)).toString('utf8')))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(link))
      } catch (e: any) {
        res.writeHead(e.message.includes('Payload demasiado grande') ? 413 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // 4. CRM Stage Change Trigger
    if (req.method === 'POST' && url.pathname === '/api/crm/stage-change') {
      try {
        const event = JSON.parse((await readBody(req)).toString('utf8'))
        const result = await crmTriggers.handleStageChange(event)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (e: any) {
        res.writeHead(e.message.includes('Payload demasiado grande') ? 413 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // 5. Payment Links & Webhooks
    if (req.method === 'POST' && url.pathname === '/api/payments/create-link') {
      try {
        const tx = paymentManager.createPaymentLink(JSON.parse((await readBody(req)).toString('utf8')))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(tx))
      } catch (e: any) {
        res.writeHead(e.message.includes('Payload demasiado grande') ? 413 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/payments/webhook') {
      try {
        const { transactionId, status } = JSON.parse((await readBody(req)).toString('utf8'))
        const tx = paymentManager.handlePaymentWebhook(transactionId, status)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, transaction: tx }))
      } catch (e: any) {
        res.writeHead(e.message.includes('Payload demasiado grande') ? 413 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // ==============================================================
    // ENDPOINTS DE DASHBOARD OPERATIVO (Inbox · Locks · Suppressions · Metrics)
    // ==============================================================
    // Todos son de solo lectura para alimentar el panel de control.
    // ==============================================================

    // GET /api/inbox — lista de mensajes con filtros opcionales:
    //   ?phone=...      filtra por teléfono exacto
    //   ?since=<ms>     filtra por created_at >= since
    //   ?limit=<int>    máximo número de filas (default 200, max 1000)
    if (req.method === 'GET' && url.pathname === '/api/inbox') {
      const phone = url.searchParams.get('phone') || undefined
      const since = Number(url.searchParams.get('since') || 0)
      let limit = Number(url.searchParams.get('limit') || 200)
      if (!Number.isFinite(limit) || limit < 1) limit = 200
      if (limit > 1000) limit = 1000

      const rows = phone
        ? db.prepare(
            'SELECT id, contact_phone, direction, text, media_url, created_at FROM inbox_messages WHERE contact_phone = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?'
          ).all(phone, since, limit)
        : db.prepare(
            'SELECT id, contact_phone, direction, text, media_url, created_at FROM inbox_messages WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?'
          ).all(since, limit)

      const inbox = (rows as any[]).map((r) => ({
        id: r.id,
        contactPhone: r.contact_phone,
        direction: r.direction,
        text: r.text,
        mediaUrl: r.media_url || null,
        createdAt: r.created_at,
      }))

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ messages: inbox, count: inbox.length }))
      return
    }

    // GET /api/locks — lista todos los locks activos no expirados (excluye HANDOFF_HUMAN opcional)
    if (req.method === 'GET' && url.pathname === '/api/locks') {
      const now = Math.floor(Date.now() / 1000)
      const includeHandoff = url.searchParams.get('include_handoff') !== 'false'
      const rows = db.prepare(
        `SELECT contact_phone, organization_id, current_state, locked_at, expires_at, correlation_id
         FROM conversation_locks
         WHERE expires_at > ?
         ORDER BY locked_at DESC`
      ).all(now) as Array<{
        contact_phone: string
        organization_id: string
        current_state: string
        locked_at: number
        expires_at: number
        correlation_id: string
      }>

      const locks = rows
        .filter((r) => includeHandoff || r.current_state !== 'HANDOFF_HUMAN')
        .map((r) => ({
          contactPhone: r.contact_phone,
          organizationId: r.organization_id,
          currentState: r.current_state,
          lockedAt: r.locked_at,
          expiresAt: r.expires_at,
          correlationId: r.correlation_id,
          expiresInSeconds: Math.max(0, r.expires_at - now),
        }))

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ locks, count: locks.length }))
      return
    }

    // CRM de Contactos (paridad ManyChat "Contactos"):
    // GET /api/contacts — une crm_contacts + inbox + tags + locks + supresiones en una vista única
    if (req.method === 'GET' && url.pathname === '/api/contacts') {
      const now = Math.floor(Date.now() / 1000)
      type CrmRow = { contact_phone: string; name: string | null; email: string | null; notes: string | null; source: string; created_at: number; updated_at: number }
      const known = new Map<string, { name: string | null; email: string | null; notes: string | null; source: string; createdAt: number; updatedAt: number }>()
      try {
        const rows = db.prepare(`SELECT contact_phone, name, email, notes, source, created_at, updated_at FROM crm_contacts ORDER BY updated_at DESC`).all() as CrmRow[]
        for (const r of rows) {
          known.set(r.contact_phone, { name: r.name, email: r.email, notes: r.notes, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at })
        }
      } catch {}
      // Contactos conocidos por tráfico de inbox (aunque no tengan ficha creada)
      try {
        const inboxRows = db.prepare(`SELECT contact_phone, MAX(created_at) as last_seen, COUNT(*) as msg_count FROM inbox_messages GROUP BY contact_phone`).all() as Array<{ contact_phone: string; last_seen: number; msg_count: number }>
        for (const r of inboxRows) {
          if (!known.has(r.contact_phone)) {
            known.set(r.contact_phone, { name: null, email: null, notes: null, source: 'inbox', createdAt: r.last_seen, updatedAt: r.last_seen })
          }
        }
      } catch {}
      // Último mensaje por contacto
      const lastMsg = new Map<string, { text: string; at: number; count: number }>()
      try {
        const msgs = db.prepare(`SELECT contact_phone, text, created_at FROM inbox_messages ORDER BY created_at ASC`).all() as Array<{ contact_phone: string; text: string; created_at: number }>
        for (const m of msgs) {
          lastMsg.set(m.contact_phone, { text: m.text, at: m.created_at, count: (lastMsg.get(m.contact_phone)?.count ?? 0) + 1 })
        }
      } catch {}
      // Tags
      const tagsByPhone = new Map<string, string[]>()
      try {
        const tagRows = db.prepare(`SELECT contact_phone, tag_name FROM contact_tags`).all() as Array<{ contact_phone: string; tag_name: string }>
        for (const t of tagRows) {
          const arr = tagsByPhone.get(t.contact_phone) ?? []
          arr.push(t.tag_name)
          tagsByPhone.set(t.contact_phone, arr)
        }
      } catch {}
      // Estado de lock (en flujo / handoff)
      const lockState = new Map<string, { currentState: string; lockedAt: number }>()
      try {
        const lockRows = db.prepare(`SELECT contact_phone, current_state, locked_at FROM conversation_locks WHERE expires_at > ?`).all(now) as Array<{ contact_phone: string; current_state: string; locked_at: number }>
        for (const l of lockRows) lockState.set(l.contact_phone, { currentState: l.current_state, lockedAt: l.locked_at })
      } catch {}
      // Opt-outs
      const suppressed = new Set<string>()
      try {
        const suppRows = db.prepare(`SELECT phone FROM suppression_list`).all() as Array<{ phone: string }>
        for (const s of suppRows) suppressed.add(s.phone)
      } catch {}

      const contacts = Array.from(known.entries()).map(([phone, k]) => {
        const lock = lockState.get(phone)
        return {
          contactPhone: phone,
          name: k.name,
          email: k.email,
          notes: k.notes,
          source: k.source,
          tags: tagsByPhone.get(phone) ?? [],
          currentState: lock?.currentState ?? 'IDLE',
          suppressed: suppressed.has(phone),
          lastMessageText: lastMsg.get(phone)?.text ?? null,
          lastMessageAt: lastMsg.get(phone)?.at ?? null,
          messageCount: lastMsg.get(phone)?.count ?? 0,
          createdAt: k.createdAt,
          updatedAt: k.updatedAt,
        }
      }).sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt))

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ contacts, count: contacts.length }))
      return
    }

    // POST /api/contacts — crea o actualiza la ficha de un contacto
    if (req.method === 'POST' && url.pathname === '/api/contacts') {
      try {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as {
          phone?: string; name?: string; email?: string; notes?: string; tags?: string[]
        }
        const phone = (body.phone ?? '').trim()
        if (!phone || !/^\+?\d{7,15}$/.test(phone.replace(/[\s-]/g, ''))) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Teléfono inválido. Formato esperado: +573001112233' }))
          return
        }
        const nowSec = Math.floor(Date.now() / 1000)
        const existing = db.prepare(`SELECT contact_phone FROM crm_contacts WHERE contact_phone = ?`).get(phone)
        if (existing) {
          db.prepare(`UPDATE crm_contacts SET name = COALESCE(?, name), email = COALESCE(?, email), notes = COALESCE(?, notes), updated_at = ? WHERE contact_phone = ?`)
            .run(body.name ?? null, body.email ?? null, body.notes ?? null, nowSec, phone)
        } else {
          db.prepare(`INSERT INTO crm_contacts (contact_phone, name, email, notes, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', ?, ?)`)
            .run(phone, body.name ?? null, body.email ?? null, body.notes ?? null, nowSec, nowSec)
        }
        // Tags opcionales
        if (Array.isArray(body.tags)) {
          for (const tag of body.tags.slice(0, 20)) {
            const clean = String(tag).trim()
            if (!clean) continue
            db.prepare(`INSERT OR IGNORE INTO contact_tags (contact_phone, tag_name, created_at) VALUES (?, ?, ?)`).run(phone, clean, nowSec)
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, phone, created: !existing }))
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // GET /api/suppressions — lista todos los opt-outs con paginación simple
    if (req.method === 'GET' && url.pathname === '/api/suppressions') {
      let limit = Number(url.searchParams.get('limit') || 100)
      if (!Number.isFinite(limit) || limit < 1) limit = 100
      if (limit > 1000) limit = 1000
      const offset = Number(url.searchParams.get('offset') || 0)

      const rows = db.prepare(
        'SELECT phone, reason, created_at FROM suppression_list ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(limit, offset) as Array<{ phone: string; reason: string; created_at: number }>

      const total = (db.prepare('SELECT COUNT(*) AS total FROM suppression_list').get() as { total: number }).total

      const suppressions = rows.map((r) => ({
        phone: r.phone,
        reason: r.reason,
        createdAt: r.created_at,
      }))

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ suppressions, total, offset, limit }))
      return
    }

    // GET /api/metrics — KPIs básicos para el dashboard
    if (req.method === 'GET' && url.pathname === '/api/metrics') {
      const now = Date.now()
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const todayMs = todayStart.getTime()

      const totalInbound = (
        db.prepare("SELECT COUNT(*) AS n FROM inbox_messages WHERE direction = 'inbound'").get() as { n: number }
      ).n
      const totalOutbound = (
        db.prepare("SELECT COUNT(*) AS n FROM inbox_messages WHERE direction = 'outbound'").get() as { n: number }
      ).n
      const todayInbound = (
        db.prepare("SELECT COUNT(*) AS n FROM inbox_messages WHERE direction = 'inbound' AND created_at >= ?").get(todayMs) as { n: number }
      ).n
      const todayOutbound = (
        db.prepare("SELECT COUNT(*) AS n FROM inbox_messages WHERE direction = 'outbound' AND created_at >= ?").get(todayMs) as { n: number }
      ).n
      const uniqueContacts = (
        db.prepare('SELECT COUNT(DISTINCT contact_phone) AS n FROM inbox_messages').get() as { n: number }
      ).n
      const handoffCount = (
        db.prepare("SELECT COUNT(*) AS n FROM conversation_locks WHERE current_state = 'HANDOFF_HUMAN'").get() as {
          n: number
        }
      ).n
      const activeFlowLocks = (
        db.prepare("SELECT COUNT(*) AS n FROM conversation_locks WHERE current_state = 'IN_FLOW_2A'").get() as {
          n: number
        }
      ).n
      const suppressionCount = (db.prepare('SELECT COUNT(*) AS n FROM suppression_list').get() as { n: number }).n
      const activeAgents = (
        db.prepare('SELECT COUNT(*) AS n FROM agents WHERE is_active = 1').get() as { n: number }
      ).n
      const openAssignments = (
        db.prepare("SELECT COUNT(*) AS n FROM agent_assignments WHERE status = 'OPEN'").get() as { n: number }
      ).n
      const pendingPayments = (
        db.prepare("SELECT COUNT(*) AS n FROM payment_transactions WHERE status = 'PENDING'").get() as { n: number }
      ).n
      const approvedPayments = (
        db.prepare("SELECT COUNT(*) AS n FROM payment_transactions WHERE status = 'APPROVED'").get() as { n: number }
      ).n
      const activeFlows = (db.prepare('SELECT COUNT(*) AS n FROM flows WHERE is_active = 1').get() as { n: number }).n
      const activeSequences = (
        db.prepare("SELECT COUNT(*) AS n FROM sequence_enrollments WHERE status = 'ACTIVE'").get() as { n: number }
      ).n
      const wsClients = wsServer.clientCount

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          serverTime: now,
          inbox: { totalInbound, totalOutbound, todayInbound, todayOutbound, uniqueContacts },
          locks: { handoff: handoffCount, activeFlow: activeFlowLocks },
          suppression: { total: suppressionCount },
          team: { activeAgents, openAssignments },
          payments: { pending: pendingPayments, approved: approvedPayments },
          flows: { active: activeFlows },
          sequences: { active: activeSequences },
          realtime: { wsClients },
        })
      )
      return
    }

    // GET /api/realtime/stats — estado del WebSocket server
    if (req.method === 'GET' && url.pathname === '/api/realtime/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ clients: wsServer.clientCount, messagesSent: wsServer.totalMessagesSent }))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Ruta no encontrada' }))
  })

  // ============================================================
  // WEBSOCKET UPGRADE HANDLER
  // Intercepts HTTP→WS upgrades on path /ws and accepts them.
  // ============================================================
  server.on('upgrade', (req: IncomingMessage, socket: import('node:net').Socket, head: Buffer) => {
    const accepted = wsServer.handleUpgrade(req, socket, head)
    if (!accepted) {
      // Si no era para /ws, dejamos que Caddy/demás capas lo manejen.
      // Si no hay otras capas, cerramos la conexión limpiamente.
      try {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
      } catch {}
    }
  })

  // ============================================================
  // DRIP SEQUENCE SCHEDULER
  // ------------------------------------------------------------
  // Procesa sequence_enrollments con next_run_at <= ahora:
  //   1. Lee el step actual de sequence_steps
  //   2. Envía el mensaje vía transport (best-effort, fire-and-forget)
  //   3. Avanza current_step +1 y recalcula next_run_at con delay_minutes del siguiente step
  //   4. Si no hay siguiente step, marca el enrollment como COMPLETED
  // Se ejecuta cada 60s; unref() para no bloquear el exit del proceso.
  // ============================================================
  const sequenceScheduler = setInterval(() => {
    try {
      const now = Date.now()
      const due = db.prepare(`
        SELECT id, sequence_id, contact_phone, current_step
        FROM sequence_enrollments
        WHERE status = 'ACTIVE' AND next_run_at <= ?
      `).all(now) as Array<{
        id: string
        sequence_id: string
        contact_phone: string
        current_step: number
      }>

      for (const en of due) {
        const step = db.prepare(`
          SELECT step_order, delay_minutes, message_text
          FROM sequence_steps
          WHERE sequence_id = ? AND step_order = ?
        `).get(en.sequence_id, en.current_step) as
          | { step_order: number; delay_minutes: number; message_text: string }
          | undefined

        if (!step) {
          db.prepare("UPDATE sequence_enrollments SET status = 'COMPLETED' WHERE id = ?").run(en.id)
          continue
        }

        // Fire-and-forget: el transport maneja sus propios errores
        transport
          .sendMessage(en.contact_phone, step.message_text, `seq_${en.id}_${en.current_step}`)
          .catch((e: any) => console.warn(`[Sequence Scheduler] Falla enviando a ${en.contact_phone}:`, e?.message || e))

        const nextStep = db.prepare(`
          SELECT step_order, delay_minutes
          FROM sequence_steps
          WHERE sequence_id = ? AND step_order = ?
        `).get(en.sequence_id, en.current_step + 1) as
          | { step_order: number; delay_minutes: number }
          | undefined

        if (nextStep) {
          const nextRunAt = now + (nextStep.delay_minutes || 0) * 60 * 1000
          db.prepare(`
            UPDATE sequence_enrollments SET current_step = ?, next_run_at = ? WHERE id = ?
          `).run(en.current_step + 1, nextRunAt, en.id)
        } else {
          db.prepare(`
            UPDATE sequence_enrollments SET current_step = ?, status = 'COMPLETED' WHERE id = ?
          `).run(en.current_step + 1, en.id)
        }
      }
    } catch (e: any) {
      console.error('[Sequence Scheduler] Error inesperado:', e?.message || e)
    }
  }, 60_000)

  // No bloquear la salida del proceso si el scheduler está pendiente
  sequenceScheduler.unref?.()

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
    sequenceScheduler,
    wsServer,
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
