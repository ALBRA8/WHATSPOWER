/**
 * org-wa-registry.ts — Registro de conexiones WhatsApp POR ORGANIZACIÓN
 * (OLEADA 2, decisión de negocio 2026-11-11).
 *
 * Responsabilidades (puntos 2, 3, 6 y 7 de la decisión):
 *  1. SABER qué número(s) tiene conectados cada organización (identidad).
 *  2. ATRIBUIR automáticamente un phoneNumberId entrante a su organización
 *     (punto 4: identificación automática por número).
 *  3. RESOLVER la credencial (token) de una organización para despachar sus
 *     envíos (punto 6) — el token solo vive EN MEMORIA con TTL corto; NUNCA
 *     se persiste en la BD de WHATSPOWER ni se loguea.
 *  4. AISLAMIENTO: una organización jamás resuelve conexiones ni credenciales
 *     de otra (punto 8) — fail-closed.
 *
 * Fuentes de verdad (en orden de prioridad):
 *  - CRM (Capa 1, administrador de conexiones): endpoint interno autenticado
 *    con la credencial de servicio POR ORGANIZACIÓN (contrato §1):
 *      GET {CRM}/api/internal/whatsapp/credentials                → inventario
 *      GET {CRM}/api/internal/whatsapp/credentials?phoneNumberId= → token
 *  - Variables de entorno para despliegues standalone:
 *      WA_ORG_NUMBERS="orgId:phoneId,orgId:phoneId"     (identidad)
 *      WA_ORG_CREDENTIALS="orgId:phoneId:token,..."     (credenciales)
 *  Si ninguna fuente puede resolver → null y el llamador FALLA CERRADO
 *  (el mensaje no sale con credenciales equivocadas JAMÁS).
 */
import { safeEqual } from './security.ts'

export interface WaConnectionInfo {
  organizationId: string
  connectionId: string | null
  phoneNumberId: string
  phoneNumber: string | null
  wabaId: string | null
}

export interface WaCredential {
  organizationId: string
  phoneNumberId: string
  connectionId: string | null
  accessToken: string
  /** Fecha de expiración del cacheo (epoch ms). El token NO se persiste. */
  cachedUntil: number
}

export interface WaRegistrySource {
  /** Inventario de conexiones conectadas de UNA organización. */
  listForOrg(orgId: string): Promise<WaConnectionInfo[]>
  /** Resuelve la credencial del número indicado SIEMPRE que pertenezca a orgId. */
  resolveCredential(orgId: string, phoneNumberId: string): Promise<Pick<WaCredential, 'accessToken' | 'connectionId' | 'phoneNumberId'> | null>
}

// ===========================================================================
// Fuente ENV (despliegues standalone)
// ===========================================================================

export interface EnvRegistryConfig {
  /** "orgId:phoneId,orgId2:phoneId2" — identidad org→números. */
  waOrgNumbers?: string
  /** "orgId:phoneId:token,..." — credenciales por org (solo memoria). */
  waOrgCredentials?: string
}

interface EnvCredentialEntry {
  orgId: string
  phoneNumberId: string
  accessToken: string
}

export function parseOrgNumbers(raw: string | undefined): Array<{ orgId: string; phoneNumberId: string }> {
  const out: Array<{ orgId: string; phoneNumberId: string }> = []
  if (!raw) return out
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':')
    if (idx <= 0) continue
    const orgId = pair.slice(0, idx).trim()
    const phoneNumberId = pair.slice(idx + 1).trim()
    if (orgId && phoneNumberId && /^[a-zA-Z0-9_-]{1,64}$/.test(orgId)) out.push({ orgId, phoneNumberId })
  }
  return out
}

export function parseOrgCredentials(raw: string | undefined): EnvCredentialEntry[] {
  const out: EnvCredentialEntry[] = []
  if (!raw) return out
  for (const triple of raw.split(',')) {
    const parts = triple.split(':')
    if (parts.length !== 3) continue
    const [orgId, phoneNumberId, accessToken] = parts.map((s) => s.trim())
    if (!orgId || !phoneNumberId || !accessToken || accessToken.length < 16) continue
    out.push({ orgId, phoneNumberId, accessToken })
  }
  return out
}

