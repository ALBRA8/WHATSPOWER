# CHANGELOG

## 2026-11-15 — Preparación para Producción Real (rama repair/produccion-real)

### Fase 1 — Canal Oficial de WhatsApp
- **Meta Cloud API por defecto:** Implementación de `resolveOrganizationTransportPlan` que asigna transporte oficial Meta Cloud para planes de pago y degrada Baileys a plan básico desactivado por defecto.
- **Ventana de 24 horas y Plantillas:** Almacén durable `MessagingWindowStore` y registro de plantillas `TemplateRegistry`. Envíos libres bloqueados fuera de la ventana de 24 horas.
- **Clasificación de Errores:** Adaptador `meta-error-classifier.ts` que categoriza rechazos permanentes vs errores ambiguos (`UNCERTAIN`) sin reintentos ciegos.
- **Pruebas y Mocks:** `MockMetaServer` local para validación contractual.

### Fase 2 — Consentimiento y Cumplimiento Normativo (Ley 1581)
- **Registro de Consentimiento:** Implementación de `ConsentStore` con tablas `consent_records` y `consent_audit_log`.
- **Revocación en Bajas:** Revocación automática y auditada de consentimientos cuando un contacto solicita baja (`STOP/BAJA`).
- **Endpoints de Habeas Data:** `GET /api/compliance/contact-data` y `DELETE /api/compliance/contact-data` para exportación y supresión de datos personales.

### Fase 3 — Estabilidad y Operaciones
- **Alineación de Entorno:** Node `>=22.12.0` (engines), `.nvmrc` (`22.14.0`), Dockerfile (`node:22-alpine`) y CI (`node-version: 22`).
- **Runner de Pruebas:** `scripts/run-tests.mjs` sin `--test-isolation=process` para estabilidad total en Windows/Node 22+.
- **Healthcheck Operativo:** `/api/health` con monitoreo de DB ping, memoria RSS/heap, locks activos y consentimientos.
- **Runbook:** Guía completa de incidentes y operación en `docs/RUNBOOK.md`.

### Fase 4 y 5 — Higiene y Verificación
- Sanitización de datos personales y eliminación de afirmaciones inexactas de paridad ManyChat en `README.md` y `FICHA.md`.
- 38 suites de prueba pasando (250/250 pruebas superadas al 100%). TypeScript 0 errores.

---

## 2026-11-11/12 — Auditoría integral: ciclos 1 y 2 (rama impl/audit-20261111)

### Corregido
- Seguridad: rate limiting durable en BD; fail-closed de secretos; HMAC timing-safe;
  secretos Telegram cifrados con lookup por hash; JWT jamás en URLs de export; errores
  genéricos (sin filtrar e.message); P2002→409 / P2025→404.
- Fiabilidad: idempotencia extremo a extremo con eventId determinista; dedup de webhooks
  (waMessageId/mid) incl. statuses; liberación de dedup on-throw; transacciones atómicas
  (registro, conexiones con límite de plan, cliente+timeline); WAL + busy_timeout.
- Frontend (CRM): deep-links reales, reset de formulario corregido, TabsList wrap,
  JSON.parse blindado, vista /chat muerta eliminada.
- Pruebas: suites en verde al cierre de cada ciclo; pruebas nuevas para cada corrección
  (rate limit durable, dedup, dual-formato, release-on-throw, etc.).

### Rerequisito de despliegue
- Ejecutar `npx prisma migrate deploy` (incluye migración 4_audit_indexes con respaldo
  reversible) y `node scripts/migrate-telegram-secrets.mjs` (backfill idempotente).
- NO desplegar sin autorización expresa del propietario.
