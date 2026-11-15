# Guía de Activación y Prueba Controlada: CRM ALBRA + Capa 2A

Esta guía describe cómo levantar y probar el entorno de integración conjunto de forma segura, controlada y sin riesgo de envíos reales a producción.

---

## 1. Puertos y Servicios

| Servicio | Puerto por Defecto | Directorio | Comando de Arranque |
| :--- | :--- | :--- | :--- |
| **Capa 1: CRM ALBRA** | `3000` | `audit_repos/CRM-ALBRA/` | `npm run dev` |
| **Capa 2A: Motor Agéntico** | `3003` | `clones/albra-agentic-2a/` | `npm run start` (o `node --experimental-strip-types src/server.ts`) |

---

## 2. Variables de Entorno Requeridas

### En `CRM-ALBRA/.env` (Capa 1)
```env
# Feature Flag del Puente (desactivado por defecto; cambiar a true para activar)
AGENTIC_2A_ENABLED=true

# Endpoint Inbound del Satélite 2A
AGENTIC_2A_URL=http://localhost:3003/api/inbound

# Secreto Compartido para Firma HMAC-SHA256 (mínimo 32 caracteres)
AGENTIC_2A_WEBHOOK_SECRET=dev_shared_hmac_secret_albra_2a_2026
```

### En `clones/albra-agentic-2a/.env` (Capa 2A)
```env
PORT=3003
WEBHOOK_SECRET=dev_shared_hmac_secret_albra_2a_2026
CRM_BASE_URL=http://localhost:3000
ALBRA_API_KEY=albra_tu_api_key_de_la_organizacion
NODE_ENV=development
```

---

## 3. Prevención de Doble Respuesta y Manejo de Fallback

El puente implementado en `audit_repos/CRM-ALBRA/src/app/api/whatsapp/auto-reply/route.ts` garantiza que:
1. **Inhibición de LLM:** Cuando Capa 2A responde con éxito (`handled: true`), la función retorna de inmediato con `engine: 'agentic-2a'`, cortando la ejecución antes de construir el contexto del LLM. Esto garantiza **cero gasto de tokens y cero doble mensaje**.
2. **Fallback Automático:** Si Capa 2A no responde en menos de 3.5 segundos o devuelve un error HTTP, el puente captura la excepción y permite que el CRM continúe transparentemente hacia su auto-respuesta habitual.

---

## 4. Comandos para Ejecutar las Suites de Verificación

Desde la raíz del workspace `D:\NAS CLONADOR\`:

```bash
# 1. Ejecutar las 10 pruebas de aceptación de Capa 2A (sala limpia, mock transport)
node --experimental-strip-types clones/albra-agentic-2a/tests/suite.test.ts

# 2. Ejecutar las 4 pruebas unitarias de firma HMAC y tolerancia a replay
node --experimental-strip-types clones/albra-agentic-2a/tests/bridge.test.ts

# 3. Ejecutar las 4 pruebas E2E conjuntas de circuito completo y fallback
node --experimental-strip-types clones/albra-agentic-2a/tests/e2e-bridge.test.ts
```

---

## 5. Protocolo para Prueba Manual Controlada (Sin WhatsApp Real)

1. En una terminal, arrancar Capa 2A:
   ```bash
   cd clones/albra-agentic-2a
   node --experimental-strip-types src/server.ts
   ```
2. Verificar en el navegador o curl:
   ```bash
   curl http://localhost:3003/api/health
   # Respuesta: {"status":"ok","service":"albra-agentic-2a"}
   ```
3. Enviar un mensaje simulado por webhook:
   ```bash
   node --experimental-strip-types clones/albra-agentic-2a/tests/e2e-bridge.test.ts
   ```
