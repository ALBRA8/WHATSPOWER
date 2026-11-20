/**
 * I6 (WP + ULTRA) — Selector de transporte POR POLÍTICA por organización.
 *
 * Problema del plan: la elección de transporte sigue siendo la variable global
 * `TRANSPORT` (una sola para todo el sistema). `transport-selector.ts` ya está
 * probado aislado; esta lib portable resuelve el transporte por org con
 * política declarada y fail-closed.
 *
 * Política por org (JSON en WP_TRANSPORT_POLICY):
 *   { "org-a": "cloud_api", "org-b": "baileys", "*": "baileys" }
 * Prioridad: política explícita de la org > default "*" > error (fail-closed).
 *
 * La lista de transportes válidos es la del ecosistema: cloud_api | baileys.
 * Un valor desconocido en la política NO degrada a la global: lanza (fail-closed)
 * para que el despliegue corrija su configuración en vez de enviar por el canal
 * equivocado.
 */

export const TRANSPORTS = ['cloud_api', 'baileys']

export class TransportPolicyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TransportPolicyError'
  }
}

export function createTransportPolicy(rawJson, { requireExplicit = true } = {}) {
  let policy = {}
  if (rawJson && String(rawJson).trim()) {
    try {
      policy = JSON.parse(String(rawJson))
    } catch {
      throw new TransportPolicyError('WP_TRANSPORT_POLICY no es JSON válido')
    }
    if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
      throw new TransportPolicyError('WP_TRANSPORT_POLICY debe ser un objeto {"orgId":"transporte"}')
    }
    for (const [org, transport] of Object.entries(policy)) {
      if (!TRANSPORTS.includes(transport)) {
        throw new TransportPolicyError(`transporte desconocido "${transport}" para org "${org}" (válidos: ${TRANSPORTS.join(', ')})`)
      }
    }
  } else if (requireExplicit) {
    throw new TransportPolicyError('WP_TRANSPORT_POLICY no configurado (fail-closed: sin política no se elige transporte)')
  }

  return {
    /**
     * Resuelve el transporte de una organización. La org sin entrada explícita
     * usa el "*" si existe; sin "*" y con requireExplicit → error (fail-closed).
     */
    resolve(orgId) {
      if (!orgId || typeof orgId !== 'string') {
        throw new TransportPolicyError('orgId requerido para resolver transporte (jamás una variable global)')
      }
      const explicit = policy[orgId]
      if (explicit) return { transport: explicit, source: 'org_policy' }
      if (policy['*']) return { transport: policy['*'], source: 'default' }
      throw new TransportPolicyError(`sin política de transporte para la org "${orgId}" ni default "*"; configúrala en WP_TRANSPORT_POLICY`)
    },
  }
}
