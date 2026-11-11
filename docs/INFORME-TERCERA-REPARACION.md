# INFORME DE TERCERA REPARACIÓN INTEGRAL — WHATSPOWER

**Repositorio:** `ALBRA8/WHATSPOWER` · **Rama:** `fix/tercera-reparacion-integral`
**Base commit:** `f3f6136` (fix/segunda-reparacion-integral) · **Commit final:** `82079bd`
**Fecha:** 2026-11-06/07 · **Ejecutado en sala limpia (sandbox), sin despliegues ni envíos reales.**

---

## 1. Alcance ejecutado (orden §4.A–§4.F)

### 4.A — AISLAMIENTO MULTIEMPRESA TOTAL (causa raíz: tablas de configuración globales)
La segunda reparación aisló las tablas de contacto, pero `flows`, `sequences`,
`sequence_steps`, `agents`, `canned_responses` y `growth_links` seguían
GLOBALES (PK sin organización): una organización veía, editaba y ejecutaba la
configuración de otra. Corregido a nivel de ESQUEMA y de TODO el recorrido:

- **Migración v4 (reversible, documentada en `docs/MIGRACIONES.md` §W-v4):** las
  6 tablas se reconstruyen con `organization_id` dentro de la PK; unicidad
  `(organization_id, shortcut)` y `(organization_id, slug)`. Filas legacy →
  espacio reservado `'__legacy__'` (ninguna organización real puede
  consultarlas; no se inventa atribución).
- **Endpoints con X-Org-Id OBLIGATORIO (header, jamás del body):** `/api/flows`
  (GET/POST), `/api/team/agents` (GET/POST), `/api/team/assign` (la org del
  header; el body ya no decide), `/api/canned`, `/api/growth/links`,
  `/api/internal/*`. Sin header → 400.
- **FlowEngine org-aware:** `saveFlow/getFlow/listFlows/deleteFlow/
  findMatchingFlow/saveSequence/getSequence` con org; el mensaje de una org
  JAMÁS dispara el flujo de otra (aun con keywords o ids idénticos); sub-flujos
  (`goto_flow`) e inscripciones a secuencias verifican pertenencia; seed del
  flujo demo perezosa POR ORGANIZACIÓN (cada org recibe SU copia).
- **Equipo:** agentes por organización; una org no lista ni asigna agentes de otra.
- **Eco de organización (contrato v2 hacia ULTRA):** respuestas internas de
  locks y supresión incluyen `organizationId`.

### 4.B — MOTOR DE FLUJOS
Incluido en 4.A (arriba). Pruebas negativas: A no puede listar/leer/editar/
ejecutar B (T3-06, FL-01, MO-03, studio-api 1c/aislamiento).

### 4.C — IDEMPOTENCIA DE ENTRADA REFORZADA (modelo de entrega REAL, documentado)
- **Journal duradero de efectos** (`inbound_effect_journal`, migración v4): todo
  efecto externo (envío/acción CRM) queda PENDING→DONE; un reingreso tras
  crash/lease vencido SÓLO ejecuta efectos PENDING — **un mensaje ya enviado
  jamás se reenvía por un fallo posterior** (T3-01).
- **Estado UNCERTAIN:** un fallo con efectos externos ya completados deja la
  clave UNCERTAIN (no FAILED): el reintento ciego está BLOQUEADO
  (`uncertain_needs_reconciliation`); la **reconciliación explícita**
  (`POST /api/internal/idempotency/reconcile`, listado en `GET .../uncertain`)
  re-ejecuta el ciclo reutilizando el journal, sin reenviar lo DONE y sin
  re-adquirir el lock de conversación (exclusión mutua ya garantizada por la
  reserva). Payload original persistido (`idempotency_event_payloads`).
- **Lease con renovación segura:** heartbeat cada 30 s extiende el lease 120 s
  MIENTRAS el proceso vive; si otro proceso toma posesión, el ejecutador
  aborta (`LEASE_LOST`) antes del siguiente efecto (T3-04).
- **MODELO DE ENTREGA (sin promesas falsas):** at-least-once con efectos
  idempotentes (journal). NO se promete exactly-once. Documentado en
  `.env.example` y en el código.

### 4.D — CLIENTE CRM (HttpCrmClient) ESTRICTO
- **Exige** `orgId` en la respuesta del CRM: respuesta SIN organización →
  `TENANT_UNVERIFIED` (rechazada; antes se aceptaba con `?? orgId`); organización
  distinta → `TENANT_MISMATCH`; respuesta no-JSON ambigua → rechazada.
- Errores de autenticación/tenant → fail-closed. Credenciales POR organización
  (`CRM_API_KEYS`); una org sin clave falla sin usar la de otra (T3-05).

### 4.E — PAGOS
- **Pasarelas reales exigen configuración explícita:** `WOMPI_PUBLIC_KEY`
  (formato `pub_*`), `MERCADOPAGO_LINK_PREFIX`, `STRIPE_PAYMENT_LINK_PREFIX`;
  sin ellas se rechaza la creación (`PAYMENTS_GATEWAY_NOT_CONFIGURED`) —
  eliminados los valores de test por defecto (`pub_test_123`,
  `buy.stripe.com/test_`, dominio productivo aparente del simulador).