/** Fuente de solo-entorno: identidad y credenciales declaradas por el operador. */
export class EnvRegistrySource implements WaRegistrySource {
  private numbers: Array<{ orgId: string; phoneNumberId: string }>
  private credentials: EnvCredentialEntry[]

  constructor(config: EnvRegistryConfig = {}) {
    this.numbers = parseOrgNumbers(config.waOrgNumbers ?? process.env.WA_ORG_NUMBERS)
    this.credentials = parseOrgCredentials(config.waOrgCredentials ?? process.env.WA_ORG_CREDENTIALS)
  }

  async listForOrg(orgId: string): Promise<WaConnectionInfo[]> {
    return this.numbers
      .filter((n) => safeEqual(n.orgId, orgId))
      .map((n) => ({
        organizationId: orgId,
        connectionId: null,
        phoneNumberId: n.phoneNumberId,
        phoneNumber: null,
        wabaId: null,
      }))
  }

  async resolveCredential(orgId: string, phoneNumberId: string) {
    const entry = this.credentials.find(
      (c) => safeEqual(c.orgId, orgId) && safeEqual(c.phoneNumberId, phoneNumberId),
    )
    return entry
      ? { accessToken: entry.accessToken, connectionId: null, phoneNumberId: entry.phoneNumberId }
      : null
  }
}

// ===========================================================================
// Fuente CRM (administrador de conexiones — contrato OLEADA 2)
// ===========================================================================

export class CrmRegistrySource implements WaRegistrySource {
  private credentialByOrg: string

  /**
   * @param credentialByOrg credencial de servicio DE UNA organización
   *   (formato contrato §1). Cada llamada se hace autenticada como ESA org:
   *   el CRM jamás entrega conexiones ni tokens de otra organización.
   */
  constructor(credentialByOrg: string) {
    if (!credentialByOrg || credentialByOrg.length < 16) {
      throw new Error('CrmRegistrySource exige una credencial de servicio de organización (>=16 chars)')
    }
    this.credentialByOrg = credentialByOrg
  }

  private async crmGet(url: string): Promise<Response | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      return await fetch(url, {
        headers: { Authorization: `Bearer ${this.credentialByOrg}` },
        signal: controller.signal,
      })
    } catch {
      return null // CRM no disponible: fail-closed en el llamador
    } finally {
      clearTimeout(timer)
    }
  }

  async listForOrg(orgId: string): Promise<WaConnectionInfo[]> {
    const base = process.env.CRM_BASE_URL || 'http://localhost:3000'
    const res = await this.crmGet(`${base}/api/internal/whatsapp/credentials`)
    if (!res || !res.ok) return []
    const body = (await res.json().catch(() => null)) as {
      organizationId?: string
      connections?: Array<{ id: string; phoneNumberId: string; phoneNumber: string; wabaId: string | null }>
    } | null
    // Verificación de identidad: el CRM confirma a qué org pertenece lo
    // entregado. Si no coincide con la org solicitada → fail-closed ([]).
    if (!body || !body.organizationId || !safeEqual(body.organizationId, orgId)) return []
    return (body.connections ?? []).map((c) => ({
      organizationId: orgId,
      connectionId: c.id,
      phoneNumberId: c.phoneNumberId,
      phoneNumber: c.phoneNumber,
      wabaId: c.wabaId,
    }))
  }

  async resolveCredential(orgId: string, phoneNumberId: string) {
    const base = process.env.CRM_BASE_URL || 'http://localhost:3000'
    const res = await this.crmGet(`${base}/api/internal/whatsapp/credentials?phoneNumberId=${encodeURIComponent(phoneNumberId)}`)
    if (!res || !res.ok) return null
    const body = (await res.json().catch(() => null)) as {
      organizationId?: string
      connectionId?: string
      phoneNumberId?: string
      accessToken?: string
    } | null
    if (!body?.accessToken || !body.organizationId || !safeEqual(body.organizationId, orgId)) return null
    return { accessToken: body.accessToken, connectionId: body.connectionId ?? null, phoneNumberId: body.phoneNumberId ?? phoneNumberId }
  }
}

