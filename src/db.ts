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
 *    en el esquema v2 y se perderían — documentado).
 *  - La migración corre DENTRO de una transacción: un fallo a mitad ⇒ ROLLBACK
 *    completo, jamás importación parcial silenciosa.
 */
export const SCHEMA_VERSION = 3
export const DEFAULT_ORG_ID = 'default'

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) as { name: string } | undefined
  return Boolean(row)
}

function migrateToV3(db: DatabaseSync, targetPath: string): void {
  // Copia de seguridad previa (solo BD en archivo) — base del rollback documentado.
  if (targetPath !== ':memory:') {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      copyFileSync(targetPath, `${targetPath}.pre-v3-${stamp}.bak`)
    } catch { /* si la copia falla (p.ej. BD nueva sin archivo aún), continuar */ }
  }

  db.exec('BEGIN')
  try {
    // --- conversation_locks: PK (organization_id, contact_phone) ---
    if (tableExists(db, 'conversation_locks') && !tableExists(db, 'conversation_locks_v3')) {
      db.exec('ALTER TABLE conversation_locks RENAME TO conversation_locks_legacy')
      db.exec(`CREATE TABLE conversation_locks_v3 (
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        current_state TEXT NOT NULL,
        locked_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        correlation_id TEXT NOT NULL,
        PRIMARY KEY (organization_id, contact_phone)
      );`)
      db.exec(`INSERT OR IGNORE INTO conversation_locks_v3 (organization_id, contact_phone, current_state, locked_at, expires_at, correlation_id)
        SELECT '${DEFAULT_ORG_ID}', contact_phone, current_state, locked_at, expires_at, correlation_id FROM conversation_locks_legacy;`)
      db.exec('DROP TABLE conversation_locks_legacy;')
      db.exec('ALTER TABLE conversation_locks_v3 RENAME TO conversation_locks;')
    }

    // --- suppression_list: PK (organization_id, phone) ---
    if (tableExists(db, 'suppression_list') && !tableExists(db, 'suppression_list_v3')) {
      db.exec('ALTER TABLE suppression_list RENAME TO suppression_list_legacy')
      db.exec(`CREATE TABLE suppression_list_v3 (
        organization_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, phone)
      );`)
      db.exec(`INSERT OR IGNORE INTO suppression_list_v3 (organization_id, phone, reason, created_at)
        SELECT '${DEFAULT_ORG_ID}', phone, reason, created_at FROM suppression_list_legacy;`)
      db.exec('DROP TABLE suppression_list_legacy;')
      db.exec('ALTER TABLE suppression_list_v3 RENAME TO suppression_list;')
    }

    // --- flow_sessions: PK (organization_id, contact_phone) ---
    if (tableExists(db, 'flow_sessions') && !tableExists(db, 'flow_sessions_v3')) {
      db.exec('ALTER TABLE flow_sessions RENAME TO flow_sessions_legacy')
      db.exec(`CREATE TABLE flow_sessions_v3 (
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        flow_id TEXT NOT NULL,
        current_node_id TEXT NOT NULL,
        waiting_for_input INTEGER NOT NULL DEFAULT 1,
        context_json TEXT NOT NULL,
        last_activity INTEGER NOT NULL,
        PRIMARY KEY (organization_id, contact_phone)
      );`)
      db.exec(`INSERT OR IGNORE INTO flow_sessions_v3 (organization_id, contact_phone, flow_id, current_node_id, waiting_for_input, context_json, last_activity)
        SELECT '${DEFAULT_ORG_ID}', contact_phone, flow_id, current_node_id, waiting_for_input, context_json, last_activity FROM flow_sessions_legacy;`)
      db.exec('DROP TABLE flow_sessions_legacy;')
      db.exec('ALTER TABLE flow_sessions_v3 RENAME TO flow_sessions;')
    }

    // --- session_variables: PK (organization_id, contact_phone, var_key) ---
    if (tableExists(db, 'session_variables') && !tableExists(db, 'session_variables_v3')) {
      db.exec('ALTER TABLE session_variables RENAME TO session_variables_legacy')
      db.exec(`CREATE TABLE session_variables_v3 (
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        var_key TEXT NOT NULL,
        var_value TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, contact_phone, var_key)
      );`)
      db.exec(`INSERT OR IGNORE INTO session_variables_v3 (organization_id, contact_phone, var_key, var_value, updated_at)
        SELECT '${DEFAULT_ORG_ID}', contact_phone, var_key, var_value, updated_at FROM session_variables_legacy;`)
      db.exec('DROP TABLE session_variables_legacy;')
      db.exec('ALTER TABLE session_variables_v3 RENAME TO session_variables;')
    }

    // --- contact_tags: PK (organization_id, contact_phone, tag_name) ---
    if (tableExists(db, 'contact_tags') && !tableExists(db, 'contact_tags_v3')) {
      db.exec('ALTER TABLE contact_tags RENAME TO contact_tags_legacy')
      db.exec(`CREATE TABLE contact_tags_v3 (
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        tag_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, contact_phone, tag_name)
      );`)
      db.exec(`INSERT OR IGNORE INTO contact_tags_v3 (organization_id, contact_phone, tag_name, created_at)
        SELECT '${DEFAULT_ORG_ID}', contact_phone, tag_name, created_at FROM contact_tags_legacy;`)
      db.exec('DROP TABLE contact_tags_legacy;')
      db.exec('ALTER TABLE contact_tags_v3 RENAME TO contact_tags;')
    }

    // --- contact_custom_fields: PK (organization_id, contact_phone, field_key) ---
    if (tableExists(db, 'contact_custom_fields') && !tableExists(db, 'contact_custom_fields_v3')) {
      db.exec('ALTER TABLE contact_custom_fields RENAME TO contact_custom_fields_legacy')
      db.exec(`CREATE TABLE contact_custom_fields_v3 (
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        field_key TEXT NOT NULL,
        field_value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, contact_phone, field_key)
      );`)
      db.exec(`INSERT OR IGNORE INTO contact_custom_fields_v3 (organization_id, contact_phone, field_key, field_value, updated_at)
        SELECT '${DEFAULT_ORG_ID}', contact_phone, field_key, field_value, updated_at FROM contact_custom_fields_legacy;`)
      db.exec('DROP TABLE contact_custom_fields_legacy;')
      db.exec('ALTER TABLE contact_custom_fields_v3 RENAME TO contact_custom_fields;')
    }

    // --- inbox_messages: añade organization_id ---
    if (tableExists(db, 'inbox_messages') && !tableExists(db, 'inbox_messages_v3')) {
      db.exec('ALTER TABLE inbox_messages RENAME TO inbox_messages_legacy')
      db.exec(`CREATE TABLE inbox_messages_v3 (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        direction TEXT NOT NULL,
        text TEXT NOT NULL,
        media_url TEXT,
        created_at INTEGER NOT NULL
      );`)
      db.exec(`INSERT OR IGNORE INTO inbox_messages_v3 (id, organization_id, contact_phone, direction, text, media_url, created_at)
        SELECT id, '${DEFAULT_ORG_ID}', contact_phone, direction, text, media_url, created_at FROM inbox_messages_legacy;`)
      db.exec('DROP TABLE inbox_messages_legacy;')
      db.exec('ALTER TABLE inbox_messages_v3 RENAME TO inbox_messages;')
    }

    // --- agent_assignments: PK (organization_id, contact_phone) ---
    if (tableExists(db, 'agent_assignments') && !tableExists(db, 'agent_assignments_v3')) {
      db.exec('ALTER TABLE agent_assignments RENAME TO agent_assignments_legacy')
      db.exec(`CREATE TABLE agent_assignments_v3 (
        organization_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        assigned_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN',
        PRIMARY KEY (organization_id, contact_phone)
      );`)
      db.exec(`INSERT OR IGNORE INTO agent_assignments_v3 (organization_id, contact_phone, agent_id, assigned_at, status)
        SELECT '${DEFAULT_ORG_ID}', contact_phone, agent_id, assigned_at, status FROM agent_assignments_legacy;`)
      db.exec('DROP TABLE agent_assignments_legacy;')
      db.exec('ALTER TABLE agent_assignments_v3 RENAME TO agent_assignments;')
    }

    // --- sequence_enrollments: añade organization_id ---
    if (tableExists(db, 'sequence_enrollments') && !tableExists(db, 'sequence_enrollments_v3')) {
      db.exec('ALTER TABLE sequence_enrollments RENAME TO sequence_enrollments_legacy')
      db.exec(`CREATE TABLE sequence_enrollments_v3 (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        sequence_id TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        current_step INTEGER NOT NULL DEFAULT 1,
        next_run_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE'
      );`)
      db.exec(`INSERT OR IGNORE INTO sequence_enrollments_v3 (id, organization_id, sequence_id, contact_phone, current_step, next_run_at, status)
        SELECT id, '${DEFAULT_ORG_ID}', sequence_id, contact_phone, current_step, next_run_at, status FROM sequence_enrollments_legacy;`)
      db.exec('DROP TABLE sequence_enrollments_legacy;')
      db.exec('ALTER TABLE sequence_enrollments_v3 RENAME TO sequence_enrollments;')
    }

    // --- payment_transactions: añade organization_id ---
    if (tableExists(db, 'payment_transactions') && !tableExists(db, 'payment_transactions_v3')) {
      db.exec('ALTER TABLE payment_transactions RENAME TO payment_transactions_legacy')
      db.exec(`CREATE TABLE payment_transactions_v3 (
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
      );`)
      db.exec(`INSERT OR IGNORE INTO payment_transactions_v3 (id, organization_id, contact_phone, amount, currency, description, gateway, external_id, payment_link, status, created_at, updated_at)
        SELECT id, '${DEFAULT_ORG_ID}', contact_phone, amount, currency, description, gateway, external_id, payment_link, status, created_at, updated_at FROM payment_transactions_legacy;`)
      db.exec('DROP TABLE payment_transactions_legacy;')
      db.exec('ALTER TABLE payment_transactions_v3 RENAME TO payment_transactions;')
    }

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* nada que revertir */ }
    throw err
  }
}

