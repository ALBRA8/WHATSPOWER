import type { DatabaseSync } from 'node:sqlite'

export interface Agent {
  id: string
  name: string
  email: string
  phone?: string
  isActive: boolean
  role: 'admin' | 'agent'
  createdAt: number
}

export interface AgentAssignment {
  contactPhone: string
  agentId: string
  assignedAt: number
  status: 'OPEN' | 'RESOLVED'
}

export class TeamManager {
  private db: DatabaseSync
  private lastAssignedIndex: number = -1

  constructor(db: DatabaseSync) {
    this.db = db
  }

  registerAgent(agent: { id: string; name: string; email: string; phone?: string; role?: 'admin' | 'agent' }): Agent {
    const now = Math.floor(Date.now() / 1000)
    const role = agent.role || 'agent'
    this.db.prepare(`
      INSERT OR REPLACE INTO agents (id, name, email, phone, is_active, role, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(agent.id, agent.name, agent.email, agent.phone || null, role, now)

    return {
      id: agent.id,
      name: agent.name,
      email: agent.email,
      phone: agent.phone,
      isActive: true,
      role,
      createdAt: now,
    }
  }

  getActiveAgents(): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents WHERE is_active = 1 ORDER BY created_at ASC').all() as any[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone || undefined,
      isActive: Boolean(r.is_active),
      role: r.role,
      createdAt: r.created_at,
    }))
  }

  /**
   * Asignación Round-Robin equitativa entre los agentes activos
   */
  assignRoundRobin(contactPhone: string): Agent | null {
    const existing = this.getAssignment(contactPhone)
    if (existing && existing.status === 'OPEN') {
      const current = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(existing.agentId) as any
      if (current) {
        return {
          id: current.id,
          name: current.name,
          email: current.email,
          phone: current.phone || undefined,
          isActive: Boolean(current.is_active),
          role: current.role,
          createdAt: current.created_at,
        }
      }
    }

    const agents = this.getActiveAgents()
    if (agents.length === 0) return null

    this.lastAssignedIndex = (this.lastAssignedIndex + 1) % agents.length
    const selectedAgent = agents[this.lastAssignedIndex]
    const now = Math.floor(Date.now() / 1000)

    this.db.prepare(`
      INSERT OR REPLACE INTO agent_assignments (contact_phone, agent_id, assigned_at, status)
      VALUES (?, ?, ?, 'OPEN')
    `).run(contactPhone, selectedAgent.id, now)

    return selectedAgent
  }

  /**
   * Asignación por balanceo de carga (asigna al agente con menor número de chats OPEN)
   */
  assignLeastLoaded(contactPhone: string): Agent | null {
    const agents = this.getActiveAgents()
    if (agents.length === 0) return null

    let minLoad = Infinity
    let candidate = agents[0]

    for (const ag of agents) {
      const row = this.db.prepare(`
        SELECT COUNT(*) as active_count FROM agent_assignments
        WHERE agent_id = ? AND status = 'OPEN'
      `).get(ag.id) as { active_count: number }
      const load = row?.active_count || 0
      if (load < minLoad) {
        minLoad = load
        candidate = ag
      }
    }

    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_assignments (contact_phone, agent_id, assigned_at, status)
      VALUES (?, ?, ?, 'OPEN')
    `).run(contactPhone, candidate.id, now)

    return candidate
  }

  getAssignment(contactPhone: string): AgentAssignment | null {
    const row = this.db.prepare('SELECT * FROM agent_assignments WHERE contact_phone = ?').get(contactPhone) as any
    if (!row) return null
    return {
      contactPhone: row.contact_phone,
      agentId: row.agent_id,
      assignedAt: row.assigned_at,
      status: row.status,
    }
  }

  resolveAssignment(contactPhone: string): void {
    this.db.prepare("UPDATE agent_assignments SET status = 'RESOLVED' WHERE contact_phone = ?").run(contactPhone)
  }
}
