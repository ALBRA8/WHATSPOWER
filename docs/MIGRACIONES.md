# MIGRACIONES — Reparación Integral 2026-11-06 (WHATSPOWER)

Rama: `fix/tercera-reparacion-integral` · Base: `fix/segunda-reparacion-integral` @ `f3f6136`
Fase B2 (final): rama `fix/b2-uncertain-b3-org-identity`

Todas las migraciones son **aditivas y reversibles**. No se modifica ni borra
ninguna columna/tabla existente.

## W-v5 (B2 FASE FINAL) — Idempotencia durable de envíos externos por organización

**Causa raíz corregida:** el daemon Baileys de Capa 1 (repo CRM-ALBRA) NO
consume ni persiste `idempotencyKey` / `X-Correlation-Id`. Si aceptaba un
mensaje y la respuesta se perdía antes de confirmar DONE, el journal podía
re-ejecutar el efecto PENDING al vencer el lease → duplicado real (un daemon
sin deduplicación reenvía).

**Tabla nueva** `daemon_send_idempotency` (registro durable de intentos, este
servicio es el ejecutor del despacho):

```
organization_id TEXT NOT NULL,
idempotency_key TEXT NOT NULL,          -- `${correlationId}#${effecto}`
status TEXT NOT NULL,                   -- 'IN_FLIGHT'|'SENT'|'UNCERTAIN'|'REJECTED'
to_phone, message_text, correlation_id, daemon_message_id,
attempt_token, attempt_count, resend_authorized_at,
created_at, updated_at,
PRIMARY KEY (organization_id, idempotency_key)   -- restricción única exigida por B2
+ INDEX idx_send_idem_org_corr(organization_id, correlation_id)
```

Comportamiento nuevo (ver `tests/b2-send-idempotency.test.ts`):

1. El intento se registra ANTES de llamar a Baileys (`IN_FLIGHT`).
2. Clave repetida en `IN_FLIGHT`/`SENT`/`UNCERTAIN` → se devuelve su estado y
   NO se reenvía (sólo `REJECTED` previo permite reintento limpio).
3. Tras caída/lease vencido, los efectos PENDING del journal pasan a
   `UNCERTAIN` (journal y registro de envíos) y JAMÁS se re-ejecutan
   automáticamente: exigen reconciliación con evidencia
   (`GET /api/internal/idempotency/uncertain` ahora incluye `evidence`).
4. `POST /api/internal/idempotency/reconcile` acepta `confirmResend: true` —
   afirmación EXPLÍCITA del operador (con verificación externa de no llegada)
   que autoriza UN reenvío auditado por envío incierto. La entrega sigue siendo
   **at-least-once**: NO hay garantía exactly-once del daemon ni del proveedor.
5. `TransportSender.sendMessage` incorpora `idempotencyKey?` (por mensaje);
   el transporte HTTP lo envía en `X-Idempotency-Key` + cuerpo.

**Rollback exacto:**

```bash
sqlite3 db/operational.db "DROP TABLE IF EXISTS daemon_send_idempotency;
DROP INDEX IF EXISTS idx_send_idem_org_corr;"
# y revertir el commit del contrato (el 4º parámetro de sendMessage es opcional:
# el código previo sigue funcionando sin él)
```

## W-v4 (TERCERA REPARACIÓN) — Configuración/catálogo por organización

**Causa raíz corregida:** `flows`, `sequences`, `sequence_steps`, `agents`,
`canned_responses` y `growth_links` eran GLOBALES (PK sin organización): una
organización veía, editaba y ejecutaba la configuración de otra. Cada tabla se
RECONSTRUYE con `organization_id` dentro de la PK (rebuild con renombrado, el
mismo patrón reversible de la fase v3):

| Tabla | PK nueva | Unicidad nueva |
|---|---|---|
| `flows` | `(organization_id, id)` | — |
| `sequences` | `(organization_id, id)` | — |
| `sequence_steps` | `(organization_id, id)` | — |
| `agents` | `(organization_id, id)` | — |
| `canned_responses` | `(organization_id, id)` | `(organization_id, shortcut)` |
| `growth_links` | `(organization_id, id)` | `(organization_id, slug)` |

**Filas legacy:** las filas previas (sin organización) se atribuyen a
`'__legacy__'`, un espacio reservado que NINGUNA organización real puede
consultar — no se inventa atribución.

**Rollback exacto por tabla** (antes de arrancar la versión nueva; si ya
arrancó, solo hay filas `'__legacy__'` + filas nuevas de orgs reales):

```bash
# Ejemplo para flows (idéntico patrón para las otras 5 tablas)
sqlite3 db/operational.db "
ALTER TABLE flows RENAME TO flows_v4new;
CREATE TABLE flows (id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger_keywords TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1, graph_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO flows (id, name, trigger_keywords, is_active, graph_json, created_at, updated_at)
  SELECT id, name, trigger_keywords, is_active, graph_json, created_at, updated_at FROM flows_v4new;
DROP TABLE flows_v4new;"
# (las filas de orgs reales creadas con la v4 se conservan en flows_v4new;.exportar antes si se necesitan)
```

## W-v4 — Journal de efectos externos + payloads de reconciliación (4.C)

- `inbound_effect_journal(key, effect_key, effect_type, status, result_json,
  created_at, updated_at, PK(key, effect_key))` — cada efecto externo
  (envío/acción CRM) PENDING→DONE de forma duradera; un reingreso sólo ejecuta
  los PENDING (un mensaje ya enviado jamás se reenvía).
- `idempotency_event_payloads(key PK, payload_json, created_at)` — payload
  original para reconciliar claves UNCERTAIN.
- `idempotency_keys.status` incorpora el VALOR `'UNCERTAIN'` (sin cambio de
  esquema; los índices existentes lo cubren).
- `payment_webhook_events.organization_id` (columna nueva, nullable; eventos
  legacy quedan NULL — no se inventa atribución).

**Rollback exacto:**

```bash
sqlite3 db/operational.db "DROP TABLE IF EXISTS inbound_effect_journal;
DROP TABLE IF EXISTS idempotency_event_payloads;
ALTER TABLE payment_webhook_events DROP COLUMN organization_id;"
# UNCERTAIN desaparece al revertir el código (los valores solo existen con la v4)
```

## W1 — Tablas nuevas (se crean con `CREATE TABLE IF NOT EXISTS` al arrancar)

- `payment_webhook_events(event_id PK, transaction_id, status, payload_json, created_at)`
  → idempotencia DURABLE de webhooks de pasarela (sobrevive reinicios).
- `payment_audit(id, transaction_id, from_status, to_status, action, event_id, created_at)`
  → pista de auditoría de pagos.

**Rollback exacto:**

```bash
sqlite3 <db> "DROP TABLE IF EXISTS payment_webhook_events; DROP TABLE IF EXISTS payment_audit;"
```

## W2 — Anti-replay durable: `db/replay-cache.db` (nueva base)

Tabla `replay_seen(fingerprint TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`.
Sobrevive reinicios; sirve réplicas que compartan el archivo. Ruta configurable
con `REPLAY_DB_PATH`. **Rollback:** borrar el archivo y revertir el commit.

## Cambio de contrato (no-DB): HMAC v2

- Antes (v1): `X-Signature-SHA256 = HMAC(secret, rawBody)` — el timestamp NO
  estaba ligado a la firma (replay con timestamp fresco posible).
- Ahora (v2): `X-Signature-SHA256 = HMAC(secret, "${timestamp}.${rawBody}")`.
- Emisores afectados: puente CRM→WP (`/api/inbound`) y pasarela de pagos
  (`/api/payments/webhook`). La rotación de secretos admite `"actual|previo"`
  sin interrupción. Actualiza el firmante del CRM en la misma ventana.
- Rollback: revertir el commit del contrato en AMBOS repos.

## Cambios de comportamiento (sin migración)

- `POST /api/payments/webhook` exige `eventId`, `status ∈ {APPROVED, REJECTED}`;
  valida `amount`/`currency`/`reference` si vienen; responde **409** en
  transiciones ilegales (los estados terminales son inmutables) y **200
  idempotent** en re-entregas del mismo evento.
- `createPaymentLink` con `gateway=simulator` **falla en producción** salvo
  `PAYMENTS_ALLOW_SIMULATOR=true` (decisión explícita y audible).
- `/qr` y `/qr/data` exigen Bearer `INTERNAL_API_SECRET` (el QR de WhatsApp
  permite secuestrar la sesión; antes se servía a anónimos).
