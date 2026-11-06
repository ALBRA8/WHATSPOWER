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

export interface TransportSender {
  /**
   * CUARTA FASE CORRECTIVA (idempotencia externa): `idempotencyKey` es una clave
   * DETERMINISTA del sistema (`wpfx_<hash(evento,efecto)>`) que el transporte
   * transmite al proveedor/daemon. Si el daemon la honra (dedup por clave), la
   * ventana "proveedor aceptó + crash antes de DONE" queda cerrada de extremo a
   * extremo; si no, el sistema sigue siendo at-least-once con reconciliación.
   * Contrato de fallos:
   *  - No-aceptación DEFINITIVA (el proveedor NO recibió el mensaje):
   *    devolver { ok:false, error:'PREFLIGHT: ...' } — reintento seguro.
   *  - Resultado DESCONOCIDO (conexión muerta a mitad): LANZAR
   *    TransportAmbiguousError — exige reconciliación, jamás reenvío ciego.
   */
  sendMessage(to: string, text: string, correlationId: string, idempotencyKey?: string): Promise<{ ok: boolean; messageId?: string; error?: string }>
}

export interface CrmClientInterface {
  createClient(orgId: string, name: string, phone: string, correlationId: string): Promise<CrmActionResult>
  createOpportunity(orgId: string, clientId: string, title: string, amount: number, correlationId: string): Promise<CrmActionResult>
  addNote(orgId: string, clientId: string, content: string, correlationId: string): Promise<CrmActionResult>
}
