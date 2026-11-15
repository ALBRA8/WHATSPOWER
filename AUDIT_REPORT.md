# AUDIT_REPORT — WHATSPOWER

## Actualización 2026-11-15 — Producción real (rama `repair/produccion-real`)

**Método:** línea base completa ejecutada sobre la rama (que ya traía FASE 1-4 de la sesión anterior re-verificadas en verde), hallazgos corregidos con prueba que falla antes y pasa después, E2E con los 3 servicios reales en simulación y prueba de studios en navegador real.

### Línea base (ejecutada en esta sesión)
| Verificación | Resultado |
|---|---|
| `tsc --noEmit` | 0 errores |
| Suite (node:test) | **253/253** en 38 suites (incluye fase1 Meta Cloud, fase2 Ley 1581, ventana 24h, transporte por plan, H1-H6) |
| `npm audit` | 0 vulnerabilidades |
| `security:scan` (árbol) | LIMPIO (exit 0) |
| `security:scan:history` | LIMPIO (exit 0): 91 hallazgos históricos verificados uno a uno como fixtures dummy de test; baseline + allowlist explícitas |

### Hallazgos de esta sesión

| ID | Severidad | Descripción | Estado | Evidencia |
|---|---|---|---|---|
| F6-W1 | ALTA | Flow Studio: paleta llamaba `addNode(...)` que no existía (ReferenceError; "addNode pendiente" de la orden original) | ✅ CORREGIDO | `tests/studio-addnode.test.ts` 3/3 (fallaban antes del fix); navegador real: nodo añadido al lienzo (8→9) |
| F6-W2 | MEDIA | Tipo de nodo inválido `action_tag` (el motor espera `action`) | ✅ CORREGIDO | Mapeo en `NODE_PALETTE_DEFAULTS` verificado contra FlowNodeType (STUDIO-ADDNODE-2) |
| F6-W3 | BAJA | Afirmaciones de paridad "ManyChat 100%" en el HTML del studio (contradecían la higiene de docs) | ✅ CORREGIDO | Título y etiquetas renombrados; suite 253/253 |
| F6-W4 | BAJA | WP sin escáner de secretos propio | ✅ CORREGIDO | `scripts/scan-secrets.mjs` + npm scripts; árbol e historial en verde con baseline verificable |

### E2E 3 servicios reales (18/18 PASS, simulación, cero envíos reales)
- Inbound del puente CRM (webhook Meta firmado → CRM valida → HMAC v2 → `/api/inbound`) procesado por WP; el flujo con trigger keyword ejecutó `crm_action create_client` y el cliente quedó creado en el CRM real.
- Lock `IN_FLOW_2A` creado por mensaje entrante real; el checker de ULTRA consultó `GET /api/internal/locks/:phone` y excluyó el contacto (`LOCK_EXCLUDED`).
- Consentimiento por organización operativo (endpoint FASE 2 usado por el E2E: 201).
- `SENT=0` en toda la campaña ULTRA (salvaguarda intacta).

### Studios en navegador (Playwright/Chromium, 11/11 PASS)
Flow Studio: carga 200, paleta 7 nodos, addNode funcional, móvil 390px sin desbordamiento. (Campaign Studio de ULTRA: Historial y métricas presentes.)

### Pendientes (no bloqueados por código)
- Docker compose en el PC del dueño (sin docker aquí) → `OWNER_TODO.md` §4.
- Cuenta Meta Business + número oficial + plantillas aprobadas → `OWNER_TODO.md` §2.

---

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


---

## Ciclo de auditoría 2026-11-11/12 — corrección integral y reauditoría goldfish (ciclos 1 y 2)

**Método.** 5 auditores independientes consolidaron 73 hallazgos deduplicados. Corrección
autónoma en 2 ciclos con regla "sin prueba verificable no se declara resuelto". El ciclo 2 fue
una REAUDITORÍA con revisores "goldfish" de contexto fresco (protocolo EGM de Google:
elephant-goldfish-model, Apache-2.0) sobre los diffs reales, sin el historial de la conversación.

### Resumen por severidad
- Críticas/altas de seguridad: resueltas (detalles por commit abajo).
- 0 vulnerabilidades críticas/altas de dependencias en runtime tras los bumps (quedan 5 moderadas
  conocidas en el CRM: react-syntax-highlighter/PrismJS DOM clobbering — fix breaking programado).

### Ciclo 1 — correcciones (commits: ver CHANGELOG)
- Batch B2/D2: clasificación de errores 5xx/timeout como UNCERTAIN (jamás reenvío a ciegas),
  eventId determinista CRM→WHATSPOWER con ventana de 5 min, rate limiting DURABLE en BD,
  fail-closed de secretos (webhook secret jamás como Bearer, secreto legado desactivado con
  claves por-org presentes), transacciones para org+user y para conexiones, dedup de webhooks
  Meta por waMessageId, cifrado AES-256-GCM + lookup por hash de secretos Telegram.
- Frontend (CRM): export con JWT en header (nunca en URL), deep-link Settings?tab, reset de
  formulario, TabsList con wrap, JSON.parse blindado.

### Ciclo 2 — reauditoría goldfish: hallazgos y resolución
| Sev | Hallazgo | Resolución |
| --- | --- | --- |
| CRITICA | CRM: useEffect del form de clientes sin deps (borraba cada tecla) | deps [open, editClient] — 569/569 |
| ALTA | CRM: backfill Telegram derivaba hash del ciphertext en estado parcial | hash SIEMPRE del valor en claro (descifra primero) |
| ALTA | ULTRA: sin busy_timeout (server+worker comparten db/) | PRAGMA busy_timeout=5000 en ambas aperturas |
| MEDIA | WP: sin WAL/busy_timeout | pragmas en createDatabase |
| MEDIA | WP: fail-open del limiter invisible | console.warn en el catch |
| MEDIA | WP: evento 'ya procesado sin resultado' si la ejecución falla tras el dedup | liberación de clave on-throw (reintento re-ejecuta) |
| MEDIA | CRM: statuses de Meta duplicados en reintentos | dedup por messageId también en statuses |
| MEDIA | CRM: migración de dedup irreversible | respaldo reversible Client_dedup_backup_20261111 |
| MEDIA | ULTRA: claim A4-10 ≠ código (columnas pesadas) | comentario sincronizado; proyección pendiente |
| BAJA | CRM: encryptSecret null silencioso; WP/ULTRA: limiter muertos, stacks en logs, tests dual-formato | resueltos |

### Residuales documentados (no bloqueantes, con riesgo conocido)
1. Prisma SQLite abre BEGIN DEFERRED: la re-verificación del límite de plan dentro de la
   transacción es best-effort; la cerradura definitiva contra duplicados es el UNIQUE
   (phoneNumberId) con P2002→409. Multi-instancia sobre PostgreSQL eliminaría la reserva.
2. ULTRA: API de campañas cambió contrato (201 + {campaigns:[...]}) — consumidor interno
   actualizado; terceros deben migrar (documentado en CHANGELOG).
3. WP A1-05: evento sin teléfono deduplicado 24 h — si el CRM corrige el dato debe emitir un
   eventId nuevo (comportamiento documentado).
4. CRM: 5 vulnerabilidades moderadas de dependencias (fix breaking programado).
5. Dedup check-then-act de webhooks conserva ventana TOCTOU microscópica ante POSTs
   simultáneos verdaderos (el índice parcial cierra la vía del daemon).

### Pruebas (verde al cierre)
- CRM (vitest): 569/569
- WHATSPOWER (node --test): 203/203
- ULTRA (node --test): 152/152
- TypeScript --noEmit: 0 errores en los 3 repos.
