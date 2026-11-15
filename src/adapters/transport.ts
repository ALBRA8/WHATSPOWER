import type { TransportSender, TransportSendResult, DispatchOutcome, OutboundMedia } from '../types.ts'

/**
 * (hallazgo 6, auditoría funcional 2026-11-12) Degradación EXPLÍCITA de
 * contenido enriquecido a texto para transportes sin soporte nativo (proxy
 * Baileys del CRM / simuladores). El contenido NO se pierde en silencio:
 * la URL viaja como enlace de texto y los botones como lista; cada limitación
 * se reporta en `degraded` para observabilidad.
 */
export function renderMediaAsText(text: string, media?: OutboundMedia): { text: string; degraded: string[] } {
  const hasMedia = Boolean(media?.mediaUrl)
  const buttons = media?.buttons ?? []
  if (!hasMedia && buttons.length === 0) return { text, degraded: [] }
  let out = text
  const degraded: string[] = []
  if (hasMedia) {
    out += (out ? '\n\n' : '') + (media?.mediaUrl as string)
    degraded.push('media_url_entregada_como_enlace_de_texto: transporte sin soporte nativo de multimedia')
  }
  for (const b of buttons) {
    out += (out ? '\n' : '') + (b.url ? `▸ ${b.title}: ${b.url}` : `▸ ${b.title}`)
    degraded.push(
      b.url
        ? `boton_url_convertido_a_texto (${b.title}): transporte sin soporte nativo de botones`
        : `boton_respuesta_convertido_a_texto (${b.title}): transporte sin soporte nativo de botones`
    )
  }
  return { text: out, degraded }
}

export interface DispatchedLog {
  to: string
  text: string
  correlationId: string
  /** B2 (fase final): clave de idempotencia POR MENSAJE que acompaña al despacho. */
  idempotencyKey?: string
  timestamp: number
  /** (hallazgo 6) contenido enriquecido solicitado (para verificación en pruebas). */
  media?: OutboundMedia
}

/**
 * Simulador de transporte para pruebas en sala limpia (sin envíos reales a WhatsApp).
 * La falla simulada es un 503 del daemon: resultado AMBIGUO (el mensaje pudo
 * haberse aceptado antes del fallo) → outcome 'UNCERTAIN'.
 */
export class MockTransportSender implements TransportSender {
  public dispatched: DispatchedLog[] = []
  private simulateFailure = false

  setSimulateFailure(value: boolean): void {
    this.simulateFailure = value
  }

