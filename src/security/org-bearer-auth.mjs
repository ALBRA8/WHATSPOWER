/**
 * S3 (WP) — Bearer POR ORGANIZACIÓN con comparación timing-safe.
 *
 * Problema del plan: un secreto operador GLOBAL concentra acceso a TODAS las
 * organizaciones; cualquier proceso con ese secreto fija `X-Org-Id` arbitrario
 * (cross-org). Solución del CRM (misma barrera del webhook de WhatsApp: el
 * tenant NO viene del body/header creíble, viene de la CREDENCIAL que matchea):
 *   credenciales = JSON { "<orgId>": "<credencial>" }  (variable de entorno o
 *   archivo secreto); la org se determina por la credencial presentada.
 *
 * Uso:
 *   const auth = requireOrgServiceCredentials(env('WP_ORG_SERVICE_CREDENTIALS'))
 *   const result = auth.authenticate(bearerToken)  // → { orgId } | null
 *   if (!result) 401  // jamás revelar cuántas orgs existen ni cuál falló
 *
 * Migración segura: conserva el secreto global como credencial de EMERGENCIA
 * mapeada a ninguna org (`authenticateGlobal`, solo lectura de estado) y
 * elimínalo cuando todos los emisores hayan migrado. Ver README.
 */
import { timingSafeEqual } from 'node:crypto'

export class OrgServiceCredentialsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OrgServiceCredentialsError'
  }
}

function safeEquals(provided, expected) {
  if (!provided || !expected) return false
  const a = Buffer.from(String(provided))
  const b = Buffer.from(String(expected))
  return a.length === b.length && timingSafeEqual(a, b)
}

export function requireOrgServiceCredentials(rawJson) {
  if (!rawJson) {
    throw new OrgServiceCredentialsError('WP_ORG_SERVICE_CREDENTIALS no configurado (fail-closed: sin credenciales por-org no hay acceso S2S)')
  }
  let parsed
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    throw new OrgServiceCredentialsError('WP_ORG_SERVICE_CREDENTIALS no es JSON válido (esperado {"orgId":"credencial"})')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OrgServiceCredentialsError('WP_ORG_SERVICE_CREDENTIALS debe ser un objeto {"orgId":"credencial"}')
  }
  const entries = Object.entries(parsed).filter(([, v]) => typeof v === 'string' && v.length >= 16)
  if (entries.length === 0) {
    throw new OrgServiceCredentialsError('WP_ORG_SERVICE_CREDENTIALS sin credenciales válidas (mínimo 16 caracteres)')
  }

  return {
    /**
     * Autentica un Bearer y devuelve la org que le corresponde. Comparación
     * timing-safe CONTRA CADA credencial: un token inválido no revela si la
     * org existe. Devuelve null si no matchea ninguna (el handler responde 401).
     */
    authenticate(bearerToken) {
      if (!bearerToken) return null
      for (const [orgId, credential] of entries) {
        if (safeEquals(bearerToken, credential)) return { orgId }
      }
      return null
    },

    /** ¿La org pedida coincide EXACTAMENTE con la autenticada? (defensa extra) */
    authorizeOrg(authResult, requestedOrgId) {
      return !!authResult && typeof requestedOrgId === 'string' && authResult.orgId === requestedOrgId
    },

    /** Número de organizaciones con credencial (para el runbook, no para logs). */
    orgCount() {
      return entries.length
    },
  }
}
