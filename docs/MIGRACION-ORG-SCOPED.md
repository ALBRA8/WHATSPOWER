# Migración de esquema v3 — estado multi-organización (2026-11-06)

**Repositorio:** ALBRA8/WHATSPOWER · **Rama:** `repair/integral-20261106`
**Contrato:** docs de integración v1.1.0 §3 (anti-replay persistente) y §9 (propiedad de datos).

## Qué cambia

Todo el estado de conversación y datos de contacto pasa a ser **propiedad de la organización**
(claves compuestas `(organization_id, contact_phone)`): locks, sesiones de flujo, variables de
sesión, tags, campos personalizados, supresiones, asignaciones de equipo, enrolamientos de
secuencias, inbox y transacciones de pago. Dos organizaciones que comparten un teléfono NO
comparten estado entre sí (contrato §9).

Tablas nuevas: `webhook_replay` (anti-replay PERSISTENTE, purga >600 s, sobrevive reinicios),
`idempotency_claims` (reclamación atómica de eventos; idempotencia con purga de 7 días) y
`payment_audit` (auditoría de transiciones de pago).

## Compatibilidad

- El credencial legado `INTERNAL_API_SECRET` resuelve a la organización **`default`** con rol
  `admin`. Los datos pre-existentes se migran a `organization_id='default'`, por lo que los
  servicios desplegados siguen operando sin reconfiguración.
- `INTERNAL_API_KEYS="orgId:secreto[:rol],..."` añade organizaciones adicionales con roles.

## Cómo corre la migración

Automática al arrancar el servicio (`createDatabase`). Detección: una BD heredada tiene
`conversation_locks` con PK mono-organización y **no** tiene `webhook_replay`. La migración:

1. Crea copia de seguridad: `<db>.pre-v3-<timestamp>.bak` (solo BD en archivo).
2. En UNA transacción: renombra cada tabla heredada → crea la v3 → copia las filas con
   `organization_id='default'` → elimina la tabla heredada. Un fallo a mitad ⇒ `ROLLBACK`
   completo (jamás importación parcial silenciosa).
3. Marca `PRAGMA user_version = 3`.

## Rollback (reversible y documentado)

1. Detener el servicio.
2. Restaurar la copia de seguridad: `mv <db>.pre-v3-<timestamp>.bak <db>`.
3. Arrancar la versión anterior del código (etiqueta/commit anterior a esta rama).

**Límite documentado del rollback:** las filas creadas DESPUÉS de la migración con
`organization_id != 'default'` no existen en el esquema v2 y se perderían al restaurar.
Si se crearon organizaciones nuevas antes del rollback, expórtalas primero.

## Pruebas de la migración y del contrato

- `tests/persistence-and-handoff.test.ts`: reinicio real sobre archivo de BD (locks y
  supresiones sobreviven; ahora también el anti-replay — ver `tests/contract-v11.test.ts` P1).
- `tests/contract-v11.test.ts`: los 7 rechazos obligatorios del contrato §4, aislamiento con
  teléfono compartido (R6/P2), roles (P3), X-Org-Id (P4), /qr protegido (P5), X-Event-Id (P6),
  máquina de estados de pagos (PAY-01), 413 (AB-01) y rate limit 429+Retry-After (AB-02).
