/**
 * template-registry.ts — Registro y verificación de plantillas de WhatsApp Cloud API.
 * Modela estados oficiales de aprobación: APPROVED, PENDING, REJECTED, PAUSED.
 */
import type { DatabaseSync } from 'node:sqlite'

export type TemplateStatus = 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED'
export type TemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'

export interface MetaTemplate {
  id: string
  organizationId: string
  name: string
  language: string
  category: TemplateCategory
  status: TemplateStatus
  body: string
  components?: Array<Record<string, unknown>>
  updatedAt?: number
}

export class TemplateRegistry {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.ensureSchema()
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta_templates (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        language TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        body TEXT NOT NULL,
        components_json TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meta_templates_org_name
      ON meta_templates (organization_id, name);
    `)
  }

  registerTemplate(tpl: MetaTemplate): void {
    const updatedAt = tpl.updatedAt ?? Date.now()
    const componentsJson = tpl.components ? JSON.stringify(tpl.components) : null
    const stmt = this.db.prepare(`
      INSERT INTO meta_templates (
        id, organization_id, name, language, category, status, body, components_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        organization_id = excluded.organization_id,
        name = excluded.name,
        language = excluded.language,
        category = excluded.category,
        status = excluded.status,
        body = excluded.body,
        components_json = excluded.components_json,
        updated_at = excluded.updated_at
    `)
    stmt.run(
      tpl.id,
      tpl.organizationId,
      tpl.name,
      tpl.language,
      tpl.category,
      tpl.status,
      tpl.body,
      componentsJson,
      updatedAt
    )
  }

  getTemplate(organizationId: string, name: string): MetaTemplate | null {
    const stmt = this.db.prepare(`
      SELECT id, organization_id, name, language, category, status, body, components_json, updated_at
      FROM meta_templates
      WHERE organization_id = ? AND name = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    const row = stmt.get(organizationId, name) as any
    if (!row) return null
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      language: row.language,
      category: row.category,
      status: row.status,
      body: row.body,
      components: row.components_json ? JSON.parse(row.components_json) : undefined,
      updatedAt: row.updated_at,
    }
  }

  isTemplateApproved(
    organizationId: string,
    name: string
  ): { approved: boolean; status?: TemplateStatus; template?: MetaTemplate } {
    const tpl = this.getTemplate(organizationId, name)
    if (!tpl) {
      return { approved: false }
    }
    return {
      approved: tpl.status === 'APPROVED',
      status: tpl.status,
      template: tpl,
    }
  }
}
