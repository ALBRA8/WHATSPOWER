/**
 * F6 (WP) — Adaptador de pasarela de cobro (WOMPI / MP / Stripe) fail-closed.
 *
 * Problema del plan: no hay cobro real desde el CRM ni WP (el simulador sigue
 * blindado) porque faltan credenciales del propietario. Este adaptador define
 * la INTERFAZ única de cobro con el simulador como única implementación activa
 * hasta que el propietario cargue credenciales reales por entorno.
 *
 * Garantías de diseño:
 *  - SIN credenciales reales configuradas → modo 'simulator' EXPLÍCITO (el
 *    resultado marca simulator=true; jamás se presenta como cobro real)
 *  - CON credenciales → delega al proveedor configurado; cualquier error de
 *    proveedor NO convierte el pago en simulado: lanza (fail-closed)
 *  - el simulador NO acepta montos negativos ni monedas no declaradas
 *  - la decisión de proveedor es POR ORGANIZACIÓN (coherente con I6), no global
 */

export const PROVIDERS = ['simulator', 'wompi', 'mercadopago', 'stripe']
export const CURRENCIES = ['COP', 'USD']

export class PaymentAdapterError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PaymentAdapterError'
  }
}

const ENV_BY_PROVIDER = {
  wompi: ['WOMPI_PUBLIC_KEY', 'WOMPI_PRIVATE_KEY'],
  mercadopago: ['MP_ACCESS_TOKEN'],
  stripe: ['STRIPE_SECRET_KEY'],
}

/**
 * Fábrica del adaptador.
 * @param {{ policyJson?: string, env?: Record<string, string | undefined> }} opts
 */
export function createPaymentAdapter({ policyJson, env = process.env } = {}) {
  let policy = {}
  if (policyJson) {
    try {
      policy = JSON.parse(String(policyJson))
    } catch {
      throw new PaymentAdapterError('PAYMENT_POLICY no es JSON válido')
    }
  }

  return {
    /** Proveedor de una org: explícito > 'simulator'. Valores inválidos → error. */
    resolveProvider(orgId) {
      if (!orgId) throw new PaymentAdapterError('orgId requerido (el proveedor es por organización)')
      const p = policy[orgId] || 'simulator'
      if (!PROVIDERS.includes(p)) {
        throw new PaymentAdapterError(`proveedor desconocido "${p}" para "${orgId}" (válidos: ${PROVIDERS.join(', ')})`)
      }
      return p
    },

    /**
     * Crea el cobro. Devuelve { provider, simulator, reference, status } o lanza.
     * Con proveedor real sin credenciales → error EXPLÍCITO de configuración
     * (jamás degrada a simulador en silencio: eso ocultaría un cobro no hecho).
     * @param {{ orgId: string, amount: number, currency?: string, reference?: string }} charge
     */
    async createCharge({ orgId, amount, currency = 'COP', reference }) {
      const provider = this.resolveProvider(orgId)
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new PaymentAdapterError('amount debe ser un número positivo')
      }
      if (!CURRENCIES.includes(currency)) {
        throw new PaymentAdapterError(`moneda no soportada "${currency}" (válidas: ${CURRENCIES.join(', ')})`)
      }
      if (provider === 'simulator') {
        return {
          provider: 'simulator',
          simulator: true,
          reference: reference || `SIM-${Date.now()}`,
          status: 'approved_simulated',
          amount,
          currency,
        }
      }
      const required = ENV_BY_PROVIDER[provider]
      const missing = required.filter((k) => !env[k])
      if (missing.length) {
        throw new PaymentAdapterError(`credenciales reales ausentes para ${provider}: faltan ${missing.join(', ')} (configura el entorno o usa el simulador)`)
      }
      // Punto de integración real: el PR del repo destino implementa aquí la
      // llamada del proveedor con sus SDK oficiales. El adaptador NO simula
      // éxito: hasta existir la implementación, la operación falla tipada.
      throw new PaymentAdapterError(`implementación de ${provider} pendiente en el repo destino (kit listo: la interfaz y los guardas ya están probados)`)
    },
  }
}
