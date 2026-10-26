# WHATSPOWER (Nivel 2 ALBRA) — Automatización Conversacional y Flujos Visuales

> **Paridad 100% ManyChat para el Ecosistema CRM ALBRA**  
> Diseñado bajo metodología Clean-Room / ClonaKit. Opera de forma modular como un "enchufe" ("anillo al dedo") con **CRM-ALBRA (Nivel 1)** y colabora de forma transparente con **WHATSPOWER-ULTRA (Nivel 3)**.

---

## 🚀 Capacidades Principales (ManyChat 100% Parity)

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

### 3. Ejecutar el Servidor y Flow Studio
```bash
npm start
```
Abrir en el navegador:
👉 **`http://localhost:3003/studio`**

### 4. Pruebas Automatizadas
```bash
npm test
```
Ejecuta la suite completa de 31+ pruebas unitarias y de integración que verifican la paridad 100% ManyChat, persistencia SQLite, locks JIT y fallbacks fail-closed.