  async sendMessage(to: string, text: string, correlationId: string, idempotencyKey?: string, _orgId?: string, media?: OutboundMedia): Promise<TransportSendResult> {
    if (this.simulateFailure) {
      return { ok: false, error: 'Daemon de transporte no disponible (503)', outcome: 'UNCERTAIN' }
    }

    const messageId = `mock_wa_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    // (hallazgo 6) el simulador REGISTRA el contenido enriquecido para que las
    // pruebas verifiquen la propagación completa motor → router → transporte.
    this.dispatched.push({
      to,
      text,
      correlationId,
      idempotencyKey: idempotencyKey ?? correlationId,
      timestamp: Date.now(),
      media,
    })

    return { ok: true, messageId, outcome: 'SENT' }
  }

  clear(): void {
    this.dispatched = []
  }
}

/**
 * Cliente de transporte para hablar con el proxy de WhatsApp de Capa 1 (CRM ALBRA).
 *
 * B2 — CLASIFICACIÓN DE RESULTADOS (no todo fallo es un rechazo definitivo):
 *  - 2xx legible          → 'SENT' (aceptación confirmada).
 *  - 400/401/403/404/410/413/422/429 → 'REJECTED': el daemon rechazó la
 *    petición a nivel API ANTES de despachar — evidencia fiable de que el
 *    mensaje NO fue aceptado (único caso con reintento limpio permitido).
 *  - 408/425 y todo 5xx   → 'UNCERTAIN': el daemon pudo ACEPTAR el mensaje y
 *    fallar después (o perderse la respuesta). Un 502/503 de un proxy tras
 *    aceptar el daemon es indistinguible de un rechazo previo.
 *  - timeout / conexión cortada / respuesta ilegible → 'UNCERTAIN'.
 *  - Guard ALLOW_REAL_DISPATCH → 'REJECTED' (bloqueo local previo al envío:
 *    evidencia fiable de que NADA salió).
 *
 * La clave de idempotencia viaja SIEMPRE al daemon:
 *  - X-Correlation-Id: correlación del EVENTO (trazabilidad).
 *  - X-Idempotency-Key + cuerpo (idempotencyKey): clave POR MENSAJE
 *    (B2 fase final: `${correlationId}#${efecto}`) para que el lado daemon
 *    pueda verificarla/aplicarla.
 *
 * IMPORTANTE (B2, requisito 7): el daemon Baileys de Capa 1 HOY NO consume ni
 * persiste estas claves (hallazgo B2). Esto NO convierte la entrega en
 * exactly-once: mientras el proveedor no garantice deduplicación, el modelo
 * es AT-LEAST-ONCE + registro durable previo al envío en Capa 2A
 * (daemon_send_idempotency, única (organization_id, idempotency_key)) +
 * reconciliación de resultados UNCERTAIN sin reenvío automático.
 */
export class HttpAlbraTransportSender implements TransportSender {
  crmBaseUrl: string
  internalSecret: string
  constructor(crmBaseUrl: string, internalSecret: string) {
    this.crmBaseUrl = crmBaseUrl
    this.internalSecret = internalSecret
  }

  async sendMessage(to: string, text: string, correlationId: string, idempotencyKey?: string, _orgId?: string, media?: OutboundMedia): Promise<TransportSendResult> {
    // Salvaguarda dura (orden de cierre 2026-11-06): NINGÚN envío real sale sin
    // ALLOW_REAL_DISPATCH=true, independientemente del entorno o la URL. Fail-closed.
    if (process.env.ALLOW_REAL_DISPATCH !== 'true') {
      return {
        ok: false,
        error: 'DISPATCH_BLOCKED_BY_SAFETY_GUARD: envío real bloqueado — ALLOW_REAL_DISPATCH no está en true (fail-closed)',
        outcome: 'REJECTED',
      }
    }
    // (hallazgo 6) Este transporte (proxy Baileys Capa 1) NO soporta multimedia
    // ni botones en su contrato /send: degradación EXPLÍCITA a texto (la URL
    // y los botones viajan en el texto; nada se pierde silenciosamente).
    const { text: finalText, degraded } = renderMediaAsText(text, media)
    const sendKey = idempotencyKey ?? correlationId
    let res: Response
    try {
      res = await fetch(`${this.crmBaseUrl}/api/whatsapp/daemon-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': this.internalSecret,
          'X-Correlation-Id': correlationId,
          // B2 (fase final): clave de idempotencia POR MENSAJE en header dedicado.
          'X-Idempotency-Key': sendKey,
        },
        body: JSON.stringify({
          path: '/send',
          to,
          message: finalText,
          // B2: la clave de idempotencia llega explícitamente al daemon
          // (además del header) para que el receptor pueda verificarla.
          idempotencyKey: sendKey,
        }),
      })
    } catch (err: any) {
      // Timeout, conexión cortada, DNS: NO hay evidencia de si el daemon aceptó.
      return { ok: false, error: `Fallo de conexión con daemon-proxy: ${err?.message || err}`, outcome: 'UNCERTAIN', degraded }
    }

    if (!res.ok) {
      const status = res.status
      const DEFINITIVE_REJECTIONS = new Set([400, 401, 403, 404, 410, 413, 422, 429])
      const outcome: DispatchOutcome = DEFINITIVE_REJECTIONS.has(status) ? 'REJECTED' : 'UNCERTAIN'
      return { ok: false, error: `Error del transporte WhatsApp: ${status}`, outcome, degraded }
    }

    // 2xx con cuerpo ilegible: el daemon pudo aceptar y la respuesta perderse.
    try {
      const data = (await res.json()) as { messageId?: string }
      return degraded.length > 0
        ? { ok: true, messageId: data.messageId, outcome: 'SENT', degraded }
        : { ok: true, messageId: data.messageId, outcome: 'SENT' }
    } catch {
      return { ok: false, error: 'Respuesta 2xx ilegible del daemon-proxy (aceptación no confirmable)', outcome: 'UNCERTAIN', degraded }
    }
  }
}
