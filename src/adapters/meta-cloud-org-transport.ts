/**
 * meta-cloud-org-transport.ts — Transporte Meta Cloud API POR ORGANIZACIÓN
 * (OLEADA 2, decisión de negocio 2026-11-11, puntos 3, 6 y 8).
 *
 * Cada envío usa las credenciales de la ORGANIZACIÓN indicada:
 *   sendMessage(to, text, correlationId, idempotencyKey, orgId)
 *
 * REGLAS FAIL-CLOSED:
 *  - sin orgId → REJECTED (jamás se elige una org "por defecto");
 *  - org sin número conectado, o número de OTRA org → REJECTED (aislamiento);
 *  - sin credencial resoluble → REJECTED (no se envía con credenciales ajenas);
 *  - ALLOW_REAL_DISPATCH !== 'true' → REJECTED (salvaguarda anti-envío real,
 *    igual que ULTRA y que HttpAlbraTransportSender).
 *
 * Clasificación B2 (idéntica a transport.ts): 2xx → SENT; 400/401/403/404/
 * 410/413/422/429 → REJECTED; 408/425/5xx/timeout/ilegible → UNCERTAIN.
 */
import type { TransportSendResult, DispatchOutcome, OutboundMedia } from '../types.ts'
import { OrgWaRegistry, type WaCredential } from '../org-wa-registry.ts'

export interface MetaCloudOrgTransportOptions {
  registry?: OrgWaRegistry
  apiVersion?: string
  /** Inyectable para pruebas (sin red real). */
  fetchImpl?: typeof fetch
  /** Guarda anti-envío (default: env ALLOW_REAL_DISPATCH). */
  allowRealDispatch?: boolean
}

const REJECTABLE_STATUS = new Set([400, 401, 403, 404, 410, 413, 422, 429])

/** Tope del registro en memoria (ring buffer) — fuga de memoria (A1-02, auditoría 2026-11-11). */
const SENT_LOG_CAP = 500

export class MetaCloudOrgTransport {
  private registry: OrgWaRegistry
  private apiVersion: string
  private fetchImpl: typeof fetch
  private allowRealDispatch: boolean
  /** Registro de envíos para pruebas (sin secretos). */
  public sentLog: Array<{ orgId: string; phoneNumberId: string; to: string; text: string; correlationId: string; idempotencyKey: string | null; at: number; media?: OutboundMedia }> = []

  constructor(options: MetaCloudOrgTransportOptions = {}) {
    this.registry = options.registry ?? new OrgWaRegistry()
    this.apiVersion = options.apiVersion ?? process.env.META_GRAPH_VERSION ?? 'v21.0'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.allowRealDispatch = options.allowRealDispatch ?? (process.env.ALLOW_REAL_DISPATCH === 'true')
  }

  async sendMessage(to: string, text: string, correlationId: string, idempotencyKey?: string, orgId?: string, media?: OutboundMedia): Promise<TransportSendResult> {
    // 1) Sin organización NO se envía (punto 8: jamás una org implícita).
    if (!orgId) {
      return { ok: false, outcome: 'REJECTED', error: 'ORG_REQUIRED: el transporte Meta Cloud por organización exige orgId (fail-closed)' }
    }
    // 2) Salvaguarda anti-envío real (mismo orden de cierre que Capa 3).
    if (!this.allowRealDispatch) {
      return { ok: false, outcome: 'REJECTED', error: 'DISPATCH_BLOCKED_BY_SAFETY_GUARD: ALLOW_REAL_DISPATCH no está en true (fail-closed)' }
    }
    // 3) Número de la organización para despachar (primera conexión conectada;
    //    el enrutamiento multi-número por campaña llega con la OLEADA 3).
    const connections = await this.registry.listForOrg(orgId)
    if (connections.length === 0) {
      return { ok: false, outcome: 'REJECTED', error: `NO_CONNECTED_NUMBER: la organización no tiene números de WhatsApp conectados (org verificada, sin credenciales resueltas)` }
    }
    const connection = connections[0]
    // 4) Credencial de ESA organización para ESE número (la fuente re-verifica
    //    la pertenencia: una credencial de org-a jamás entrega token de org-b).
    const credential = await this.registry.resolveCredential(orgId, connection.phoneNumberId)
    if (!credential) {
      return { ok: false, outcome: 'REJECTED', error: 'CREDENTIAL_UNAVAILABLE: sin credencial resoluble para la organización (fail-closed)' }
    }
    // 5) Envío real vía Graph API con el token de la organización.
    //    (hallazgo 6) multimedia y botones se envían en formato NATIVO de la
    //    Cloud API cuando es posible; las limitaciones se degradan explícitamente.
    return this.dispatchViaGraph(credential, to, text, correlationId, idempotencyKey ?? null, media)
  }

