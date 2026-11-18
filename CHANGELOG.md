# CHANGELOG

## 2026-11-17 — Higiene PII y blindaje de SSO Ecosistema

- **`fix(pii)`**:
  - **Guardián de PII (`scripts/check-pii.mjs`)**: Implementación del script de auditoría estricta para números reales y nombres en archivos rastreados; añadido `npm run check:pii`.
  - **Integración en CI (`.github/workflows/ci.yml`)**: Validación automática en el pipeline de CI contra regresiones de datos personales en el repositorio público.
- **`security(sso)`**:
  - Endurecimiento de `/studio/login-ecosystem` en modo producción: rechazo incondicional con HTTP 403 cuando `NODE_ENV=production` y `DEMO_MODE=false`.
  - Inclusión de validación multi-tenant en el token HMAC y revocación en `productionConfigProblems`. Suite: **324/324 PASS**.

## 2026-11-17 — Acceso directo al ecosistema (SSO de un solo uso)

- **`feat(studio)` (84d7232)**: `GET /studio/login-ecosystem` canjea enlaces SSO emitidos por el
  CRM (capa 1) para abrir el studio con sesión de operador sin repetir credenciales:
  - Token `v1.<payload>.<hmac>` — HMAC-SHA256 con `ECOSYSTEM_SSO_SECRET` compartido, TTL 90 s,
    `jti` de UN SOLO USO (registro en memoria con purga perezosa), verificación timing-safe.
  - Concesión: 302 a `/` con cookie HttpOnly de sesión del Studio (misma identidad que
    `/studio/login` con `INTERNAL_API_SECRET`).
  - Fail-closed: sin `ECOSYSTEM_SSO_SECRET` la ruta NO existe (404); sin credenciales
    administrativas 503; rate limit compartido con el login del studio (10/min por IP).
  - El login clásico y las puertas `/api/*` quedan intactos.
  - Pruebas: `tests/ecosystem-login.test.ts` (8 aserciones). Suite: **318/318**.
  - Docs: README §3.b, `.env.example` (`ECOSYSTEM_SSO_SECRET`).


## 2026-11-17 — Reparación de producción real (FASE 1.E + higiene + arquitectura)

### Seguridad / Privacidad — IA desactivada por defecto
- **`fix(ai)` (53cb61f)**: `resolveAiProvider` reforzado con `isAiEnabled()`:
  - Sin `AI_API_KEY` → `UnconfiguredAiProvider` (CERO llamadas HTTP a terceros).
  - `AI_ENABLED=false` apaga la IA AUNQUE exista credencial (switch maestro).
  - Con credencial (y sin `AI_ENABLED=false`) la IA activa (compatibilidad).
- Documentación de privacidad: `.env.example` (bloque de IA con advertencia) y
  README §2.b: al activar la IA, el TEXTO DE LAS CONVERSACIONES DE CLIENTES se
  transmite al proveedor externo (`AI_API_URL`); evaluar contra Ley 1581.
- Prueba: `tests/ai-disabled-by-default.test.ts` (6 casos, fetch inyectado que
  verifica que solo sale al endpoint configurado y nada sale sin config).

### Higiene y documentación
- **`docs(hygiene)` (acd532f)**: aviso de canal NO oficial Baileys en README;
  **motor de automatización DOCUMENTADO** en `FICHA.md` §7.b (automation_rules,
  automation_events, stage_change_dedup, /api/crm/stage-change, disparadores y
  acciones — código existente en `src/engine/crm-triggers.ts` que faltaba en
  docs); conteos de pruebas sin número rígido que envejece; dummies de prueba
  marcados `scan-secrets:allow`.
- **`docs(architecture)` (a6cf359)**: `DOCS/DECISION_SQLITE_TYPES.md` (postura
  `node:sqlite` + `--experimental-strip-types`: riesgos, mitigaciones,
  comportamiento esperado y plan de migración por escenario).

### Números de la sesión
- Suite: **316/316** PASS (`npm test`, runner sin `--test-isolation` para
  estabilidad Windows/Node 22.23) · `security:scan`: 0 secretos en el árbol.

---


## 2026-11-15 — Producción real: verificación total, escáner de historial, addNode del studio (rama repair/produccion-real)

### Corregido (con prueba ejecutada)
- **Flow Studio `addNode` (hallazgo F6):** la paleta llamaba una función inexistente (ReferenceError; el nodo jamás aparecía). Implementada con defaults por tipo, mapeo `action_tag`→`action` (tipo inválido) y creación de borrador si no hay flujo. Pruebas `tests/studio-addnode.test.ts` (3, fallaban antes, pasan después); evidencia en navegador real: clic añade nodo al lienzo (8→9).
- **Higiene studio:** retiradas las afirmaciones "Paridad ManyChat 100%" / "Clon ManyChat 100%" del título y etiquetas del Flow Studio.

### Seguridad
- **Escáner de secretos árbol+historial** portado desde CRM (`scripts/scan-secrets.mjs` + `npm run security:scan[:history]`): 91 hallazgos del historial verificados uno a uno como fixtures dummy de test (0 secretos reales) → baseline + allowlist explícitas; ambos modos exit 0.

### Verificación total de esta sesión
- Suite: **253/253** (38 suites, incluye fase1/fase2/consent/transporte/ventana/H1-H6) · tsc 0 errores · `npm audit` 0 vulnerabilidades.
- **E2E de los 3 servicios reales juntos** (18/18 PASS): WP recibió el inbound del puente CRM (HMAC v2), ejecutó el flujo con crm_action y el cliente quedó creado en el CRM real; el checker de locks 2B→2A excluyó el contacto con lock (`LOCK_EXCLUDED`).
- Studios en navegador (Playwright 11/11): carga, paleta, addNode real, Historial/métricas (ULTRA), vista móvil 390px sin desbordamiento.

### Límites honestos
- Docker compose NO ejecutado (sin docker en el entorno; OWNER_TODO §4). Ningún envío real; ALLOW_REAL_DISPATCH=false en todas las pruebas.


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
