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

  // (tercera reparación 4.A) Growth links POR ORGANIZACIÓN: PK (organization_id, id)
  // y unicidad (organization_id, slug). Dos orgs pueden usar el mismo slug sin
  // colisionar ni exponerse información.

  createGrowthLink(orgId: string, params: {
    slug: string
    prefilledText: string
    targetFlowId?: string
    initialTag?: string
  }): GrowthLink {
    if (!orgId || typeof orgId !== 'string') {
      throw new Error('VALIDATION: createGrowthLink exige organizationId (aislamiento multi-organización)')
    }
    const id = `gw_${randomUUID()}`
    const now = Math.floor(Date.now() / 1000)
    const slug = params.slug.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-')

    this.db.prepare(`
      INSERT INTO growth_links (id, organization_id, slug, target_flow_id, initial_tag, prefilled_text, clicks, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, orgId, slug, params.targetFlowId || null, params.initialTag || null, params.prefilledText, now)

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

  getLinkBySlug(orgId: string, slug: string): GrowthLink | null {
    const row = this.db.prepare('SELECT * FROM growth_links WHERE organization_id = ? AND slug = ?').get(orgId, slug) as any
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

  /**
   * Click público en /ref/:slug. El slug resuelve al link DE SU organización:
   * la fila misma lleva la org (endpoint público sin contexto de org; el
   * enlace es de la org que lo creó). Se mantiene compatibilidad de URL.
   */
  registerClick(slug: string): string | null {
    const row = this.db.prepare('SELECT * FROM growth_links WHERE slug = ? ORDER BY created_at ASC LIMIT 1').get(slug) as any
    if (!row) return null
    const link: GrowthLink = {
      id: row.id,
      slug: row.slug,
      targetFlowId: row.target_flow_id || undefined,
      initialTag: row.initial_tag || undefined,
      prefilledText: row.prefilled_text,
      clicks: row.clicks,
      createdAt: row.created_at,
    }
    this.db.prepare('UPDATE growth_links SET clicks = clicks + 1 WHERE organization_id = ? AND id = ?').run(row.organization_id, row.id)
    const encoded = encodeURIComponent(link.prefilledText)
    return `https://wa.me/${this.businessPhone}?text=${encoded}`
  }

  /**
   * Resuelve si un texto entrante corresponde a un growth link DE ESTA org (4.A).
   */
  matchIncomingText(orgId: string, text: string): GrowthLink | null {
    const trimmed = text.trim()
    const rows = this.db.prepare('SELECT * FROM growth_links WHERE organization_id = ?').all(orgId) as any[]
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
