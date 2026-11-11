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
import type { TransportSendResult, DispatchOutcome } from '../types.ts'
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

export class MetaCloudOrgTransport {
  private registry: OrgWaRegistry
  private apiVersion: string
  private fetchImpl: typeof fetch
  private allowRealDispatch: boolean
  /** Registro de envíos para pruebas (sin secretos). */
  public sentLog: Array<{ orgId: string; phoneNumberId: string; to: string; text: string; correlationId: string; idempotencyKey: string | null; at: number }> = []

  constructor(options: MetaCloudOrgTransportOptions = {}) {
    this.registry = options.registry ?? new OrgWaRegistry()
    this.apiVersion = options.apiVersion ?? process.env.META_GRAPH_VERSION ?? 'v21.0'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.allowRealDispatch = options.allowRealDispatch ?? (process.env.ALLOW_REAL_DISPATCH === 'true')
  }

  async sendMessage(to: string, text: string, correlationId: string, idempotencyKey?: string, orgId?: string): Promise<TransportSendResult> {
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
    return this.dispatchViaGraph(credential, to, text, correlationId, idempotencyKey ?? null)
  }

  private async dispatchViaGraph(credential: WaCredential, to: string, text: string, correlationId: string, idempotencyKey: string | null): Promise<TransportSendResult> {
    const formattedPhone = to.replace(/\D/g, '')
    const url = `https://graph.facebook.com/${this.apiVersion}/${credential.phoneNumberId}/messages`
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formattedPhone,
      type: 'text',
      text: { preview_url: true, body: text },
    }
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
        })
        return { ok: true, messageId, outcome: 'SENT' as DispatchOutcome }
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
