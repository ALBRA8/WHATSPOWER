import type { CrmActionResult, CrmClientInterface } from '../types.ts'

export interface MockActionRecord {
  action: 'create_client' | 'create_opportunity' | 'add_note'
  orgId: string
  params: Record<string, unknown>
  correlationId: string
}

/**
 * Cliente CRM en memoria para testing y sala limpia.
 */
export class MockCrmClient implements CrmClientInterface {
  public executedActions: MockActionRecord[] = []
  private simulateUnavailable = false

  setSimulateUnavailable(val: boolean): void {
    this.simulateUnavailable = val
  }

  async createClient(orgId: string, name: string, phone: string, correlationId: string): Promise<CrmActionResult> {
    if (this.simulateUnavailable) return { ok: false, error: '503 Service Unavailable' }
    const clientId = `cl_mock_${Math.random().toString(36).substring(2, 8)}`
    this.executedActions.push({
      action: 'create_client',
      orgId,
      params: { name, phone },
      correlationId,
    })
    return { ok: true, summary: `Cliente "${name}" creado`, clientId }
  }

  async createOpportunity(orgId: string, clientId: string, title: string, amount: number, correlationId: string): Promise<CrmActionResult> {
    if (this.simulateUnavailable) return { ok: false, error: '503 Service Unavailable' }
    this.executedActions.push({
      action: 'create_opportunity',
      orgId,
      params: { clientId, title, amount },
      correlationId,
    })
    return { ok: true, summary: `Oportunidad "${title}" creada` }
  }

  async addNote(orgId: string, clientId: string, content: string, correlationId: string): Promise<CrmActionResult> {
    if (this.simulateUnavailable) return { ok: false, error: '503 Service Unavailable' }
    this.executedActions.push({
      action: 'add_note',
      orgId,
      params: { clientId, content },
      correlationId,
    })
    return { ok: true, summary: `Nota añadida al cliente ${clientId}` }
  }

  clear(): void {
    this.executedActions = []
  }
}

/**
 * Cliente HTTP real hacia CRM ALBRA (POST /api/crm/actions con autenticación Bearer albra_<key>).
 */
export class HttpCrmClient implements CrmClientInterface {
  crmBaseUrl: string
  apiKey: string
  constructor(crmBaseUrl: string, apiKey: string) {
    this.crmBaseUrl = crmBaseUrl
    this.apiKey = apiKey
  }

  private async callAction(action: string, params: Record<string, unknown>, correlationId: string): Promise<CrmActionResult> {
    try {
      const res = await fetch(`${this.crmBaseUrl}/api/crm/actions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Correlation-Id': correlationId,
          'X-Idempotency-Key': `crm:${action}:${correlationId}`,
        },
        body: JSON.stringify({ action, params }),
      })

      const data = await res.json() as any
      if (!res.ok) {
        return { ok: false, error: data.error || `HTTP ${res.status}` }
      }
      return { ok: true, summary: data.summary, data: data.data, clientId: data.clientId }
    } catch (err: any) {
      return { ok: false, error: `Fallo de conexión con CRM: ${err?.message || err}` }
    }
  }

  async createClient(orgId: string, name: string, phone: string, correlationId: string): Promise<CrmActionResult> {
    return this.callAction('create_client', { name, phone }, correlationId)
  }

  async createOpportunity(orgId: string, clientId: string, title: string, amount: number, correlationId: string): Promise<CrmActionResult> {
    return this.callAction('create_opportunity', { clientId, title, amount }, correlationId)
  }

  async addNote(orgId: string, clientId: string, content: string, correlationId: string): Promise<CrmActionResult> {
    return this.callAction('add_note', { clientId, content }, correlationId)
  }
}
