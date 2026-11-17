# OWNER_TODO — Acciones que SOLO el dueño puede ejecutar

**Actualizado:** 2026-11-17 · **Rama:** `repair/produccion-real`

## 0. Nuevas tareas de esta sesión (reparación 2026-11-17)
- [ ] **Rotar el PAT de GitHub** usado en esta sesión (estuvo en texto de chat) tras validar el push.
- [ ] **Decidir la política de IA**: si se activa el nodo AI_RESPONSE, aceptar explícitamente que el texto de conversaciones de clientes se transmite al proveedor externo (configurar `AI_API_KEY`, `AI_API_URL`, `AI_MODEL`) y revisarlo contra la política de tratamiento de datos.
- [ ] **Docker build en el PC** si se despliega en contenedor (no ejecutable en el entorno de trabajo remoto).

---




## 1. Credenciales y seguridad
- [ ] **Rotar el PAT de GitHub** compartido en chat para operar los repos (tras el merge, revocar y crear uno con alcance mínimo).
- [ ] **Purgar el historial git** con `git filter-repo` (el escáner de historial quedó en verde para hallazgos NUEVOS con 91 fixtures dummy baselined; el historial NO se purgó por regla de la misión). Requiere force-push: decisión del dueño.

## 2. Canal oficial (FASE 1)
- [ ] Cuenta **Meta Business** verificada + app Meta + **número oficial** en Cloud API (`phone_number_id`, WABA id, token de sistema).
- [ ] Cargar plantillas y obtener **aprobación de Meta** (el `TemplateRegistry` ya modela estados; sin plantillas aprobadas no hay envíos fuera de la ventana 24 h).
- [ ] Webhook de Meta → URL pública de WP con el appSecret real.

## 3. Piloto
- [ ] Autorizar por escrito la prueba real mínima (destinatario + plantilla + ventana).
- [ ] Proveer CSV inicial con columna de **origen del consentimiento** (exigida por el importador).
- [ ] Escanear QR solo para el plan básico de la organización que lo elija (aviso de riesgo explícito ya implementado).

## 4. Despliegue (PC del dueño)
- [ ] **Docker compose build + up en el PC**: NO ejecutable en el entorno de trabajo remoto (sin docker). Dockerfile/compose presentes.
- [ ] `.env` reales (secretos nuevos con `openssl rand -hex 32`); revisar `docs/RUNBOOK.md` y `MANUAL_DESPLIEGUE_Y_OPERACION.md`.
- [ ] Migraciones: copia de seguridad de la BD → aplicar → verificar healthcheck `/api/health`.

## 5. Legal
- [ ] Términos y Condiciones + Política de Privacidad definitivos (Ley 1581).

## 6. Integración
- [ ] Revisar diff y hacer merge de `repair/produccion-real` → `main` (sin autorización no se tocó main).
- [ ] Alta de cada organización de pago en `CRM_API_KEYS` y credenciales por organización en CRM (`WHATSPOWER_ORG_SERVICE_CREDENTIALS`).
