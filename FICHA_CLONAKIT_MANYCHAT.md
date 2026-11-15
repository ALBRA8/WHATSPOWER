# Ficha: WhatsPower Flow Studio (Nivel 2)

> Inspirada en: ManyChat (solo como referencia funcional de automatización de marketing y flujos visuales; no se copia código ni interfaz)  
> Metodología: ClonaKit · Sala Limpia  
> Proyecto: ALBRA8 / WHATSPOWER (Nivel 2)  
> Fecha: 26 de Octubre de 2026  

Esta ficha es la especificación funcional completa de la capa conversacional de **WhatsPower** antes de conectar su lienzo visual con el motor de ejecución.

---

## 1. En una frase

Un constructor visual de flujos de chat (lienzo de nodos conectables) que permite diseñar árboles de conversación interactivos para WhatsApp, calificar prospectos automáticamente y sincronizar en tiempo real el pipeline y los contactos de **CRM-ALBRA** sin escribir código.

---

## 2. Para quién y para qué

Para dueños de negocio, equipos de ventas y agencias que usan **CRM-ALBRA** y necesitan automatizar la atención inicial, calificar prospectos y responder preguntas frecuentes 24/7 sin pagar suscripciones mensuales a plataformas externas (ManyChat) ni servicios por mensaje a terceros, manteniendo el control total de sus datos y de su línea de WhatsApp.

---

## 3. Funciones de la primera versión (MVP)

| # | Función | Qué hace, con tus palabras | Cómo se hará en la app |
|---|---|---|---|
| **1** | **Visual Flow Builder (Lienzo de Nodos)** | Permite al usuario arrastrar, soltar y conectar cajitas en una pantalla infinita para armar la conversación (Inicio, Pregunta, Condición, Acción, Handoff). | Componente React con lienzo interactivo (`@xyflow/react`), nodos arrastrables y guardado en JSON. |
| **2** | **Flow Execution Engine (Motor de Flujos)** | Cuando un contacto escribe por WhatsApp, el motor evalúa en qué nodo del flujo se encuentra, procesa su respuesta y avanza al siguiente nodo. | Máquina de estados en Node.js que evalúa grafos dirigidos almacenados en `operational.db` y mantiene la sesión por contacto. |
| **3** | **Acciones de Negocio CRM ALBRA** | Nodos que ejecutan cambios reales en el CRM: mover cliente en el pipeline Kanban, añadir etiquetas, agendar cita o crear nota. | Conexión HTTP autenticada con `CRM-ALBRA` consumiendo el catálogo canónico `/api/crm/actions` (`Bearer albra_...`). |
| **4** | **Disparadores Inteligentes (Triggers)** | Iniciar un flujo específico cuando el cliente escribe ciertas palabras clave (`PRECIO`, `INFO`, `SOPORTE`, `CATALOGO`). | Enrutador determinista rápido (`router.ts`) que activa el flujo asociado sin invocar LLMs costosos. |
| **5** | **Live Chat & Human Handoff** | Si el cliente pide un asesor o el bot no entiende, pausa la automatización y transfiere la conversación a un humano. | Sistema de locks atómicos (`lock-manager.ts`) con TTL, silenciando el bot y generando una nota estructurada en el Timeline del CRM. |

---

## 4. Pantallas

### 4.1 Pantalla Principal: Lienzo del Diseñador de Flujos (`/flow-builder`)
- **Zona Superior:** Barra con nombre del flujo, estado (Borrador / Activo), selector de flujo guardado, botón "Probar Flujo" y botón "Guardar y Publicar".
- **Lienzo Central (Canvas Infinito):** Área interactiva para hacer zoom, mover la vista y conectar puertos de salida con puertos de entrada mediante flechas curvas.
- **Paleta Lateral Izquierda (Nodos Disponibles):**
  - **Nodo Disparador (Trigger):** Define qué inicia el flujo (palabra clave, primer mensaje, evento CRM).
  - **Nodo Mensaje:** Texto a enviar, con soporte de variables (`{{nombre}}`, `{{empresa}}`) y botones de menú (`1. Ventas`, `2. Soporte`).
  - **Nodo Condición:** Bifurcación Sí/No (ej. "¿El mensaje contiene 'precio'?", "¿Tiene cotización previa?").
  - **Nodo Acción CRM:** Ejecuta una acción en CRM ALBRA (`create_opportunity`, `add_note`, `update_stage`).
  - **Nodo Espera (Delay):** Pausa simulada de lectura humana (ej. 3 a 10 segundos).
  - **Nodo Handoff Humano:** Pausa la automatización y marca la conversación para atención manual.
