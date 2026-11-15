# Ficha: WhatsPower — Capa de Difusión Masiva y Ventas Conversacionales para CRM ALBRA

> Inspirada en: WhatsOn (envíos masivos y anti-ban) y Kommo (automatización de pipeline y calificación de leads por chat)
> Metodología ClonaKit · Nivel 2: Capa satélite de superpoderes, conectada por contratos oficiales al CRM ALBRA sin modificar su núcleo

Esta ficha es la especificación funcional completa de la aplicación antes de su construcción.

---

## 1. En una frase

Una aplicación satélite que dota a **CRM ALBRA** de superpoderes de difusión masiva por WhatsApp con protección anti-ban, combinada con la inteligencia de pipeline de **Kommo**: cuando los destinatarios responden, el sistema actualiza automáticamente su etapa en el Kanban, añade etiquetas y notifica al vendedor con el contexto listo.

---

## 2. Para quién y para qué

Para equipos y negocios que usan **CRM ALBRA** y quieren lanzar campañas masivas y seguimientos de WhatsApp sin pagar costes por mensaje a Meta, con seguridad total contra bloqueos, y sin perder el orden: cada respuesta alimenta directamente el embudo de ventas del CRM.

---

## 3. Arquitectura del "Segundo Nivel" (Capa Satélite)

WhatsPower vive como un módulo satélite independiente que se comunica limpiamente con CRM ALBRA mediante contratos:
1. **Contratos CRM ALBRA:**
   - Lectura de clientes, etiquetas y etapas de oportunidad mediante `/api/crm/actions` y endpoints REST con API Key (`Authorization: Bearer albra_...`).
   - Actualización bidireccional: mueve oportunidades de etapa (`move_opportunity_stage`) y crea notas de timeline (`add_note`).
2. **Motor de Envío WhatsApp (Daemon Bridge):**
   - Utiliza la sesión activa de WhatsApp que ya corre en el daemon Baileys del CRM (`http://localhost:3002` o proxy `/api/whatsapp/daemon-proxy`), o modo simulador local para pruebas seguras.
3. **Persistencia Ligera:**
   - Guarda el histórico de campañas, borradores, plantillas y configuraciones en el almacenamiento local del navegador (IndexedDB / LocalStorage). No requiere modificar el esquema de base de datos de SQLite del CRM.

---

## 4. Funciones Principales (MVP)

| # | Función | Origen / Inspiración | Qué hace en la app |
|---|---|---|---|
| 1 | **Importación Dual & Segmentación Inteligente** | WhatsOn + Kommo | Carga contactos desde archivo Excel/CSV o importa clientes desde CRM ALBRA por etiquetas y etapas. Incluye **filtros de exclusión inteligente de Kommo**: excluye clientes con oportunidad activa o que ya recibieron mensaje en las últimas 24h. |
| 2 | **Redactor Spintax & Botones de Respuesta** | WhatsOn + ManyChat | Mensajes con variables dinámicas (`{{nombre}}`, `{{empresa}}`) y bloques Spintax `{Hola\|Buen día\|Qué tal}`. Soporta botones de respuesta numerada sugerida (ej. `1. Me interesa`, `2. Más información`) y previsualizador en vivo con 5 variantes aleatorias. |
| 3 | **Escudo Anti-Ban Dinámico** | WhatsOn | Control total de seguridad: intervalos aleatorios configurables (ej. 15 a 45 seg), límites de lote con pausas de enfriamiento (ej. 5 min cada 20 envíos) y alerta visual si el mensaje no tiene suficiente variación Spintax. |
| 4 | **Despachador en Vivo con Controles Calientes** | WhatsOn | Panel de progreso en tiempo real: enviados, pendientes, fallidos, barra de avance, registro segundo a segundo y botones de control inmediato: **Pausar**, **Reanudar** y **Detener**. |
| 5 | **Reglas de Reacción en el Pipeline (Estilo Kommo)** | Kommo | Permite definir qué pasa en el CRM cuando la campaña se ejecuta o cuando el cliente responde: a) Mover el lead automáticamente a una etapa (ej: `Enviada` ➔ `Respondió`); b) Asignar etiqueta de campaña; c) Dejar nota en el timeline de ALBRA para el vendedor. |
| 6 | **Reporte y Exportación** | WhatsOn | Historial de campañas con tasa de entrega, resumen de fallidos con motivo (número inválido, error de conexión) y exportación de informe completo a CSV. |