  /** Límites DUROS de WhatsApp Cloud API (hallazgo 6): degradación explícita, no fallos oscuros. */
  private static readonly MAX_REPLY_BUTTONS = 3
  private static readonly MAX_BUTTON_TITLE_CHARS = 20

  /**
   * (hallazgo 6) Construye el payload NATIVO de WhatsApp Cloud API para el
   * contenido enriquecido del flujo visual:
   *  - media (image/audio/video/document) vía `link` + caption (caption no
   *    aplica a audio);
   *  - botones de respuesta (sin URL) → interactive `reply_buttons`, MÁXIMO 3
   *    (límite del proveedor); el excedente viaja como texto y queda en degraded;
   *  - botones URL → interactive `cta_url` (MÁXIMO 1 por mensaje); el excedente
   *    viaja como texto y queda en degraded;
   *  - media + botones a la vez: WhatsApp NO los combina → los botones viajan
   *    como lista de texto en la caption (limitación explícita);
   *  - títulos recortados al máximo del proveedor (20 chars) con degraded.
   */
  buildGraphPayload(to: string, text: string, media?: OutboundMedia): { payload: Record<string, unknown>; degraded: string[] } {
    const formattedPhone = to.replace(/\D/g, '')
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: formattedPhone }
    const degraded: string[] = []
    const hasMedia = Boolean(media?.mediaUrl && media?.mediaType)
    const buttons = media?.buttons ?? []

    if (hasMedia) {
      const t = (media as { mediaType: 'image' | 'audio' | 'video' | 'document' }).mediaType
      const node: Record<string, unknown> = { link: (media as { mediaUrl: string }).mediaUrl }
      let caption = text
      if (t !== 'audio') {
        if (buttons.length > 0) {
          const list = buttons.map((b) => (b.url ? `▸ ${b.title}: ${b.url}` : `▸ ${b.title}`)).join('\n')
          caption = caption ? `${caption}\n${list}` : list
          degraded.push('botones_no_combinables_con_media: WhatsApp Cloud API no permite interactive+media; entregados como lista de texto en el caption')
        }
        if (caption) node.caption = caption
      } else if (buttons.length > 0) {
        degraded.push('botones_no_combinables_con_audio: el audio no admite caption; los botones no pueden adjuntarse al mismo mensaje')
      }
      return { payload: { ...base, type: t, [t]: node }, degraded }
    }

