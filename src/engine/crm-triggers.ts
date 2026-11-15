import type { DatabaseSync } from 'node:sqlite'
import type { FlowEngine } from './flow-engine.ts'

export interface StageChangeEvent {
  clientId: string
  clientPhone: string
  clientName?: string
  opportunityId: string
  fromStage: string
  toStage: string
  dealValue?: number
}

export interface StageTriggerRule {
  targetStage: string
  action: 'send_message' | 'start_flow' | 'enroll_sequence'
  templateMessage?: string
  targetFlowId?: string
  targetSequenceId?: string
}

export class CrmTriggerListener {
  private db: DatabaseSync
  private flowEngine: FlowEngine
  private rules: Map<string, StageTriggerRule> = new Map()

  constructor(db: DatabaseSync, flowEngine: FlowEngine) {
    this.db = db
    this.flowEngine = flowEngine
    this.registerDefaultRules()
  }

  registerRule(stage: string, rule: StageTriggerRule) {
    this.rules.set(stage.toUpperCase(), rule)
  }

  private registerDefaultRules() {
    // Regla 1: Cotización / Propuesta enviada -> Mensaje de seguimiento automático
    this.rules.set('PROPUESTA_ENVIADA', {
      targetStage: 'PROPUESTA_ENVIADA',
      action: 'send_message',
      templateMessage: 'Hola {{nombre}}, te confirmamos que tu propuesta ya fue generada. ¿Deseas revisarla juntos?',
    })

    // Regla 2: Cita no asistida -> Flujo de reprogramación
    this.rules.set('NO_SHOW', {
      targetStage: 'NO_SHOW',
      action: 'start_flow',
      targetFlowId: 'flow_reprogramar_cita',
    })

    // Regla 3: Ganado / Cliente cerrado -> Secuencia de onboarding
    this.rules.set('GANADO', {
      targetStage: 'GANADO',
      action: 'send_message',
      templateMessage: '¡Bienvenido a bordo {{nombre}}! Estamos felices de iniciar este proyecto contigo.',
    })
  }

  async handleStageChange(event: StageChangeEvent): Promise<{
    triggered: boolean
    action?: string
    messageSent?: string
  }> {
    const stageKey = event.toStage.toUpperCase()
    const rule = this.rules.get(stageKey)

    if (!rule) {
      return { triggered: false }
    }

    const contactName = event.clientName || 'Cliente'

    if (rule.action === 'send_message' && rule.templateMessage) {
      const text = rule.templateMessage.replace(/\{\{nombre\}\}/g, contactName)
      // Encolar mensaje o registrarlo en inbox
      const now = Math.floor(Date.now() / 1000)
      this.db.prepare(`
        INSERT INTO inbox_messages (id, contact_phone, direction, text, created_at)
        VALUES (?, ?, 'outbound', ?, ?)
      `).run(`msg_trig_${Date.now()}`, event.clientPhone, text, now)

      return {
        triggered: true,
        action: 'send_message',
        messageSent: text,
      }
    }

    if (rule.action === 'start_flow' && rule.targetFlowId) {
      return {
        triggered: true,
        action: `start_flow:${rule.targetFlowId}`,
      }
    }

    return { triggered: true, action: rule.action }
  }
}
