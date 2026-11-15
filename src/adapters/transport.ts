import type { TransportSender } from '../types.ts'

export interface DispatchedLog {
  to: string
  text: string
  correlationId: string
  timestamp: number
}

/**
 * Simulador de transporte para pruebas en sala limpia (sin envíos reales a WhatsApp).
 */
export class MockTransportSender implements TransportSender {
  public dispatched: DispatchedLog[] = []
  private simulateFailure = false

  setSimulateFailure(value: boolean): void {
    this.simulateFailure = value
  }

  async sendMessage(to: string, text: string, correlationId: string): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    if (this.simulateFailure) {
      return { ok: false, error: 'Daemon de transporte no disponible (503)' }
    }

    const messageId = `mock_wa_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    this.dispatched.push({
      to,
      text,
      correlationId,
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

  async sendMessage(to: string, text: string, correlationId: string): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    try {
      const res = await fetch(`${this.crmBaseUrl}/api/whatsapp/daemon-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': this.internalSecret,
          'X-Correlation-Id': correlationId,
        },
        body: JSON.stringify({
          path: '/send',
          to,
          message: text,
        }),
      })

      if (!res.ok) {
        return { ok: false, error: `Error del transporte WhatsApp: ${res.status}` }
      }

      const data = (await res.json()) as { messageId?: string }
      return { ok: true, messageId: data.messageId }
    } catch (err: any) {
      return { ok: false, error: `Fallo de conexión con daemon-proxy: ${err?.message || err}` }
    }
  }
}
