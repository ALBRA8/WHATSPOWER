import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { createHmac } from 'node:crypto'
import { createDatabase, purgeExpiredSecurityRows, durableRateLimit } from './db.ts'
import { ConversationRouter } from './engine/router.ts'
import { startScheduler } from './engine/scheduler.ts'
import { MockTransportSender, HttpAlbraTransportSender } from './adapters/transport.ts'
import { MetaCloudOrgTransport } from './adapters/meta-cloud-org-transport.ts'
import { MockCrmClient, HttpCrmClient } from './adapters/crm-client.ts'
import { renderStudioHtml } from './studio/studio-html.ts'
import { renderDashboardHtml, dashboardAsset } from './dashboard/dashboard-html.ts'
import { handleDashboardApi } from './dashboard/dashboard-api.ts'
import { TeamManager } from './state/team-manager.ts'
import { CannedResponseManager } from './engine/canned-responses.ts'
import { GrowthToolsManager } from './engine/growth-tools.ts'
import { CrmTriggerListener } from './engine/crm-triggers.ts'
import { PaymentGatewayManager } from './payments/payment-gateway.ts'
import type { InboundEvent, TransportSender, CrmClientInterface } from './types.ts'
import {
  isAuthorizedBearer,
  safeEqual,
  checkWebhookSecurity,
  verifyWebhookWithOrg,
  parseWebhookSecrets,
  resolveAdminIdentity,
  orgHeaderAllowed,
  readBody,
  DurableReplayCache,
  RateLimiter,
  PersistentReplayStore,
  SlidingRateLimiter,
  clientIp,
  maskPhone,
  issueStudioSession,
  resolveStudioSession,
  productionConfigProblems,
  type InternalIdentity,
} from './security.ts'
import {
  verifyOrgServiceCredential,
  extractOrgServiceAuth,
  provisionOrgServiceCredentialsFromEnv,
  idempotencyKeyBelongsToOrg,
} from './org-auth.ts'
import { ReconcileForbiddenOrgError } from './engine/router.ts'

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
    if (mode === 'meta-cloud') {
      // OLEADA 2 (decisión 2026-11-11 #6): envíos DIRECTOS a Meta Cloud con las
      // credenciales de CADA organización (resueltas por OrgWaRegistry). Cada
      // org necesita SU credencial de servicio (WA_ORG_CREDENTIALS o CRM) y SUS
      // números (WA_ORG_NUMBERS o inventario del CRM). Sin credencial para una
      // org → esa org NO envía (fail-closed); las demás organizaciones siguen
      // operativas (punto 9).
      if (process.env.ALLOW_REAL_DISPATCH !== 'true') {
        console.warn('[Capa 2A AVISO] TRANSPORT=meta-cloud con ALLOW_REAL_DISPATCH=false: los envíos quedarán BLOQUEADOS por la salvaguarda.')
      }
      if (!process.env.WA_ORG_CREDENTIALS && !process.env.CRM_INTERNAL_CREDENTIAL) {
        throw new Error('TRANSPORT=meta-cloud exige credenciales por organización: WA_ORG_CREDENTIALS (standalone) o CRM_INTERNAL_CREDENTIAL (vía CRM). Sin ellas ninguna org puede enviar (fail-closed).')
      }
      return new MetaCloudOrgTransport()
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
  // WEBHOOK_SECRETS="orgId:secreto,..." (integral): el secreto del HMAC VINCULA la org —
  // el HMAC del webhook jamás sustituye a una credencial de servicio por organización.
  const perOrgWebhookSecrets = parseWebhookSecrets(process.env.WEBHOOK_SECRETS)
  const legacyWebhookSecret = webhookSecret
    || process.env.AGENTIC_2A_WEBHOOK_SECRET
    || process.env.WEBHOOK_SECRET

  const router = new ConversationRouter(db, transport, crm)
  // B3: provisión de credenciales de servicio por organización (env ORG_SERVICE_CREDENTIALS
  // formato "orgId:credencial,orgId2:credencial2"). Solo se persisten hashes; nunca se loguean.
  const provisionedCreds = provisionOrgServiceCredentialsFromEnv(db)
  if (provisionedCreds > 0) console.log(`[Seguridad 2A] Credenciales de servicio registradas para ${provisionedCreds} organización(es) (hashes only)`)

  /**
   * B3 — GUARD DE IDENTIDAD DE SERVICIO POR ORGANIZACIÓN (fail-closed).
   * Exige X-Org-Id + Bearer <credencial de ESA organización> y valida la
   * credencial CONTRA ESA organización en service_credentials. El secreto
   * global (INTERNAL_API_SECRET) NO autoriza estas rutas (fallback eliminado):
   * una credencial válida de otra organización, ausente o sin registrar →
   * 401/403. Devuelve null si la petición es válida; si no, ya respondió.
   */
  const requireOrgServiceAuth = (
    req: IncomingMessage,
    res: ServerResponse,
    opts?: { adminOnly?: boolean }
  ): { orgId: string } | null => {
    const auth = extractOrgServiceAuth(req.headers as Record<string, string | string[] | undefined>)
    const serviceCredOk = auth ? verifyOrgServiceCredential(db, auth.orgId, auth.credential) : false
    if (auth && !serviceCredOk) {
      // (fusión) la credencial presentada no está registrada para esa org: antes de
      // rechazar, se permite que sea una credencial de servicio de INTERNAL_API_KEYS
      // (route alternativo del contrato fusionado). El secreto global JAMÁS autoriza aquí.
      const fallback = resolveAdminIdentity(req.headers['authorization'])
      if (!(fallback.ok && fallback.identity)) {
        console.warn(`[Seguridad 2A ALERTA] Credencial de servicio inválida o no vinculada a la org declarada (org: ${auth.orgId}, IP: ${req.socket.remoteAddress})`)
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Forbidden: credencial de servicio no válida para la organización declarada' }))
        return null
      }
    }
    if (auth && serviceCredOk) return { orgId: auth.orgId }
    // Credencial de servicio POR ORGANIZACIÓN de INTERNAL_API_KEYS ("orgId:secreto[:rol]").
    // La org SIEMPRE viene de la credencial; X-Org-Id solo puede RESTRINGIR.
    const keyResolution = auth && serviceCredOk
      ? ({ ok: false, status: 401 } as const)
      : resolveAdminIdentity(req.headers['authorization'])
    if (keyResolution.ok && keyResolution.identity) {
      const keyIdentity = keyResolution.identity
      const xOrgRaw = req.headers['x-org-id']
      const xOrg = Array.isArray(xOrgRaw) ? String(xOrgRaw[0]) : (xOrgRaw ? String(xOrgRaw) : undefined)
      if (keyIdentity.orgId === '__legacy__') {
        // §4: credencial de INTERNAL_API_KEYS ligada a __legacy__ → jamás opera.
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Forbidden: organización reservada' }))
        return null
      }
      if (xOrg && xOrg !== keyIdentity.orgId) {
        console.warn(`[Seguridad 2A ALERTA] X-Org-Id ajeno a la credencial de servicio: ${req.method} ${req.url} (org credencial: ${keyIdentity.orgId}, IP: ${req.socket.remoteAddress})`)
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Forbidden: la organización solicitada no corresponde a la credencial' }))
        return null
      }
      if (opts?.adminOnly && keyIdentity.role !== 'admin') {
        console.warn(`[Seguridad 2A ALERTA] Operación destructiva con rol insuficiente: ${req.method} ${req.url} (rol: ${keyIdentity.role}, IP: ${req.socket.remoteAddress})`)
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Forbidden: esta operación exige rol admin' }))
        return null
      }
      return { orgId: keyIdentity.orgId }
    }
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized: identidad de servicio requerida (X-Org-Id + credencial de la organización, o credencial INTERNAL_API_KEYS)' }))
    return null
  }
  const teamManager = new TeamManager(db)
  const cannedManager = new CannedResponseManager(db)
  const growthManager = new GrowthToolsManager(db, options?.businessPhone || '573001234567')
  // (OLEADA 2) El ejecutor de automatizaciones despacha con el transporte POR
  // ORGANIZACIÓN (credenciales Meta de cada org, decisión 2026-11-11 #6).
  const crmTriggers = new CrmTriggerListener(db, router.getFlowEngine(), transport)
  const paymentManager = new PaymentGatewayManager(db)

  function verifyHmac(payload: string, signatureHeader?: string): boolean {
    if (!webhookSecret || !signatureHeader) return false
    const expected = createHmac('sha256', webhookSecret).update(payload).digest('hex')
    // (A2-10, auditoría 2026-11-11) Comparación EN TIEMPO CONSTANTE: `===` corta
    // en la primera divergencia y filtra por longitud — oráculo de tiempo.
    return safeEqual(expected, signatureHeader)
  }
  void verifyHmac // conservado por compatibilidad de firma pública; la validación dura usa checkWebhookSecurity

  // Anti-replay DURABLE (reparación integral 2026-11-06): sobrevive reinicios;
  // en tests con dbPath ':memory:' se usa ':memory:' para no compartir estado.
  const replayPath = options?.replayDbPath ?? (options?.dbPath === ':memory:' ? ':memory:' : undefined)
  const inboundReplay = new DurableReplayCache(replayPath)
  const paymentsReplay = new DurableReplayCache(replayPath)

  // (ronda 17, paso 2) Contadores de realtime para /api/realtime/stats.
  // El dashboard usa SSE (/api/wp-stream en el proxy Next.js) para push; si el
  // WebSocket directo no está activo estos quedan en 0 (respuesta honesta).
  // Si se cablea MiniWebSocketServer más adelante, los incrementa aquí.
  const wsClientCountRef = { count: 0 }
  const wsMessagesSentRef = { count: 0 }

  // Rate limiting de endpoints públicos (tercera reparación 4.F)
  // (reauditoría ciclo 2) inbound/payments usan durableRateLimit (BD): los
  // limiter en memoria equivalentes eran código muerto con límites duplicados.
  const refRate = new RateLimiter(300, 60_000)
  const studioLoginRate = new RateLimiter(10, 60_000)
  const qrRate = new RateLimiter(30, 60_000) // (integral §7): /qr/data 30/min por IP
  // (integral) Rate limiting deslizante para la puerta /api/* + purga periódica
  const rateLimiter = new SlidingRateLimiter()
  purgeExpiredSecurityRows(db)
  const purgeTimer = setInterval(() => {
    purgeExpiredSecurityRows(db)
  }, 60 * 60 * 1000)
  purgeTimer.unref?.()

  /** Extrae la IP del cliente (sin confiar ciegamente en X-Forwarded-For: se usa solo
   *  como clave de rate-limit, jamás como decisión de autorización). */
  function clientKey(req: IncomingMessage): string {
    const fwd = req.headers['x-forwarded-for']
    return (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown'
  }
  /** Org obligatoria desde el header X-Org-Id (nunca del body — no se infiere de datos no confiables). */
  function requireOrgHeader(req: IncomingMessage): string | null {
    const orgId = String(req.headers['x-org-id'] || '').trim()
    if (!orgId || !/^[a-zA-Z0-9_-]{1,64}$/.test(orgId)) return null
    // §4: '__legacy__' es espacio histórico RESERVADO — ninguna petición puede operarlo.
    if (orgId === '__legacy__') return null
    return orgId
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
    // replay propio), /api/payments/webhook (protegida por HMAC de la pasarela) y
    // las rutas de SERVICIO por organización /api/internal/locks|suppression e
    // /api/internal/idempotency/{uncertain,reconcile} — B3/B2: esas ya NO
    // aceptan el secreto global; exigen credencial de servicio VINCULADA a la
    // organización (verificación por endpoint, fail-closed).
    // Fail-closed: sin secret configurado responde 503, nunca acepta.
    // ==========================================================
    const isOrgScopedServicePath =
      url.pathname.startsWith('/api/internal/locks/') || url.pathname.startsWith('/api/internal/suppression/')
      // B2 hardening: la reconciliación de idempotencia expone claves, teléfonos
      // y evidencias → exige identidad de servicio POR ORGANIZACIÓN (el secreto
      // global compartido ya no autoriza lectura ni escritura aquí).
      || url.pathname === '/api/internal/idempotency/uncertain'
      || url.pathname === '/api/internal/idempotency/reconcile'
    const isPublicApiPath = url.pathname === '/api/health'
      || url.pathname === '/api/inbound'
      || url.pathname === '/api/payments/webhook'
      || isOrgScopedServicePath

    let identity: InternalIdentity | undefined
    if (url.pathname.startsWith('/api/') && !isPublicApiPath) {
      // FUSIÓN de la puerta (contrato v1.1.0 + cierre 2026-11-06). Se acepta UNA identidad:
      //  (a) OPERADOR CENTRAL: Bearer INTERNAL_API_SECRET o cookie de Studio (HttpOnly).
      //      Sin org enlazada; las rutas por-org exigen selección explícita (X-Org-Id).
      //  (b) Credencial de servicio POR ORGANIZACIÓN: INTERNAL_API_KEYS="orgId:secreto[:rol]"
      //      → la org SIEMPRE viene de la credencial; X-Org-Id solo puede restringir.
      // Fail-closed: sin NINGUNA credencial configurada → 503. Bearer inválido → 401.
      const internalSecret = process.env.INTERNAL_API_SECRET
      const keysConfigured = Boolean(process.env.INTERNAL_API_KEYS)
      if (!internalSecret && !keysConfigured) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Service Unavailable: sin credenciales administrativas configuradas (fail-closed)' }))
        return
      }
      const bearerOk = internalSecret ? isAuthorizedBearer(req.headers['authorization'], internalSecret) : false
      const sessionOk = internalSecret ? resolveStudioSession(req.headers.cookie as string | undefined, internalSecret) : false
      if (bearerOk || sessionOk) {
        identity = undefined // OPERADOR CENTRAL: sin org enlazada
      } else {
        const resolution = resolveAdminIdentity(req.headers['authorization'])
        if (resolution.ok) {
          identity = resolution.identity
          if (!orgHeaderAllowed(req.headers['x-org-id'], identity!)) {
            console.warn(`[Seguridad 2A ALERTA] X-Org-Id ajeno a la credencial: ${req.method} ${url.pathname} (org: ${identity!.orgId}, IP: ${clientIp(req)})`)
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Forbidden: la organización solicitada no corresponde a la credencial' }))
            return
          }
        } else {
          console.warn(`[Seguridad 2A ALERTA] Acceso administrativo no autorizado: ${req.method} ${url.pathname} (IP: ${req.socket.remoteAddress})`)
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid internal secret' }))
          return
        }
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
      // (fusión) Rate limit 30/min por IP (integral §7) — antes de cualquier otra comprobación.
      if (!qrRate.allow(`qrdata:${clientKey(req)}`)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
        res.end(JSON.stringify({ error: 'Demasiadas peticiones: límite 30/min por IP' }))
        return
      }
      const internalSecret = process.env.INTERNAL_API_SECRET
      // La puerta de QR acepta: Bearer INTERNAL_API_SECRET, cookie de Studio (4.F),
      // o credencial INTERNAL_API_KEYS con rol admin (rol agent → 403: no vincula dispositivos).
      const bearerOk = internalSecret ? isAuthorizedBearer(req.headers['authorization'], internalSecret) : false
      const sessionOk = internalSecret ? resolveStudioSession(req.headers.cookie as string | undefined, internalSecret) : false
      if (!bearerOk && !sessionOk) {
        const qrResolution = resolveAdminIdentity(req.headers['authorization'])
        if (qrResolution.ok && qrResolution.identity && qrResolution.identity.role === 'admin') {
          // admin de organización: autorizado para vincular el dispositivo de SU org
        } else if (qrResolution.ok) {
          console.warn(`[Seguridad 2A ALERTA] Rol insuficiente para QR: ${req.method} ${url.pathname} (rol: ${qrResolution.identity?.role}, IP: ${req.socket.remoteAddress})`)
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Forbidden: solo el rol admin vincula dispositivos WhatsApp' }))
          return
        } else if (!internalSecret && !process.env.INTERNAL_API_KEYS) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Service Unavailable: sin credenciales administrativas configuradas (fail-closed)' }))
          return
        } else {
          console.warn(`[Seguridad 2A ALERTA] Acceso a QR sin autenticación: ${req.method} ${url.pathname} (IP: ${req.socket.remoteAddress})`)
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized: el QR exige autenticación administrativa (Bearer)' }))
          return
        }
      }
    }

    // WhatsPower Flow Studio (Lienzo visual ManyChat)
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/studio')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderStudioHtml())
      return
    }

    // Panel de control operativo (dashboard tipo ManyChat): la SPA y sus recursos
    // son inertes; todos los datos viajan por /api/dashboard/*, que exige la misma
    // identidad administrativa que el resto de la API.
    if (req.method === 'GET' && url.pathname.startsWith('/dashboard/assets/')) {
      const asset = dashboardAsset(url.pathname.slice('/dashboard/assets/'.length))
      if (!asset) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Recurso no encontrado' }))
        return
      }
      res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' })
      res.end(asset.body)
      return
    }

    if (req.method === 'GET' && url.pathname.startsWith('/dashboard')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(renderDashboardHtml())
      return
    }

    // API del panel de control: se resuelve DESPUÉS de la puerta de identidad,
    // así el orgId que llega al manejador ya pasó la comprobación de credencial.
    if (url.pathname.startsWith('/api/dashboard')) {
      const dashOrg = requireOrgHeader(req)
      if (!dashOrg) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      // Quién está detrás: la puerta ya validó la credencial. Un operador central
      // (sin identidad de organización) manda como administración; una credencial
      // de organización trae su rol, y el panel lo respeta.
      const dashActor: { label: string; role: 'admin' | 'agent' } = identity
        ? { label: `cred:${identity.orgId}`, role: identity.role }
        : { label: 'operator', role: 'admin' }
      const handled = await handleDashboardApi({
        req,
        res,
        url,
        orgId: dashOrg,
        actor: dashActor,
        db,
        engine: router.getFlowEngine(),
        locks: router.getLockManager(),
        team: teamManager,
        canned: cannedManager,
        growth: growthManager,
        suppression: router.getSuppressionStore(),
        transport,
      })
      if (handled) return
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
        // (A4-14) Detalle del error SOLO al log del servidor; al llamador un
        // mensaje genérico (no filtramos internals de BD/crypto por el 400).
        console.error(`[wp] 400 en ${url.pathname}:`, e?.message)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        console.warn('[API] 400 sin detalles al cliente:', e instanceof Error ? e.message : e)
        res.end(JSON.stringify({ error: 'Petición inválida' }))
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
        // (A4-14) Detalle del error SOLO al log del servidor; al llamador un
        // mensaje genérico (no filtramos internals de BD/crypto por el 400).
        console.error(`[wp] 400 en ${url.pathname}:`, e?.message)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        console.warn('[API] 400 sin detalles al cliente:', e instanceof Error ? e.message : e)
        res.end(JSON.stringify({ error: 'Petición inválida' }))
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
        console.warn('[API] 500 sin detalles al cliente:', e instanceof Error ? e.message : e)
        res.end(JSON.stringify({ error: 'Error interno' }))
      }
      return
    }

    // 1. Healthcheck y Métricas Operativas
    if (req.method === 'GET' && url.pathname === '/api/health') {
      try {
        db.prepare('SELECT 1').get()
        const lockCount = (db.prepare('SELECT COUNT(*) as c FROM conversation_locks WHERE expires_at > ?').get(Date.now()) as any)?.c ?? 0
        const suppCount = (db.prepare('SELECT COUNT(*) as c FROM suppression_list').get() as any)?.c ?? 0
        const consentCount = (db.prepare("SELECT COUNT(*) as c FROM consent_records WHERE status = 'ACTIVE'").get() as any)?.c ?? 0
        const mem = process.memoryUsage()

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          status: 'ok',
          service: 'albra-agentic-2a',
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
          database: { connected: true, driver: 'node:sqlite' },
          metrics: {
            activeLocks: lockCount,
            suppressedContacts: suppCount,
            activeConsents: consentCount,
          },
          memory: {
            rssMb: Math.round(mem.rss / 1024 / 1024),
            heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
          }
        }))
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'error', error: err.message }))
      }
      return
    }

    // 2. Consulta de Locks para Capa 2B (GET /api/internal/locks/:phone)
    if (req.method === 'GET' && url.pathname.startsWith('/api/internal/locks/')) {
      const phone = decodeURIComponent(url.pathname.replace('/api/internal/locks/', ''))
      // B3: identidad de servicio POR ORGANIZACIÓN (el secreto global no autoriza aquí).
      const orgAuth = requireOrgServiceAuth(req, res)
      if (!orgAuth) return
      const orgId = orgAuth.orgId
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
      // B3: identidad de servicio POR ORGANIZACIÓN (el secreto global no autoriza aquí).
      const orgAuthSupp = requireOrgServiceAuth(req, res)
      if (!orgAuthSupp) return
      const orgId = orgAuthSupp.orgId
      const suppressed = router.getSuppressionStore().isSuppressed(orgId, phone)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // (contrato v2) Eco de organización para verificación del cliente (5.A)
      res.end(JSON.stringify({ phone, suppressed, organizationId: orgId }))
      return
    }

    // 3.2 Registro Administrativo de Supresión (POST /api/internal/suppression/:phone)
    if (req.method === 'POST' && url.pathname.startsWith('/api/internal/suppression/')) {
      // B3: identidad de servicio POR ORGANIZACIÓN (fail-closed; el secreto
      // global ya no autoriza escrituras de servicio de una org concreta).
      const orgAuthPost = requireOrgServiceAuth(req, res)
      if (!orgAuthPost) return

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

      const orgId = orgAuthPost.orgId
      router.getSuppressionStore().addSuppression(orgId, phone, reason)
      console.log(`[Seguridad 2A AUDIT] Registro de supresión para: ${phone.slice(0, 4)}***${phone.slice(-2)} (org: ${orgId}, Motivo: "${reason}", IP: ${req.socket.remoteAddress}, Time: ${new Date().toISOString()})`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ phone, suppressed: true, reason, organizationId: orgId }))
      return
    }

    // 3.3 Eliminación Administrativa de Supresión (DELETE /api/internal/suppression/:phone)
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/internal/suppression/')) {
      // B3: identidad de servicio POR ORGANIZACIÓN (fail-closed)
      const orgAuthDel = requireOrgServiceAuth(req, res, { adminOnly: true })
      if (!orgAuthDel) return

      const rawPhone = decodeURIComponent(url.pathname.replace('/api/internal/suppression/', ''))
      const digits = rawPhone.replace(/\D/g, '')
      const phone = (digits.length === 10 && digits.startsWith('3')) ? `57${digits}` : digits
      if (!phone || phone.length < 10) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Bad Request: Teléfono inválido o ambiguo' }))
        return
      }

      const orgId = orgAuthDel.orgId
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
      // B3: identidad de servicio POR ORGANIZACIÓN (el secreto global no autoriza aquí).
      const orgAuthRel = requireOrgServiceAuth(req, res, { adminOnly: true })
      if (!orgAuthRel) return
      const orgId = orgAuthRel.orgId
      router.getLockManager().releaseLock(phone, orgId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ phone, released: true }))
      return
    }

    // 4.ter Cumplimiento y Protección de Datos Personales (Ley 1581 de 2012 / Habeas Data)
    if (req.method === 'GET' && url.pathname === '/api/compliance/contact-data') {
      const phone = url.searchParams.get('phone')
      if (!phone) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'PHONE_REQUIRED' }))
        return
      }
      const orgId = identity?.orgId ?? url.searchParams.get('org') ?? 'default'
      const data = router.getConsentStore().exportContactData(orgId, phone)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
      return
    }

    if (req.method === 'DELETE' && url.pathname === '/api/compliance/contact-data') {
      const phone = url.searchParams.get('phone')
      if (!phone) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'PHONE_REQUIRED' }))
        return
      }
      const orgId = identity?.orgId ?? url.searchParams.get('org') ?? 'default'
      const result = router.getConsentStore().deleteContactData(orgId, phone, identity?.orgId || 'admin')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/compliance/consent') {
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const body = JSON.parse(rb.body)
        const orgId = identity?.orgId ?? body.organizationId ?? 'default'
        const rec = router.getConsentStore().recordConsent({
          organizationId: orgId,
          contactPhone: body.contactPhone,
          whoAuthorized: body.whoAuthorized,
          channel: body.channel,
          textShown: body.textShown,
          source: body.source,
          authorizedAt: body.authorizedAt,
        })
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, consent: rec }))
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/compliance/opt-out') {
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const body = JSON.parse(rb.body)
        const orgId = identity?.orgId ?? body.organizationId ?? 'default'
        router.getSuppressionStore().addSuppression(orgId, body.contactPhone, body.reason || 'opt_out')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, suppressed: true, consentRevoked: true }))
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // 4.bis Reconciliación de eventos UNCERTAIN (tercera reparación 4.C + B2 fase final):
    // POST /api/internal/idempotency/reconcile — body {key} | {all: true} | {key, confirmResend: true, evidence}.
    // B2 HARDENING (autorización y aislamiento por organización):
    //  - Exige identidad de servicio VINCULADA (X-Org-Id + Bearer de SU
    //    credencial); el secreto global NO autoriza (401/403).
    //  - Una clave de OTRA organización → 403, sin tomar posesión ni revelar
    //    estado (verificado también dentro del router, defensa en profundidad).
    //  - `all: true` sólo procesa los eventos UNCERTAIN de LA organización
    //    autenticada (nunca eventos globales).
    //  - `confirmResend: true` JAMÁS en lote: sólo una clave concreta propia, y
    //    sólo con `evidence` (verificación externa documentada de no llegada);
    //    queda auditado. Ningún reenvío automático ni masivo.
    // JAMÁS es un reintento ciego: re-ejecuta el ciclo reutilizando el journal
    // (efectos DONE se saltan; ningún mensaje ya enviado se reenvía) y el
    // registro durable de envíos bloquea todo re-despacho de claves
    // IN_FLIGHT/SENT/UNCERTAIN. Sólo `confirmResend: true` — afirmación
    // EXPLÍCITA del operador con evidencia externa de no llegada — autoriza UN
    // reenvío por envío incierto (la entrega sigue siendo at-least-once).
    if (req.method === 'POST' && url.pathname === '/api/internal/idempotency/reconcile') {
      const orgAuthRec = requireOrgServiceAuth(req, res)
      if (!orgAuthRec) return
      const orgId = orgAuthRec.orgId
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const body = JSON.parse(rb.body || '{}') as { key?: string; all?: boolean; confirmResend?: boolean; evidence?: string }
        const confirmResend = body.confirmResend === true
        // Control adicional 1: el reenvío confirmado JAMÁS es masivo.
        if (confirmResend && body.all === true) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'confirmResend sólo se autoriza para UNA clave concreta ({key}); prohibido el reenvío masivo' }))
          return
        }
        if (body.key && typeof body.key === 'string') {
          // Control adicional 2 (aislamiento): la clave DEBE ser de la
          // organización autenticada. Clave ajena → 403 sin tocar estado.
          if (!idempotencyKeyBelongsToOrg(body.key, orgId)) {
            console.warn(`[Seguridad 2A ALERTA] Reconciliación de clave AJENA bloqueada (org: ${orgId}, IP: ${req.socket.remoteAddress})`)
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Forbidden: la clave no pertenece a la organización autenticada' }))
            return
          }
          let opts: { confirmResend: boolean; requestingOrgId: string }
          if (confirmResend) {
            // Control adicional 3: autorización explícita CON evidencia
            // documentada de no llegada (verificación externa del operador).
            const evidence = typeof body.evidence === 'string' ? body.evidence.trim() : ''
            if (evidence.length < 16) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'confirmResend exige "evidence": verificación externa documentada de no llegada (mínimo 16 caracteres)' }))
              return
            }
            console.log(`[Seguridad 2A AUDIT] Reenvío autorizado EXPLÍCITAMENTE por operador (org: ${orgId}, key: ${body.key}, IP: ${req.socket.remoteAddress}, evidencia: "${evidence}")`)
            opts = { confirmResend: true, requestingOrgId: orgId }
          } else {
            opts = { confirmResend: false, requestingOrgId: orgId }
          }
          const report = await router.reconcileEvent(body.key, opts)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, organizationId: orgId, key: body.key, result: report }))
          return
        }
        if (body.all === true) {
          // B2 hardening: SÓLO los eventos UNCERTAIN de la organización
          // autenticada (jamás eventos globales ni de otras organizaciones).
          const pending = router.listUncertainEvents(25, orgId)
          const outcomes: Array<{ key: string; ok: boolean; requiresManualResolution?: boolean; error?: string }> = []
          for (const ev of pending) {
            try {
              const report = await router.reconcileEvent(ev.key, { requestingOrgId: orgId })
              outcomes.push({ key: ev.key, ok: Boolean(report?.resolved), requiresManualResolution: report?.requiresManualResolution })
            } catch (e: any) {
              outcomes.push({ key: ev.key, ok: false, error: String(e?.message || e) })
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, organizationId: orgId, reconciled: outcomes.filter((o) => o.ok).length, outcomes }))
          return
        }
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Body requerido: {key} o {all:true} (lista previa vía GET .../uncertain); confirmResend:true sólo con evidencia externa de no llegada' }))
      } catch (e: any) {
        if (e instanceof ReconcileForbiddenOrgError) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Forbidden: la clave no pertenece a la organización autenticada' }))
          return
        }
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
      }
      return
    }

    // 4.ter Listado de eventos UNCERTAIN pendientes (GET /api/internal/idempotency/uncertain)
    // B2: incluye la EVIDENCIA durable de los envíos (registro daemon_send_idempotency)
    // para que la resolución sea documentada, no a ciegas.
    // B2 HARDENING: exige identidad de servicio POR ORGANIZACIÓN y devuelve
    // EXCLUSIVAMENTE los eventos UNCERTAIN de la organización autenticada —
    // claves, estados, teléfonos y evidencias de otras organizaciones jamás
    // salen por esta ruta.
    if (req.method === 'GET' && url.pathname === '/api/internal/idempotency/uncertain') {
      const orgAuthUnc = requireOrgServiceAuth(req, res)
      if (!orgAuthUnc) return
      const orgId = orgAuthUnc.orgId
      const uncertain = router.listUncertainEvents(100, orgId).map((u) => ({
        ...u,
        evidence: router.describeUncertainEvent(u.key),
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ organizationId: orgId, uncertain }))
      return
    }

    // 5. Inbound Webhook (POST /api/inbound)
    // Endurecido (orden de cierre): firma HMAC OBLIGATORIA siempre + timestamp OBLIGATORIO
    // en ventana ±5min + caché anti-replay + comparación timing-safe. Sin excepción en dev:
    // el puente del CRM ya firma (X-Signature-SHA256 + X-Timestamp).
    if (req.method === 'POST' && url.pathname === '/api/inbound') {
      // Rate limiting DURABLE (A2-11, auditoría 2026-11-11): contador en BD —
      // sobrevive reinicios y coordina procesos que compartan la BD (el limiter
      // en memoria se resetea con cada deploy y no ve a los demás procesos).
      const inboundRL = durableRateLimit(db, `inbound:${clientKey(req)}`, 120)
      if (!inboundRL.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(inboundRL.retryAfterSec) })
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

        // (fusión) verificación con secretos POR ORGANIZACIÓN: el secreto que valida
        // el HMAC VINCULA la org (prevalece sobre el body); en modo de transición el
        // orgId viene del payload autenticado. Jamás se acepta un orgId libre.
        let payloadOrgId: string | undefined
        try { payloadOrgId = JSON.parse(rb.body)?.orgId } catch {}
        const sec = verifyWebhookWithOrg(rb.body, signature, timestampHeader, payloadOrgId, {
          perOrgSecrets: perOrgWebhookSecrets,
          legacySecret: legacyWebhookSecret,
          replay: inboundReplay,
        })
        if (!sec.ok) {
          res.writeHead(sec.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: sec.error }))
          return
        }

        const event = JSON.parse(rb.body) as InboundEvent
        if (sec.boundOrgId) event.orgId = sec.boundOrgId // identidad desde el SECRETO, no del body
        // (fusión) contrato §3: si el body no trae eventId, se acepta el de la
        // cabecera X-Event-Id (deduplicación por (orgId, eventId) igualmente).
        if (!event.eventId) {
          const hdr = req.headers['x-event-id']
          const hdrVal = Array.isArray(hdr) ? hdr[0] : hdr
          if (hdrVal && typeof hdrVal === 'string' && hdrVal.trim()) event.eventId = hdrVal.trim()
        }
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
        console.warn('[API] 500 sin detalles al cliente:', err instanceof Error ? err.message : err)
        res.end(JSON.stringify({ error: 'Error interno' }))
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
        // (A4-14) Detalle del error SOLO al log del servidor; al llamador un
        // mensaje genérico (no filtramos internals de BD/crypto por el 400).
        console.error(`[wp] 400 en ${url.pathname}:`, e?.message)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        console.warn('[API] 400 sin detalles al cliente:', e instanceof Error ? e.message : e)
        res.end(JSON.stringify({ error: 'Petición inválida' }))
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
        // (A4-14) Detalle del error SOLO al log del servidor; al llamador un
        // mensaje genérico (no filtramos internals de BD/crypto por el 400).
        console.error(`[wp] 400 en ${url.pathname}:`, e?.message)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        console.warn('[API] 400 sin detalles al cliente:', e instanceof Error ? e.message : e)
        res.end(JSON.stringify({ error: 'Petición inválida' }))
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
        // (A4-14) Detalle del error SOLO al log del servidor; al llamador un
        // mensaje genérico (no filtramos internals de BD/crypto por el 400).
        console.error(`[wp] 400 en ${url.pathname}:`, e?.message)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        console.warn('[API] 400 sin detalles al cliente:', e instanceof Error ? e.message : e)
        res.end(JSON.stringify({ error: 'Petición inválida' }))
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
        // (A4-14) Detalle del error SOLO al log del servidor; al llamador un
        // mensaje genérico (no filtramos internals de BD/crypto por el 400).
        console.error(`[wp] 400 en ${url.pathname}:`, e?.message)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        console.warn('[API] 400 sin detalles al cliente:', e instanceof Error ? e.message : e)
        res.end(JSON.stringify({ error: 'Petición inválida' }))
      }
      return
    }

    // 4. CRM Stage Change Trigger
    if (req.method === 'POST' && url.pathname === '/api/crm/stage-change') {
      // ================================================================
      // CONTRATO CRM→WHATSPOWER §5 (reparación integral 2026-11-06):
      // La organización del evento VIENE DE LA IDENTIDAD AUTENTICADA, jamás
      // del body (el orgId del body se VERIFICA, no autoriza):
      //  (a) credencial de servicio POR ORGANIZACIÓN (INTERNAL_API_KEYS) → org de la credencial;
      //  (b) credencial de servicio registrada (X-Org-Id + Bearer de la org, hash en BD);
      //  (c) OPERADOR CENTRAL → exige X-Org-Id explícito (selección auditable).
      // orgId ausente o DIVERGENTE del body → 403 (el evento se rechaza entero).
      // ================================================================
      let eventOrg: string | null = null
      if (identity) {
        eventOrg = identity.orgId
      } else {
        const svcAuth = extractOrgServiceAuth(req.headers as Record<string, string | string[] | undefined>)
        if (svcAuth && verifyOrgServiceCredential(db, svcAuth.orgId, svcAuth.credential)) {
          eventOrg = svcAuth.orgId
        } else {
          const hdr = req.headers['x-org-id']
          const hdrVal = Array.isArray(hdr) ? hdr[0] : hdr
          const candidate = hdrVal && typeof hdrVal === 'string' ? hdrVal.trim() : ''
          if (candidate && /^[a-zA-Z0-9_-]{1,64}$/.test(candidate)) {
            eventOrg = candidate
          }
        }
      }
      if (!eventOrg) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized: el evento stage-change exige identidad de organización (credencial de servicio o X-Org-Id del operador central)' }))
        return
      }
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const event = JSON.parse(rb.body)
        if (!event.orgId || event.orgId !== eventOrg) {
          // Contradicción body↔identidad: se rechaza el evento COMPLETO (no se
          // ejecuta ninguna parte con la org del body).
          console.warn(`[Seguridad 2A ALERTA] stage-change con orgId del body divergente de la identidad autenticada (identidad: ${eventOrg}, body: ${String(event.orgId).slice(0, 64)})`)
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Forbidden: el orgId del evento no coincide con la identidad autenticada' }))
          return
        }
        const result = await crmTriggers.handleStageChange(event)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (e: any) {
        // (A4-14) Detalle del error SOLO al log del servidor; al llamador un
        // mensaje genérico (no filtramos internals de BD/crypto por el 400).
        console.error(`[wp] 400 en ${url.pathname}:`, e?.message)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        console.warn('[API] 400 sin detalles al cliente:', e instanceof Error ? e.message : e)
        res.end(JSON.stringify({ error: 'Petición inválida' }))
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
        // (fusión) el modo de la pasarela viaja en la respuesta: jamás se presenta
        // un enlace de simulador como si fuera una pasarela real (contrato §5).
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ...tx, mode: tx.gateway }))
      } catch (e: any) {
        // (A4-14) Detalle del error SOLO al log del servidor; al llamador un
        // mensaje genérico (no filtramos internals de BD/crypto por el 400).
        console.error(`[wp] 400 en ${url.pathname}:`, e?.message)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        console.warn('[API] 400 sin detalles al cliente:', e instanceof Error ? e.message : e)
        res.end(JSON.stringify({ error: 'Petición inválida' }))
      }
      return
    }

    // Webhook de la pasarela de pagos: exige HMAC propio (PAYMENTS_WEBHOOK_SECRET) +
    // timestamp + anti-replay. Fail-closed: sin secret configurado, 503.
    if (req.method === 'POST' && url.pathname === '/api/payments/webhook') {
      // Rate limiting DURABLE (A2-11, auditoría 2026-11-11)
      const paymentsRL = durableRateLimit(db, `pay:${clientKey(req)}`, 60)
      if (!paymentsRL.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(paymentsRL.retryAfterSec) })
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
        // (fusión) pasarelas sin eventId propio: se deriva de (transactionId,status)
        // para conservar idempotencia durable (re-entrega idéntica → 200 sin doble efecto).
        if (!payload.eventId && payload.transactionId && payload.status) {
          payload.eventId = `tx:${payload.transactionId}:${payload.status}`
        }
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
        // (A4-14) Detalle del error SOLO al log del servidor; al llamador un
        // mensaje genérico (no filtramos internals de BD/crypto por el 400).
        console.error(`[wp] 400 en ${url.pathname}:`, e?.message)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        console.warn('[API] 400 sin detalles al cliente:', e instanceof Error ? e.message : e)
        res.end(JSON.stringify({ error: 'Petición inválida' }))
      }
      return
    }

    // =========================================================================
    // (ronda 17, paso 2) Endpoints de lista/lectura que el dashboard Next.js
    // espera y que antes faltaban → caía a datos demo. Todos exigen X-Org-Id
    // (aislamiento multi-organización fail-closed) y leen EXCLUSIVAMENTE las
    // filas de la organización autenticada. Sin secretos en las respuestas.
    // =========================================================================

    // GET /api/inbox — lista mensajes de la bandeja de la organización.
    // Query: phone? (filtra por contacto), since? (epoch ms), limit? (default 200, máx 500).
    if (req.method === 'GET' && url.pathname === '/api/inbox') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const phone = url.searchParams.get('phone') || undefined
      const sinceStr = url.searchParams.get('since')
      const since = sinceStr ? Number(sinceStr) : undefined
      const limitStr = url.searchParams.get('limit')
      const limit = Math.min(Math.max(Number(limitStr) || 200, 1), 500)
      let sql = 'SELECT id, contact_phone, direction, text, media_url, created_at FROM inbox_messages WHERE organization_id = ?'
      const params: Array<string | number> = [orgId]
      if (phone) { sql += ' AND contact_phone = ?'; params.push(phone) }
      if (since !== undefined && !Number.isNaN(since)) { sql += ' AND created_at >= ?'; params.push(since) }
      sql += ' ORDER BY created_at ASC LIMIT ?'
      params.push(limit)
      const rows = db.prepare(sql).all(...params) as Array<{
        id: string; contact_phone: string; direction: string; text: string; media_url: string | null; created_at: number
      }>
      const messages = rows.map((r) => ({
        id: r.id,
        contactPhone: r.contact_phone,
        direction: r.direction as 'inbound' | 'outbound',
        text: r.text,
        mediaUrl: r.media_url,
        createdAt: r.created_at,
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ messages, count: messages.length }))
      return
    }

    // GET /api/locks — lista locks activos de la organización (no expirados).
    // Query: include_handoff? 'true' (default) | 'false' (excluye HANDOFF_HUMAN).
    if (req.method === 'GET' && url.pathname === '/api/locks') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const includeHandoff = url.searchParams.get('include_handoff') !== 'false'
      const now = Date.now()
      let sql = 'SELECT contact_phone, current_state, locked_at, expires_at, correlation_id FROM conversation_locks WHERE organization_id = ? AND expires_at > ?'
      const params: Array<string | number> = [orgId, now]
      if (!includeHandoff) { sql += " AND current_state != 'HANDOFF_HUMAN'" }
      sql += ' ORDER BY locked_at DESC'
      const rows = db.prepare(sql).all(...params) as Array<{
        contact_phone: string; current_state: string; locked_at: number; expires_at: number; correlation_id: string
      }>
      const locks = rows.map((r) => ({
        contactPhone: r.contact_phone,
        organizationId: orgId,
        currentState: r.current_state,
        lockedAt: r.locked_at,
        expiresAt: r.expires_at,
        correlationId: r.correlation_id,
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ locks, count: locks.length }))
      return
    }

    // GET /api/suppressions — lista la suppression_list de la organización.
    // Query: limit? (default 100, máx 500), offset? (default 0).
    if (req.method === 'GET' && url.pathname === '/api/suppressions') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500)
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0)
      const rows = db.prepare('SELECT phone, reason, created_at FROM suppression_list WHERE organization_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(orgId, limit, offset) as Array<{ phone: string; reason: string; created_at: number }>
      const total = (db.prepare('SELECT COUNT(*) AS n FROM suppression_list WHERE organization_id = ?').get(orgId) as { n: number }).n
      const suppressions = rows.map((r) => ({ phone: r.phone, reason: r.reason, createdAt: r.created_at }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ suppressions, total, offset, limit }))
      return
    }

    // GET /api/metrics — KPIs básicos para el dashboard. Todo por organización.
    // Conversaciones (inbound/outbound hoy y total), contactos únicos, locks por estado.
    if (req.method === 'GET' && url.pathname === '/api/metrics') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
      const dayStartMs = dayStart.getTime()
      const inboundTotal = (db.prepare("SELECT COUNT(*) AS n FROM inbox_messages WHERE organization_id = ? AND direction = 'inbound'").get(orgId) as { n: number }).n
      const outboundTotal = (db.prepare("SELECT COUNT(*) AS n FROM inbox_messages WHERE organization_id = ? AND direction = 'outbound'").get(orgId) as { n: number }).n
      const inboundToday = (db.prepare("SELECT COUNT(*) AS n FROM inbox_messages WHERE organization_id = ? AND direction = 'inbound' AND created_at >= ?").get(orgId, dayStartMs) as { n: number }).n
      const outboundToday = (db.prepare("SELECT COUNT(*) AS n FROM inbox_messages WHERE organization_id = ? AND direction = 'outbound' AND created_at >= ?").get(orgId, dayStartMs) as { n: number }).n
      const uniqueContacts = (db.prepare('SELECT COUNT(DISTINCT contact_phone) AS n FROM inbox_messages WHERE organization_id = ?').get(orgId) as { n: number }).n
      const now = Date.now()
      const activeFlowLocks = (db.prepare("SELECT COUNT(*) AS n FROM conversation_locks WHERE organization_id = ? AND expires_at > ? AND current_state = 'IN_FLOW_2A'").get(orgId, now) as { n: number }).n
      const handoffLocks = (db.prepare("SELECT COUNT(*) AS n FROM conversation_locks WHERE organization_id = ? AND current_state = 'HANDOFF_HUMAN'").get(orgId) as { n: number }).n
      const suppressions = (db.prepare('SELECT COUNT(*) AS n FROM suppression_list WHERE organization_id = ?').get(orgId) as { n: number }).n
      const activeFlows = (db.prepare('SELECT COUNT(*) AS n FROM flows WHERE organization_id = ? AND is_active = 1').get(orgId) as { n: number }).n
      const activeSequences = (db.prepare('SELECT COUNT(*) AS n FROM sequences WHERE organization_id = ? AND is_active = 1').get(orgId) as { n: number }).n
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        messages: { inboundTotal, outboundTotal, inboundToday, outboundToday },
        contacts: uniqueContacts,
        locks: { activeFlow: activeFlowLocks, handoff: handoffLocks },
        suppressions,
        flows: activeFlows,
        sequences: activeSequences,
      }))
      return
    }

    // GET /api/realtime/stats — clientes WebSocket y mensajes enviados.
    // Si el servidor WS no está activo (modo sin /ws), devuelve ceros.
    if (req.method === 'GET' && url.pathname === '/api/realtime/stats') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const clients = typeof wsClientCountRef.count === 'number' ? wsClientCountRef.count : 0
      const messagesSent = typeof wsMessagesSentRef.count === 'number' ? wsMessagesSentRef.count : 0
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ clients, messagesSent }))
      return
    }

    // GET /api/sequences — lista secuencias de la organización con conteos.
    if (req.method === 'GET' && url.pathname === '/api/sequences') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const seqs = db.prepare('SELECT id, name, is_active, created_at FROM sequences WHERE organization_id = ? ORDER BY created_at DESC').all(orgId) as Array<{ id: string; name: string; is_active: number; created_at: number }>
      const out = seqs.map((s) => {
        const stepCount = (db.prepare('SELECT COUNT(*) AS n FROM sequence_steps WHERE organization_id = ? AND sequence_id = ?').get(orgId, s.id) as { n: number }).n
        const activeEnrollments = (db.prepare("SELECT COUNT(*) AS n FROM sequence_enrollments WHERE organization_id = ? AND sequence_id = ? AND status = 'ACTIVE'").get(orgId, s.id) as { n: number }).n
        const completedEnrollments = (db.prepare("SELECT COUNT(*) AS n FROM sequence_enrollments WHERE organization_id = ? AND sequence_id = ? AND status = 'COMPLETED'").get(orgId, s.id) as { n: number }).n
        return {
          id: s.id,
          name: s.name,
          isActive: s.is_active === 1,
          createdAt: s.created_at,
          stepCount,
          enrolledActive: activeEnrollments,
          enrolledCompleted: completedEnrollments,
        }
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out))
      return
    }

    // POST /api/sequences — crea una secuencia para la organización.
    if (req.method === 'POST' && url.pathname === '/api/sequences') {
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
        const seq = JSON.parse(rb.body)
        if (!seq?.id || typeof seq.id !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'sequence.id es obligatorio' }))
          return
        }
        if (seq.organizationId && seq.organizationId !== orgId) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'organizationId del body no coincide con x-org-id' }))
          return
        }
        seq.organizationId = orgId
        router.getFlowEngine().saveSequence(orgId, seq)
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, id: seq.id }))
      } catch (e) {
        console.error(`[wp] 400 en POST /api/sequences:`, (e as Error)?.message)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Petición inválida' }))
      }
      return
    }

    // GET /api/sequences/:id — detalle de una secuencia con sus pasos.
    if (req.method === 'GET' && url.pathname.startsWith('/api/sequences/')) {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const seqId = decodeURIComponent(url.pathname.slice('/api/sequences/'.length).split('/')[0])
      const seq = db.prepare('SELECT id, name, is_active, created_at FROM sequences WHERE organization_id = ? AND id = ?').get(orgId, seqId) as { id: string; name: string; is_active: number; created_at: number } | undefined
      if (!seq) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Secuencia no encontrada' }))
        return
      }
      const steps = db.prepare('SELECT id, sequence_id, step_number, delay_minutes, message_text, target_flow_id FROM sequence_steps WHERE organization_id = ? AND sequence_id = ? ORDER BY step_number ASC').all(orgId, seqId) as Array<{
        id: string; sequence_id: string; step_number: number; delay_minutes: number; message_text: string; target_flow_id: string | null
      }>
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: seq.id,
        name: seq.name,
        isActive: seq.is_active === 1,
        createdAt: seq.created_at,
        steps: steps.map((s) => ({
          id: s.id,
          stepNumber: s.step_number,
          delayMinutes: s.delay_minutes,
          messageText: s.message_text,
          targetFlowId: s.target_flow_id,
        })),
      }))
      return
    }

    // POST /api/sequences/:id/exit — saca a un contacto de una secuencia.
    if (req.method === 'POST' && url.pathname.startsWith('/api/sequences/') && url.pathname.endsWith('/exit')) {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const parts = url.pathname.slice('/api/sequences/'.length).split('/')
      const seqId = decodeURIComponent(parts[0])
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const body = JSON.parse(rb.body || '{}')
        if (!body?.phone || typeof body.phone !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'phone es obligatorio en el body' }))
          return
        }
        // (ronda 19) Antes se cancelaba con el texto tal cual y se respondía
        // «ok» aunque no coincidiera ninguna fila: un acuse en falso.
        const digitos = body.phone.replace(/\D/g, '')
        if (digitos.length < 8 || digitos.length > 15) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'phone no parece un teléfono utilizable (8-15 dígitos)' }))
          return
        }
        const cancelled = router.getFlowEngine().cancelSequenceEnrollment(orgId, body.phone, seqId)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          phone: digitos,
          requestedPhone: body.phone,
          sequenceId: seqId,
          // 0 significa «no había ninguna inscripción activa que cancelar»: se
          // mantiene 200 para que reintentar sea inofensivo, pero ya no se finge.
          cancelled,
          ...(cancelled === 0 ? { note: 'No había ninguna inscripción activa que cancelar' } : {}),
        }))
      } catch (e) {
        console.error(`[wp] 400 en POST /api/sequences/:id/exit:`, (e as Error)?.message)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Petición inválida' }))
      }
      return
    }

    // GET /api/contacts — lista contactos de la organización (UNION de
    // inbox_messages + contact_tags + contact_custom_fields) con sus tags y CF.
    if (req.method === 'GET' && url.pathname === '/api/contacts') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const phones = new Set<string>()
      const inboxPhones = db.prepare('SELECT DISTINCT contact_phone FROM inbox_messages WHERE organization_id = ?').all(orgId) as Array<{ contact_phone: string }>
      for (const r of inboxPhones) phones.add(r.contact_phone)
      const tagPhones = db.prepare('SELECT DISTINCT contact_phone FROM contact_tags WHERE organization_id = ?').all(orgId) as Array<{ contact_phone: string }>
      for (const r of tagPhones) phones.add(r.contact_phone)
      const cfPhones = db.prepare('SELECT DISTINCT contact_phone FROM contact_custom_fields WHERE organization_id = ?').all(orgId) as Array<{ contact_phone: string }>
      for (const r of cfPhones) phones.add(r.contact_phone)
      const contacts = Array.from(phones).map((phone) => {
        const tags = (db.prepare('SELECT tag_name FROM contact_tags WHERE organization_id = ? AND contact_phone = ?').all(orgId, phone) as Array<{ tag_name: string }>).map((r) => r.tag_name)
        const customFields: Record<string, string> = {}
        const cfRows = db.prepare('SELECT field_key, field_value FROM contact_custom_fields WHERE organization_id = ? AND contact_phone = ?').all(orgId, phone) as Array<{ field_key: string; field_value: string }>
        for (const c of cfRows) customFields[c.field_key] = c.field_value
        const lastMsg = db.prepare('SELECT text, created_at, direction FROM inbox_messages WHERE organization_id = ? AND contact_phone = ? ORDER BY created_at DESC LIMIT 1').get(orgId, phone) as { text: string; created_at: number; direction: string } | undefined
        return {
          phone,
          name: customFields.name || null,
          email: customFields.email || null,
          tags,
          customFields,
          lastMessageText: lastMsg?.text ?? null,
          lastMessageAt: lastMsg?.created_at ?? null,
          lastMessageDirection: lastMsg?.direction ?? null,
        }
      })
      contacts.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ contacts, count: contacts.length }))
      return
    }

    // POST /api/contacts — registra un contacto nuevo (inserta nombre/email/notas
    // como custom fields y aplica los tags iniciales). No crea un cliente en el CRM
    // (eso lo hace el nodo `crm_action` del flow builder) — sólo lo known en 2A.
    if (req.method === 'POST' && url.pathname === '/api/contacts') {
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
        const body = JSON.parse(rb.body)
        if (!body?.phone || typeof body.phone !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'phone es obligatorio' }))
          return
        }
        const fe = router.getFlowEngine()
        if (typeof body.name === 'string' && body.name) fe.setCustomField(orgId, body.phone, 'name', body.name)
        if (typeof body.email === 'string' && body.email) fe.setCustomField(orgId, body.phone, 'email', body.email)
        if (typeof body.notes === 'string' && body.notes) fe.setCustomField(orgId, body.phone, 'notes', body.notes)
        if (Array.isArray(body.tags)) for (const t of body.tags) if (typeof t === 'string' && t) fe.addTag(orgId, body.phone, t)
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, phone: body.phone }))
      } catch (e) {
        console.error(`[wp] 400 en POST /api/contacts:`, (e as Error)?.message)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Petición inválida' }))
      }
      return
    }

    // GET /api/audit — log de auditoría de automatizaciones (automation_events).
    // Query: limit? (default 100, máx 500), offset?, event_key?, status?
    if (req.method === 'GET' && url.pathname === '/api/audit') {
      const orgId = requireOrgHeader(req)
      if (!orgId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'x-org-id requerido (aislamiento multi-organización)' }))
        return
      }
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500)
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0)
      const eventKey = url.searchParams.get('event_key') || undefined
      const status = url.searchParams.get('status') || undefined
      let sql = 'SELECT id, event_key, stage, action, status, detail, message_id, created_at FROM automation_events WHERE organization_id = ?'
      const params: Array<string | number> = [orgId]
      if (eventKey) { sql += ' AND event_key = ?'; params.push(eventKey) }
      if (status) { sql += ' AND status = ?'; params.push(status) }
      sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
      params.push(limit, offset)
      const rows = db.prepare(sql).all(...params) as Array<{
        id: string; event_key: string; stage: string; action: string; status: string; detail: string | null; message_id: string | null; created_at: number
      }>
      const totalSql = 'SELECT COUNT(*) AS n FROM automation_events WHERE organization_id = ?' + (eventKey ? ' AND event_key = ?' : '') + (status ? ' AND status = ?' : '')
      const totalParams: Array<string> = [orgId, ...(eventKey ? [eventKey] : []), ...(status ? [status] : [])]
      const total = (db.prepare(totalSql).get(...totalParams) as { n: number }).n
      const events = rows.map((r) => ({
        id: r.id,
        eventKey: r.event_key,
        stage: r.stage,
        action: r.action,
        status: r.status,
        detail: r.detail,
        messageId: r.message_id,
        createdAt: r.created_at,
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ events, total, offset, limit }))
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
  const { server, router, transport } = createAgenticServer()
