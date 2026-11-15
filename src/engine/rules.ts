const HANDOFF_KEYWORDS = ['asesor', 'humano', 'persona', 'agente', 'hablar con alguien', 'soporte humano']

export interface RuleEvaluation {
  matched: boolean
  intent: 'handoff' | 'pricing' | 'catalog' | 'none'
  responseTemplate?: string
  action?: 'handoff_human' | 'reply_only' | 'create_deal'
}

export function evaluateDeterministicRules(messageText: string): RuleEvaluation {
  const clean = messageText.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

  // 1. Evaluación de solicitud de asesor humano
  if (HANDOFF_KEYWORDS.some((kw) => clean.includes(kw))) {
    return {
      matched: true,
      intent: 'handoff',
      action: 'handoff_human',
      responseTemplate: '🤖 Entendido. Te estoy transfiriendo con un asesor de nuestro equipo. En un momento se comunicará contigo por este mismo chat.',
    }
  }

  // 2. Consulta de Precios / Planes
  if (['precio', 'precios', 'costo', 'planes', 'cuanto cuesta'].some((kw) => clean.includes(kw))) {
    return {
      matched: true,
      intent: 'pricing',
      action: 'reply_only',
      responseTemplate: '📌 Nuestros planes vigentes son:\n1️⃣ Plan Emprendedor: $29/mes (Gestión de contactos y WhatsApp).\n2️⃣ Plan Comercial: $79/mes (Pipeline, cotizaciones y automatizaciones).\n\n¿Deseas que un asesor te agende una demostración personalizada? Responde "ASESOR".',
    }
  }

  // 3. Consulta de Catálogo / Servicios
  if (['catalogo', 'servicios', 'portafolio', 'que hacen'].some((kw) => clean.includes(kw))) {
    return {
      matched: true,
      intent: 'catalog',
      action: 'reply_only',
      responseTemplate: '💼 En ALBRA ofrecemos soluciones de automatización comercial, integración de WhatsApp y CRM especializado para equipos de ventas. ¿Te interesa conocer nuestros precios? Escribe "PRECIO".',
    }
  }

  return {
    matched: false,
    intent: 'none',
  }
}