- **Simulador honesto:** enlace LOCAL `/payments/simulator/:id`.
- **Webhook con organización:** si el payload declara `orgId`, DEBE coincidir
  con la organización de la transacción (si no, `VALIDATION_MISMATCH` sin
  consumir el eventId); el evento registrado persiste `organization_id`
  (migración aditiva, legacy NULL sin atribución inventada) (T3-09, PAY-ISO/PAY-NEG/PAY-CONC previos).
- **No se ejecuta ninguna cobranza real.**

### 4.F — CREDENCIALES Y SEGURIDAD
- **Sesión de Studio/QR por cookie HttpOnly+SameSite=Strict** (Secure en
  producción): el secreto administrativo se canjea UNA vez en `/studio/login`
  y JAMÁS toca sessionStorage (antes un XSS lo leía; paridad con el fix de
  ULTRA de fase 2) (T3-10).
- **Rate limiting** (`RateLimiter` por ventana) en `/api/inbound` (120/min),
  `/api/payments/webhook` (60/min), `/ref/:slug` (300/min), `/studio/login`
  (10/min) (T3-08).
- **Auth timing-safe** (`isAuthorizedBearer`) en supresión POST/DELETE (antes
  comparación `===` no constante) (T3-07); **tope de body** en supresión POST;
  teléfonos enmascarados en logs de auditoría.

## 2. Hallazgos PENDIENTES / decisiones de producto
- `INTERNAL_API_SECRET` es un único secreto compartido por todas las
  organizaciones para la superficie admin: la autenticación identifica el
  SERVICIO, la organización la aporta y valida cada llamada (`X-Org-Id`
  obligatorio + unicidad por org + validaciones de pertenencia). Un secreto
  POR ORGANIZACIÓN para la API admin exigiría cambio de contrato con el CRM
  (fuera del alcance autorizado; requiere decisión de producto).
- `/api/payments/create-link` toma `orgId` del body (caller interno
  autenticado por el secreto compartido); consistente con lo anterior.
- `payment_audit` no lleva columna de organización (la transacción sí; el
  evento de webhook también desde v4).
- La entrega WhatsApp final depende del daemon de Capa 1: el journal garantiza
  no-duplicación del lado 2A; la deduplicación en el canal exige cooperación
  del daemon (documento, no implementable aquí).

## 3. Pruebas REALES ejecutadas (comandos y resultados)
| Comando | Resultado |
|---|---|
| `node --experimental-strip-types --test tests/*.test.ts` | **124/124 pass** (114 previos endurecidos + 10 nuevas T3-01..T3-10) |
| `npx tsc --noEmit` | OK (CI: success) |
| CI GitHub Actions (`CI WHATSPOWER`) | **success** en `82079bd` |

Pruebas forzosas nuevas (todas "reproducen el fallo antes del fix y pasan tras"):
T3-01 envío exitoso+fallo tardío+reintento sin duplicación (journal) · T3-02
fallo limpio → FAILED · T3-03 colisión de eventId entre orgs · T3-04 renovación
de lease · T3-05 HttpCrmClient estricto (sin org/ajena/no-JSON) · T3-06
aislamiento HTTP de team/canned/growth · T3-07 eco de org + timing-safe ·
T3-08 rate limit 429 · T3-09 webhook org ajena sin consumir eventId · T3-10
Studio sin sessionStorage + cookie HttpOnly.

## 4. Migraciones y sus resultados
`docs/MIGRACIONES.md` §W-v4 (tablas por org con rollback exacto por tabla;
journal/payloads; columna `payment_webhook_events.organization_id`; valor
UNCERTAIN sin cambio de esquema). Ejecutadas automáticamente al arrancar sobre
BD en memoria y de archivo en la batería e integración; probadas con datos
representativos (filas legacy → `__legacy__`).

## 5. Integración real (sección 7)
15/15 escenarios OK con contratos HTTP REALES (`/home/z/my-project/integration`,
`results.json`): dos orgs simultáneas, invisibilidad cruzada, inbound por org,
consulta real de locks/supresiones por ULTRA, rechazo sin `X-Org-Id`, eco de
org, cancelada/pausada sin envíos, reintento sin duplicar, webhook duplicado,
fallo de servicio → fail-closed, reinicio preserva estado de seguridad,
workers concurrentes sin duplicar trabajo, puente 2A→CRM atribuye la acción a
la org correcta y falla cerrado sin credencial.

## 6. Enlaces
- Rama: https://github.com/ALBRA8/WHATSPOWER/tree/fix/tercera-reparacion-integral
- Commits: `9a142a7` (reparación), `82079bd` (fix tipos CI)
- CI: https://github.com/ALBRA8/WHATSPOWER/actions (run success en `82079bd`)
