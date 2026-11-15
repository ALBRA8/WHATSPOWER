/**
 * meta-error-classifier.ts — Mapeo de errores de Meta Graph API a estados de dominio explícitos.
 * Prohíbe reintentos ciegos ante rechazos por límites, degradación de calidad, o plantillas.
 */

export interface ClassifiedMetaError {
  state: string
  retryable: boolean
  uncertain: boolean
  message: string
  subcode?: number
}

export function classifyMetaError(httpStatus: number, responseBody: any): ClassifiedMetaError {
  const errObj = responseBody?.error || {}
  const code = Number(errObj.code ?? 0)
  const subcode = Number(errObj.error_subcode ?? code)
  const rawMsg = String(errObj.message ?? 'Unknown Meta Graph API error')

  // 1. Límites de tasa / spam (Throughput limit / Spam rate limit)
  if (code === 131048 || subcode === 131048 || code === 130429 || subcode === 130429) {
    return {
      state: 'META_RATE_LIMIT_EXCEEDED',
      retryable: false,
      uncertain: false,
      message: `Meta Rate Limit Exceeded: ${rawMsg}`,
      subcode,
    }
  }

  // 2. Calidad del número degradada / restricción de cuenta
  if (code === 131049 || subcode === 131049) {
    return {
      state: 'META_NUMBER_QUALITY_DEGRADED',
      retryable: false,
      uncertain: false,
      message: `Meta Phone Number Quality Degraded: ${rawMsg}`,
      subcode,
    }
  }

  // 3. Plantilla rechazada, pausada o inexistente
  if (code === 132000 || subcode === 132000 || code === 132001 || subcode === 132001 || code === 132007 || subcode === 132007) {
    return {
      state: 'META_TEMPLATE_REJECTED',
      retryable: false,
      uncertain: false,
      message: `Meta Template Rejected or Inactive: ${rawMsg}`,
      subcode,
    }
  }

  // 4. Fuera de ventana de 24 horas (re-engagement message window expired)
  if (code === 131047 || subcode === 131047) {
    return {
      state: 'META_WINDOW_EXPIRED',
      retryable: false,
      uncertain: false,
      message: `Meta 24h Customer Service Window Expired: ${rawMsg}`,
      subcode,
    }
  }

  // 5. Destinatario no registrado en WhatsApp
  if (code === 131056 || subcode === 131056) {
    return {
      state: 'META_NOT_ON_WHATSAPP',
      retryable: false,
      uncertain: false,
      message: `Recipient Phone Not On WhatsApp: ${rawMsg}`,
      subcode,
    }
  }

  // Códigos 4xx rechazables estándar (confirmado sin entrega)
  if (httpStatus >= 400 && httpStatus < 500) {
    return {
      state: `META_HTTP_${httpStatus}_REJECTED`,
      retryable: false,
      uncertain: false,
      message: rawMsg,
      subcode,
    }
  }

  // Errores 5xx / conexión / timeout son inciertos (el mensaje pudo haberse procesado)
  return {
    state: `META_HTTP_${httpStatus}_UNCERTAIN`,
    retryable: false,
    uncertain: true,
    message: `Uncertain Meta API Result (${httpStatus}): ${rawMsg}`,
    subcode,
  }
}