    if (buttons.length > 0) {
      const replyBtns = buttons.filter((b) => !b.url)
      const urlBtns = buttons.filter((b) => b.url)
      let bodyText = text

      if (urlBtns.length > 0) {
        // CTA URL: máximo 1 botón de URL por mensaje en Cloud API.
        const first = urlBtns[0]
        const display = (first.title || 'Abrir').slice(0, MetaCloudOrgTransport.MAX_BUTTON_TITLE_CHARS)
        if ((first.title || '').length > MetaCloudOrgTransport.MAX_BUTTON_TITLE_CHARS) {
          degraded.push(`titulo_boton_recortado_a_${MetaCloudOrgTransport.MAX_BUTTON_TITLE_CHARS}_chars (${first.title})`)
        }
        if (urlBtns.length > 1) {
          const extra = urlBtns.slice(1).map((b) => `▸ ${b.title}: ${b.url}`).join('\n')
          bodyText = bodyText ? `${bodyText}\n${extra}` : extra
          degraded.push('solo_un_boton_url_por_mensaje: los botones URL excedentes se entregan como texto')
        }
        if (replyBtns.length > 0) {
          const extra = replyBtns.map((b) => `▸ ${b.title}`).join('\n')
          bodyText = bodyText ? `${bodyText}\n${extra}` : extra
          degraded.push('cta_url_no_combina_con_botones_de_respuesta: los botones de respuesta se entregan como texto')
        }
        return {
          payload: {
            ...base,
            type: 'interactive',
            interactive: {
              type: 'cta_url',
              body: { text: bodyText },
              action: { name: 'cta_url', parameters: { display_text: display, url: first.url } },
            },
          },
          degraded,
        }
      }

      // Botones de respuesta: máximo 3 (límite duro del proveedor).
      const usable = replyBtns.slice(0, MetaCloudOrgTransport.MAX_REPLY_BUTTONS)
      const excess = replyBtns.slice(MetaCloudOrgTransport.MAX_REPLY_BUTTONS)
      for (const b of usable) {
        if ((b.title || '').length > MetaCloudOrgTransport.MAX_BUTTON_TITLE_CHARS) {
          degraded.push(`titulo_boton_recortado_a_${MetaCloudOrgTransport.MAX_BUTTON_TITLE_CHARS}_chars (${b.title})`)
        }
      }
      if (excess.length > 0) {
        const extra = excess.map((b) => `▸ ${b.title}`).join('\n')
        bodyText = bodyText ? `${bodyText}\n${extra}` : extra
        degraded.push(`maximo_${MetaCloudOrgTransport.MAX_REPLY_BUTTONS}_botones_por_mensaje: el excedente se entrega como texto`)
      }
      return {
        payload: {
          ...base,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: bodyText },
            action: {
              buttons: usable.map((b, i) => ({
                type: 'reply',
                reply: {
                  id: b.url ? `url_${i}` : `btn_${i}`,
                  title: b.title.slice(0, MetaCloudOrgTransport.MAX_BUTTON_TITLE_CHARS),
                },
              })),
            },
          },
        },
        degraded,
      }
    }

    return { payload: { ...base, type: 'text', text: { preview_url: true, body: text } }, degraded }
  }

  private async dispatchViaGraph(credential: WaCredential, to: string, text: string, correlationId: string, idempotencyKey: string | null, media?: OutboundMedia): Promise<TransportSendResult> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${credential.phoneNumberId}/messages`
    const formattedPhone = to.replace(/\D/g, '')
    const { payload, degraded } = this.buildGraphPayload(to, text, media)
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      })
      // Respuesta ilegible → UNCERTAIN (el mensaje pudo haberse aceptado).
      const bodyText = await response.text().catch(() => '')
      let messageId: string | undefined
      try {
        const parsed = JSON.parse(bodyText) as { messages?: Array<{ id: string }> }
        messageId = parsed.messages?.[0]?.id
      } catch { /* cuerpo no-JSON: se clasifica por status */ }

      if (response.ok && messageId) {
        this.sentLog.push({
          orgId: credential.organizationId,
          phoneNumberId: credential.phoneNumberId,
          to: formattedPhone,
          text,
          correlationId,
          idempotencyKey,
          at: Date.now(),
          media,
        })
        if (this.sentLog.length > SENT_LOG_CAP) {
          this.sentLog.splice(0, this.sentLog.length - SENT_LOG_CAP)
        }
        return degraded.length > 0
          ? { ok: true, messageId, outcome: 'SENT' as DispatchOutcome, degraded }
          : { ok: true, messageId, outcome: 'SENT' as DispatchOutcome }
      }
      if (REJECTABLE_STATUS.has(response.status)) {
        return { ok: false, outcome: 'REJECTED', error: `graph ${response.status}` }
      }
      // 408/425/5xx y todo lo demás → AMBIGUO
      return { ok: false, outcome: 'UNCERTAIN', error: `graph ${response.status} (resultado ambiguo: el mensaje pudo haberse aceptado)` }
    } catch (err) {
      // timeout / conexión cortada → UNCERTAIN (B2)
      return { ok: false, outcome: 'UNCERTAIN', error: err instanceof Error ? err.message : 'transport error' }
    }
  }
}
