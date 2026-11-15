# Ficha Técnica y Especificación Funcional: Capa 2A — Núcleo Agéntico y Conversacional (MVP)

> **Documento de Especificación y Diseño Arquitectónico**  
> **Ubicación:** `clones/albra-agentic-2a/FICHA.md`  
> **Documento Maestro de Referencia:** [investigacion_camino/PROPUESTA_DISENO_CONTRATOS_2A_2B.md](file:///d:/NAS%20CLONADOR/investigacion_camino/PROPUESTA_DISENO_CONTRATOS_2A_2B.md)  
> **Estado:** FASE DE DISEÑO EXCLUSIVO (Sin código funcional implementado).

---

## 1. Arquitectura Física y Límites del Sistema

La **Capa 2A** se concibe como un satélite desacoplado y autónomo. No se aloja dentro del árbol de código de `CRM-ALBRA/src/modules/` ni accede de manera directa a la base de datos `db/custom.db` del CRM.

### 1.1 Estructura Física del Paquete
```text
clones/albra-agentic-2a/
├── FICHA.md                       <-- Este documento de especificación
├── package.json                   <-- Módulo Node.js 22+ / TypeScript independiente
├── tsconfig.json
├── db/
│   └── operational.db             <-- SQLite operativa local privada (solo sesiones volátiles y locks)
└── src/
    ├── server.ts                  <-- Servicio HTTP ligero (Fastify/Node HTTP) para recibir webhooks
    ├── state/
    │   ├── machine.ts             <-- Máquina de estados finita de la conversación
    │   └── lock-manager.ts        <-- Adquisición y liberación atómica de locks por contacto con TTL
    ├── engine/
    │   ├── router.ts              <-- Enrutador determinista por palabras clave e intenciones
    │   └── rules.ts               <-- Definición declarativa de reglas conversacionales mínimas
    ├── suppression/
    │   └── suppression-store.ts   <-- Almacén local de bajas y consentimientos revocados
    ├── adapters/
    │   ├── crm-actions-client.ts  <-- Cliente REST para POST /api/crm/actions de Capa 1
    │   ├── crm-mcp-client.ts      <-- Cliente JSON-RPC para POST /api/mcp de Capa 1
    │   └── wa-transport-client.ts <-- Cliente de transporte WhatsApp (proxy / daemon de Capa 1)
    └── mock-transport/
        └── transport-simulator.ts <-- Simulador de transporte para testing en sala limpia (sin envíos reales)
```

### 1.2 Límites de Responsabilidad y No Invasión
- **Frente a Capa 1 (CRM ALBRA):** 2A no administra tablas comerciales. No crea modelos de clientes, no almacena pipelines ni factura cotizaciones. Si 2A detecta que un lead califica, emite una orden autorizada mediante los contratos del CRM (`create_client`, `create_opportunity`, `add_note`).
- **Frente a Capa 2B (Superpowers / Marketing):** 2A es dueña exclusiva de la **interacción interactiva 1 a 1**. 2A desconoce Spintax y no gestiona colas de difusión masiva. 2A únicamente expone una API de consulta de bloqueo (`GET /api/internal/locks/:phone`) para que 2B sepa si puede o no despachar un mensaje masivo a ese número.

---

## 2. Contratos Verificables de Capa 1 (CRM ALBRA)

Se distingue formalmente entre lo **comprobado en código**, lo **propuesto** y lo **pendiente de adaptador**.

### 2.1 Contratos Comprobados y Operativos en el Repositorio Base
*Verificados mediante inspección directa del código fuente en `audit_repos/CRM-ALBRA/`:*

1. **Catálogo de Acciones REST (`src/lib/capabilities/crm-actions.ts` y `src/app/api/crm/actions/route.ts`):**
   - **Método:** `POST /api/crm/actions`
   - **Autenticación:** Cabecera `Authorization: Bearer albra_<48_hex_api_key>` (o JWT de usuario).
   - **Aislamiento Multi-tenant:** La API Key está vinculada a un único `organizationId` mediante hash SHA-256 (`ApiKey.hashedKey`).
   - **Acciones Disponibles y Schemas Zod verificados:**
     - `create_client`: `{ name: string, phone?: string, email?: string }` (Crea prospecto y entra al round-robin).
     - `create_opportunity`: `{ clientId?: string, title: string, amount?: number }` (Crea deal en etapa inicial).
     - `schedule_reservation`: `{ clientId?: string, title: string, startsAt: string }` (Agenda cita).
     - `add_note`: `{ clientId: string, content: string }` (Inserta nota en el timeline del cliente).
     - `quote_summary` y `list_recent_clients` (Consultas de lectura seguras).
   - *Nota de auditoría comprobada:* En la línea 25 de `crm-actions.ts` se confirma que las operaciones destructivas y el envío masivo están explícitamente omitidos por diseño.

2. **Servidor MCP (`src/lib/mcp/tools.ts` y `src/app/api/mcp/route.ts`):**
   - **Método:** `POST /api/mcp` (JSON-RPC 2.0).
   - **Autenticación:** `Authorization: Bearer albra_<key>`.
   - **Tools Verificadas (16):** Entre ellas `send_whatsapp` (envío individual con límite de 4000 caracteres), `list_clients`, `get_client`, `create_opportunity`, `add_client_note`, `get_conversation`, `list_pipeline_stages`.

3. **Proxy de Transporte WhatsApp (`src/app/api/whatsapp/daemon-proxy/route.ts`):**
   - **Método:** `POST /api/whatsapp/daemon-proxy` `{ path: '/send', to: string, message: string }`.
   - **Seguridad:** Requiere JWT o secreto interno `INTERNAL_API_SECRET` y validación de `ownership` contra el daemon Baileys (`linkedOrgId === authOrgId`).

### 2.2 Contrato Pendiente de Adaptador en Capa 1
- **Notificación Inbound desde Capa 1 hacia Capa 2A:**
  - *Estado real:* En el código base actual, el daemon Baileys (`daemon.mjs:471`) llama directamente a `${crmUrl}/api/whatsapp/auto-reply` con `X-Internal-Secret`.
  - *Adaptador pendiente:* Se requiere que Capa 1 dispare un webhook HTTP o invoque la ruta de Capa 2A (`POST http://localhost:3003/api/inbound`) cuando entra un mensaje no procesado por el handoff. Mientras se aprueba dicho adaptador en Capa 1, Capa 2A expondrá su interfaz estándar lista para ser conectada.

---

## 3. Modelo de Propiedad de Conversación y Máquina de Estados

Para evitar condiciones de carrera, doble respuesta y colisión con Capa 2B, la Capa 2A implementa una máquina de estados finita con almacenamiento en su base local `operational.db`.

```
                    ┌───────────────┐
                    │     IDLE      │  (Contacto sin lock; elegible para campañas 2B)
                    └───────┬───────┘
                            │
            ┌───────────────┴───────────────┐
            │ Adquisición atómica de lock   │ Lock adquirido por mensaje entrante
            ▼ (por evento entrante)         ▼
   ┌────────────────────────────────────────────────┐
   │                  IN_FLOW_2A                    │
   │  * 2B bloqueado para este contacto             │
   │  * TTL del lock: 15 minutos de inactividad     │
   │  * Reglas deterministas en ejecución           │
   └───────┬────────────────────────────────┬───────┘
           │                                │
           │ Detecta intención de asesor    │ Flujo completado con éxito
           ▼ (o palabra clave de handoff)   ▼
┌───────────────────────────────┐   ┌───────────────────────────────┐
│         HANDOFF_HUMAN         │   │        FLOW_COMPLETED         │
│  * 2A y 2B SILENCIADOS        │   │  * Libera lock atómicamente   │
│  * Genera nota en Timeline    │   │  * Retorna a IDLE             │
│  * Solo asesor responde       │   └───────────────┬───────────────┘
└───────────────┬───────────────┘                   │
                │                                   ▼
                │ Asesor resuelve conversación     IDLE
                │ en el CRM (status: closed)
                ▼
      Retorna a IDLE (libera lock)
```

### 3.1 Adquisición y Liberación Atómica del Lock
- **Tabla local en `operational.db`:**
  ```sql
  CREATE TABLE conversation_locks (
    contact_phone TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    current_state TEXT NOT NULL, -- IN_FLOW_2A, HANDOFF_HUMAN
    locked_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    correlation_id TEXT NOT NULL
  );
  ```
- **Operación atómica de adquisición:**
  `INSERT INTO conversation_locks (contact_phone, organization_id, current_state, locked_at, expires_at, correlation_id) VALUES (?, ?, 'IN_FLOW_2A', unixepoch(), unixepoch() + 900, ?) ON CONFLICT(contact_phone) DO UPDATE SET current_state = 'IN_FLOW_2A', expires_at = unixepoch() + 900 WHERE expires_at < unixepoch();`
  Si la fila no se actualiza porque el lock sigue vigente, la transacción detecta colisión y descarta el evento duplicado.

### 3.2 Prevención de Bloqueos Indefinidos y Recuperación ante Caídas
- **TTL Estricto:** Todo lock tiene una expiración de 15 minutos (`expires_at`). Si un paso de flujo queda congelado o el servidor se reinicia, el lock vence automáticamente y el contacto regresa a `IDLE`.
- **Handoff y Reactivación:** Si el estado pasa a `HANDOFF_HUMAN`, no vence por TTL: se mantiene activo hasta que Capa 1 reporte mediante webhook o consulta periódica que la conversación fue cerrada (`WhatsAppConversation.status === 'closed'`), momento en el que el lock se libera.

---

## 4. Seguridad, Autenticación y Autorización

1. **Autenticación Inter-Servicio:**
   - Toda llamada saliente desde Capa 2A hacia Capa 1 se firma con la API Key oficial de la organización:  
     `Authorization: Bearer albra_<48_hex_key>`.
   - Toda llamada entrante desde Capa 1 hacia Capa 2A viaja con una cabecera de firma HMAC-SHA256 del cuerpo de la petición:  
     `X-Signature-SHA256: hmac_sha256(payload, SHARED_WEBHOOK_SECRET)`.
   - Se rechaza con `401 Unauthorized` cualquier petición con firma inválida o timestamp desfasado por más de 300 segundos (protección contra ataques de retransmisión / *replay attacks*).
2. **Principio de Mínimo Privilegio:**
   - La Capa 2A opera únicamente con permisos de lectura y escritura acotados: `clients.write`, `opportunities.write`, `quotes.read`.
   - No tiene permisos de administración, modificación de contraseñas de usuarios ni borrado de datos.
3. **Manejo Seguro de Credenciales:**
   - Los secretos (`ALBRA_API_KEY`, `WEBHOOK_SECRET`) se configuran por variables de entorno del proceso o almacén cifrado en reposo. Jamás se versionan en Git.

---

## 5. Idempotencia, Deduplicación y Resiliencia

1. **Deduplicación de Eventos Entrantes:**
   - Cada evento entrante contiene un `eventId` único y un `messageId` de WhatsApp.
   - Capa 2A guarda en `operational.db` un registro con clave única:
     `idempotency_keys(key TEXT PRIMARY KEY, processed_at INTEGER, response_payload TEXT)`.
   - Si llega un evento con una clave procesada en las últimas 24 horas, Capa 2A responde inmediatamente con el resultado anterior sin volver a disparar el flujo ni llamar al CRM.
2. **Identificador de Correlación Canónico (`X-Correlation-Id`):**
   - Desde que entra el mensaje se genera o propaga un UUIDv4.
   - Este UUID se adjunta a todas las llamadas hacia Capa 1 (`add_note`, `send_whatsapp`) permitiendo auditar en los logs de ambos sistemas el hilo exacto de ejecución.
3. **Gestión de Resultado de Envío Desconocido (Timeouts):**
   - Si la llamada a `send_whatsapp` o al proxy de transporte sufre un timeout de red, Capa 2A **NO reintenta de inmediato ciegamente** para evitar enviar mensajes dobles al cliente.
   - Marca el mensaje local como `status = 'dispatch_unknown'` y consulta el estado de la conversación en Capa 1 (`get_conversation`) antes de decidir un reintento.

---

## 6. Bajas, Consentimiento y Supresión

1. **Detección Determinista de Palabras Clave de Baja:**
   - Palabras clave reservadas (insensibles a mayúsculas/minúsculas y acentos): `BAJA`, `SALIR`, `STOP`, `CANCELAR`, `NO DESEO MAS MENSAJES`.
2. **Acción de Supresión Inmediata:**
   - Cuando el contacto envía una palabra de baja:
     1. Se interrumpe cualquier flujo en curso.
     2. Se inscribe el número telefónico en la tabla local `suppression_list` con fecha y motivo.
     3. Se expone en el endpoint interno `GET /api/internal/suppression/:phone` para que Capa 2B vete permanentemente a ese contacto.
     4. Se registra una nota en el Timeline de Capa 1: `add_note` ➔ *"🚫 [Baja Voluntaria]: El contacto solicitó no recibir más comunicaciones"*.
     5. Se envía un único mensaje final de confirmación formal: *"Has sido dado de baja correctamente. No volverás a recibir mensajes de nuestra parte"*.
3. **Criterio Ético y Técnico:**
   - Las pausas aleatorias no son un escudo mágico anti-baneo; la verdadera protección de reputación es respetar el consentimiento y cesar inmediatamente los envíos ante una baja.

---

## 7. Persistencia Operativa vs. Persistencia Comercial

| Entidad / Dato | Dónde se Guarda | Justificación |
| :--- | :--- | :--- |
| **Clientes, nombres, emails, teléfonos** | **Capa 1 (CRM ALBRA)** | Fuente canónica única de negocio. |
| **Oportunidades, etapas del pipeline, valor** | **Capa 1 (CRM ALBRA)** | Propiedad exclusiva del CRM. |
| **Cotizaciones, reservas y catálogo** | **Capa 1 (CRM ALBRA)** | Propiedad exclusiva del CRM. |
| **Historial unificado (Timeline comercial)** | **Capa 1 (CRM ALBRA)** | Auditoría canónica del cliente. |
| **Locks activos de conversación** | **Capa 2A (`operational.db`)** | Estado volátil de coordinación y concurrencia. |
| **Variables temporales de sesión de diálogo** | **Capa 2A (`operational.db`)** | Estado en vuelo (ej. qué opción eligió en el menú). |
| **Registro de deduplicación e idempotencia** | **Capa 2A (`operational.db`)** | Logs operativos con rotación cada 7 días. |
| **Lista de supresión y bajas locales** | **Capa 2A (`operational.db`)** | Caché de seguridad de consentimientos revocados. |

---

## 8. Pruebas de Aceptación del MVP (En Sala Limpia con Transporte Simulado)

Todas las pruebas deben ser ejecutables localmente con un simulador de transporte (`mock-transport`) sin enviar un solo WhatsApp real ni tocar clientes de producción.

| ID | Escenario de Prueba | Entrada / Condición | Comportamiento Esperado |
| :--- | :--- | :--- | :--- |
| **CP-01** | Lead nuevo entrante | Mensaje de teléfono desconocido (+57300000001) | Invoca `create_client` en Capa 1, inicializa lock `IN_FLOW_2A`, responde con bienvenida simulada y actualiza timeline. |
| **CP-02** | Palabra clave determinista | Contacto escribe "PRECIO" | Evalúa regla determinista sin LLM, responde con información de precios y registra el evento. |
| **CP-03** | Handoff Humano | Contacto escribe "deseo hablar con un asesor" | Transiciona estado a `HANDOFF_HUMAN`, silencia futuras auto-respuestas y genera nota en Capa 1 con el resumen. |
| **CP-04** | Deduplicación e Idempotencia | Recepción del mismo `eventId` 2 veces en 5 segundos | La primera ejecuta el flujo; la segunda devuelve el resultado cacheado sin duplicar el mensaje simulado. |
| **CP-05** | Resiliencia ante caída de Capa 1 | Capa 1 devuelve `503 Service Unavailable` | 2A no crashea; encola el intento con backoff exponencial y no pierde el estado del contacto. |
| **CP-06** | Prevención de Colisión 2A vs 2B | Contacto en `IN_FLOW_2A` consultado por 2B | El endpoint de consulta de lock responde `{ locked: true, owner: "2A" }`. Capa 2B descarta el despacho. |
| **CP-07** | Aislamiento Multi-tenant | Petición con API Key de Org A solicitando datos de Org B | Capa 1 o 2A deniega la operación con `403 Forbidden`. No hay fuga de datos entre organizaciones. |
| **CP-08** | Evento Falsificado (Firma Inválida) | Webhook entrante con firma HMAC corrupta o ausente | 2A rechaza inmediatamente con `401 Unauthorized` y no procesa el payload. |
| **CP-09** | Solicitud de Baja (Opt-Out) | Contacto escribe "BAJA" | Bloquea el flujo, inscribe el número en `suppression_list`, notifica a Capa 1 y confirma la baja. |
| **CP-10** | Expiración de Lock por Timeout (TTL) | Contacto abandona el diálogo por más de 15 min | El lock vence automáticamente. Si entra un nuevo mensaje después de 16 min, se trata como nueva sesión limpia. |

---

## 9. Alcance y Exclusiones del MVP de la Capa 2A

### Incluido en este MVP:
- Servidor HTTP de recepción de eventos con validación de firma y correlación.
- Máquina de estados de conversación con locks atómicos en SQLite y TTL de 15 minutos.
- Enrutador determinista por palabras clave exactas y disparadores de handoff.
- Cliente para contratos autorizados de Capa 1 (`POST /api/crm/actions` y proxy/MCP de WhatsApp).
- Mecanismo de baja y lista de supresión.
- Simulador de transporte (`mock-transport`) para validación de pruebas sin mensajes reales.

### Excluido explícitamente de este MVP:
- **Editor visual de flujos con canvas interactivo** (se modela de forma declarativa en JSON/código para validar el motor primero).
- **Agentes de IA generativa con prompts complejos y RAG vectorial** (primero se estabiliza el núcleo determinista y el handoff).
- **Mecanismos de difusión masiva, Spintax y campañas salientes** (responsabilidad exclusiva de Capa 2B).

---

## 10. Criterios de Salida, Riesgos y Dependencias

### Criterios de Salida para Pasar a Implementación:
1. Aprobación formal de esta especificación técnica por parte del usuario.
2. Aprobación del diseño del adaptador de eventos inbound en Capa 1.
3. Suite de tests unitarios diseñados para pasar los casos CP-01 a CP-10 con mock transport.

### Riesgos y Dependencias Identificados:
- **Dependencia de la sesión del daemon Baileys:** Si el teléfono pierde conexión en Capa 1, Capa 2A debe estar preparada para degradación elegante (encolado y notificación al operador sin bloquear hilos).
- **Decisión Pendiente:** Confirmar si el adaptador de eventos inbound de Capa 1 se implementará como un hook dentro de `src/app/api/whatsapp/auto-reply/route.ts` o como un listener de eventos interno de Node.js.
