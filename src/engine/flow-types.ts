export type FlowNodeType =
  | 'trigger'
  | 'send_message'
  | 'user_input'
  | 'condition'
  | 'action'
  | 'crm_action'
  | 'delay'
  | 'smart_delay'
  | 'ab_split'
  | 'goto_flow'
  | 'handoff'
  | 'ai_response'

export interface ConditionRule {
  type:
    | 'has_tag'
    | 'does_not_have_tag'
    | 'field_equals'
    | 'field_contains'
    | 'field_greater_than'
    | 'field_less_than'
    | 'message_contains'
    | 'message_equals'
  field?: string
  value: string
}

export interface FlowNode {
  id: string
  type: FlowNodeType
  title: string
  position?: { x: number; y: number }
  data: {
    // 1. Trigger
    keywords?: string[]
    matchType?: 'exact' | 'contains' | 'startsWith' | 'regex'
    isFirstContact?: boolean

    // 2. Send Message
    messageText?: string
    mediaUrl?: string
    mediaType?: 'image' | 'audio' | 'video' | 'document'
    buttons?: Array<{
      id: string
      title: string
      type?: 'reply' | 'url' | 'call'
      url?: string
      phone?: string
    }>
    quickReplies?: string[]

    // 3. User Input (Captura de dato a campo personalizado)
    inputPrompt?: string
    saveToCustomField?: string
    validationType?: 'email' | 'phone' | 'number' | 'text'

    // 4. Condition
    conditionLogic?: 'AND' | 'OR'
    rules?: ConditionRule[]

    // 5. Action
    actionType?:
      | 'add_tag'
      | 'remove_tag'
      | 'set_custom_field'
      | 'enroll_sequence'
      | 'http_webhook'
      | 'crm_opportunity'
      | 'crm_note'
      | 'crm_stage'
    tag?: string
    customFieldKey?: string
    customFieldValue?: string
    sequenceId?: string
    webhookUrl?: string
    webhookHeaders?: Record<string, string>
    crmAction?: 'create_client' | 'create_opportunity' | 'add_note' | 'update_stage'
    crmParams?: Record<string, unknown>

    // 6. Delay / Smart Delay
    delaySeconds?: number
    delayMinutes?: number

    // 7. A/B Split Test
    splitRatio?: number // 0 a 100 (% para rama A)

    // 8. GoTo Flow
    targetFlowId?: string

    // 9. Handoff
    handoffReason?: string

    // 10. AI Response
    aiPrompt?: string
    aiModel?: string
  }
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string // 'yes' | 'no' | 'default' | 'a' | 'b' | button index/id
}

export interface FlowDefinition {
  id: string
  name: string
  triggerKeywords: string[]
  isActive: boolean
  nodes: FlowNode[]
  edges: FlowEdge[]
  createdAt?: number
  updatedAt?: number
}

export interface FlowSession {
  contactPhone: string
  flowId: string
  currentNodeId: string
  waitingForInput: boolean
  inputTargetField?: string
  context: Record<string, string>
  lastActivity: number
}

export interface FlowEvaluationResult {
  handled: boolean
  flowId?: string
  currentNodeId?: string
  messagesToSend: Array<{
    text: string
    mediaUrl?: string
    mediaType?: string
    buttons?: Array<{ title: string; url?: string }>
  }>
  actionsToExecute: Array<{
    action: string
    params: Record<string, unknown>
  }>
  tagsToAdd?: string[]
  tagsToRemove?: string[]
  customFieldsToSet?: Record<string, string>
  sequenceToEnroll?: string
  webhookToCall?: { url: string; body: Record<string, unknown> }
  isHandoff?: boolean
  handoffReason?: string
  flowCompleted?: boolean
}

export interface SequenceDefinition {
  id: string
  name: string
  isActive: boolean
  steps: Array<{
    id: string
    stepOrder: number
    delayMinutes: number
    messageText: string
    flowId?: string
  }>
}
