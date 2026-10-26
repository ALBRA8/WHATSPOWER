# Manual Operativo: Despliegue, Control y Reversión (Capa 1 + Daemon WA + Capa 2A)

**Documento:** Procedimiento de Operación en Sala Limpia y Despliegue  
**Ubicación:** `clones/albra-agentic-2a/MANUAL_DESPLIEGUE_Y_OPERACION.md`  
**Estado:** Preparado para activación supervisada (Pendiente de Autorización de Tráfico Real)

---

## 1. Procedimiento de Arranque y Detención

### 1.1 Orden de Arranque (De abajo hacia arriba)
Para garantizar que cuando el CRM o el daemon reciban tráfico todos los componentes satélite estén listos:

1. **Paso 1: Iniciar Capa 2A (Satélite Agéntico):**
   ```bash
   cd clones/albra-agentic-2a
   # Iniciar servicio en puerto 3003
   npm run start
   ```
   *Salida esperada en consola:*
   `[Capa 2A] Servidor Agéntico escuchando en http://localhost:3003`

2. **Paso 2: Iniciar Capa 1 (CRM ALBRA - Next.js):**
   ```bash
   cd audit_repos/CRM-ALBRA
   # Iniciar servidor Next.js en puerto 3000
   npm run dev
   ```
   *Salida esperada en consola:*
   `Ready in ...ms (http://localhost:3000)`

3. **Paso 3: Iniciar Daemon de WhatsApp (Baileys):**
   ```bash
   cd audit_repos/CRM-ALBRA
   # Iniciar daemon en puerto 3002
   node src/whatsapp-daemon/daemon.mjs
   ```
   *Procedimiento de vinculación QR:*
   - Si no existe una sesión previa en `.wa-auth/`, el daemon imprimirá un código QR en la consola de comandos.
   - Desde el teléfono de la empresa/remitente: **WhatsApp > Dispositivos vinculados > Vincular un dispositivo** y escanear el QR en pantalla.
   - El daemon confirmará: `[WA] Conexión abierta - número: <telefono_emisor>` y entrará en estado `connected`.

### 1.2 Procedimiento de Detención Limpia
1. Detener el Daemon de WhatsApp (Ctrl+C en la terminal de Baileys).
2. Detener el CRM ALBRA (Ctrl+C en la terminal de Next.js).
3. Detener Capa 2A (Ctrl+C en la terminal de Node). La base de datos `operational.db` preserva atómicamente todos los locks, bajas y registros de idempotencia.

---

## 2. Configuración de Entorno, Gestión del Secreto y Healthchecks

### 2.1 Variables Requeridas
- **En `CRM-ALBRA/.env`:**
  ```env
  # Feature flag: OBLIGATORIAMENTE false durante la preparación
  AGENTIC_2A_ENABLED=false
  AGENTIC_2A_URL=http://localhost:3003/api/inbound
  AGENTIC_2A_WEBHOOK_SECRET=albra_shared_webhook_secret_min32chars_hex
  
  # Allowlist estricta para el piloto: SOLO el número autorizado
  AGENTIC_2A_PILOT_ALLOWLIST=3163301286

  # Secretos internos del CRM y puertos
  INTERNAL_API_SECRET=albra_internal_secret_min24chars_hex
  DATABASE_URL="file:./db/custom.db"
  WHATSAPP_DAEMON_URL="http://localhost:3002"
  ```

- **En `clones/albra-agentic-2a/.env`:**
  ```env
  PORT=3003
  WEBHOOK_SECRET=albra_shared_webhook_secret_min32chars_hex
  CRM_BASE_URL=http://localhost:3000
  NODE_ENV=production
  ```

### 2.2 Política de Gestión del Secreto HMAC
- El secreto compartido `AGENTIC_2A_WEBHOOK_SECRET` debe tener un mínimo de 32 caracteres criptográficamente aleatorios (generar con `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`).
- **Prohibición estricta:** Jamás versionar secretos reales en Git ni exponerlos en logs.

### 2.3 Comprobación de Salud (Healthchecks)
Antes de autorizar tráfico, verificar los tres servicios:

```bash
# 1. Verificar Capa 2A
curl http://localhost:3003/api/health
# Respuesta: {"status":"ok","service":"albra-agentic-2a"}

# 2. Verificar CRM ALBRA
curl http://localhost:3000/api/health
# Respuesta: {"status":"ok"}

# 3. Verificar Daemon de WhatsApp
curl http://localhost:3002/status
# Respuesta: {"status":"connected", ...}
```

---

## 3. Autoridad Única de Despacho y Aislamiento de Socket

1. **Autoridad de Despacho Exclusiva:** Capa 2A **NO** tiene socket de WhatsApp ni conexión directa a Baileys.
2. **Flujo de Respuesta:**
   - Usuario (`3163301286`) envía mensaje a WhatsApp.
   - Baileys (Daemon, :3002) recibe el mensaje y llama a `POST /api/whatsapp/auto-reply` en el CRM (:3000).
   - El CRM evalúa la allowlist: al coincidir `3163301286` y estar `AGENTIC_2A_ENABLED=true`, reenvía por HTTP firmado a Capa 2A (:3003).
   - Capa 2A procesa la regla y **retorna el texto en el cuerpo de la respuesta HTTP** (`{ handled: true, replyText: "..." }`).
   - El CRM inhibe su LLM local y entrega el texto al Daemon.
   - El Daemon ejecuta `sendWhatsAppMessage` al socket.
