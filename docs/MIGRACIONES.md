# MIGRACIONES — Reparación Integral 2026-11-06 (WHATSPOWER)

Rama: `fix/tercera-reparacion-integral` · Base: `fix/segunda-reparacion-integral` @ `f3f6136`

Todas las migraciones son **aditivas y reversibles**. No se modifica ni borra
ninguna columna/tabla existente.

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