// ===========================================================================
// Registro con caché en memoria (tokens con TTL — nunca en disco)
// ===========================================================================

const TOKEN_TTL_MS = 5 * 60 * 1000 // 5 min: token en memoria, no en disco
const IDENTITY_TTL_MS = 60 * 1000 // inventario de números: 1 min

export class OrgWaRegistry {
  private sources: WaRegistrySource[]
  private identityCache = new Map<string, { connections: WaConnectionInfo[]; cachedUntil: number }>()
  private credentialCache = new Map<string, { credential: WaCredential }>()

  constructor(sources?: WaRegistrySource[]) {
    this.sources = sources ?? [
      new EnvRegistrySource(),
      ...(process.env.CRM_INTERNAL_CREDENTIAL ? [new CrmRegistrySource(process.env.CRM_INTERNAL_CREDENTIAL)] : []),
    ]
  }

  /** Invalida TODA la caché (rotación de credenciales, pruebas). */
  invalidate(): void {
    this.identityCache.clear()
    this.credentialCache.clear()
  }

  /** Atribución automática: a qué organización pertenece un phoneNumberId. */
  async resolveOrgByPhoneNumberId(phoneNumberId: string): Promise<WaConnectionInfo | null> {
    if (!phoneNumberId) return null
    const now = Date.now()
    // Consulta el inventario de cada org cacheada; para orgs no cacheadas,
    // la identidad viene de las fuentes (env o CRM). Para no sondear orgs
    // infinitas, la fuente env es el índice completo; la fuente CRM usa el
    // índice declarado en WA_ORG_NUMBERS (orgId:phoneId) como guía de sondeo.
    const index = parseOrgNumbers(process.env.WA_ORG_NUMBERS)
    const candidates = new Set<string>(index.filter((i) => i.phoneNumberId === phoneNumberId).map((i) => i.orgId))
    if (candidates.size === 0) {
      for (const conn of this.identityCache.values()) {
        const hit = conn.connections.find((c) => c.phoneNumberId === phoneNumberId)
        if (hit && conn.cachedUntil > now) return hit
      }
      return null
    }
    for (const orgId of candidates) {
      const connections = await this.listForOrg(orgId)
      const hit = connections.find((c) => c.phoneNumberId === phoneNumberId)
      if (hit) return hit
    }
    return null
  }

  /** Inventario de conexiones conectadas de UNA organización (con caché 60s). */
  async listForOrg(orgId: string): Promise<WaConnectionInfo[]> {
    const now = Date.now()
    const cached = this.identityCache.get(orgId)
    if (cached && cached.cachedUntil > now) return cached.connections
    const connections: WaConnectionInfo[] = []
    for (const source of this.sources) {
      try {
        const listed = await source.listForOrg(orgId)
        connections.push(...listed)
      } catch {
        // una fuente caída no autoriza usar otra org: solo se acumula lo válido
      }
    }
    this.identityCache.set(orgId, { connections, cachedUntil: now + IDENTITY_TTL_MS })
    return connections
  }

  /**
   * Resuelve la credencial de UNA organización para UN número. La org SIEMPRE
   * se compara contra la fuente (punto 8): una credencial de org-a jamás
   * sirve un token de org-b.
   */
  async resolveCredential(orgId: string, phoneNumberId: string): Promise<WaCredential | null> {
    const cacheKey = `${orgId}::${phoneNumberId}`
    const cached = this.credentialCache.get(cacheKey)
    if (cached && cached.credential.cachedUntil > Date.now()) return cached.credential
    for (const source of this.sources) {
      try {
        const resolved = await source.resolveCredential(orgId, phoneNumberId)
        if (resolved) {
          const credential: WaCredential = {
            organizationId: orgId,
            phoneNumberId: resolved.phoneNumberId,
            connectionId: resolved.connectionId,
            accessToken: resolved.accessToken,
            cachedUntil: Date.now() + TOKEN_TTL_MS,
          }
          this.credentialCache.set(cacheKey, { credential })
          return credential
        }
      } catch {
        // fuente caída → siguiente fuente; sin fuentes válidas → null (fail-closed)
      }
    }
    return null
  }
}
