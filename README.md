# WHATSPOWER (Nivel 2 ALBRA) — Automatización Conversacional y Flujos Visuales

> **Motor Conversacional y Automatizaciones Avanzadas para el Ecosistema CRM ALBRA**  
> Diseñado bajo metodología Clean-Room / ClonaKit. Opera de forma modular como un "enchufe" ("anillo al dedo") con **CRM-ALBRA (Nivel 1)** y colabora de forma transparente con **WHATSPOWER-ULTRA (Nivel 3)**.

> ⚠️ **Aviso Importante — Canal no oficial de WhatsApp**: el daemon de WhatsApp conecta por **Baileys**, un canal **no oficial** basado en emulación de WhatsApp Web. Su uso conlleva **riesgo inherente de bloqueo o suspensión del número por parte de Meta**. Se recomienda **calentar líneas** (envíos graduales, respetando locks y ventanas) y usar **números secundarios**, nunca el número principal del negocio. Para producción comercial, usa el transporte oficial **Meta Cloud API** disponible en los adaptadores del proyecto.

---

## 🚀 Capacidades Principales de Automatización Conversacional

1. **Flow Builder Visual e Interactivo (`/studio`)**:
   - Constructor no-code de diagramas de flujo conversacionales tipo nodo.
   - Simulador en vivo integrado dentro del navegador para probar flujos paso a paso sin gastar mensajes ni tocar WhatsApp.
2. **Nodos Conversacionales Soportados**:
   - **Mensaje**: Envío de texto y contenido multimedia interactivo.
   - **User Input (Captura de Datos)**: Pregunta al usuario y almacena automáticamente la respuesta en un **Custom Field** (Atributo Personalizado).
   - **Condición**: Ramificación inteligente según etiquetas (*Tags*) o atributos del contacto.
   - **Acción**: Asignación/remoción de etiquetas, disparo de webhooks externos y mutaciones transaccionales en el CRM.
   - **A/B Split Testing**: Distribución aleatoria porcentual ponderada de tráfico para optimizar conversiones de ofertas.
3. **Campañas de Goteo (Drip Sequences)**:
   - Programación de secuencias temporizadas con retrasos relativos (*delays* en minutos/horas/días).
   - Inscripción y desafiliación dinámica de prospectos.
4. **Handoff Humano y Locks de Seguridad**:
   - Detección de intención de hablar con un humano ("asesor", "humano", "agente").
   - Silenciamiento automático del bot y emisión de lock JIT para evitar colisiones con agentes humanos o difusiones masivas.
5. **Circuitos de Bajas / Opt-Out**:
   - Detección inmediata de palabras de desafiliación (`BAJA`, `STOP`, `CANCELAR`).
   - Persistencia autoritativa en `suppression_list` SQLite.

---

## 🔌 Conectividad Modular "Plug & Play" (Anillo al Dedo)

`WHATSPOWER` se conecta al **CRM-ALBRA** de forma desacoplada mediante REST HTTP firmado:
- **Inbound Bridge**: CRM-ALBRA reenvía mensajes entrantes a `http://localhost:3003/api/inbound` con firma HMAC-SHA256 (`X-Signature-SHA256`).
- **CRM Actions Bridge**: Si el flujo requiere crear notas o pausar el bot en el CRM, invoca `http://localhost:3000/api/crm/actions`.
- **Independencia Operativa**: Si WhatsPower no está activo, el CRM ALBRA opera en modo Nivel 1 autónomo (LLM estándar o atención manual).

---

## 🛠️ Instalación y Puesta en Marcha

### 1. Requisitos
- Node.js 22+ (con soporte nativo para TypeScript y SQLite).
- CRM-ALBRA ejecutándose en los puertos 3000 (App) y 3002 (Daemon WhatsApp).

### 2. Configuración (`.env`)
Copiar `.env.example` a `.env`:
```bash
cp .env.example .env
```
Variables clave:
```ini
PORT=3003
AGENTIC_2A_WEBHOOK_SECRET=tu_secreto_hmac_32_caracteres
CRM_ACTIONS_URL=http://localhost:3000/api/crm/actions
WHATSAPP_DAEMON_URL=http://localhost:3002
ALLOW_REAL_DISPATCH=false
```

### 2.b. Inteligencia Artificial (nodo AI_RESPONSE) — DESACTIVADA POR DEFECTO

El nodo `AI_RESPONSE` del Flow Builder puede generar respuestas con un proveedor de completions compatible con la API de OpenAI.

> **Advertencia de privacidad**: al activar la IA, el **texto de las conversaciones de clientes** (prompt del nodo + contexto del contacto) se **transmite a un proveedor externo** (`AI_API_URL`, por defecto la API de OpenAI). Evalúa esta transmisión contra tu política de tratamiento de datos (Ley 1581 / Habeas Data) antes de activarla.

La IA permanece **apagada por defecto** y **ninguna llamada HTTP a terceros ocurre** sin configuración explícita:

```ini
AI_API_KEY=          # credencial del proveedor — sin ella el nodo no llama a nadie (fallback honesto)
AI_ENABLED=          # false apaga la IA aunque exista credencial
AI_API_URL=          # endpoint chat/completions (default OpenAI)
AI_MODEL=            # modelo por defecto (default gpt-4o-mini)
AI_TIMEOUT_MS=       # timeout (default 20000)
```

Con la IA sin configurar, el nodo AI_RESPONSE continúa el flujo con un aviso explícito de indisponibilidad (jamás simula ser IA).

### 3. Ejecutar el Servidor y Flow Studio
```bash
npm start
```
Abrir en el navegador:
👉 **`http://localhost:3003/studio`**

### 3.b. Acceso directo al ecosistema desde el CRM (SSO de un solo uso)
El botón **Ecosistema** del CRM (capa 1) abre este studio con sesión de operador, sin repetir
credenciales: el CRM emite un enlace firmado de UN SOLO USO (`ECOSYSTEM_SSO_SECRET` compartido,
HMAC-SHA256, TTL 90 s) que se canjea en `GET /studio/login-ecosystem` (302 al Studio con cookie
HttpOnly). Fail-closed: sin el secreto configurado la ruta NO existe (404). El login clásico
(`/studio/login`) y sus reglas quedan intactos. Pruebas: `tests/ecosystem-login.test.ts`.

### 4. Pruebas Automatizadas
```bash
npm test
```
Ejecuta la suite completa de pruebas automatizadas (38+ suites) que verifican flujos interactivos, persistencia SQLite, locks JIT, consentimiento Ley 1581, motor de automatización y fallbacks fail-closed. El conteo exacto vigente lo imprime el runner.
