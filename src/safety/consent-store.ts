/**
 * consent-store.ts — Registro y auditoría de consentimiento de datos personales (Ley 1581 de 2012 / Habeas Data).
 *
 * Exigencias normativas:
 *  - Quién autorizó, cuándo, canal, texto mostrado y fuente.
 *  - Las bajas revocan el consentimiento y quedan registradas en audit trail inmutable.
 *  - Exportación de datos personales por contacto (derecho de acceso/portabilidad).
 *  - Borrado o supresión de datos personales por contacto (derecho al olvido).
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type ConsentStatus = 'ACTIVE' | 'REVOKED'

export interface ConsentRecord {
  id: string
  organizationId: string
  contactPhone: string
  whoAuthorized: string
  authorizedAt: number
  channel: string
  textShown: string
  source: string
  status: ConsentStatus
  revokedAt?: number | null
  revocationReason?: string | null
  revocationActor?: string | null
}

export interface ConsentAuditEntry {
  id: string
  organizationId: string
  contactPhone: string
  action: 'GRANT' | 'REVOKE' | 'DELETE' | 'EXPORT'
  actor: string
  reason?: string
  timestamp: number
  detailsJson?: string
}

export interface RecordConsentInput {
  organizationId: string
  contactPhone: string
  whoAuthorized: string
  channel: string
  textShown: string
  source: string
  authorizedAt?: number
}

export class ConsentStore {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.ensureSchema()
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consent_records (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        who_authorized TEXT NOT NULL,
        authorized_at INTEGER NOT NULL,
        channel TEXT NOT NULL,
        text_shown TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        revoked_at INTEGER,
        revocation_reason TEXT,
        revocation_actor TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_consent_records_org_phone
      ON consent_records (organization_id, contact_phone);

      CREATE TABLE IF NOT EXISTS consent_audit_log (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT,
        timestamp INTEGER NOT NULL,
        details_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_consent_audit_org_phone
      ON consent_audit_log (organization_id, contact_phone);
    `)
  }

  recordConsent(input: RecordConsentInput): ConsentRecord {
    const cleanPhone = input.contactPhone.replace(/\D/g, '')
    const id = `cst_${randomUUID()}`
    const authorizedAt = input.authorizedAt ?? Date.now()

    const stmt = this.db.prepare(`
      INSERT INTO consent_records (
        id, organization_id, contact_phone, who_authorized, authorized_at,
        channel, text_shown, source, status, revoked_at, revocation_reason, revocation_actor
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, NULL, NULL)
      ON CONFLICT(id) DO NOTHING
    `)
    stmt.run(
      id,
      input.organizationId,
      cleanPhone,
      input.whoAuthorized,
      authorizedAt,
      input.channel,
      input.textShown,
      input.source
    )

    this.audit(input.organizationId, cleanPhone, 'GRANT', input.whoAuthorized, 'Consentimiento otorgado', {
      channel: input.channel,
      source: input.source,
      authorizedAt,
    })

    return {
      id,
      organizationId: input.organizationId,
      contactPhone: cleanPhone,
      whoAuthorized: input.whoAuthorized,
      authorizedAt,
      channel: input.channel,
      textShown: input.textShown,
      source: input.source,
      status: 'ACTIVE',
    }
  }

  hasActiveConsent(organizationId: string, contactPhone: string): boolean {
    const cleanPhone = contactPhone.replace(/\D/g, '')
    const stmt = this.db.prepare(`
      SELECT status FROM consent_records
      WHERE organization_id = ? AND contact_phone = ? AND status = 'ACTIVE'
      ORDER BY authorized_at DESC
      LIMIT 1
    `)
    const row = stmt.get(organizationId, cleanPhone) as { status: string } | undefined
    return Boolean(row && row.status === 'ACTIVE')
  }

  getConsentRecord(organizationId: string, contactPhone: string): ConsentRecord | null {
    const cleanPhone = contactPhone.replace(/\D/g, '')
    const stmt = this.db.prepare(`
      SELECT id, organization_id, contact_phone, who_authorized, authorized_at,
             channel, text_shown, source, status, revoked_at, revocation_reason, revocation_actor
      FROM consent_records
      WHERE organization_id = ? AND contact_phone = ?
      ORDER BY authorized_at DESC
      LIMIT 1
    `)
    const row = stmt.get(organizationId, cleanPhone) as any
    if (!row) return null
    return {
      id: row.id,
      organizationId: row.organization_id,
      contactPhone: row.contact_phone,
      whoAuthorized: row.who_authorized,
      authorizedAt: row.authorized_at,
      channel: row.channel,
      textShown: row.text_shown,
      source: row.source,
      status: row.status as ConsentStatus,
      revokedAt: row.revoked_at,
      revocationReason: row.revocation_reason,
      revocationActor: row.revocation_actor,
    }
  }

  revokeConsent(organizationId: string, contactPhone: string, reason: string, actor: string = 'system'): boolean {
    const cleanPhone = contactPhone.replace(/\D/g, '')
    const now = Date.now()
    const stmt = this.db.prepare(`
      UPDATE consent_records
      SET status = 'REVOKED', revoked_at = ?, revocation_reason = ?, revocation_actor = ?
      WHERE organization_id = ? AND contact_phone = ? AND status = 'ACTIVE'
    `)
    const info = stmt.run(now, reason, actor, organizationId, cleanPhone)

    this.audit(organizationId, cleanPhone, 'REVOKE', actor, reason, { revokedAt: now })
    return info.changes > 0
  }

  exportContactData(organizationId: string, contactPhone: string) {
    const cleanPhone = contactPhone.replace(/\D/g, '')
    const consent = this.getConsentRecord(organizationId, cleanPhone)
    const auditTrail = this.getAuditLog(organizationId, cleanPhone)
    this.audit(organizationId, cleanPhone, 'EXPORT', 'compliance_system', 'Exportación de datos personales')
    return {
      organizationId,
      contactPhone: cleanPhone,
      exportedAt: new Date().toISOString(),
      legalBasis: 'Ley 1581 de 2012 — Habeas Data',
      consentRecord: consent,
      auditTrail,
    }
  }

  deleteContactData(organizationId: string, contactPhone: string, actor: string = 'admin'): { success: boolean } {
    const cleanPhone = contactPhone.replace(/\D/g, '')
    // Borrado de registros personales activos
    const delConsent = this.db.prepare(`
      DELETE FROM consent_records
      WHERE organization_id = ? AND contact_phone = ?
    `)
    delConsent.run(organizationId, cleanPhone)

    // El log de auditoría conserva constancia inmutable de la supresión de datos
    this.audit(organizationId, cleanPhone, 'DELETE', actor, 'Derecho de supresión / borrado ejercido')
    return { success: true }
  }

  getAuditLog(organizationId: string, contactPhone: string): ConsentAuditEntry[] {
    const cleanPhone = contactPhone.replace(/\D/g, '')
    const stmt = this.db.prepare(`
      SELECT id, organization_id, contact_phone, action, actor, reason, timestamp, details_json
      FROM consent_audit_log
      WHERE organization_id = ? AND contact_phone = ?
      ORDER BY timestamp ASC
    `)
    const rows = stmt.all(organizationId, cleanPhone) as any[]
    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      contactPhone: r.contact_phone,
      action: r.action,
      actor: r.actor,
      reason: r.reason,
      timestamp: r.timestamp,
      detailsJson: r.details_json,
    }))
  }

  private audit(organizationId: string, contactPhone: string, action: ConsentAuditEntry['action'], actor: string, reason?: string, details?: any) {
    const stmt = this.db.prepare(`
      INSERT INTO consent_audit_log (id, organization_id, contact_phone, action, actor, reason, timestamp, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      `aud_${randomUUID()}`,
      organizationId,
      contactPhone,
      action,
      actor,
      reason ?? null,
      Date.now(),
      details ? JSON.stringify(details) : null
    )
  }
}
