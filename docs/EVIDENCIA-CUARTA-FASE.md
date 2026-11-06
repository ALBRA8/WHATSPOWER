# EVIDENCIA — CUARTA FASE CORRECTIVA (REPARACIÓN INTEGRAL)

**Fecha:** 2026-11-07 · **Rama:** `fix/fase-correctiva-final` (base: `fix/tercera-reparacion-integral`)
**Alcance:** cierre de los hallazgos pendientes de la auditoría independiente de la tercera reparación.
**Sin envíos reales de WhatsApp, sin cobros reales, sin despliegues, sin PR ni merge.**

---

## 1. Correcciones de esta fase (por repositorio)

### WHATSPOWER (commits `3bd1bc6` + `1954943`)
1. **Ventana de duplicación de `journaledEffect()` cerrada** (auditoría: "el proveedor acepta el mensaje pero el proceso cae antes de registrar DONE"):
   - Máquina de estados del journal: `PENDING → IN_FLIGHT (antes de invocar al proveedor) → DONE | (resolución)`.
   - Un reingreso tras crash ve `IN_FLIGHT` → responde `uncertain_needs_reconciliation` y **jamás reenvía a ciegas**.
   - Resolución explícita por efecto: `POST /api/internal/idempotency/effects/resolve` (`delivered` | `not_delivered`, auditable, sin datos sensibles).
   - Reconciliación **bloqueada** (`RECONCILE_BLOCKED_UNRESOLVED_EFFECTS`) mientras existan efectos sin resolver.
   - **Idempotencia externa**: cada envío transmite `wpfx_hash(evento,efecto)` (body `idempotencyKey` + header `X-Idempotency-Key`); si el daemon de Capa 1 la honra, la ventana cierra de extremo a extremo. **Modelo declarado con honestidad: at-least-once** (la cooperación del daemon está fuera de este repositorio).
   - Corregida además la **pérdida silenciosa**: un envío no aceptado (`ok:false` definitivo) ya no queda como DONE.
2. **`INTERNAL_API_SECRET` → identidad por organización**: `INTERNAL_API_KEYS` con clave dedicada por org (la identidad viaja en la credencial; las orgs con clave dedicada **rechazan el secreto global** con 403; clave cruzada → 403); `create-link` exige `X-Org-Id` y valida body/identidad. Compatibilidad documentada para orgs sin clave.
3. Migración **v5 aditiva** (`inbound_effect_journal.attempt_at`) documentada con rollback en `docs/MIGRACIONES.md` §W-v5.

### WHATSPOWER-ULTRA (commits `662c8da` + `221059d` + `82d6cb0`)
1. **`ADMIN_API_KEYS` revisada**: `/studio/login` usaba comparación `===` (no timing-safe) → `safeEqual`; la sesión del Studio **preserva el límite de org** (sin escalada a servicio, verificado por prueba); ownership 404 sin oráculo re-verificado.
2. **`campaign_items` aislado a nivel de fila**: migración **v5 aditiva** (columna `organization_id` + índice + **backfill determinista** desde la campaña; huérfanos → NULL aislados); el **claim excluye filas corruptas** (org de fila ≠ org de campaña) y las deja en cuarentena sin despacho; los ítems nuevos (CSV y webhook) nacen con la organización de su campaña.
3. **Credencial ULTRA→2A con identidad por organización**: `bearerForOrg()` (`AGENTIC_2A_KEYS`); sin credencial para la org → fail-closed `TENANT_UNAUTHENTICATED`. Verificado contra 2A REAL en la integración.

### CRM-ALBRA (commit `d09ff11`)
1. **Referencias históricas entre organizaciones — fuga reproducida y corregida**: una oportunidad/cotización histórica de org A con `clientId` de org B **exponía nombre+email del cliente ajeno** vía el `include` de la relación `client` (el listado JSON contenía "Cliente Beta Org B" con su email — reproducido en rojo).
2. Corrección: `src/app/api/_lib/multitenant.ts` (`stripForeignClient/s`) aplicado en **8 rutas** (oportunidades GET/detalle, quotes GET/PUT/PDF, reservations GET/PUT/DELETE, pipeline, dashboard, export CSV): el cliente de otra org se elimina del resultado; el `clientId` propio (referencia histórica de la org) se conserva; el caso legítimo no se sobre-bloquea (prueba incluida).

---

## 2. Diferenciación explícita: pruebas con MOCKS vs pruebas ENTRE SERVICIOS REALES

