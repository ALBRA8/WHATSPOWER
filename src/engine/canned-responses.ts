import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

export interface CannedResponse {
  id: string
  shortcut: string
  title: string
  content: string
  mediaUrl?: string
  category: string
  createdAt: number
}

export class CannedResponseManager {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  // (tercera reparación 4.A) Respuestas predefinidas POR ORGANIZACIÓN:
  // PK (organization_id, id) y unicidad (organization_id, shortcut).

  createResponse(orgId: string, params: {
    shortcut: string
    title: string
    content: string
    mediaUrl?: string
    category?: string
  }): CannedResponse {
    if (!orgId || typeof orgId !== 'string') {
      throw new Error('VALIDATION: createResponse exige organizationId (aislamiento multi-organización)')
    }
    const id = `can_${randomUUID()}`
    const now = Math.floor(Date.now() / 1000)
    const shortcut = params.shortcut.startsWith('/') ? params.shortcut : `/${params.shortcut}`
    const category = params.category || 'general'

    this.db.prepare(`
      INSERT INTO canned_responses (id, organization_id, shortcut, title, content, media_url, category, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, shortcut, params.title, params.content, params.mediaUrl || null, category, now)

    return {
      id,
      shortcut,
      title: params.title,
      content: params.content,
      mediaUrl: params.mediaUrl,
      category,
      createdAt: now,
    }
  }

  findByShortcut(orgId: string, shortcut: string): CannedResponse | null {
    const formatted = shortcut.startsWith('/') ? shortcut : `/${shortcut}`
    const row = this.db.prepare('SELECT * FROM canned_responses WHERE organization_id = ? AND shortcut = ?').get(orgId, formatted) as any
    if (!row) return null
    return {
      id: row.id,
      shortcut: row.shortcut,
      title: row.title,
      content: row.content,
      mediaUrl: row.media_url || undefined,
      category: row.category,
      createdAt: row.created_at,
    }
  }

  listAll(orgId: string): CannedResponse[] {
    const rows = this.db.prepare('SELECT * FROM canned_responses WHERE organization_id = ? ORDER BY category ASC, shortcut ASC').all(orgId) as any[]
    return rows.map((r) => ({
      id: r.id,
      shortcut: r.shortcut,
      title: r.title,
      content: r.content,
      mediaUrl: r.media_url || undefined,
      category: r.category,
      createdAt: r.created_at,
    }))
  }

  /**
   * Expande el contenido del atajo sustituyendo variables de contacto
   */
  expandSnippet(content: string, variables: Record<string, string> = {}): string {
    let result = content
    for (const [k, v] of Object.entries(variables)) {
      result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v)
    }
    return result
  }
}
