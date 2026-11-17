# MATRIZ DE PRODUCCIÓN REAL — WHATSPOWER (2026-11-17)

**Rama:** `repair/produccion-real` · **Método:** evidencia EJECUTADA en la sesión.

## Veredicto final transparente (sesión reparación 2026-11-17)

| Área | Veredicto | Evidencia |
|---|---|---|
| IA del motor de flujos apagada por defecto | ✅ CERRADO | `isAiEnabled()`: sin credencial CERO llamadas HTTP; AI_ENABLED=false manda — 316/316 |
| Transmisión a terceros documentada | ✅ CERRADO | `.env.example` + README §2.b con advertencia Ley 1581 |
| Motor de automatización documentado | ✅ CERRADO | FICHA §7.b: automation_rules/events, stage_change_dedup, /api/crm/stage-change |
| Aviso canal no oficial Baileys | ✅ DOCUMENTADO | Cabecera del README |
| Node 22 / runtime | ✅ ALINEADO | engines >=22.12.0 + .nvmrc 22.14 (igual que CRM y ULTRA) |
| `npm test` en Node 22.23 aislado y limpio | ✅ OPERATIVO | runner propio sin --test-isolation=process (316/316) |
| Postura node:sqlite / strip-types | ✅ DOCUMENTADA | DOCS/DECISION_SQLITE_TYPES.md |
| Secretos en el árbol | ✅ LIMPIO | security:scan 0 hallazgos (dummies allowlisted) |
| Migración a Meta Cloud | 🟦 DECISIÓN DEL DUEÑO | Adaptadores por organización existen; Baileys NO se toca (regla del encargo) |

---

# MATRIZ DE PRODUCCIÓN REAL — WHATSPOWER (histórico 2026-11-15)

**Rama:** `repair/produccion-real` · **Método:** cada casilla con evidencia EJECUTADA (comando y resultado real), no declaraciones.

## A. Construcción y calidad

| Casilla | Estado | Evidencia ejecutada |
|---|---|---|
| TypeScript `tsc --noEmit` | ✅ LISTO | exit 0 |
| Suite completa | ✅ LISTO | **253/253** en 38 suites (`npm test`, runner sin `--test-isolation` para estabilidad Windows/Node 22) |
| `npm audit` | ✅ LISTO | 0 vulnerabilidades |
| Node alineado | ✅ LISTO | engines `>=22.12.0`, `.nvmrc` 22.14, Dockerfile node:22-alpine, CI node 22 (commit 4b8ac40, verificado hoy) |
| Docker compose | ⛔ NO EJECUTADO | Sin docker en el entorno de trabajo (OWNER_TODO §4) |
| Healthcheck operativo | ✅ LISTO | `/api/health` 200 con DB, locks activos, memoria (usado por el E2E) |
| Runbook de incidentes | ✅ LISTO | `docs/RUNBOOK.md` (commit 39cc293) |

## B. Canal oficial (FASE 1)

| Casilla | Estado | Evidencia ejecutada |
|---|---|---|
| Meta Cloud API por plan de pago | ✅ LISTO (código+pruebas) | `resolveOrganizationTransportPlan` en `tests/fase1-meta-official-channel.test.ts`; Baileys degradado a plan básico desactivado por defecto |
| Ventana 24 h + plantillas | ✅ LISTO (código+pruebas) | `MessagingWindowStore` + `TemplateRegistry`; envíos libres bloqueados fuera de ventana (suite en verde) |
| Errores Meta como estados explícitos | ✅ LISTO | `meta-error-classifier.ts`: permanentes vs `UNCERTAIN`, sin reintentos ciegos (suite) |
| Servidor Meta simulado | ✅ LISTO | `tests/helpers/mock-meta-server.ts` contra el adaptador |
| **Cuenta Meta real + número + plantillas aprobadas** | ⛔ REQUIERE DUEÑO | OWNER_TODO §2 (no se simula) |

## C. Consentimiento y Ley 1581 (FASE 2)

| Casilla | Estado | Evidencia ejecutada |
|---|---|---|
| Registro de consentimiento por org+contacto | ✅ LISTO | `ConsentStore` (consent_records + consent_audit_log); endpoint usado por el E2E (201) |
| Ninguna campaña sin consentimiento vigente | ✅ LISTO | Pruebas fase2 + E2E real: ítem sin consentimiento → `SKIPPED_NO_CONSENT` |
| Bajas revocan y quedan auditadas | ✅ LISTO | `consentRevoked:true` en opt-out (pruebas fase2) |
| Exportación/borrado de datos (habeas data) | ✅ LISTO | `/api/compliance/contact-data` GET/DELETE (pruebas fase2) |
| CSV con origen del consentimiento | ✅ LISTO (ULTRA importa; WP valida) | pruebas fase2 |

## D. Integración (FASE 5)

| Casilla | Estado | Evidencia ejecutada |
|---|---|---|
| Puente CRM→WP (HMAC v2) | ✅ LISTO | E2E 3 servicios: inbound firmado procesado (cliente creado en CRM real) |
| Locks/supresión consultables por 2B | ✅ LISTO | E2E: `GET /api/internal/locks/:phone` → locked:true → `LOCK_EXCLUDED` en campaña ULTRA |
| Aislamiento por organización | ✅ LISTO | `multiorg-isolation`, `org-identity`, credenciales por org (suites en verde) |
| Idempotencia inbound | ✅ LISTO | reserva atómica con lease (CONC-01/02) + outbox idempotente H1-H6 en verde |

## E. UI (navegador real, 11/11 con ULTRA)

| Casilla | Estado | Evidencia ejecutada |
|---|---|---|
| Flow Studio carga/login | ✅ LISTO | 200 (Playwright) |
| Paleta + **addNode** (antes roto) | ✅ LISTO | 7 ítems; clic añade nodo (8→9); 3 pruebas de cableado que fallaban antes |
| Vista móvil 390px | ✅ LISTO | overflow 0px |

## F. Seguridad

| Casilla | Estado | Evidencia ejecutada |
|---|---|---|
| Escáner de secretos árbol | ✅ LISTO | exit 0 |
| Escáner de secretos historial | ✅ LISTO | exit 0; 91 fixtures dummy baselined uno a uno (0 secretos reales); sin purga (regla) |
| PII en árbol | ✅ LISTO | higiene de sesión previa verificada: sin números reales |
| Rate limiting / HMAC / fail-closed | ✅ LISTO | security-hardening + contract-v11 en 253/253 |

## G. Bloqueos para producción

1. Cuenta Meta Business + número oficial + plantillas aprobadas (OWNER_TODO §2).
2. Rotación del PAT + purga de historial con filter-repo (OWNER_TODO §1).
3. Docker compose y `.env` reales en el PC (OWNER_TODO §4).
4. Merge autorizado de `repair/produccion-real` → `main`.
