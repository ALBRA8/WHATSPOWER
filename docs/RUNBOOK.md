# RUNBOOK DE OPERACIONES E INCIDENTES — ECOSISTEMA ALBRA (Nivel 2 y 3)

## 1. NIVELES DE SEVERIDAD
- **P1 — Crítico:** Servicio no responde, base de datos bloqueada (SQLITE_BUSY), fallos masivos de despacho o caída del transporte. Tiempo de respuesta objetivo: < 15 minutos.
- **P2 — Alto:** Tasa anormal de errores 429 (Rate Limit de Meta), colapso parcial de reconexión de Baileys, incremento de envíos UNCERTAIN. Tiempo de respuesta: < 1 hora.
- **P3 — Medio:** Flujo detenido en paso individual, demora en procesamiento de webhook de leads, advertencias de ventana de 24h. Tiempo de respuesta: < 4 horas.

---

## 2. PROCEDIMIENTOS DE RECUPERACIÓN

### 2.1 Caída del Proceso o Reinicio Inesperado
1. Al reiniciar, el motor de despacho (`BroadcastEngine`) ejecuta automáticamente `recoverFromCrash()`.
2. Todo ítem que haya quedado en estado transitorio `DISPATCHING` con lease expirado se transiciona a `UNCERTAIN_DISPATCH` con el motivo `"Recuperación ante caída: despacho interrumpido en vuelo"`.
3. **REGLA DE ORO:** Nunca reintentar a ciegas un ítem `UNCERTAIN_DISPATCH`. El mensaje pudo haber llegado a WhatsApp antes del crash.

### 2.2 Reconciliación de Mensajes UNCERTAIN
1. Consultar eventos inciertos por organización:
   ```bash
   GET /api/internal/idempotency/uncertain
   Header: Authorization: Bearer <ORG_INTERNAL_KEY>
   ```
2. Verificar en el WhatsApp Business Manager de Meta o en el teléfono del receptor si el mensaje fue efectivamente entregado.
3. Si se confirma la NO llegada, autorizar reenvío explícito con evidencia:
   ```bash
   POST /api/internal/idempotency/reconcile
   Body: { "key": "itm_...", "confirmResend": true, "evidence": "Receptor confirma no recepcion via llamada soporte" }
   ```

### 2.3 Desconexión del Daemon Baileys (Plan Básico)
1. El daemon implementa reintentos exponenciales automáticos (`scheduleReconnect`, 3s a 30s).
2. Si el código de desconexión es `401 / loggedOut`, la sesión fue cerrada desde el teléfono.
3. Procedimiento:
   - Notificar al administrador de la organización.
   - Acceder al Studio -> Configuración -> WhatsApp.
   - Generar nuevo código QR y escanear.

### 2.4 Error 429 de Meta (Rate Limit Exceeded)
1. El adaptador `classifyMetaError` clasifica el error 131048/130429 como `META_RATE_LIMIT_EXCEEDED` sin reintentos ciegos.
2. La campaña pausará su ejecución respetando el encabezado `Retry-After`.
3. Procedimiento: Revisar en Meta Business Manager el límite diario de mensajes del número (Tier 1K, 10K, 100K o Unlimited). No forzar envíos hasta el reinicio de la ventana diaria.

---

## 3. MONITOREO Y SALUD DEL SERVICIO
- **Healthcheck Capa 2A (WHATSPOWER):**
  `GET http://localhost:3003/api/health`
  Retorna estado de BD, memoria, locks activos, contactos suprimidos y consentimientos.
- **Healthcheck Capa 2B (ULTRA):**
  `GET http://localhost:3004/api/health`
  Retorna estado de cola (pendientes, en vuelo), métricas de envíos (sent, failed, uncertain) y memoria.

---

## 4. CRITERIOS DE MIGRACIÓN A POSTGRESQL
SQLite en modo WAL soporta >2,500 claims/seg y >70,000 inserciones en lote/seg en local. La migración a PostgreSQL es recomendada cuando:
1. Se desplieguen múltiples nodos de workers en servidores diferentes (concurrencia multi-host).
2. El tamaño de la base de datos supere los 15 GB y el checkpoint de WAL comience a penalizar latencias.
3. La organización requiera replicación geográfica multi-región activa.