// (A5-08, auditoría 2026-11-11) Umbrales de proceso: sin muerte silenciosa.
process.on('unhandledRejection', (reason) => {
  console.error('[wp-server] unhandledRejection:', reason instanceof Error ? reason.message : reason)
})
process.on('uncaughtException', (err) => {
  console.error('[wp-server] uncaughtException (parada de emergencia):', err.message)
  process.exit(1)
})

  server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`[Capa 2A] Servidor Agéntico escuchando en http://localhost:${PORT}`)
  })

  // (ronda 22) PLANIFICADOR: sin él, un nodo «Espera» de un flujo y una secuencia
  // con retardo se quedaban escritos en la base y nadie los ejecutaba. Basta con
  // que el servidor esté vivo; SCHEDULER_ENABLED=false lo apaga (y entonces lo dice).
  if (process.env.SCHEDULER_ENABLED !== 'false') {
    const pedido = Number(process.env.SCHEDULER_INTERVAL_MS || 30000)
    const cadaMs = Number.isFinite(pedido) && pedido >= 1000 ? pedido : 30000
    const scheduler = startScheduler({
      engine: router.getFlowEngine(),
      transport,
      suppression: router.getSuppressionStore(),
      intervalMs: cadaMs,
    })
    console.log(`[Capa 2A] Planificador activo: esperas de flujo y pasos de secuencia cada ${Math.round(cadaMs / 1000)} s (SCHEDULER_ENABLED=false lo apaga)`)
    process.on('SIGTERM', () => scheduler.stop())
    process.on('SIGINT', () => scheduler.stop())
  } else {
    console.warn('[Capa 2A AVISO] Planificador APAGADO por SCHEDULER_ENABLED=false: las esperas de los flujos y los pasos de secuencia no se enviarán solos.')
  }
}
