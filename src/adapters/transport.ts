import type { TransportSender } from '../types.ts'

/**
 * CUARTA FASE CORRECTIVA: el resultado del envío es DESCONOCIDO (la conexión
 * murió a mitad de la llamada — el proveedor pudo aceptar o no). Un efecto en
 * este estado NO puede re-ejecutarse a ciegas: exige reconciliación.
 * (Los fallos DEFINITIVOS de no-aceptación se reportan con ok:false+PREFLIGHT.)
 */
export class TransportAmbiguousError extends Error {
  constructor(message: string) {
    super(`TRANSPORT_AMBIGUOUS: ${message}`)
    this.name = 'TransportAmbiguousError'
  }
}

export interface DispatchedLog {
  to: string
  text: string
  correlationId: string
  /** CUARTA FASE: clave de idempotencia externa transmitida al proveedor. */
  idempotencyKey?: string
  timestamp: number
}

/** Códigos de fallo de conexión que significan "el mensaje JAMÁS salió" (no-aceptación definitiva). */
const PREFLIGHT_CAUSE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])

/**
 * Simulador de transporte para pruebas en sala limpia (sin envíos reales a WhatsApp).
 */
export class MockTransportSender implements TransportSender {
  public dispatched: DispatchedLog[] = []
  private simulateFailure = false

  setSimulateFailure(value: boolean): void {
    this.simulateFailure = value
  }

  async sendMessage(to: string, text: string, correlationId: string, idempotencyKey?: string): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    if (this.simulateFailure) {
      return { ok: false, error: 'PREFLIGHT: Daemon de transporte no disponible (503)' }
    }

    const messageId = `mock_wa_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    this.dispatched.push({
      to,
      text,
      correlationId,
      idempotencyKey,
      timestamp: Date.now(),
    })

    return { ok: true, messageId }
  }

  clear(): void {
    this.dispatched = []
  }
}

/**
 * Cliente de transporte para hablar con el proxy de WhatsApp de Capa 1 (CRM ALBRA).
 */
export class HttpAlbraTransportSender implements TransportSender {
  crmBaseUrl: string
  internalSecret: string
  constructor(crmBaseUrl: string, internalSecret: string) {
    this.crmBaseUrl = crmBaseUrl
    this.internalSecret = internalSecret
  }

  async sendMessage(to: string, text: string, correlationId: string, idempotencyKey?: string): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    // Salvaguarda dura (orden de cierre 2026-11-06): NINGÚN envío real sale sin
    // ALLOW_REAL_DISPATCH=true, independientemente del entorno o la URL. Fail-closed.
    if (process.env.ALLOW_REAL_DISPATCH !== 'true') {
      return {
        ok: false,
        error: 'PREFLIGHT: DISPATCH_BLOCKED_BY_SAFETY_GUARD — envío real bloqueado, ALLOW_REAL_DISPATCH no está en true (fail-closed)',
      }
    }
    try {
      const res = await fetch(`${this.crmBaseUrl}/api/whatsapp/daemon-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': this.internalSecret,
          'X-Correlation-Id': correlationId,
          // CUARTA FASE: la clave viaja también en header para gateways que auditan por cabecera.
          ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
        },
        body: JSON.stringify({
          path: '/send',
          to,
          message: text,
          // CUARTA FASE (idempotencia externa): si el daemon honra esta clave,
          // un reintento tras crash NO duplica el mensaje en WhatsApp.
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      })

      if (!res.ok) {
        // Rechazo DEFINITIVO del proxy (nada salió): reintento seguro.
        return { ok: false, error: `PREFLIGHT: Error del transporte WhatsApp: ${res.status}` }
      }

      const data = (await res.json()) as { messageId?: string }
      return { ok: true, messageId: data.messageId }
    } catch (err: any) {
      // Clasificación de fallos (cuarta fase): si la conexión NUNCA se estableció
      // (ECONNREFUSED/DNS/inalcanzable) el mensaje no salió → PREFLIGHT (ok:false,
      // reintento seguro). Cualquier otro fallo de red (timeout, socket muerto a
      // mitad, reset) deja el resultado DESCONOCIDO → TransportAmbiguousError.
      const causeCode = String(err?.cause?.code || err?.code || '')
      if (PREFLIGHT_CAUSE_CODES.has(causeCode)) {
        return { ok: false, error: `PREFLIGHT: conexión no establecida (${causeCode}): ${err?.message || err}` }
      }
      throw new TransportAmbiguousError(`fallo de red con resultado desconocido (${causeCode || 'sin código'}): ${err?.message || err}`)
    }
  }
}
