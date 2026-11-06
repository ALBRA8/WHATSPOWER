# MIGRACIONES — Reparación Integral 2026-11-06 (WHATSPOWER)

Rama: `fix/reparacion-integral` · Base: `main` @ `85d7fcf`

Todas las migraciones son **aditivas y reversibles**. No se modifica ni borra
ninguna columna/tabla existente.

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
