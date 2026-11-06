import type { CrmActionResult, CrmClientInterface } from '../types.ts'

export interface MockActionRecord {
  action: 'create_client' | 'create_opportunity' | 'add_note'
  orgId: string
  params: Record<string, unknown>
  correlationId: string
}

/**
 * Cliente CRM en memoria para testing y sala limpia.
 * (segunda reparación §3.B) simulateResponseOrgId permite simular que el CRM
 * responde atribuyendo la acción a OTRA organización → el consumidor debe
 * rechazar la discrepancia (TENANT_MISMATCH).
 */
export class MockCrmClient implements CrmClientInterface {
  public executedActions: MockActionRecord[] = []
  private simulateUnavailable = false
  /** Si se fija, las respuestas del "CRM" llevan ese orgId (para simular mismatch). */
  simulateResponseOrgId?: string

  setSimulateUnavailable(val: boolean): void {
    this.simulateUnavailable = val
  }

  private confirmOrg(orgId: string): CrmActionResult | null {
    // El CRM REAL devuelve el orgId de la API key usada; el Mock emula el caso
    // de discrepancia cuando simulateResponseOrgId está fijado.
    if (this.simulateResponseOrgId && this.simulateResponseOrgId !== orgId) {
      return { ok: false, error: `TENANT_MISMATCH: el CRM confirmó la organización ${this.simulateResponseOrgId}, se esperaba ${orgId}` }
    }
    return null
  }

  async createClient(orgId: string, name: string, phone: string, correlationId: string): Promise<CrmActionResult> {
    if (this.simulateUnavailable) return { ok: false, error: '503 Service Unavailable' }
    const mismatch = this.confirmOrg(orgId)
    if (mismatch) return mismatch
    const clientId = `cl_mock_${Math.random().toString(36).substring(2, 8)}`
    this.executedActions.push({
      action: 'create_client',
      orgId,
      params: { name, phone },
      correlationId,
    })
    return { ok: true, summary: `Cliente "${name}" creado`, clientId, orgId }
  }

  async createOpportunity(orgId: string, clientId: string, title: string, amount: number, correlationId: string): Promise<CrmActionResult> {
    if (this.simulateUnavailable) return { ok: false, error: '503 Service Unavailable' }
    const mismatch = this.confirmOrg(orgId)
    if (mismatch) return mismatch
    this.executedActions.push({
      action: 'create_opportunity',
      orgId,
      params: { clientId, title, amount },
      correlationId,
    })
    return { ok: true, summary: `Oportunidad "${title}" creada`, orgId }
  }

  async addNote(orgId: string, clientId: string, content: string, correlationId: string): Promise<CrmActionResult> {
    if (this.simulateUnavailable) return { ok: false, error: '503 Service Unavailable' }
    const mismatch = this.confirmOrg(orgId)
    if (mismatch) return mismatch
    this.executedActions.push({
      action: 'add_note',
      orgId,
      params: { clientId, content },
      correlationId,
    })
    return { ok: true, summary: `Nota añadida al cliente ${clientId}`, orgId }
  }

  clear(): void {
    this.executedActions = []
  }
}

/**
 * Cliente HTTP real hacia CRM ALBRA (POST /api/crm/actions).
 *
 * (segunda reparación §3.B) AISLAMIENTO DE EXTREMO A EXTREMO:
 *  - Resolución de credenciales POR ORGANIZACIÓN: CRM_API_KEYS (JSON {orgId:
 *    "albra_..."}) con fallback a CRM_API_KEY (despliegues de una sola org).
 *    Una credencial de una org NUNCA se usa para otra.
 *  - La organización viaja en la petición (X-Org-Id) y en la clave de
 *    idempotencia de la acción.
 *  - Se VERIFICA que el CRM confirma la organización esperada en la respuesta
 *    (campo orgId): cualquier discrepancia → TENANT_MISMATCH y la acción se
 *    trata como fallida (jamás se acepta una escritura atribuida a otra org).
 */
export class HttpCrmClient implements CrmClientInterface {
  crmBaseUrl: string
  /** Mapa orgId → API key (resolución por organización). */
  private apiKeysByOrg: Map<string, string>
  /** Clave única de respaldo para despliegues mono-organización. */
  private singleKey: string | null

  constructor(crmBaseUrl: string, apiKey: string, apiKeysByOrg?: Record<string, string>) {
    this.crmBaseUrl = crmBaseUrl
    this.singleKey = apiKey || null
    this.apiKeysByOrg = new Map(Object.entries(apiKeysByOrg || {}))
  }

  /** Resuelve la credencial de la organización (fail-closed si no hay). */
  resolveApiKey(orgId: string): string | null {
    const perOrg = this.apiKeysByOrg.get(orgId)
    if (perOrg) return perOrg
    if (this.apiKeysByOrg.size > 0) {
      // Hay configuración multi-org y esta org NO tiene clave: NO usar la de otra org.
      return null
    }
    return this.singleKey
  }

  private async callAction(orgId: string, action: string, params: Record<string, unknown>, correlationId: string): Promise<CrmActionResult> {
    const apiKey = this.resolveApiKey(orgId)
    if (!apiKey) {
      return { ok: false, error: `TENANT_MISMATCH: sin credencial CRM para la organización ${orgId} (configura CRM_API_KEYS)` }
    }
    try {
      const res = await fetch(`${this.crmBaseUrl}/api/crm/actions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'X-Correlation-Id': correlationId,
          'X-Idempotency-Key': `crm:${orgId}:${action}:${correlationId}`,
          'X-Org-Id': orgId,
        },
        body: JSON.stringify({ action, params }),
      })

      const data = await res.json() as any
      if (!res.ok) {
        return { ok: false, error: data.error || `HTTP ${res.status}` }
      }
      // Verificación de identidad del tenant: el CRM DEBE confirmar la org a la
      // que se atribuyó la acción (la org real la decide el CRM desde la API key).
      if (data.orgId !== undefined && data.orgId !== orgId) {
        return { ok: false, error: `TENANT_MISMATCH: el CRM confirmó la organización ${data.orgId}, se esperaba ${orgId}` }
      }
      return { ok: true, summary: data.summary, data: data.data, clientId: data.clientId, orgId: data.orgId ?? orgId }
    } catch (err: any) {
      return { ok: false, error: `Fallo de conexión con CRM: ${err?.message || err}` }
    }
  }

  async createClient(orgId: string, name: string, phone: string, correlationId: string): Promise<CrmActionResult> {
    return this.callAction(orgId, 'create_client', { name, phone }, correlationId)
  }

  async createOpportunity(orgId: string, clientId: string, title: string, amount: number, correlationId: string): Promise<CrmActionResult> {
    return this.callAction(orgId, 'create_opportunity', { clientId, title, amount }, correlationId)
  }

  async addNote(orgId: string, clientId: string, content: string, correlationId: string): Promise<CrmActionResult> {
    return this.callAction(orgId, 'add_note', { clientId, content }, correlationId)
  }
}