- **Panel Lateral Derecho (Configuración del Nodo):** Al hacer clic en cualquier nodo, se despliegan sus propiedades específicas (editar texto, opciones del menú, etiquetas CRM).

### 4.2 Pantalla Secundaria: Consola de Simulación y Pruebas (`/simulator`)
- Un teléfono simulado en pantalla para chatear en vivo con el flujo diseñado antes de activarlo en el WhatsApp real.
- Panel de inspección que muestra en tiempo real qué nodo se ejecutó, qué variables cambiaron y qué llamadas a CRM ALBRA se generaron.

---

## 5. Flujos Paso a Paso

### Flujo 1: Calificación Automática de Lead y Creación de Oportunidad
1. El cliente potencial escribe al WhatsApp del negocio: *"Hola, quiero info del servicio"*.
2. El **Trigger** detecta el mensaje entrante y despierta el flujo *"Calificación Comercial"*.
3. El nodo **Mensaje** responde: *"¡Hola! Con gusto te comparto la información. ¿Qué tamaño tiene tu equipo? 1) 1-5 personas, 2) Más de 5 personas"*.
4. El cliente responde: *"2"*.
5. El nodo **Condición** evalúa la respuesta:
   - Si es opción 2 (lead de alto valor): avanza al nodo **Acción CRM** que invoca `create_opportunity` en ALBRA con monto estimado y etapa *"Interesado"*.
   - Envía mensaje: *"Excelente. Un especialista se comunicará contigo de inmediato"*.
6. El nodo **Handoff** adquiere el lock de conversación y publica una nota en el Timeline de CRM ALBRA: *"🤖 Lead calificado: Equipo de +5 personas. Requiere atención comercial inmediata"*.

---

## 6. Modelo de Datos y Persistencia

- **Esquema de Flujos (`FlowDefinition`):**
  - Cada flujo se almacena como un grafo JSON estructurado: `{ id, name, trigger, nodes: [...], edges: [...] }`.
  - Persistencia: SQLite local privada en `db/operational.db` dentro de `audit_repos/WHATSPOWER`.
- **Sesión de Diálogo por Contacto (`ContactSession`):**
  - Registra: `phone`, `currentFlowId`, `currentNodeId`, `variables: {}`, `lockedUntil`, `lastInteractionAt`.
- **Aislamiento Total:**
  - WhatsPower **no toca ni modifica** la base de datos `db/custom.db` del CRM. Toda interacción con el CRM se realiza estrictamente a través de los contratos HTTP oficiales.

---

## 7. Para más adelante (Fuera de esta primera versión)

- Integración de Comment-to-DM para publicaciones en redes sociales.
- Integración de notas de voz generadas por IA (TTS) dentro de los nodos.
- Pruebas A/B automáticas de variantes de mensajes.

---

## 8. Identidad Propia

- **Nombre:** WhatsPower Flow Studio
- **Estilo Visual:** Interfaz moderna y técnica inspirada en herramientas de diseño de sistemas: fondo oscuro sutil (`slate-950`), nodos con bordes de color por tipo (Verde: Triggers, Azul: Mensajes, Ámbar: Condiciones, Morado: Acciones CRM), tipografía monospace limpia para datos y preview en tiempo real.
- **Idioma:** Español neutro.

---

## 9. Checklist de Sala Limpia ClonaKit

- [x] Las funciones están descritas en nuestras palabras; no hay textos copiados de ManyChat.
- [x] No hay capturas, marcas registradas, logos ni activos del original.
- [x] El diseño respeta la arquitectura propia de ALBRA (Next.js, Node 22, SQLite y MCP).
- [x] El producto resultante no se salta licencias ni protecciones de plataformas externas; opera sobre infraestructura propia.
