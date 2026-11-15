import { test, describe, it } from 'node:test'
import assert from 'node:assert'
import { createDatabase } from '../src/db.ts'
import { ConsentStore } from '../src/safety/consent-store.ts'

describe('FASE 2 — CONSENTIMIENTO Y CUMPLIMIENTO (WHATSPOWER Nivel 2)', () => {
  const db = createDatabase(':memory:')
  const consentStore = new ConsentStore(db)

  const orgId = 'org_compliance_test'
  const phone = '573001234567'

  it('2.1 Registro completo de consentimiento (Ley 1581)', () => {
    consentStore.recordConsent({
      organizationId: orgId,
      contactPhone: phone,
      whoAuthorized: 'Juan Pérez',
      channel: 'web_form',
      textShown: 'Autorizo el tratamiento de mis datos personales para finalidades comerciales conforme a la Ley 1581 de 2012.',
      source: 'checkout_page_v1',
    })

    const hasConsent = consentStore.hasActiveConsent(orgId, phone)
    assert.strictEqual(hasConsent, true)

    const record = consentStore.getConsentRecord(orgId, phone)
    assert.ok(record)
    assert.strictEqual(record.whoAuthorized, 'Juan Pérez')
    assert.strictEqual(record.channel, 'web_form')
    assert.strictEqual(record.source, 'checkout_page_v1')
    assert.strictEqual(record.status, 'ACTIVE')
  })

  it('2.2 Contacto sin consentimiento registrado no tiene consentimiento activo', () => {
    const hasConsent = consentStore.hasActiveConsent(orgId, '573000000000')
    assert.strictEqual(hasConsent, false)
  })

  it('2.3 Las bajas revocan el consentimiento y quedan auditadas', () => {
    consentStore.revokeConsent(orgId, phone, 'Solicitud expresa de baja vía WhatsApp (STOP)', 'user_inbound')
    const hasConsentAfter = consentStore.hasActiveConsent(orgId, phone)
    assert.strictEqual(hasConsentAfter, false)

    const record = consentStore.getConsentRecord(orgId, phone)
    assert.strictEqual(record?.status, 'REVOKED')
    assert.strictEqual(record?.revocationReason, 'Solicitud expresa de baja vía WhatsApp (STOP)')

    const auditTrail = consentStore.getAuditLog(orgId, phone)
    assert.ok(auditTrail.length >= 2, 'Debe haber auditoría de creación y de revocación')
    const lastAudit = auditTrail[auditTrail.length - 1]
    assert.strictEqual(lastAudit.action, 'REVOKE')
    assert.strictEqual(lastAudit.actor, 'user_inbound')
  })

  it('2.4 Exportación de datos por contacto (Ley 1581 - Habeas Data)', () => {
    const exported = consentStore.exportContactData(orgId, phone)
    assert.strictEqual(exported.organizationId, orgId)
    assert.strictEqual(exported.contactPhone, phone)
    assert.ok(exported.consentRecord)
    assert.ok(Array.isArray(exported.auditTrail))
    assert.strictEqual(exported.auditTrail.length >= 2, true)
  })

  it('2.5 Borrado de datos por contacto (Derecho de supresión Ley 1581)', () => {
    const deleted = consentStore.deleteContactData(orgId, phone, 'admin_dpo')
    assert.strictEqual(deleted.success, true)

    // Datos personales quedan borrados o anonimizados
    const checkActive = consentStore.hasActiveConsent(orgId, phone)
    assert.strictEqual(checkActive, false)

    const record = consentStore.getConsentRecord(orgId, phone)
    assert.strictEqual(record, null)
  })
})
