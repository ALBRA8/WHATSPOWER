export type ConversationState = 'IDLE' | 'IN_FLOW_2A' | 'HANDOFF_HUMAN' | 'FLOW_COMPLETED'

export interface InboundContact {
  phone: string
  name?: string
  clientId?: string | null
}

export interface InboundMessage {
  id: string
  text: string
  type: 'text' | 'voice' | 'image' | 'button_reply'
}

export interface InboundEvent {
  eventId: string
  orgId: string
  correlationId?: string
  timestamp: string
  channel: 'whatsapp' | 'instagram' | 'telegram'
  contact: InboundContact
  message: InboundMessage
}

export interface ConversationLock {
  contactPhone: string
  organizationId: string
  currentState: ConversationState
  lockedAt: number
  expiresAt: number
  correlationId: string
}

export interface SuppressionEntry {
  phone: string
  reason: string
  createdAt: number
}

export interface ExecutionResult {
  handled: boolean
  actionTaken: 'new_lead_welcome' | 'keyword_rule' | 'handoff_human' | 'suppression_opt_out' | 'deduplicated' | 'locked_busy' | 'ignored' | 'visual_flow_execution' | 'in_flight' | 'uncertain_needs_reconciliation'
  replyText?: string
  crmSynced?: boolean
  error?: string
  correlationId: string
  flowId?: string
}

export interface CrmActionResult {
  ok: boolean
  summary?: string
  data?: Record<string, unknown>
  clientId?: string
  error?: string
  /** (segunda reparación §3.B) Organización que el CRM confirma haber aplicado. */
  orgId?: string
}

/**
 * B2 — Clasificación del resultado de un envío externo.
 *  - 'SENT': el daemon/devolución confirma aceptación del mensaje.
 *  - 'REJECTED': evidencia FABLE de NO aceptación (rechazo a nivel de API
 *    antes del despacho: 400/401/403/404/413/422/429).
 *  - 'UNCERTAIN': resultado AMBIGUO — 5xx, 408/425, timeout, conexión cortada
 *    o respuesta ilegible: el mensaje PUDO haberse aceptado antes del fallo.
 */
export type DispatchOutcome = 'SENT' | 'REJECTED' | 'UNCERTAIN'

export interface TransportSendResult {
  ok: boolean
  messageId?: string
  error?: string
  /** B2: clasificación del resultado. Si falta con ok=false se asume UNCERTAIN (fail-safe). */
  outcome?: DispatchOutcome
  /**
   * (hallazgo 6, auditoría funcional 2026-11-12) Limitaciones aplicadas al
   * contenido enriquecido por este envío (p.ej. media entregada como enlace de
   * texto). Vacío/ausente = el contenido llegó completo en su formato nativo.
   * EXPLÍCITO por diseño: nada se pierde silenciosamente.
   */
  degraded?: string[]
}

/**
 * (hallazgo 6) Contenido enriquecido que el flujo visual puede pedir y el
 * transporte intenta entregar en formato NATIVO cuando el proveedor lo soporta.
 * Los campos son opcionales; un transporte que no soporte una característica
 * degrada EXPLÍCITAMENTE (degraded) sin perder el contenido.
 */
export interface OutboundMedia {
  mediaUrl?: string
  mediaType?: 'image' | 'audio' | 'video' | 'document'
  buttons?: Array<{ title: string; url?: string }>
}

export interface TransportSender {
  /**
   * B2 (fase final): `idempotencyKey` es la clave de idempotencia POR MENSAJE
   * (distinta del correlationId del evento, que puede amparar varios mensajes).
   * Viaja al daemon en el header X-Idempotency-Key y en el cuerpo para que el
   * receptor pueda verificarla/aplicarla. Opcional por compatibilidad: si se
   * omite, el transporte usa correlationId (comportamiento previo).
   *
   * OLEADA 2 (decisión 2026-11-11 #6): `orgId` es la organización del envío.
   * Los transportes POR ORGANIZACIÓN (Meta Cloud) la EXIGEN y resuelven las
   * credenciales de ESA organización — fail-closed si falta. Los transportes
   * legacy (Baileys por org) la aceptan y pueden usarla para el enrutamiento.
   */
  /**
   * (hallazgo 6) `media` es OPCIONAL por compatibilidad: los transportes que no
   * lo aceptan siguen funcionando (firma previa intacta); los que soportan el
   * contenido enriquecido lo entregan en formato nativo, y los que no, degradan
   * explícitamente (TransportSendResult.degraded) sin perder contenido.
   */
  sendMessage(to: string, text: string, correlationId: string, idempotencyKey?: string, orgId?: string, media?: OutboundMedia): Promise<TransportSendResult>
}

export interface CrmClientInterface {
  createClient(orgId: string, name: string, phone: string, correlationId: string): Promise<CrmActionResult>
  createOpportunity(orgId: string, clientId: string, title: string, amount: number, correlationId: string): Promise<CrmActionResult>
  addNote(orgId: string, clientId: string, content: string, correlationId: string): Promise<CrmActionResult>
}