### Pruebas con mocks (verifican LÓGICA INTERNA; NO prueban contratos de red)
| Suite | Mocks usados | Qué prueba |
|---|---|---|
| WHATSPOWER `tests/*.test.ts` (131) | `MockTransportSender`, `FlakyTransport`, `MockCrmClient`, colgado/ambiguo en W4 | máquina de estados del journal, UNCERTAIN, resolución por efecto, claves externas, puertas HTTP con servidores efímeros locales |
| ULTRA `npm test` (80) | `MockLockChecker`, mock 2A local (TEST 2), dispatcher de prueba | claim atómico, cuarentena de filas corruptas, contrato v3 contra un mock que EXIGE Bearer y clave dedicada |
| CRM `npx vitest run` (506) | handlers de ruta importados directamente sobre BD de prueba | referencias históricas, aislamiento cross-org, backup/restore, sesiones |

### Pruebas ENTRE SERVICIOS REALES (contratos HTTP de red, sin mocks de red)
**Entorno:** 3 servicios reales arrancados como procesos independientes (CRM standalone de producción en :3101, WHATSPOWER en :3103, ULTRA en :3104, daemon simulado de transporte), BDs de prueba aisladas, 2 organizaciones (`org-albra-a`, `org-albra-b`) con **claves dedicadas por organización** (contrato v3).

Los **15 escenarios I-01..I-15** son inter-servicio REALES (evidencia cruda: `results.json` y `daemon-sends.jsonl` del entorno de integración; copia en `docs/integracion/`). Resultado sobre el código corregido: **15/15 OK**, incluyendo:
- I-05: ULTRA consulta locks/supresiones de 2A REAL con **clave dedicada por org**;
- I-06: sin `X-Org-Id` → 400; **secreto global para org con clave dedicada → 403**; **clave cruzada (org A con header de org B) → 403**;
- I-10: reintento del mismo evento → `deduplicated`, exactamente 1 efecto externo;
- I-11: webhook de pago duplicado → 1 transición; org ajena → rechazado;
- I-13: reinicio del servicio preserva locks + anti-replay + idempotencia;
- I-14: dos workers concurrentes → 4 ítems, 4 envíos, 0 duplicados.

**Comando de reproducción:** `node /home/z/my-project/integration/run-scenarios.mjs` (puede adaptarse a otras rutas; los servicios se arrancan y detienen solos).

Nota honesta: la suite `test:e2e` de ULTRA (`pilot-safeguards`) exige una Capa 2A viva en :3003 y no forma parte de `npm test` (CI); su equivalente real quedó cubierto por I-05/I-06 de esta ejecución.

---

## 3. Resultados de pruebas y CI (commits exactos)

| Repositorio | Commit de código | Suite | Resultado | CI (GitHub Actions) |
|---|---|---|---|---|
| CRM-ALBRA | `d09ff11` | vitest **506/506** · lint ratchet **328≤328** · tsc OK · escáner de secretos OK | ✅ | **success** en `d09ff11` — https://github.com/ALBRA8/CRM-ALBRA/actions |
| WHATSPOWER | `1954943` | node --test **131/131** (124 + 7 nuevas W4) · tsc OK | ✅ | **success** en `1954943` — https://github.com/ALBRA8/WHATSPOWER/actions |
| WHATSPOWER-ULTRA | `82d6cb0` | `npm test` **80/80** (incluye 4 nuevas U4 + contrato v3) · tsc OK | ✅ | **success** en `82d6cb0` — https://github.com/ALBRA8/WHATSPOWER-ULTRA/actions |
| Integración | — | I-01..I-15 sobre el código corregido | **15/15 OK** | n/a (entorno aislado local; evidencia en `docs/integracion/`) |

Cada corrección tiene su prueba que **reproduce el defecto antes del fix y pasa después** (W4-01..W4-06, U4-01..U4-04, historical-references 3 pruebas). No se eliminó ninguna prueba ni se redujo ninguna aserción; se ajustó al contrato v3 el mock 2A de `contracts-integration.test.ts` (ahora exige Bearer y clave dedicada por org — más estricto, no menos).

---

## 4. Estados y residuales (actualizados en la matriz de trazabilidad)

- **23 hallazgos CORREGIDO Y VERIFICADO · 1 PARCIAL · 4 PENDIENTE · 1 BLOQUEADO** (32 en total, fases 3+4).
- Quedan PENDIENTES (decisiones de producto/despliegue): `payment_audit` sin columna de organización (la transacción y el evento sí la llevan); `ADMIN_API_KEYS` identidad de servicio en ULTRA (poder total por diseño); deuda de lint 328 en CRM; proveedor definitivo de BD del CRM.
- BLOQUEADO: dedup de mensajes en el canal final WhatsApp (daemon de Capa 1, fuera de los tres repositorios) — mitigado del lado 2A con journal + clave externa `wpfx_` que el daemon puede honrar.
