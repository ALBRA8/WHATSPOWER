import { DatabaseSync } from 'node:sqlite'
import type {
  FlowDefinition,
  FlowSession,
  FlowEvaluationResult,
  FlowNode,
  FlowEdge,
  SequenceDefinition,
  ConditionRule,
} from './flow-types.ts'

export class FlowEngine {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.seedDefaultFlowIfEmpty()
  }

  // =========================================================================
  // 1. GESTIÓN DE FLUJOS (CRUD)
  // =========================================================================

  saveFlow(flow: FlowDefinition): void {
    const now = Date.now()
    const stmt = this.db.prepare(`
      INSERT INTO flows (id, name, trigger_keywords, is_active, graph_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        trigger_keywords = excluded.trigger_keywords,
        is_active = excluded.is_active,
        graph_json = excluded.graph_json,
        updated_at = excluded.updated_at
    `)

    stmt.run(
      flow.id,
      flow.name,
      JSON.stringify(flow.triggerKeywords.map((k) => k.toLowerCase().trim())),
      flow.isActive ? 1 : 0,
      JSON.stringify({ nodes: flow.nodes, edges: flow.edges }),
      flow.createdAt || now,
      now
    )
  }

  getFlow(id: string): FlowDefinition | null {
    const row = this.db.prepare('SELECT * FROM flows WHERE id = ?').get(id) as
      | {
          id: string
          name: string
          trigger_keywords: string
          is_active: number
          graph_json: string
          created_at: number
          updated_at: number
        }
      | undefined

    if (!row) return null

    const graph = JSON.parse(row.graph_json) as { nodes: FlowNode[]; edges: FlowEdge[] }
    return {
      id: row.id,
      name: row.name,
      triggerKeywords: JSON.parse(row.trigger_keywords),
      isActive: row.is_active === 1,
      nodes: graph.nodes || [],
      edges: graph.edges || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  listFlows(): FlowDefinition[] {
    const rows = this.db.prepare('SELECT * FROM flows ORDER BY updated_at DESC').all() as Array<{
      id: string
      name: string
      trigger_keywords: string
      is_active: number
      graph_json: string
      created_at: number
      updated_at: number
    }>

    return rows.map((row) => {
      const graph = JSON.parse(row.graph_json) as { nodes: FlowNode[]; edges: FlowEdge[] }
      return {
        id: row.id,
        name: row.name,
        triggerKeywords: JSON.parse(row.trigger_keywords),
        isActive: row.is_active === 1,
        nodes: graph.nodes || [],
        edges: graph.edges || [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    })
  }

  deleteFlow(id: string): boolean {
    const res = this.db.prepare('DELETE FROM flows WHERE id = ?').run(id)
    return res.changes > 0
  }

  // =========================================================================
  // 2. ETIQUETAS (TAGS) Y CAMPOS PERSONALIZADOS (CUSTOM FIELDS)
  // =========================================================================

  addTag(phone: string, tag: string): void {
    const cleanTag = tag.trim().toLowerCase()
    this.db.prepare('INSERT OR IGNORE INTO contact_tags (contact_phone, tag_name, created_at) VALUES (?, ?, ?)').run(
      phone,
      cleanTag,
      Date.now()
    )
  }

  removeTag(phone: string, tag: string): void {
    const cleanTag = tag.trim().toLowerCase()
    this.db.prepare('DELETE FROM contact_tags WHERE contact_phone = ? AND tag_name = ?').run(phone, cleanTag)
  }

  getTags(phone: string): string[] {
    const rows = this.db.prepare('SELECT tag_name FROM contact_tags WHERE contact_phone = ? ORDER BY created_at ASC').all(phone) as Array<{
      tag_name: string
    }>
    return rows.map((r) => r.tag_name)
  }

  hasTag(phone: string, tag: string): boolean {
    const cleanTag = tag.trim().toLowerCase()
    const row = this.db.prepare('SELECT 1 FROM contact_tags WHERE contact_phone = ? AND tag_name = ?').get(phone, cleanTag)
    return Boolean(row)
  }

  setCustomField(phone: string, key: string, value: string): void {
    const cleanKey = key.trim().toLowerCase()
    this.db.prepare(`
      INSERT INTO contact_custom_fields (contact_phone, field_key, field_value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(contact_phone, field_key) DO UPDATE SET
        field_value = excluded.field_value,
        updated_at = excluded.updated_at
    `).run(phone, cleanKey, String(value), Date.now())
  }

  getCustomField(phone: string, key: string): string | null {
    const cleanKey = key.trim().toLowerCase()
    const row = this.db.prepare('SELECT field_value FROM contact_custom_fields WHERE contact_phone = ? AND field_key = ?').get(
      phone,
      cleanKey
    ) as { field_value: string } | undefined
    return row ? row.field_value : null
  }

  getAllCustomFields(phone: string): Record<string, string> {
    const rows = this.db.prepare('SELECT field_key, field_value FROM contact_custom_fields WHERE contact_phone = ?').all(
      phone
    ) as Array<{ field_key: string; field_value: string }>
    const map: Record<string, string> = {}
    for (const r of rows) {
      map[r.field_key] = r.field_value
    }
    return map
  }

  // =========================================================================
  // 3. SECUENCIAS Y DRIP CAMPAIGNS (CAMPAÑAS DE GOTEO)
  // =========================================================================

  saveSequence(seq: SequenceDefinition): void {
    this.db.prepare('INSERT OR REPLACE INTO sequences (id, name, is_active, created_at) VALUES (?, ?, ?, ?)').run(
      seq.id,
      seq.name,
      seq.isActive ? 1 : 0,
      Date.now()
    )

    this.db.prepare('DELETE FROM sequence_steps WHERE sequence_id = ?').run(seq.id)
    const stepStmt = this.db.prepare(`
      INSERT INTO sequence_steps (id, sequence_id, step_order, delay_minutes, message_text, flow_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    for (const step of seq.steps) {
      stepStmt.run(step.id, seq.id, step.stepOrder, step.delayMinutes, step.messageText, step.flowId || null)
    }
  }

  enrollContactInSequence(phone: string, sequenceId: string): void {
    const enrollmentId = `enr_${sequenceId}_${phone}`
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO sequence_enrollments (id, sequence_id, contact_phone, current_step, next_run_at, status)
      VALUES (?, ?, ?, 1, ?, 'ACTIVE')
      ON CONFLICT(id) DO UPDATE SET
        current_step = 1,
        next_run_at = excluded.next_run_at,
        status = 'ACTIVE'
    `).run(enrollmentId, sequenceId, phone, now)
  }

  cancelSequenceEnrollment(phone: string, sequenceId?: string): void {
    if (sequenceId) {
      this.db.prepare("UPDATE sequence_enrollments SET status = 'CANCELLED' WHERE contact_phone = ? AND sequence_id = ?").run(
        phone,
        sequenceId
      )
    } else {
      this.db.prepare("UPDATE sequence_enrollments SET status = 'CANCELLED' WHERE contact_phone = ?").run(phone)
    }
  }

  // =========================================================================
  // 4. SESIONES DE DIÁLOGO
  // =========================================================================

  getSession(contactPhone: string): FlowSession | null {
    const row = this.db.prepare('SELECT * FROM flow_sessions WHERE contact_phone = ?').get(contactPhone) as
      | {
          contact_phone: string
          flow_id: string
          current_node_id: string
          waiting_for_input: number
          context_json: string
          last_activity: number
        }
      | undefined

    if (!row) return null

    if (Date.now() - row.last_activity > 2 * 60 * 60 * 1000) {
      this.clearSession(contactPhone)
      return null
    }

    const parsedContext = JSON.parse(row.context_json || '{}')
    return {
      contactPhone: row.contact_phone,
      flowId: row.flow_id,
      currentNodeId: row.current_node_id,
      waitingForInput: row.waiting_for_input === 1,
      inputTargetField: parsedContext._inputTargetField,
      context: parsedContext,
      lastActivity: row.last_activity,
    }
  }

  saveSession(session: FlowSession): void {
    const stmt = this.db.prepare(`
      INSERT INTO flow_sessions (contact_phone, flow_id, current_node_id, waiting_for_input, context_json, last_activity)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(contact_phone) DO UPDATE SET
        flow_id = excluded.flow_id,
        current_node_id = excluded.current_node_id,
        waiting_for_input = excluded.waiting_for_input,
        context_json = excluded.context_json,
        last_activity = excluded.last_activity
    `)

    const ctx = { ...session.context }
    if (session.inputTargetField) {
      ctx._inputTargetField = session.inputTargetField
    }

    stmt.run(
      session.contactPhone,
      session.flowId,
      session.currentNodeId,
      session.waitingForInput ? 1 : 0,
      JSON.stringify(ctx),
      Date.now()
    )
  }

  clearSession(contactPhone: string): void {
    this.db.prepare('DELETE FROM flow_sessions WHERE contact_phone = ?').run(contactPhone)
  }

  findMatchingFlow(messageText: string): FlowDefinition | null {
    const clean = messageText.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    const flows = this.listFlows().filter((f) => f.isActive)

    for (const flow of flows) {
      for (const kw of flow.triggerKeywords) {
        if (clean.includes(kw.toLowerCase().trim())) {
          return flow
        }
      }
    }
    return null
  }

  // =========================================================================
  // 5. EVALUACIÓN Y MOTOR DE EJECUCIÓN (FLOW EVALUATOR)
  // =========================================================================

  async evaluateStep(
    contactPhone: string,
    messageText: string,
    contactInfo?: { name?: string; clientId?: string | null }
  ): Promise<FlowEvaluationResult> {
    const cleanInput = messageText.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    let session = this.getSession(contactPhone)
    let flow: FlowDefinition | null = null

    // Registrar mensaje en bandeja de entrada (Inbox)
    this.db.prepare(`
      INSERT INTO inbox_messages (id, contact_phone, direction, text, created_at)
      VALUES (?, ?, 'inbound', ?, ?)
    `).run(`in_${Date.now()}_${Math.random().toString(36).substring(7)}`, contactPhone, messageText, Date.now())

    // CASO 1: Continuar flujo existente
    if (session) {
      flow = this.getFlow(session.flowId)
      if (!flow || !flow.isActive) {
        this.clearSession(contactPhone)
        session = null
      }
    }

    // CASO 2: Iniciar nuevo flujo por trigger
    if (!session) {
      flow = this.findMatchingFlow(messageText)
      if (!flow) {
        return { handled: false, messagesToSend: [], actionsToExecute: [] }
      }

      const triggerNode = flow.nodes.find((n) => n.type === 'trigger') || flow.nodes[0]
      if (!triggerNode) {
        return { handled: false, messagesToSend: [], actionsToExecute: [] }
      }

      const firstEdge = flow.edges.find((e) => e.source === triggerNode.id)
      if (!firstEdge) {
        return { handled: false, messagesToSend: [], actionsToExecute: [] }
      }

      const customFields = this.getAllCustomFields(contactPhone)
      session = {
        contactPhone,
        flowId: flow.id,
        currentNodeId: firstEdge.target,
        waitingForInput: false,
        context: {
          nombre: contactInfo?.name || customFields.nombre || 'Cliente',
          telefono: contactPhone,
          ultimo_mensaje: messageText,
          ...customFields,
        },
        lastActivity: Date.now(),
      }
    } else {
      // Avanzar en el flujo existente
      const currentNode = flow!.nodes.find((n) => n.id === session!.currentNodeId)
      if (!currentNode) {
        this.clearSession(contactPhone)
        return { handled: false, messagesToSend: [], actionsToExecute: [] }
      }

      // Si estábamos esperando User Input (captura de dato a custom field)
      if (currentNode.type === 'user_input' && session.inputTargetField) {
        this.setCustomField(contactPhone, session.inputTargetField, messageText.trim())
        session.context[session.inputTargetField] = messageText.trim()
        session.inputTargetField = undefined
      }

      session.context.ultimo_mensaje = messageText

      // Evaluar aristas salientes
      const outgoingEdges = flow!.edges.filter((e) => e.source === currentNode.id)
      let nextEdge: FlowEdge | undefined

      if (outgoingEdges.length === 1 && !outgoingEdges[0].sourceHandle) {
        nextEdge = outgoingEdges[0]
      } else {
        // Coincidencia por opción/botón
        nextEdge = outgoingEdges.find((e) => {
          if (!e.sourceHandle) return false
          const h = e.sourceHandle.toLowerCase()
          return cleanInput === h || cleanInput.includes(h)
        })

        if (!nextEdge) {
          nextEdge = outgoingEdges.find((e) => e.sourceHandle === 'default' || !e.sourceHandle)
        }
      }

      if (!nextEdge) {
        this.clearSession(contactPhone)
        return {
          handled: true,
          flowId: flow!.id,
          messagesToSend: [],
          actionsToExecute: [],
          flowCompleted: true,
        }
      }

      session.currentNodeId = nextEdge.target
      session.waitingForInput = false
    }

    // EJECUCIÓN EN BUCLE DE NODOS SECUENCIALES
    const messagesToSend: FlowEvaluationResult['messagesToSend'] = []
    const actionsToExecute: FlowEvaluationResult['actionsToExecute'] = []
    const tagsToAdd: string[] = []
    const tagsToRemove: string[] = []
    const customFieldsToSet: Record<string, string> = {}
    let isHandoff = false
    let handoffReason: string | undefined
    let webhookToCall: FlowEvaluationResult['webhookToCall']
    let sequenceToEnroll: string | undefined

    let currentNode: FlowNode | undefined = flow!.nodes.find((n) => n.id === session!.currentNodeId)

    while (currentNode) {
      // --- NODO: SEND_MESSAGE ---
      if (currentNode.type === 'send_message') {
        let text = currentNode.data.messageText || ''
        text = this.interpolateVariables(text, session.context, contactPhone)

        const buttons = currentNode.data.buttons?.map((b) => ({ title: b.title, url: b.url }))
        messagesToSend.push({
          text,
          mediaUrl: currentNode.data.mediaUrl,
          mediaType: currentNode.data.mediaType,
          buttons,
        })

        this.recordOutboundMessage(contactPhone, text, currentNode.data.mediaUrl)

        session.waitingForInput = true
        this.saveSession(session)
        break // Pausar esperando respuesta
      }

      // --- NODO: USER_INPUT (Captura interactiva de datos) ---
      else if (currentNode.type === 'user_input') {
        let prompt = currentNode.data.inputPrompt || 'Por favor ingresa la información solicitada:'
        prompt = this.interpolateVariables(prompt, session.context, contactPhone)

        messagesToSend.push({ text: prompt })
        this.recordOutboundMessage(contactPhone, prompt)

        session.waitingForInput = true
        session.inputTargetField = currentNode.data.saveToCustomField || 'dato_capturado'
        this.saveSession(session)
        break // Pausar esperando el dato del usuario
      }

      // --- NODO: CONDITION (Bifurcación lógica) ---
      else if (currentNode.type === 'condition') {
        const rules = currentNode.data.rules || []
        const logic = currentNode.data.conditionLogic || 'AND'
        const isMatch = this.evaluateConditionRules(contactPhone, rules, logic, session.context)

        const targetHandle = isMatch ? 'yes' : 'no'
        const nextEdge = flow!.edges.find((e) => e.source === currentNode!.id && e.sourceHandle === targetHandle)

        if (nextEdge) {
          session.currentNodeId = nextEdge.target
          currentNode = flow!.nodes.find((n) => n.id === nextEdge.target)
        } else {
          currentNode = undefined
        }
      }

      // --- NODO: ACTION (ManyChat Actions & ALBRA CRM) ---
      else if (currentNode.type === 'action' || currentNode.type === 'crm_action') {
        const actType = currentNode.data.actionType || (currentNode.data.crmAction ? 'crm_opportunity' : 'add_tag')

        // 1. Tagging
        if (actType === 'add_tag' && currentNode.data.tag) {
          this.addTag(contactPhone, currentNode.data.tag)
          tagsToAdd.push(currentNode.data.tag)
        } else if (actType === 'remove_tag' && currentNode.data.tag) {
          this.removeTag(contactPhone, currentNode.data.tag)
          tagsToRemove.push(currentNode.data.tag)
        }

        // 2. Custom Field
        else if (actType === 'set_custom_field' && currentNode.data.customFieldKey && currentNode.data.customFieldValue) {
          const val = this.interpolateVariables(currentNode.data.customFieldValue, session.context, contactPhone)
          this.setCustomField(contactPhone, currentNode.data.customFieldKey, val)
          customFieldsToSet[currentNode.data.customFieldKey] = val
          session.context[currentNode.data.customFieldKey] = val
        }

        // 3. Drip Sequence
        else if (actType === 'enroll_sequence' && currentNode.data.sequenceId) {
          this.enrollContactInSequence(contactPhone, currentNode.data.sequenceId)
          sequenceToEnroll = currentNode.data.sequenceId
        }

        // 4. Webhook saliente
        else if (actType === 'http_webhook' && currentNode.data.webhookUrl) {
          webhookToCall = {
            url: currentNode.data.webhookUrl,
            body: { contactPhone, context: session.context, timestamp: Date.now() },
          }
        }

        // 5. CRM ALBRA Action
        else {
          const action = currentNode.data.crmAction || (actType === 'crm_opportunity' ? 'create_opportunity' : 'add_note')
          const params = { ...(currentNode.data.crmParams || {}) }
          if (contactInfo?.clientId && !params.clientId) params.clientId = contactInfo.clientId
          if (!params.phone) params.phone = contactPhone
          if (!params.title) params.title = `Lead desde ManyChat: ${flow!.name}`

          actionsToExecute.push({ action, params })
        }

        // Avanzar al siguiente nodo
        const nextEdge = flow!.edges.find((e) => e.source === currentNode!.id)
        if (nextEdge) {
          session.currentNodeId = nextEdge.target
          currentNode = flow!.nodes.find((n) => n.id === nextEdge.target)
        } else {
          currentNode = undefined
        }
      }

      // --- NODO: AB_SPLIT (División de tráfico A/B) ---
      else if (currentNode.type === 'ab_split') {
        const ratio = currentNode.data.splitRatio ?? 50
        const rand = Math.random() * 100
        const chosenHandle = rand < ratio ? 'a' : 'b'

        const nextEdge = flow!.edges.find((e) => e.source === currentNode!.id && e.sourceHandle === chosenHandle)
        if (nextEdge) {
          session.currentNodeId = nextEdge.target
          currentNode = flow!.nodes.find((n) => n.id === nextEdge.target)
        } else {
          currentNode = undefined
        }
      }

      // --- NODO: GOTO_FLOW (Sub-flujo) ---
      else if (currentNode.type === 'goto_flow' && currentNode.data.targetFlowId) {
        const targetFlow = this.getFlow(currentNode.data.targetFlowId)
        if (targetFlow) {
          flow = targetFlow
          session.flowId = targetFlow.id
          const startNode = targetFlow.nodes.find((n) => n.type === 'trigger') || targetFlow.nodes[0]
          const firstEdge = targetFlow.edges.find((e) => e.source === startNode?.id)
          if (firstEdge) {
            session.currentNodeId = firstEdge.target
            currentNode = targetFlow.nodes.find((n) => n.id === firstEdge.target)
            continue
          }
        }
        currentNode = undefined
      }

      // --- NODO: HANDOFF (Human Takeover) ---
      else if (currentNode.type === 'handoff') {
        isHandoff = true
        handoffReason = currentNode.data.handoffReason || `Transferencia activada en ManyChat: ${flow!.name}`
        const farewell = '👤 Te estamos comunicando con un asesor de nuestro equipo comercial. El bot se ha pausado.'
        messagesToSend.push({ text: farewell })
        this.recordOutboundMessage(contactPhone, farewell)
        this.clearSession(contactPhone)
        break
      }

      // --- NODO: AI_RESPONSE ---
      else if (currentNode.type === 'ai_response') {
        const prompt = currentNode.data.aiPrompt || 'Responde de forma concisa como asistente de ventas.'
        const aiText = `🤖 [IA Asistente]: Gracias por tu pregunta. En breve un asesor te dará más detalles personalizados.`
        messagesToSend.push({ text: aiText })
        this.recordOutboundMessage(contactPhone, aiText)

        const nextEdge = flow!.edges.find((e) => e.source === currentNode!.id)
        if (nextEdge) {
          session.currentNodeId = nextEdge.target
          currentNode = flow!.nodes.find((n) => n.id === nextEdge.target)
        } else {
          currentNode = undefined
        }
      } else {
        const nextEdge = flow!.edges.find((e) => e.source === currentNode!.id)
        if (nextEdge) {
          session.currentNodeId = nextEdge.target
          currentNode = flow!.nodes.find((n) => n.id === nextEdge.target)
        } else {
          currentNode = undefined
        }
      }
    }

    if (!currentNode && !session.waitingForInput) {
      this.clearSession(contactPhone)
    }

    return {
      handled: true,
      flowId: flow!.id,
      currentNodeId: session?.currentNodeId,
      messagesToSend,
      actionsToExecute,
      tagsToAdd,
      tagsToRemove,
      customFieldsToSet,
      sequenceToEnroll,
      webhookToCall,
      isHandoff,
      handoffReason,
      flowCompleted: !currentNode,
    }
  }

  // =========================================================================
  // 6. UTILIDADES AUXILIARES
  // =========================================================================

  private interpolateVariables(text: string, context: Record<string, string>, phone: string): string {
    let res = text
    res = res.replace(/\{\{nombre\}\}/g, context.nombre || 'amigo(a)')
    res = res.replace(/\{\{telefono\}\}/g, phone)
    for (const [k, v] of Object.entries(context)) {
      res = res.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v)
    }
    return res
  }

  private evaluateConditionRules(
    phone: string,
    rules: ConditionRule[],
    logic: 'AND' | 'OR',
    context: Record<string, string>
  ): boolean {
    if (rules.length === 0) return true

    const results = rules.map((r) => {
      if (r.type === 'has_tag') {
        return this.hasTag(phone, r.value)
      } else if (r.type === 'does_not_have_tag') {
        return !this.hasTag(phone, r.value)
      } else if (r.type === 'field_equals' && r.field) {
        const val = this.getCustomField(phone, r.field) || context[r.field] || ''
        return val.toLowerCase() === r.value.toLowerCase()
      } else if (r.type === 'field_contains' && r.field) {
        const val = this.getCustomField(phone, r.field) || context[r.field] || ''
        return val.toLowerCase().includes(r.value.toLowerCase())
      } else if (r.type === 'message_contains') {
        const msg = context.ultimo_mensaje || ''
        return msg.toLowerCase().includes(r.value.toLowerCase())
      }
      return false
    })

    return logic === 'AND' ? results.every(Boolean) : results.some(Boolean)
  }

  private recordOutboundMessage(phone: string, text: string, mediaUrl?: string): void {
    try {
      this.db.prepare(`
        INSERT INTO inbox_messages (id, contact_phone, direction, text, media_url, created_at)
        VALUES (?, ?, 'outbound', ?, ?, ?)
      `).run(`out_${Date.now()}_${Math.random().toString(36).substring(7)}`, phone, text, mediaUrl || null, Date.now())
    } catch {}
  }

  private seedDefaultFlowIfEmpty(): void {
    const count = this.db.prepare('SELECT count(*) as total FROM flows').get() as { total: number }
    if (count && count.total > 0) return

    const defaultFlow: FlowDefinition = {
      id: 'flow_ventas_manychat_01',
      name: 'Flujo Completo de Calificación ManyChat',
      triggerKeywords: ['precio', 'precios', 'planes', 'info', 'informacion', 'demo'],
      isActive: true,
      nodes: [
        {
          id: 'n_trigger',
          type: 'trigger',
          title: 'Trigger: Palabras Clave',
          position: { x: 50, y: 150 },
          data: { keywords: ['precio', 'planes', 'info', 'demo'] },
        },
        {
          id: 'n_welcome',
          type: 'send_message',
          title: 'Mensaje de Bienvenida y Menú',
          position: { x: 300, y: 150 },
          data: {
            messageText: '¡Hola {{nombre}}! 👋 Qué gusto saludarte.\nPara darte la información exacta, ¿cuántos asesores o vendedores tiene tu equipo?\n\n1️⃣ 1 a 3 asesores (Plan Emprendedor)\n2️⃣ Más de 4 asesores (Plan Corporativo)\n3️⃣ Quiero hablar con un asesor',
          },
        },
        {
          id: 'n_tag_emprendedor',
          type: 'action',
          title: 'Etiquetar: Lead Emprendedor',
          position: { x: 650, y: 50 },
          data: { actionType: 'add_tag', tag: 'lead_emprendedor' },
        },
        {
          id: 'n_plan_emprendedor',
          type: 'send_message',
          title: 'Respuesta Plan Emprendedor',
          position: { x: 950, y: 50 },
          data: {
            messageText: '🚀 El Plan Emprendedor incluye gestión de WhatsApp, CRM Kanban y plantillas por $29/mes.\n¿Te gustaría activar tu prueba gratis de 7 días? Escribe "SI" para empezar.',
          },
        },
        {
          id: 'n_tag_corporativo',
          type: 'action',
          title: 'Etiquetar: Lead Corporativo',
          position: { x: 650, y: 250 },
          data: { actionType: 'add_tag', tag: 'lead_corporativo' },
        },
        {
          id: 'n_crm_deal',
          type: 'crm_action',
          title: 'Crear Oportunidad en CRM ALBRA',
          position: { x: 950, y: 250 },
          data: {
            crmAction: 'create_opportunity',
            crmParams: { title: 'Lead Corporativo (+4 asesores)', amount: 150 },
          },
        },
        {
          id: 'n_msg_corporativo',
          type: 'send_message',
          title: 'Mensaje Lead Corporativo',
          position: { x: 1250, y: 250 },
          data: {
            messageText: '🏢 Excelente. Para equipos grandes tenemos el Plan Corporativo con WhatsApp multi-agente y automatizaciones avanzadas. Un especialista comercial te atenderá en este instante.',
          },
        },
        {
          id: 'n_handoff',
          type: 'handoff',
          title: 'Handoff a Asesor Comercial',
          position: { x: 650, y: 450 },
          data: { handoffReason: 'Cliente solicitó asesor humano desde menú ManyChat' },
        },
      ],
      edges: [
        { id: 'e1', source: 'n_trigger', target: 'n_welcome' },
        { id: 'e2', source: 'n_welcome', target: 'n_tag_emprendedor', sourceHandle: '1' },
        { id: 'e3', source: 'n_welcome', target: 'n_tag_corporativo', sourceHandle: '2' },
        { id: 'e4', source: 'n_welcome', target: 'n_handoff', sourceHandle: '3' },
        { id: 'e5', source: 'n_tag_emprendedor', target: 'n_plan_emprendedor' },
        { id: 'e6', source: 'n_tag_corporativo', target: 'n_crm_deal' },
        { id: 'e7', source: 'n_crm_deal', target: 'n_msg_corporativo' },
      ],
    }

    this.saveFlow(defaultFlow)
  }
}
