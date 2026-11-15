import { DatabaseSync } from 'node:sqlite'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function createDatabase(dbPath?: string): DatabaseSync {
  const targetPath = dbPath || join(__dirname, '..', 'db', 'operational.db')
  if (targetPath !== ':memory:') {
    mkdirSync(dirname(targetPath), { recursive: true })
  }

  const db = new DatabaseSync(targetPath)

  // Hardening SQLite: foreign keys y WAL para consistencia referencial y concurrencia.
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')

  // Inicializar esquema operativo privado de Capa 2A
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_locks (
      contact_phone TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      current_state TEXT NOT NULL,
      locked_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      correlation_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL,
      response_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suppression_list (
      phone TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_variables (
      contact_phone TEXT NOT NULL,
      var_key TEXT NOT NULL,
      var_value TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (contact_phone, var_key)
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
      contact_phone TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      current_node_id TEXT NOT NULL,
      waiting_for_input INTEGER NOT NULL DEFAULT 1,
      context_json TEXT NOT NULL,
      last_activity INTEGER NOT NULL
    );

    -- ManyChat Extended Tables
    CREATE TABLE IF NOT EXISTS contact_tags (
      contact_phone TEXT NOT NULL,
      tag_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (contact_phone, tag_name)
    );

    CREATE TABLE IF NOT EXISTS contact_custom_fields (
      contact_phone TEXT NOT NULL,
      field_key TEXT NOT NULL,
      field_value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (contact_phone, field_key)
    );

    -- CRM de Contactos (paridad ManyChat "Contactos"): ficha principal del contacto
    CREATE TABLE IF NOT EXISTS crm_contacts (
      contact_phone TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
      sequence_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      current_step INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' -- 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
    );

    CREATE TABLE IF NOT EXISTS inbox_messages (
      id TEXT PRIMARY KEY,
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
      contact_phone TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      assigned_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN' -- 'OPEN' | 'RESOLVED'
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
  `)

  // Índices para acelerar las consultas más frecuentes (lookups por teléfono, status, next_run_at, etc.)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_inbox_phone ON inbox_messages(contact_phone);
    CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox_messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_seq_enroll_next ON sequence_enrollments(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_seq_enroll_phone ON sequence_enrollments(contact_phone);
    CREATE INDEX IF NOT EXISTS idx_tags_name ON contact_tags(tag_name);
    CREATE INDEX IF NOT EXISTS idx_custom_field_key ON contact_custom_fields(field_key);
    CREATE INDEX IF NOT EXISTS idx_assignments_agent ON agent_assignments(agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_assignments_status ON agent_assignments(status);
    CREATE INDEX IF NOT EXISTS idx_payment_status ON payment_transactions(status);
    CREATE INDEX IF NOT EXISTS idx_payment_phone ON payment_transactions(contact_phone);
    CREATE INDEX IF NOT EXISTS idx_flows_active ON flows(is_active);
  `)

  return db
}