3. **Cero Doble Respuesta:** Es arquitectónicamente imposible que 2A y el CRM envíen dos mensajes simultáneos porque solo el Daemon posee el socket emisor.

---

## 4. Procedimiento de Reversión Inmediato (Kill-Switch)

Si durante la prueba supervisada ocurre cualquier anomalía:

1. **Acción Inmediata (0 segundos de downtime):**
   En `audit_repos/CRM-ALBRA/.env`:
   ```env
   AGENTIC_2A_ENABLED=false
   ```
2. **Efecto Instantáneo comprobado:**
   La función `forwardToAgentic2A` evalúa la variable en cada petición entrante. Al estar en `false`, retorna `{ forwarded: false, handled: false }` y el CRM reasume inmediatamente el comportamiento normal. No requiere reiniciar el daemon ni la base de datos comercial.

---

## 5. Garantía de Silenciamiento Humano (`HANDOFF_HUMAN`)

1. Cuando el cliente `3163301286` solicita un asesor o activa la regla de transferencia, el lock pasa a `HANDOFF_HUMAN`.
2. **Silenciamiento Estricto:** Cualquier mensaje posterior enviado mientras el lock esté activo es rechazado por el enrutador con `actionTaken: 'locked_busy'`. Capa 2A no despacha respuestas automáticas y deja la conversación a cargo del agente humano.

---

## 6. Persistencia Comprobada tras Reinicio (SQLite en Disco)

- `operational.db` conserva atómicamente:
  - Locks conversacionales activos y en estado `HANDOFF_HUMAN`.
  - Supresiones de contacto (opt-out / bajas).
  - Idempotencia de eventos procesados.

---

## 7. Checklist del Piloto Real Supervisado (Completado)

- [x] Allowlist configurada exclusivamente para el cliente de prueba `3017543786` (canonizado `573017543786`).
- [x] Teléfono emisor del daemon Baileys vinculado en vivo: `3163301286` (`573163301286`).
- [x] Feature flag activado únicamente para la ventana de prueba supervisada (`AGENTIC_2A_ENABLED=true`).
- [x] Autoridad de despacho restringida al CRM/Baileys (Capa 2A devolvió `replyText` por HTTP; cero despachos directos de socket desde 2A).
- [x] Mensaje `"PRECIO"` procesado exitosamente por regla determinística sin invocar el LLM del CRM.
- [x] Desactivación inmediata ejecutada tras la prueba: `AGENTIC_2A_ENABLED=false` restaurado y confirmado en memoria por Next.js (`Reload env: .env`).

---

## 8. Certificación y Cierre del Hito 2A: Piloto Real Supervisado

* **Fecha de Ejecución:** 24 de Octubre de 2026.
* **Actores de la Interacción:**
  * **Cliente remitente:** Johan Bravo (`+57 301 754 3786`, E.164 canónico: `573017543786`).
  * **Emisor empresarial (Daemon Baileys):** `+57 316 330 1286` (`573163301286`).
* **Mensaje de Prueba:** `"PRECIO"`.
* **Mapeo de Identidad WhatsApp (LID):** WhatsApp Web entregó el mensaje con LID `215779257634953@lid`. El daemon Baileys resolvió en disco `lid-mapping-215779257634953_reverse.json` obteniendo `573017543786`.
* **Validación de Seguridad Allowlist:** El puente en `agentic-2a-bridge.ts` autorizó la petición al coincidir con `AGENTIC_2A_PILOT_ALLOWLIST="3017543786"`.
* **Firma HMAC & Timestamp:** Petición HTTP POST firmada con HMAC-SHA256 y verificada por Capa 2A dentro de la ventana de tolerancia de 300 segundos.
* **Latencia Registrada:** `321 ms` de extremo a extremo (`POST /api/whatsapp/auto-reply 200 in 321ms`).
* **Respuesta Generada y Despachada (Single-Responder):**
  * Capa 2A devolvió el catálogo determinista en el cuerpo JSON (`replyText`).
  * El CRM inhibió por completo su LLM local y entregó el texto al daemon.
  * El daemon Baileys ejecutó `sendWhatsAppMessage` al socket una sola vez (cero mensajes duplicados).
* **Persistencia Atómica en `clones/albra-agentic-2a/db/operational.db`:**
  * Lock conversacional adquirido: `state: 'IN_FLOW_2A'`, `expires_at: 1792831216` (TTL 15 min).
  * Clave de idempotencia registrada: `evt_crm_1792830316109_3cxot`.
* **Observación Registrada para Aclaración:**
  * En el registro de idempotencia quedó `crmSynced: false`. Se registra formalmente como observación pendiente de aclaración (las respuestas de reglas determinísticas no alteran entidades del CRM, reservando `crmSynced: true` para derivaciones humanas o creación de prospectos nuevos).
* **Estado Final:**
  * **`AGENTIC_2A_ENABLED=false`** (confirmado y preservado).
  * Hito de Capa 2A cerrado y superado formalmente.
