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

### 3.c. Pantalla de acceso real y modo demo (2026-11-17)
El Studio ya NO usa `window.prompt` bloqueante (antes dejaba el body vacío al cancelar y pedía
la organización con un segundo prompt): ahora muestra una PANTALLA DE ACCESO con el secreto
clásico, un botón "Probar en modo demo (sin registro)" —solo con `DEMO_MODE=true` y FUERA de
producción, `POST /studio/login-demo` responde 403 SIEMPRE en producción— y un enlace
"Volver al CRM" (`CRM_BASE_URL`). La organización SOLO se pide en el login clásico; por SSO o
demo se fija `default` sin preguntar. Un fallo del canje SSO (403/404/429) responde una página
HTML con el motivo (caducado / ya usado / no configurado) y el enlace para reintentar desde el
CRM. Pruebas: `tests/ecosystem-login.test.ts` (cadena completa de aceptación incluida).

### 4. Pruebas Automatizadas
```bash
npm test
```
Ejecuta la suite completa de pruebas automatizadas (38+ suites) que verifican flujos interactivos, persistencia SQLite, locks JIT, consentimiento Ley 1581, motor de automatización y fallbacks fail-closed. El conteo exacto vigente lo imprime el runner.

**E2E del ecosistema completo (autocontenido y multiplataforma):**
```bash
npm run e2e:3
```
Levanta CRM + WHATSPOWER + ULTRA con bases de datos temporales y secretos efímeros, ejecuta el flujo completo (webhook firmado → puente → flujo → cliente en CRM; lock; consentimiento; campaña) y verifica SENT=0. Limpieza automática al terminar. Los repos hermanos se autodescubren por `package.json` (o usa `E2E_CRM_DIR` / `E2E_ULTRA_DIR`).

## Denylist de PII con pepper (HMAC)

`npm run check:pii` escanea el árbol rastreado por git y bloquea valores prohibidos y teléfonos colombianos no autorizados. Los valores prohibidos del operador no se publican ni en texto plano ni como hash adivinable: viven SOLO como **HMAC-SHA256** en `scripts/pii-hashlist.json`, firmados con una clave secreta (**pepper**) que **nunca se compromete**. Sin la clave no se puede calcular el HMAC de un candidato, así que la hashlist publicada no permite verificar ni un solo intento de adivinación (a diferencia de un `sha256(sal+valor)` simple, que cualquiera puede comparar contra sus candidatos).

Comportamiento del escáner según el pepper:

| Estado del pepper | Comprobación de valores prohibidos | Árbol limpio |
| --- | --- | --- |
| `ok` | Completa: hashlist + patrones genéricos + lista local | exit 0 |
| `ausente` | Desactivada: genéricos + lista local, con **aviso prominente** (y `::warning::` en Actions) | exit 0 |
| `no coincide` | Desactivada: genéricos + lista local, con **aviso prominente** que lo indica | exit 0 |

**Generar un pepper nuevo** (una sola vez; guárdelo en su gestor de contraseñas):

```bash
openssl rand -hex 32   # nunca lo comitee ni lo pegue en issues, logs o chats
```

**Cargarlo:**

- **Local**: guarde el hex en `scripts/pii-pepper.local` (ya está en `.gitignore`; admite `# comentarios`, el prefijo `PII_PEPPER=` o el hex solo en la primera línea).
- **CI**: `gh secret set PII_PEPPER --body "<hex>"` (o *Settings → Secrets and variables → Actions → New repository secret*). El workflow ya lo pasa al escáner.

**Regenerar la hashlist sin publicar valores** (requiere el pepper; no imprime valores):

```bash
PII_PEPPER="<hex>" node scripts/pii-denylist-build.mjs \
  --from-git "scripts/check-pii.mjs@<revision-antigua>" \
  --out scripts/pii-hashlist.json
```

`--from-file <archivo-privado>` y `--from-stdin` aceptan líneas `tipo:valor` (`name|handle|lid|phone`). El pepper jamás aparece en la hashlist ni en la salida del comando.

**Rotación**: genere un pepper nuevo, regenere la hashlist, haga commit de la hashlist y actualice el secreto de Actions y su `scripts/pii-pepper.local` en cada máquina. Los valores reales nunca salen de su equipo: al repo solo llega el HMAC.
