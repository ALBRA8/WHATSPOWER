/**
 * M3 (WP + ULTRA) — Guard de despacho real por Meta: ventana 24 h, plantillas
 * y clasificador ANTES de enviar.
 *
 * Problema del plan: los rechazos evitables 131047/131048 (fuera de la ventana
 * de 24 h / plantilla no aprobada) degradan la calidad del número. Los stores
 * que lo resuelven ya están probados en el CRM; este guard portable decide
 * SEND / SKIP con motivo ANTES de invocar a la Graph API.
 *
 * Reglas (verificadas en tests/kits/m3-meta-dispatch-guard.test.ts):
 *  - mensaje con plantilla APROBADA: se permite SIEMPRE (las plantillas no
 *    tienen ventana) → SEND
 *  - mensaje libre (texto) dentro de la ventana 24 h del último mensaje del
 *    USUARIO → SEND
 *  - mensaje libre fuera de ventana → SKIP con motivo window_24h (el operador
 *    envía plantilla; jamás se "ayuda" inventando plantilla)
 *  - plantilla con estado != APPROVED → SKIP con motivo template_not_approved
 *  - plantilla PAUSED/limit_reached → SKIP template_paused
 *  - sin registro del último mensaje del usuario → SKIP no_inbound_24h
 *    (fail-closed: no se asume ventana abierta)
 */
export const SKIP_REASONS = ['window_24h', 'no_inbound_24h', 'template_not_approved', 'template_paused']

/**
 * @param msg        { text: string, templateName?: string }
 * @param ctx        { lastInboundAt?: Date|null, templateStatus?: 'APPROVED'|'PENDING'|'REJECTED'|'PAUSED'|null, nowMs?: number }
 * @returns          { decision: 'send'|'skip', reason?: string }
 */
export function decideMetaDispatch(msg, ctx = {}) {
  const now = ctx.nowMs ?? Date.now()

  // 1) Plantilla declarada: valida su estado antes de cualquier otra regla.
  if (msg.templateName) {
    const status = ctx.templateStatus
    if (status === 'APPROVED') return { decision: 'send' }
    if (status === 'PAUSED') return { decision: 'skip', reason: 'template_paused' }
    return { decision: 'skip', reason: 'template_not_approved' }
  }

  // 2) Mensaje libre: SOLO dentro de la ventana de 24 h desde el último
  //    mensaje ENTRANTE del usuario (fail-closed si no hay registro).
  const last = ctx.lastInboundAt ? new Date(ctx.lastInboundAt).getTime() : null
  if (!last || Number.isNaN(last)) return { decision: 'skip', reason: 'no_inbound_24h' }
  if (now - last <= 24 * 60 * 60 * 1000) return { decision: 'send' }
  return { decision: 'skip', reason: 'window_24h' }
}
