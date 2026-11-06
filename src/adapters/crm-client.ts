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
 * (tercera reparación 4.D) simulateMissingOrg permite simular un CRM que NO
 * confirma la organización en la respuesta → el consumidor debe RECHAZAR la
 * respuesta ambigua (TENANT_UNVERIFIED), nunca aceptarla.
 */
export class MockCrmClient implements CrmClientInterface {
  public executedActions: MockActionRecord[] = []
  private simulateUnavailable = false
  /** Si se fija, las respuestas del "CRM" llevan ese orgId (para simular mismatch). */
  simulateResponseOrgId?: string
  /** Si es true, las respuestas del "CRM" OMITEN el orgId (respuesta ambigua). */
  simulateMissingOrg = false

  setSimulateUnavailable(val: boolean): void {
    this.simulateUnavailable = val
  }

  private confirmOrg(orgId: string): CrmActionResult | null {
    // El CRM REAL devuelve el orgId de la API key usada; el Mock emula los casos
    // de discrepancia/omisión cuando sus flags de simulación están fijados.
    if (this.simulateMissingOrg) return null // respuesta SIN org: el consumidor debe rechazarla
    if (this.simulateResponseOrgId && this.simulateResponseOrgId !== orgId) {
      return { ok: false, error: `TENANT_MISMATCH: el CRM confirmó la organización ${this.simulateResponseOrgId}, se esperaba ${orgId}` }
    }
    return null
  }

  private resultWithOrg(orgId: string, summary: string, extra: Record<string, unknown> = {}): CrmActionResult {
    if (this.simulateMissingOrg) {
      // Respuesta ambigua: SIN confirmación de organización (el consumidor debe rechazarla)
      return { ok: true, summary, ...extra } as CrmActionResult
    }
    return { ok: true, summary, orgId, ...extra }
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
    return this.resultWithOrg(orgId, `Cliente "${name}" creado`, { clientId })
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
    return this.resultWithOrg(orgId, `Oportunidad "${title}" creada`)
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
    return this.resultWithOrg(orgId, `Nota añadida al cliente ${clientId}`)
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
 *  - Se EXIGE que el CRM confirme la organización en la respuesta (campo
 *    orgId): una respuesta SIN organización se rechaza como ambigua
 *    (TENANT_UNVERIFIED — jamás se acepta una escritura no verificada) y una
 *    discrepancia se rechaza (TENANT_MISMATCH). Errores de autenticación o de
 *    tenant del CRM se tratan como fallo (fail-closed): nunca se acepta una
 *    respuesta ambigua como válida.
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

      const rawText = await res.text()
      if (!res.ok) {
        // Errores de autenticación/tenant del CRM: fail-closed (nunca se acepta como éxito)
        let detail = `HTTP ${res.status}`
        try { detail = (JSON.parse(rawText) as { error?: string }).error || detail } catch {}
        return { ok: false, error: detail }
      }
      let data: any
      try {
        data = JSON.parse(rawText)
      } catch {
        // Respuesta no-JSON: ambigua → se rechaza (jamás se acepta como válida)
        return { ok: false, error: 'TENANT_UNVERIFIED: el CRM no devolvió una respuesta JSON verificable' }
      }
      // Verificación ESTRICTA de identidad del tenant (tercera reparación 4.D):
      // el CRM DEBE confirmar la organización a la que se atribuyó la acción.
      //  - Sin campo orgId → TENANT_UNVERIFIED (respuesta ambigua, se rechaza).
      //  - orgId distinto al esperado → TENANT_MISMATCH (escritura ajena, se rechaza).
      if (typeof data?.orgId !== 'string' || data.orgId.length === 0) {
        return { ok: false, error: 'TENANT_UNVERIFIED: el CRM no confirmó la organización en la respuesta (se exige orgId en el contrato)' }
      }
      if (data.orgId !== orgId) {
        return { ok: false, error: `TENANT_MISMATCH: el CRM confirmó la organización ${data.orgId}, se esperaba ${orgId}` }
      }
      return { ok: true, summary: data.summary, data: data.data, clientId: data.clientId, orgId: data.orgId }
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
