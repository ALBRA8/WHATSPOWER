import { DatabaseSync } from 'node:sqlite'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Esquema operativo v3 (reparación integral 2026-11-06 — contrato v1.1.0 §9):
 * TODO el estado de conversación y datos de contacto es propiedad de la ORGANIZACIÓN.
 * Claves compuestas (organization_id, contact_phone) en locks, sesiones, variables,
 * tags, campos, supresiones, asignaciones, enrolamientos y transacciones de pago.
 * Anti-replay de webhooks PERSISTENTE (webhook_replay) e idempotencia por reclamación
 * atómica (idempotency_claims) + auditoría de pagos (payment_audit).
 *
 * Migración v0/v2 → v3: NO destructiva para datos. Los registros pre-existentes
 * (mono-organización) se asignan a la organización 'default', que es exactamente la
 * organización que resuelve el credencial legado INTERNAL_API_SECRET — los servicios
 * existentes siguen operativos sin reconfiguración.
 *
 * REVERSIBILIDAD (documentada en docs/MIGRACION-ORG-SCOPED.md):
 *  - Para BD en archivo, antes de migrar se crea una copia <db>.pre-v3-<timestamp>.bak.
 *    Rollback = detener el servicio y restaurar esa copia (los datos de la org default
 *    se conservan; las filas creadas DESPUÉS de la migración en otras orgs no existen
 *    por las guardas idempotentes de la cadena v3→v5; jamás se atribuye a una
 *    organización real: las filas heredadas van a '__legacy__'.
 */
// Versión EXPLÍCITA del esquema (fusión repair/integral-20261106 + fix/b2):
//  v3 = aislamiento multi-org por clave compuesta (segunda reparación)
//  v4 = catálogo/configuración por organización + journal de efectos externos (tercera reparación)
//  v5 = idempotencia durable de envíos externos (daemon_send_idempotency, B2)
// Todas las migraciones v3→v5 son aditivas, IDEMPOTENTES (guardas por tabla/columna)
// y reversibles (rollback documentado en docs/MIGRACIONES.md).
export const SCHEMA_VERSION = 5
// Espacio reservado para datos históricos SIN atribución: ninguna organización
// real puede consultar '__legacy__' (no se inventa pertenencia).
export const LEGACY_ORG_ID = '__legacy__'

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) as { name: string } | undefined
  return Boolean(row)
}