export function createDatabase(dbPath?: string): DatabaseSync {
  const targetPath = dbPath || join(__dirname, '..', 'db', 'operational.db')
  if (targetPath !== ':memory:') {
    mkdirSync(dirname(targetPath), { recursive: true })
  }

  const db = new DatabaseSync(targetPath)

  // Detección de esquema pre-v3: una BD heredada tiene conversation_locks con PK
  // mono-organización y jamás tiene webhook_replay (introducido en v3). Las BD
  // nuevas no tienen ninguna de las dos. user_version NO es fiable: los esquemas
  // legacy nunca lo establecieron.
  const legacyNeedsMigration = tableExists(db, 'conversation_locks') && !tableExists(db, 'webhook_replay')
  if (legacyNeedsMigration) {
    migrateToV3(db, targetPath)
  }

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
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trigger_keywords TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      graph_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sequence_steps (
      id TEXT PRIMARY KEY,
      sequence_id TEXT NOT NULL,
      step_order INTEGER NOT NULL,
      delay_minutes INTEGER NOT NULL,
      message_text TEXT NOT NULL,
      flow_id TEXT
    );

    CREATE TABLE IF NOT EXISTS sequence_enrollments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      sequence_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      current_step INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' -- 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
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
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL DEFAULT 'agent', -- 'admin' | 'agent'
      created_at INTEGER NOT NULL
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
      id TEXT PRIMARY KEY,
      shortcut TEXT UNIQUE NOT NULL, -- Ej: '/precio', '/cuenta', '/promo'
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      media_url TEXT,
      category TEXT NOT NULL DEFAULT 'general',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS growth_links (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL, -- Ej: 'promo-verano', 'fb-ads'
      target_flow_id TEXT,
      initial_tag TEXT,
      prefilled_text TEXT NOT NULL,
      clicks INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
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
      transaction_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Anti-replay PERSISTENTE (contrato §3): huellas (timestamp, MAC) con purga >600s.
    -- Sobrevive reinicios del proceso. Invariante: instancia única por BD.
    CREATE TABLE IF NOT EXISTS webhook_replay (
      fingerprint TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL
    );
  `)

  // Índice para la purga periódica del anti-replay (600s) y de la idempotencia (7 días).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_webhook_replay_seen_at ON webhook_replay (seen_at);
    CREATE INDEX IF NOT EXISTS idx_idempotency_claims_claimed_at ON idempotency_claims (claimed_at);
    CREATE INDEX IF NOT EXISTS idx_idempotency_keys_processed_at ON idempotency_keys (processed_at);
  `)

  const v = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if ((v?.user_version ?? 0) < SCHEMA_VERSION) {
    // BD nueva (nunca tuvo user_version): marcar esquema actual sin pasar por migrateToV3.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
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
    db.prepare('DELETE FROM idempotency_keys WHERE processed_at < ?').run(cutoff7d)
  } catch { /* la purga jamás debe romper el tráfico */ }
}

/** ¿Existe el archivo de BD? (para pruebas de persistencia) */
export function databaseFileExists(dbPath: string): boolean {
  return dbPath !== ':memory:' && existsSync(dbPath)
}
