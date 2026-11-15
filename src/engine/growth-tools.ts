import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

export interface GrowthLink {
  id: string
  slug: string
  targetFlowId?: string
  initialTag?: string
  prefilledText: string
  clicks: number
  createdAt: number
}

export class GrowthToolsManager {
  private db: DatabaseSync
  private businessPhone: string

  constructor(db: DatabaseSync, businessPhone: string = '573001234567') {
    this.db = db
    this.businessPhone = businessPhone.replace(/\D/g, '')
  }

  createGrowthLink(params: {
    slug: string
    prefilledText: string
    targetFlowId?: string
    initialTag?: string
  }): GrowthLink {
    const id = `gw_${randomUUID()}`
    const now = Math.floor(Date.now() / 1000)
    const slug = params.slug.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-')

    this.db.prepare(`
      INSERT INTO growth_links (id, slug, target_flow_id, initial_tag, prefilled_text, clicks, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(id, slug, params.targetFlowId || null, params.initialTag || null, params.prefilledText, now)

    return {
      id,
      slug,
      targetFlowId: params.targetFlowId,
      initialTag: params.initialTag,
      prefilledText: params.prefilledText,
      clicks: 0,
      createdAt: now,
    }
  }

  getLinkBySlug(slug: string): GrowthLink | null {
    const row = this.db.prepare('SELECT * FROM growth_links WHERE slug = ?').get(slug) as any
    if (!row) return null
    return {
      id: row.id,
      slug: row.slug,
      targetFlowId: row.target_flow_id || undefined,
      initialTag: row.initial_tag || undefined,
      prefilledText: row.prefilled_text,
      clicks: row.clicks,
      createdAt: row.created_at,
    }
  }

  registerClick(slug: string): string | null {
    const link = this.getLinkBySlug(slug)
    if (!link) return null

    this.db.prepare('UPDATE growth_links SET clicks = clicks + 1 WHERE slug = ?').run(slug)
    const encoded = encodeURIComponent(link.prefilledText)
    return `https://wa.me/${this.businessPhone}?text=${encoded}`
  }

  /**
   * Intenta resolver si un texto entrante corresponde a un enlace de crecimiento
   */
  matchIncomingText(text: string): GrowthLink | null {
    const trimmed = text.trim()
    const rows = this.db.prepare('SELECT * FROM growth_links').all() as any[]
    for (const r of rows) {
      if (r.prefilled_text.trim().toLowerCase() === trimmed.toLowerCase()) {
        return {
          id: r.id,
          slug: r.slug,
          targetFlowId: r.target_flow_id || undefined,
          initialTag: r.initial_tag || undefined,
          prefilledText: r.prefilled_text,
          clicks: r.clicks,
          createdAt: r.created_at,
        }
      }
    }
    return null
  }
}