export function createDatabase(dbPath?: string): DatabaseSync {
  const targetPath = dbPath || join(__dirname, '..', 'db', 'operational.db')
  if (targetPath !== ':memory:') {
    mkdirSync(dirname(targetPath), { recursive: true })
  }

  const db = new DatabaseSync(targetPath)

  // (reauditoría ciclo 2, A2-11) WAL + busy_timeout: los contadores durables y
  // el anti-replay coordinan PROCESOS que comparten este archivo; sin pragmas,
  // la segunda conexión fallaba con SQLITE_BUSY al primer choque de escrituras
  // y el fail-open del limiter anulaba el límite justo bajo carga. En ':memory:'
  // los pragmas son inofensivos.
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`)

  // Detección de migración INTERRUMPIDA (reparación integral §7): un marcador
  // user_version > 0 por debajo de SCHEMA_VERSION indica un proceso que murió
  // a mitad de la cadena. Las migraciones son idempotentes, así que se
  // re-ejecutan con guardas y se re-marcan; se deja evidencia en el log.
  {
    const v = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const uv = v?.user_version ?? 0
    if (uv > 0 && uv < SCHEMA_VERSION) {
      console.warn(`[db] migración interrumpida detectada: user_version=${uv} < ${SCHEMA_VERSION}; re-ejecutando cadena idempotente v3→v${SCHEMA_VERSION}`)
    }
  }

  // Detección de BD heredada pre-v3 (conversation_locks sin webhook_replay).
  // La cadena de migraciones v3→v5 de más abajo (aditiva, con guardas por
  // tabla/columna) se hace cargo. Atribución de filas legacy SIEMPRE a
  // '__legacy__' — jamás a una organización real (no se inventa pertenencia).
  // Antes de migrar se copia el archivo de BD como base del rollback documentado.
  if (tableExists(db, 'conversation_locks') && !tableExists(db, 'webhook_replay') && targetPath !== ':memory:') {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      copyFileSync(targetPath, `${targetPath}.pre-migracion-${stamp}.bak`)
    } catch { /* sin archivo previo o sin permisos: la migración es idempotente, continuar */ }
  }

  // (A2-11, auditoría 2026-11-11) Contadores DURABLES de rate limiting para
  // endpoints públicos: sobreviven reinicios y son efectivos entre procesos
  // que compartan esta BD (SQLite serializa escrituras → atómico por diseño).
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit_buckets (
      bucket_key   TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket_key, window_start)
    )
  `)

  // Inicializar esquema operativo v3 de Capa 2A
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_locks (
      organization_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      current_state TEXT NOT NULL,
      locked_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      correlation_id TEXT NOT NULL,
      PRIMARY KEY (organization_id, contact_phone)
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL,
      response_json TEXT NOT NULL
    );

    -- Reclamación atómica de eventos (contrato §3.7): INSERT OR IGNORE ⇒ changes=0
    -- significa que OTRO proceso ya atiende el evento (idempotencia bajo concurrencia).
    CREATE TABLE IF NOT EXISTS idempotency_claims (
      key TEXT PRIMARY KEY,
      claimed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suppression_list (
      organization_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, phone)
    );

    CREATE TABLE IF NOT EXISTS session_variables (
      organization_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      var_key TEXT NOT NULL,
      var_value TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, contact_phone, var_key)
    );

    CREATE TABLE IF NOT EXISTS flows (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      trigger_keywords TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      graph_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id)
    );

    CREATE TABLE IF NOT EXISTS flow_sessions (
      organization_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      flow_id TEXT NOT NULL,
      current_node_id TEXT NOT NULL,
      waiting_for_input INTEGER NOT NULL DEFAULT 1,
      context_json TEXT NOT NULL,
      last_activity INTEGER NOT NULL,
      PRIMARY KEY (organization_id, contact_phone)
    );

    -- ManyChat Extended Tables
    CREATE TABLE IF NOT EXISTS contact_tags (
      organization_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      tag_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, contact_phone, tag_name)
    );

    CREATE TABLE IF NOT EXISTS contact_custom_fields (
      organization_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      field_key TEXT NOT NULL,
      field_value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, contact_phone, field_key)
    );

    CREATE TABLE IF NOT EXISTS sequences (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id)
    );

    CREATE TABLE IF NOT EXISTS sequence_steps (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      sequence_id TEXT NOT NULL,
      step_order INTEGER NOT NULL,
      delay_minutes INTEGER NOT NULL,
      message_text TEXT NOT NULL,
      flow_id TEXT,
      PRIMARY KEY (organization_id, id)
    );

    CREATE TABLE IF NOT EXISTS sequence_enrollments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      sequence_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      current_step INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
      UNIQUE (organization_id, sequence_id, contact_phone)
    );

    CREATE TABLE IF NOT EXISTS inbox_messages (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      direction TEXT NOT NULL, -- 'inbound' | 'outbound'
      text TEXT NOT NULL,
      media_url TEXT,
      created_at INTEGER NOT NULL
    );

    -- Superpoderes Extendidos: Gestión de Equipo, Canned Responses, Growth Links y Pagos
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL DEFAULT 'agent', -- 'admin' | 'agent'
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id)
    );

    CREATE TABLE IF NOT EXISTS agent_assignments (
      organization_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      assigned_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN', -- 'OPEN' | 'RESOLVED'
      PRIMARY KEY (organization_id, contact_phone)
    );

    CREATE TABLE IF NOT EXISTS canned_responses (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      shortcut TEXT NOT NULL, -- Ej: '/precio', '/cuenta', '/promo'
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      media_url TEXT,
      category TEXT NOT NULL DEFAULT 'general',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id),
      UNIQUE (organization_id, shortcut)
    );

    CREATE TABLE IF NOT EXISTS growth_links (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      slug TEXT NOT NULL, -- Ej: 'promo-verano', 'fb-ads'
      target_flow_id TEXT,
      initial_tag TEXT,
      prefilled_text TEXT NOT NULL,
      clicks INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id),
      UNIQUE (organization_id, slug)
    );

    CREATE TABLE IF NOT EXISTS payment_transactions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'COP',
      description TEXT NOT NULL,
      gateway TEXT NOT NULL, -- 'wompi' | 'mercadopago' | 'stripe' | 'simulator'
      external_id TEXT,
      payment_link TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING' | 'APPROVED' | 'REJECTED'
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Auditoría de pagos (contrato §6): cada transición de estado queda registrada.
    CREATE TABLE IF NOT EXISTS payment_audit (
      id TEXT PRIMARY KEY,
      transaction_id TEXT,
      organization_id TEXT,
      from_status TEXT,
      to_status TEXT,
      action TEXT NOT NULL,
      event_id TEXT,
      created_at INTEGER NOT NULL
    );

    -- Anti-replay PERSISTENTE (contrato §3): huellas (timestamp, MAC) con purga >600s.
    -- Sobrevive reinicios del proceso. Invariante: instancia única por BD.
    CREATE TABLE IF NOT EXISTS webhook_replay (
      fingerprint TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL
    );
  `)

  // ============================================================
  // Migraciones aditivas y REVERSIBLES (reparación integral 2026-11-06)
  // Documentación y rollback exacto en docs/MIGRACIONES.md.
  //  - payment_webhook_events → idempotencia DURABLE de webhooks de pasarela
  //    (rollback: DROP TABLE payment_webhook_events;)
  //  - payment_audit → pista de auditoría de pagos
  //    (rollback: DROP TABLE payment_audit;)
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_webhook_events (
      event_id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_payment_audit_txn ON payment_audit(transaction_id);
  `)

  // ============================================================
  // v4 — OLEADA 2 (decisión de negocio Meta/WhatsApp 2026-11-11):
  // EJECUTORES DE AUTOMATIZACIONES POR ORGANIZACIÓN.
  //  - stage_change_dedup    → idempotencia DURABLE de eventos stage-change
  //    (clave POR ORGANIZACIÓN): un replay del mismo evento jamás vuelve a
  //    disparar la automatización ni reenvía el mensaje (regla 8: nada de
  //    duplicados hacia WhatsApp).
  //  - automation_rules      → reglas de automatización POR ORGANIZACIÓN
  //    (cada empresa define sus disparadores; los defaults son fallback).
  //  - automation_events     → pista de auditoría de cada ejecución con el
  //    resultado REAL del despacho (SENT / UNCERTAIN / REJECTED_*).
  // Rollback: DROP TABLE stage_change_dedup; DROP TABLE automation_events;
  //           DROP TABLE automation_rules;
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS stage_change_dedup (
      organization_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      processed_at INTEGER NOT NULL,
      result_json TEXT,
      PRIMARY KEY (organization_id, event_key)
    );

    CREATE TABLE IF NOT EXISTS automation_rules (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      action TEXT NOT NULL,
      template_message TEXT,
      target_flow_id TEXT,
      target_sequence_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE (organization_id, stage)
    );

    CREATE TABLE IF NOT EXISTS automation_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      stage TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      message_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_automation_events_org ON automation_events(organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_automation_rules_org ON automation_rules(organization_id, stage);
  `)

  // ============================================================
  // v3 — AISLAMIENTO MULTI-ORG POR CLAVE COMPUESTA (segunda reparación 2026-11-06)
  // Causa raíz corregida: el teléfono era la clave primaria GLOBAL en varias
  // tablas — el mismo número en dos organizaciones compartía locks, sesiones,
  // variables, etiquetas, campos y supresiones.
  //
  // Cada tabla de contacto se reconstruye con organization_id DENTRO de la
  // clave primaria. Filas legacy (previas a v3) se atribuyen a '__legacy__',
  // un espacio que NINGUNA organización real puede consultar (los orgId reales
  // son identificadores de la plataforma) — no se inventa atribución.
  //
  // Rollback exacto en docs/MIGRACIONES.md (secciones por tabla).
  // ============================================================
  const LEGACY_ORG = '__legacy__'

  function tableColumns(db: DatabaseSync, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
  }
  function tablePk(db: DatabaseSync, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>)
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name)
  }
  function columnExists(db: DatabaseSync, table: string, col: string): boolean {
    return tableColumns(db, table).includes(col)
  }

  // 1) conversation_locks — PK pasa de (contact_phone) a (organization_id, contact_phone).
  //    (la columna organization_id ya existía; la PK global era el fallo)
  if (!tablePk(db, 'conversation_locks').includes('organization_id')) {
    db.exec(`
      ALTER TABLE conversation_locks RENAME TO conversation_locks_v2old;
      CREATE TABLE conversation_locks (
        contact_phone TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        current_state TEXT NOT NULL,
        locked_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        correlation_id TEXT NOT NULL,
        PRIMARY KEY (organization_id, contact_phone)
      );
      INSERT INTO conversation_locks (contact_phone, organization_id, current_state, locked_at, expires_at, correlation_id)
        SELECT contact_phone, organization_id, current_state, locked_at, expires_at, correlation_id FROM conversation_locks_v2old;
      DROP TABLE conversation_locks_v2old;
    `)
  }

  // 2) suppression_list — org-scoped: la baja de una org no silencia a la otra.
  if (!columnExists(db, 'suppression_list', 'organization_id')) {
    db.exec(`
      ALTER TABLE suppression_list RENAME TO suppression_list_v2old;
      CREATE TABLE suppression_list (
        organization_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, phone)
      );
      INSERT INTO suppression_list (organization_id, phone, reason, created_at)
        SELECT '${LEGACY_ORG}', phone, reason, created_at FROM suppression_list_v2old;
      DROP TABLE suppression_list_v2old;
    `)
  }

  // 3) session_variables — variables de sesión por (org, contacto, clave).
  if (!columnExists(db, 'session_variables', 'organization_id')) {
    db.exec(`
      ALTER TABLE session_variables RENAME TO session_variables_v2old;
      CREATE TABLE session_variables (
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        var_key TEXT NOT NULL,
        var_value TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, contact_phone, var_key)
      );
      INSERT INTO session_variables (organization_id, contact_phone, var_key, var_value, updated_at)
        SELECT '${LEGACY_ORG}', contact_phone, var_key, var_value, updated_at FROM session_variables_v2old;
      DROP TABLE session_variables_v2old;
    `)
  }

  // 4) flow_sessions — una sesión de flujo activa POR (org, contacto).
  if (!columnExists(db, 'flow_sessions', 'organization_id')) {
    db.exec(`
      ALTER TABLE flow_sessions RENAME TO flow_sessions_v2old;
      CREATE TABLE flow_sessions (
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        flow_id TEXT NOT NULL,
        current_node_id TEXT NOT NULL,
        waiting_for_input INTEGER NOT NULL DEFAULT 1,
        context_json TEXT NOT NULL,
        last_activity INTEGER NOT NULL,
        PRIMARY KEY (organization_id, contact_phone)
      );
      INSERT INTO flow_sessions (organization_id, contact_phone, flow_id, current_node_id, waiting_for_input, context_json, last_activity)
        SELECT '${LEGACY_ORG}', contact_phone, flow_id, current_node_id, waiting_for_input, context_json, last_activity FROM flow_sessions_v2old;
      DROP TABLE flow_sessions_v2old;
    `)
  }

  // 5) contact_tags — etiquetas por (org, contacto, etiqueta).
  if (!columnExists(db, 'contact_tags', 'organization_id')) {
    db.exec(`
      ALTER TABLE contact_tags RENAME TO contact_tags_v2old;
      CREATE TABLE contact_tags (
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        tag_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, contact_phone, tag_name)
      );
      INSERT INTO contact_tags (organization_id, contact_phone, tag_name, created_at)
        SELECT '${LEGACY_ORG}', contact_phone, tag_name, created_at FROM contact_tags_v2old;
      DROP TABLE contact_tags_v2old;
    `)
  }

  // 6) contact_custom_fields — campos personalizados por (org, contacto, clave).
  if (!columnExists(db, 'contact_custom_fields', 'organization_id')) {
    db.exec(`
      ALTER TABLE contact_custom_fields RENAME TO contact_custom_fields_v2old;
      CREATE TABLE contact_custom_fields (
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        field_key TEXT NOT NULL,
        field_value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, contact_phone, field_key)
      );
      INSERT INTO contact_custom_fields (organization_id, contact_phone, field_key, field_value, updated_at)
        SELECT '${LEGACY_ORG}', contact_phone, field_key, field_value, updated_at FROM contact_custom_fields_v2old;
      DROP TABLE contact_custom_fields_v2old;
    `)
  }

  // 7) sequence_enrollments — inscripciones con org (índice de barrido por org).
  // Guardia reforzada (fusión): la forma intermedia de la rama integral ya tenía
  // la columna PERO sin la UNIQUE (organization_id, sequence_id, contact_phone) —
  // una misma inscripción podía duplicarse entre etapas de la misma org.
  const seqEnrollHasUnique = (() => {
    try {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sequence_enrollments'").get() as { sql?: string } | undefined
      return Boolean(row?.sql && row.sql.includes('UNIQUE'))
    } catch { return false }
  })()
  if (!columnExists(db, 'sequence_enrollments', 'organization_id') || !seqEnrollHasUnique) {
    db.exec(`
      ALTER TABLE sequence_enrollments RENAME TO sequence_enrollments_v2old;
      CREATE TABLE sequence_enrollments (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        sequence_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        current_step INTEGER NOT NULL DEFAULT 1,
        next_run_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        UNIQUE (organization_id, sequence_id, contact_phone)
      );
      INSERT INTO sequence_enrollments (id, organization_id, sequence_id, contact_phone, current_step, next_run_at, status)
        SELECT id, '${LEGACY_ORG}', sequence_id, contact_phone, current_step, next_run_at, status FROM sequence_enrollments_v2old;
      DROP TABLE sequence_enrollments_v2old;
      CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_org_phone ON sequence_enrollments(organization_id, contact_phone);
      CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_next_run ON sequence_enrollments(status, next_run_at);
    `)
  }

  // 8) inbox_messages — historial con org.
  if (!columnExists(db, 'inbox_messages', 'organization_id')) {
    db.exec(`
      ALTER TABLE inbox_messages RENAME TO inbox_messages_v2old;
      CREATE TABLE inbox_messages (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        direction TEXT NOT NULL,
        text TEXT NOT NULL,
        media_url TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO inbox_messages (id, organization_id, contact_phone, direction, text, media_url, created_at)
        SELECT id, '${LEGACY_ORG}', contact_phone, direction, text, media_url, created_at FROM inbox_messages_v2old;
      DROP TABLE inbox_messages_v2old;
      CREATE INDEX IF NOT EXISTS idx_inbox_messages_org_phone ON inbox_messages(organization_id, contact_phone, created_at);
    `)
  }

  // 9) agent_assignments — asignación de agente POR (org, contacto).
  if (!columnExists(db, 'agent_assignments', 'organization_id')) {
    db.exec(`
      ALTER TABLE agent_assignments RENAME TO agent_assignments_v2old;
      CREATE TABLE agent_assignments (
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        assigned_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN',
        PRIMARY KEY (organization_id, contact_phone)
      );
      INSERT INTO agent_assignments (organization_id, contact_phone, agent_id, assigned_at, status)
        SELECT '${LEGACY_ORG}', contact_phone, agent_id, assigned_at, status FROM agent_assignments_v2old;
      DROP TABLE agent_assignments_v2old;
    `)
  }

  // (fusión) Índice org-scoped de pagos, SIEMPRE (la guarda de reconstrucción no debe ocultarlo).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_transactions_org ON payment_transactions(organization_id, created_at);`)

  // 10) payment_transactions — pagos con organización (vinculación evento→pago→org).
  if (!columnExists(db, 'payment_transactions', 'organization_id')) {
    db.exec(`
      ALTER TABLE payment_transactions RENAME TO payment_transactions_v2old;
      CREATE TABLE payment_transactions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'COP',
        description TEXT NOT NULL,
        gateway TEXT NOT NULL,
        external_id TEXT,
        payment_link TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO payment_transactions (id, organization_id, contact_phone, amount, currency, description, gateway, external_id, payment_link, status, created_at, updated_at)
        SELECT id, '${LEGACY_ORG}', contact_phone, amount, currency, description, gateway, external_id, payment_link, status, created_at, updated_at FROM payment_transactions_v2old;
      DROP TABLE payment_transactions_v2old;
      CREATE INDEX IF NOT EXISTS idx_payment_transactions_org ON payment_transactions(organization_id, created_at);
    `)
  }

  // 11) idempotency_keys — RESERVA ATÓMICA de eventos inbound (segunda reparación §3.C):
  //      status PROCESSING → COMPLETED | FAILED, con lease para recuperación de
  //      procesos interrumpidos. La clave ya era org-scoped (`org::eventId`).
  if (!columnExists(db, 'idempotency_keys', 'status')) {
    db.exec(`
      ALTER TABLE idempotency_keys RENAME TO idempotency_keys_v2old;
      CREATE TABLE idempotency_keys (
        key TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'COMPLETED', -- 'PROCESSING' | 'COMPLETED' | 'FAILED'
        response_json TEXT,
        created_at INTEGER NOT NULL,
        lease_expires_at INTEGER NOT NULL
      );
      INSERT INTO idempotency_keys (key, status, response_json, created_at, lease_expires_at)
        SELECT key, 'COMPLETED', response_json, processed_at, processed_at FROM idempotency_keys_v2old;
      DROP TABLE idempotency_keys_v2old;
      CREATE INDEX IF NOT EXISTS idx_idempotency_lease ON idempotency_keys(status, lease_expires_at);
    `)
  }

  // 12) v4 — TERCERA REPARACIÓN: TABLAS DE CONFIGURACIÓN/CATÁLOGO POR ORGANIZACIÓN
  //     Causa raíz corregida: flows, sequences, sequence_steps, agents,
  //     canned_responses y growth_links eran GLOBALES (una organización veía,
  //     editaba y ejecutaba la configuración de otra). Cada tabla se reconstruye
  //     con organization_id DENTRO de la PK (y unicidad (org, shortcut)/(org, slug)).
  //     Filas legacy → '__legacy__' (espacio reservado que NINGUNA organización
  //     real puede consultar; no se inventa atribución). Rollback exacto en
  //     docs/MIGRACIONES.md (sección v4 por tabla).
  function rebuildWithOrg(
    table: string,
    createSql: string,
    legacySelectColumns: string,
    extraIndexes: string = ''
  ): void {
    if (columnExists(db, table, 'organization_id')) return
    db.exec(`
      ALTER TABLE ${table} RENAME TO ${table}_v3old;
      CREATE TABLE ${createSql};
      INSERT INTO ${createSql.match(/CREATE TABLE (\w+)/)?.[1] ?? table} (${legacySelectColumns})
        SELECT ${legacySelectColumns.replace(/organization_id/g, `'${LEGACY_ORG}' AS organization_id`)} FROM ${table}_v3old;
      DROP TABLE ${table}_v3old;
      ${extraIndexes}
    `)
  }

  // 12.1) flows — PK (organization_id, id)
  rebuildWithOrg(
    'flows',
    `flows (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      trigger_keywords TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      graph_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id)
    )`,
    'id, organization_id, name, trigger_keywords, is_active, graph_json, created_at, updated_at'
  )

  // 12.2) sequences — PK (organization_id, id)
  rebuildWithOrg(
    'sequences',
    `sequences (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id)
    )`,
    'id, organization_id, name, is_active, created_at'
  )

  // 12.3) sequence_steps — PK (organization_id, id)
  rebuildWithOrg(
    'sequence_steps',
    `sequence_steps (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      sequence_id TEXT NOT NULL,
      step_order INTEGER NOT NULL,
      delay_minutes INTEGER NOT NULL,
      message_text TEXT NOT NULL,
      flow_id TEXT,
      PRIMARY KEY (organization_id, id)
    )`,
    'id, organization_id, sequence_id, step_order, delay_minutes, message_text, flow_id'
  )

  // 12.4) agents — PK (organization_id, id): el equipo de cada organización es SUYO
  rebuildWithOrg(
    'agents',
    `agents (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL DEFAULT 'agent',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id)
    )`,
    'id, organization_id, name, email, phone, is_active, role, created_at'
  )

  // 12.5) canned_responses — PK (organization_id, id) + UNIQUE (organization_id, shortcut)
  rebuildWithOrg(
    'canned_responses',
    `canned_responses (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      shortcut TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      media_url TEXT,
      category TEXT NOT NULL DEFAULT 'general',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id),
      UNIQUE (organization_id, shortcut)
    )`,
    'id, organization_id, shortcut, title, content, media_url, category, created_at'
  )

  // 12.6) growth_links — PK (organization_id, id) + UNIQUE (organization_id, slug)
  rebuildWithOrg(
    'growth_links',
    `growth_links (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      target_flow_id TEXT,
      initial_tag TEXT,
      prefilled_text TEXT NOT NULL,
      clicks INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id),
      UNIQUE (organization_id, slug)
    )`,
    'id, organization_id, slug, target_flow_id, initial_tag, prefilled_text, clicks, created_at'
  )

  // (fusión) payment_audit: BDs creadas por ramas anteriores pueden tener la
  // forma sin 'action'/'event_id' (integral) o sin 'organization_id' (fix/b2).
  // Se reconstruye a la forma UNIÓN preservando filas; org ausente → '__legacy__'.
  if (tableExists(db, 'payment_audit')) {
    const cols = tableColumns(db, 'payment_audit')
    if (!cols.includes('action') || !cols.includes('organization_id')) {
      db.exec(`
        ALTER TABLE payment_audit RENAME TO payment_audit_mergeold;
        CREATE TABLE payment_audit (
          id TEXT PRIMARY KEY,
          transaction_id TEXT,
          organization_id TEXT,
          from_status TEXT,
          to_status TEXT,
          action TEXT NOT NULL DEFAULT 'unknown',
          event_id TEXT,
          created_at INTEGER NOT NULL
        );
        INSERT INTO payment_audit (id, transaction_id, organization_id, from_status, to_status, action, event_id, created_at)
          SELECT id, transaction_id, COALESCE(organization_id, '${'__legacy__'}'), from_status, to_status, COALESCE(action, 'unknown'), event_id, created_at
          FROM payment_audit_mergeold;
        DROP TABLE payment_audit_mergeold;
      `)
    }
  }

  // 14) v4 — (4.E) payment_webhook_events.organization_id: vinculación explícita
  //     evento↔organización (auditable; los eventos legacy quedan con NULL —
  //     no se inventa atribución). (rollback: ALTER TABLE payment_webhook_events DROP COLUMN organization_id;)
  if (!tableColumns(db, 'payment_webhook_events').includes('organization_id')) {
    db.exec('ALTER TABLE payment_webhook_events ADD COLUMN organization_id TEXT')
    db.exec('CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_org ON payment_webhook_events(organization_id)')
  }

  // 13) v4 — TERCERA REPARACIÓN (4.C): JOURNAL DE EFECTOS EXTERNOS + PAYLOADS
  //  - inbound_effect_journal: cada efecto externo (envío de mensaje, acción
  //    CRM) de un evento inbound queda registrado PENDING→DONE de forma
  //    DURADERA. Un reingreso (crash/lease vencido) sólo ejecuta efectos
  //    PENDING: un mensaje ya enviado JAMÁS se reenvía por un fallo posterior.
  //    (rollback: DROP TABLE inbound_effect_journal;)
  //  - idempotency_event_payloads: payload original del evento para que la
  //    reconciliación de claves UNCERTAIN pueda re-ejecutar el ciclo completo
  //    reutilizando el journal.
  //    (rollback: DROP TABLE idempotency_event_payloads;)
  //  - El estado UNCERTAIN de idempotency_keys es un VALOR nuevo de la columna
  //    status existente (sin cambio de esquema; documentado en MIGRACIONES).
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbound_effect_journal (
      key TEXT NOT NULL,
      effect_key TEXT NOT NULL,
      effect_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING' | 'DONE' | 'REJECTED'
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (key, effect_key)
    );
    CREATE INDEX IF NOT EXISTS idx_effect_journal_status ON inbound_effect_journal(key, status);

    CREATE TABLE IF NOT EXISTS idempotency_event_payloads (
      key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_credentials (
      org_id TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, credential_hash)
    );
  `)

  // ============================================================
  // v5 — B2 (fase final): IDEMPOTENCIA DURABLE DE ENVÍOS EXTERNOS
  // Causa raíz corregida: el daemon Baileys de Capa 1 (repo CRM-ALBRA) NO
  // consume ni persiste idempotencyKey / X-Correlation-Id, así que un envío
  // aceptado cuya respuesta se pierde era indistinguible de un no-envío y el
  // journal podía reejecutar el efecto PENDING al vencer el lease.
  //
  // Este servicio (el ejecutor del despacho en Capa 2A) registra AHORA CADA
  // intento de envío ANTES de llamar a Baileys, con restricción única
  // (organization_id, idempotency_key): una clave repetida en estado
  // IN_FLIGHT / SENT / UNCERTAIN devuelve su estado registrada y JAMÁS
  // re-despacha el mensaje (reenvío sólo con autorización explícita
  // registrada en resend_authorized_at, y sigue siendo at-least-once).
  //
  // Rollback exacto: DROP TABLE daemon_send_idempotency;
  //            DROP INDEX IF EXISTS idx_send_idem_org_corr;
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_send_idempotency (
      organization_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'IN_FLIGHT', -- 'IN_FLIGHT' | 'SENT' | 'UNCERTAIN' | 'REJECTED'
      to_phone TEXT NOT NULL,
      message_text TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      daemon_message_id TEXT,
      attempt_token TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      resend_authorized_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_send_idem_org_corr ON daemon_send_idempotency(organization_id, correlation_id);
  `)

  // Índices para la purga periódica del anti-replay (600s) y de la idempotencia (7 días)
  // (aporte de repair/integral-20261106; las tablas existen en el esquema fusionado).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_webhook_replay_seen_at ON webhook_replay (seen_at);
    CREATE INDEX IF NOT EXISTS idx_idempotency_claims_claimed_at ON idempotency_claims (claimed_at);
    CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys (created_at);
  `)

  // Gobernanza de versión EXPLÍCITA: tras ejecutar la cadena idempotente v3→v5
  // se marca user_version. Permite detectar BD a medio migrar (user_version>0
  // pero < SCHEMA_VERSION tras un fallo) en el arranque.
  {
    const v = db.prepare('PRAGMA user_version').get() as { user_version: number }
    if ((v?.user_version ?? 0) !== SCHEMA_VERSION) {
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
    }
  }
  return db
}

/**
 * Purga de antigüedad (contrato §3): huellas de replay >600s y claves de
 * idempotencia con más de 7 días. Llamado periódicamente por el servidor y
 * de forma oportunista al arrancar.
 */
export function purgeExpiredSecurityRows(db: DatabaseSync): void {
  const now = Date.now()
  try {
    db.prepare('DELETE FROM webhook_replay WHERE seen_at < ?').run(now - 600_000)
    const cutoff7d = Math.floor(now / 1000) - 7 * 24 * 60 * 60
    db.prepare('DELETE FROM idempotency_claims WHERE claimed_at < ?').run(cutoff7d)
    db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff7d)
  } catch { /* la purga jamás debe romper el tráfico */ }
}

/** ¿Existe el archivo de BD? (para pruebas de persistencia) */
export function databaseFileExists(dbPath: string): boolean {
  return dbPath !== ':memory:' && existsSync(dbPath)
}

/** (A2-11) Rate limit DURABLE de ventana fija, atómico (UPSERT...RETURNING).
 *  key: 'inbound:<ip>' / 'payments:<ip>'. Limpia ventanas viejas con 2% de
 *  probabilidad para no crecer sin techo. */
export function durableRateLimit(
  db: DatabaseSync,
  key: string,
  limit: number,
  windowMs: number = 60_000,
): { allowed: boolean; retryAfterSec: number } {
  const ws = Math.floor(Date.now() / windowMs) * windowMs
  try {
    const row = db.prepare(`
      INSERT INTO rate_limit_buckets (bucket_key, window_start, count)
      VALUES (?, ?, 1)
      ON CONFLICT(bucket_key, window_start) DO UPDATE SET count = count + 1
      RETURNING count
    `).get(key, Math.floor(ws / 1000)) as { count: number } | undefined
    if (Math.random() < 0.02) {
      db.prepare('DELETE FROM rate_limit_buckets WHERE window_start < ?')
        .run(Math.floor((Date.now() - 2 * windowMs) / 1000))
    }
    const count = row?.count ?? 1
    if (count > limit) {
      const resetAtMs = ws + windowMs
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000)) }
    }
    return { allowed: true, retryAfterSec: 0 }
  } catch (err) {
    // Si el contador falla (BD ocupada), fail-closed para endpoints públicos
    // es demasiado agresivo ante un fallo transitorio del almacén: se permite
    // y el HMAC/anti-replay propios del endpoint siguen protegiendo.
    // (reauditoría ciclo 2) El fail-open era INVISIBLE: se registra para poder
    // detectar degradación del límite en operación.
    console.warn('[db] durableRateLimit fail-open:', err instanceof Error ? err.message : err)
    return { allowed: true, retryAfterSec: 0 }
  }
}

