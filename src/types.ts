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
  correlationId: string
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
  actionTaken: 'new_lead_welcome' | 'keyword_rule' | 'handoff_human' | 'suppression_opt_out' | 'deduplicated' | 'locked_busy' | 'ignored' | 'visual_flow_execution'
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
}

export interface TransportSender {
  sendMessage(to: string, text: string, correlationId: string): Promise<{ ok: boolean; messageId?: string; error?: string }>
}

export interface CrmClientInterface {
  createClient(orgId: string, name: string, phone: string, correlationId: string): Promise<CrmActionResult>
  createOpportunity(orgId: string, clientId: string, title: string, amount: number, correlationId: string): Promise<CrmActionResult>
  addNote(orgId: string, clientId: string, content: string, correlationId: string): Promise<CrmActionResult>
}
