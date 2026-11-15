/**
 * transport-selector.ts — Selección de transporte de WhatsApp según plan de organización y salvaguardas.
 *
 * REGLAS:
 *  - Meta Cloud API es el transporte por defecto para organizaciones de pago (plan: paid).
 *  - Baileys (canal no oficial / web) queda restringido al plan básico y viene DESACTIVADO por defecto.
 *  - Baileys SOLO puede activarse si la organización acepta explícitamente el aviso de riesgo
 *    (baileysRiskAcknowledged: true). De lo contrario, falla seguro (fail-closed).
 */

export type OrganizationPlan = 'paid' | 'basic'
export type WhatsAppTransportType = 'meta-cloud' | 'baileys' | 'mock'

export interface OrganizationPlanConfig {
  organizationId: string
  plan?: OrganizationPlan
  preferredTransport?: WhatsAppTransportType
  baileysRiskAcknowledged?: boolean
}

export interface TransportResolutionResult {
  allowed: boolean
  selectedTransport?: WhatsAppTransportType
  error?: string
  warning?: string
}

export const BAILEYS_RISK_WARNING =
  'AVISO EXPLÍCITO DE ALTO RIESGO: El canal Baileys utiliza emulación no oficial de WhatsApp Web. Meta/WhatsApp monitorea y suspende de forma permanente números y cuentas asociadas por violación de los Términos de Servicio. Para entornos comerciales y producción con clientes de pago, se recomienda exclusivamente la Meta Cloud API Oficial.'

export function resolveOrganizationTransportPlan(config: OrganizationPlanConfig): TransportResolutionResult {
  const plan = config.plan ?? 'paid'
  const requested = config.preferredTransport ?? (plan === 'paid' ? 'meta-cloud' : 'baileys')

  // Si se solicita o resuelve Meta Cloud API (transporte oficial)
  if (requested === 'meta-cloud') {
    return {
      allowed: true,
      selectedTransport: 'meta-cloud',
    }
  }

  // Si se solicita Baileys (transporte no oficial)
  if (requested === 'baileys') {
    if (!config.baileysRiskAcknowledged) {
      return {
        allowed: false,
        error: `BAILEYS_RISK_NOT_ACKNOWLEDGED: El canal no oficial Baileys está desactivado por defecto para la organización "${config.organizationId}". Debe activarse explícitamente aceptando el aviso de riesgo de baneo de Meta (baileysRiskAcknowledged=true).`,
      }
    }
    return {
      allowed: true,
      selectedTransport: 'baileys',
      warning: BAILEYS_RISK_WARNING,
    }
  }

  if (requested === 'mock') {
    return {
      allowed: true,
      selectedTransport: 'mock',
    }
  }

  return {
    allowed: false,
    error: `UNKNOWN_TRANSPORT: Transporte desconocido "${requested}".`,
  }
}