---

## 5. Pantallas y Experiencia de Usuario (UX)

### Cabecera y Navegación
- Logotipo **WhatsPower** con indicador de estado del CRM ALBRA (Verde = Conectado / Naranja = Modo Autónomo/Simulación).
- Accesos directos: **Campañas**, **Nueva Difusión**, **Reglas Kommo / Pipeline**, **Ajustes**.

### Pantalla 1: Asistente de Nueva Difusión (4 pasos)
- **Paso 1: Destinatarios y Filtros Kommo:**
  - Selector de origen: "Desde CRM ALBRA" o "Cargar Excel / CSV".
  - Filtro por etapa de oportunidad (ej. *Nuevos Prospectos*, *Cotización Enviada*).
  - Casillas de protección: *Excluir clientes con cotización abierta* y *Excluir clientes contactados hoy*.
  - Tabla previa con contador de contactos válidos.
- **Paso 2: Mensaje, Variables y Spintax:**
  - Editor con atajos para insertar variables y bloques `{A|B}`.
  - Simulador de teléfono WhatsApp con selector de preview aleatorio (genera 5 mensajes distintos al instante).
- **Paso 3: Automatización de Pipeline (Reglas Kommo):**
  - "¿Al enviar el mensaje?": Mantener etapa / Mover a etapa X / Añadir etiqueta Y.
  - "¿Al registrarse respuesta?": Mover a etapa *Interesado* / Notificar al vendedor con nota en el timeline.
- **Paso 4: Escudo Anti-Ban:**
  - Selector de perfil: *Seguro (30-60s)*, *Equilibrado (15-35s)* o *Personalizado*.
  - Barra de nivel de seguridad del mensaje (evalúa riqueza del Spintax).

### Pantalla 2: Monitor de Despacho en Vivo
- Tarjetas numéricas: **Enviados**, **En Cola**, **Fallidos**, **Tiempo Estimado**.
- Barra de progreso interactiva con porcentaje.
- Log de eventos con timestamp y previsualización del mensaje exacto enviado a cada contacto.
- Botones de acción fija: `⏸️ Pausar`, `▶️ Reanudar`, `🛑 Cancelar`.

### Pantalla 3: Historial y Métricas de Rendimiento
- Tarjetas de campañas anteriores: Nombre, Fecha, Contactos alcanzados, Tasa de entrega.
- Botón de descarga de reporte en CSV y sincronización con el CRM ALBRA.

---

## 6. Flujo Completo Integrado

1. El usuario abre WhatsPower y se conecta a su CRM ALBRA local (`http://localhost:3000`) con su API Key.
2. Inicia una difusión: selecciona el segmento de clientes con "Cotizaciones Pendientes" y activa el filtro de Kommo para no contactar a los que ya tienen cita agendada.
3. Escribe un mensaje con Spintax y variables personalizadas, configurando la regla Kommo: *"Cuando el cliente responda, mover automáticamente su oportunidad a 'En Negociación' y crear una nota en su timeline"*.
4. Lanza el despacho con el Escudo Anti-Ban en modo seguro.
5. El sistema envía los mensajes uno a uno vía el daemon Baileys del CRM con intervalos humanos aleatorios.
6. Al finalizar, el usuario tiene su reporte listo y su pipeline de ventas en CRM ALBRA actualizado sin haber tocado una sola línea de código del CRM.
