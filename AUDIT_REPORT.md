# AUDIT_REPORT — WHATSPOWER

## Segunda reparación integral — 2026-11-06 (rama `fix/segunda-reparacion-integral`)

Nueva orden de trabajo (fase 2). Causas raíz corregidas y evidencia por bloque:

### §3.A Aislamiento multi-empresa por clave compuesta
- **Causa raíz:** el teléfono era PK GLOBAL en 10 tablas (`conversation_locks`, `suppression_list`, `session_variables`, `flow_sessions`, `contact_tags`, `contact_custom_fields`, `sequence_enrollments`, `inbox_messages`, `agent_assignments`, `payment_transactions`): el mismo número en dos organizaciones compartía locks, estado, sesiones, etiquetas y supresiones.
- **Corrección:** migración v3 en `src/db.ts` (reversible, documentada en `docs/MIGRACIONES.md`): PK compuesta (organization_id, contacto[, clave]) en todas; filas legacy a `__legacy__` (espacio que ninguna organización real puede consultar — sin atribución inventada). Todo el código pasa la organización por la cadena (lock-manager, suppression-store, flow-engine, team-manager, crm-triggers, router, server). Endpoints internos `/api/internal/*`, `/api/flows/simulate` y `/api/team/assign` exigen `x-org-id`/`orgId` (fail-closed).
- **Pruebas:** `tests/multiorg-isolation.test.ts` MO-01..03 — locks/handoff, supresión y etiquetas/campos/sesiones/secuencias completamente independientes por org.

### §3.B Integración CRM
- **Causa raíz:** una única API key global y ninguna verificación de la organización en la respuesta del CRM (el método recibía `orgId` pero nada comprobaba que el servidor remoto lo aplicara).
- **Corrección:** credenciales POR ORGANIZACIÓN (`CRM_API_KEYS` JSON en env, con fail-closed si una org no tiene clave — jamás se usa la clave de otra), cabecera `X-Org-Id` en cada acción, idempotencia de acción con org, y verificación de que el CRM CONFIRMA la organización en la respuesta (campo `orgId` añadido a `/api/crm/actions` en CRM-ALBRA — cambio aditivo de contrato); cualquier discrepancia → `TENANT_MISMATCH` y la acción se trata como fallida.
- **Pruebas:** CRM-ISO (mismatch rechazado en el flujo real del router), CRM-KEYS (resolución por org fail-closed).

### §3.C Idempotencia inbound y concurrencia
- **Causa raíz:** `src/engine/router.ts` consultaba la clave de idempotencia, ejecutaba efectos externos (mensajes/CRM) y guardaba el resultado al FINAL — dos eventos concurrentes pasaban el SELECT y duplicaban efectos.
- **Corrección:** RESERVA ATÓMICA de la clave (INSERT único) con estados explícitos `PROCESSING / COMPLETED / FAILED`, lease (120 s) con toma de posesión condicional para procesos interrumpidos, resultado final persistido (legible por réplicas) y liberación en FAILED ante error (la clave no queda consumida por un intento fallido).
- **Pruebas:** CONC-01 (dos eventos idénticos concurrentes → exactamente un efecto), CONC-02 (reserva vencida → recuperación controlada del evento).

### §3.D Pagos y webhooks
- **Causa raíz:** el registro del evento (INSERT en `payment_webhook_events`) era previo y separado de la transición del pago: un crash dejaba el evento registrado sin transición (pago PENDING para siempre) y un evento INVÁLIDO (importe incorrecto) consumía el eventId que necesitaba el evento válido corregido.
- **Corrección:** evento + transición en UNA transacción atómica (`BEGIN IMMEDIATE` + `UPDATE ... WHERE status='PENDING'`); importe/moneda/referencia validados ANTES de registrar la clave; re-entrega legítima → idempotente; pagos y etiquetas vinculados a organización.
- **Pruebas:** PAY-NEG (inválido no bloquea al válido con el mismo eventId), PAY-CONC (dos webhooks concurrentes → una sola transición/etiqueta), PAY-ISO (scoping por org), PAY-01..07 existentes en verde.

### §3.E API y secretos
- Puerta `/api/*` con Bearer fail-closed (intacta); rutas internas exigen organización; resolución de credenciales por organización cierra el acceso cruzado; HMAC v2 + anti-replay durable de la rama base se mantienen en verde.

### §7 CI
- Filtro de ramas reparado (estaba corrupto: `branches: ain, 'fix/**']` → `[main, 'fix/**', 'repair/**']`); ningún paso con `continue-on-error`.

### Resultados reales (esta rama)
- Suite: **114/114 → 115/115** pruebas (12 archivos; +11 nuevas en `tests/multiorg-isolation.test.ts`).
- `npx tsc --noEmit` (typescript@5): 0 errores.
- Sin envíos reales (MockTransport en sala limpia), sin campañas ni cobros reales.
