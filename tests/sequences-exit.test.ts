/**
 * (ronda 19) SALIR DE UNA SECUENCIA — POST /api/sequences/:id/exit
 *
 * Por qué existe esta prueba: el endpoint respondía `{ ok: true }` siempre, aunque
 * el teléfono llegara con adornos («+57 300 123 4567») y no coincidiera con la
 * inscripción guardada como «573001234567». Es decir, acusaba una cancelación que
 * no había ocurrido. Ahora normaliza, cuenta las filas canceladas de verdad y lo
 * dice en la respuesta.
 *
 * Estilo: servidor real + SQLite ':memory:' (sin red hacia fuera, sin mocks en la
 * lógica bajo prueba).
 *
 * Contratos verificados:
 *  SEQXIT-01  Teléfono con adornos cancela la inscripción (cancelled 1) y la fila
 *             queda en CANCELLED.
 *  SEQXIT-02  Repetir la salida no rompe nada y dice la verdad (cancelled 0).
 *  SEQXIT-03  Un teléfono imposible → 400 y no toca ninguna fila.
 *  SEQXIT-04  Sin X-Org-Id → 400 (aislamiento obligatorio).
 *  SEQXIT-05  Otra organización con el mismo id de secuencia no cancela nada.
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { createAgenticServer } from '../src/server.ts'
import { MockTransportSender as MT } from '../src/adapters/transport.ts'
import { MockCrmClient as MC } from '../src/adapters/crm-client.ts'

const ORG_X = 'org_seq_exit_x'
const ORG_Y = 'org_seq_exit_y'
const SECRET_X = 'seq_exit_secret_org_x_min_24_chars_01'
const SECRET_Y = 'seq_exit_secret_org_y_min_24_chars_01'
const CRED_X = 'seq_exit_cred_org_x_admin_min_32_chars_0123456789'
const CRED_Y = 'seq_exit_cred_org_y_admin_min_32_chars_0123456789'
const SEQ_X = 'seq_exit_bienvenida_x'
const SEQ_Y = 'seq_exit_renovacion_y'
const TEL_DIGITOS = '573001234567'
const TEL_ADORNADO = '+57 300 123 4567'

interface Boot {
  server: ReturnType<typeof createAgenticServer>['server']
  db: ReturnType<typeof createAgenticServer>['db']
  restore: () => void
}

function boot(): Boot {
  const prevSecrets = process.env.WEBHOOK_SECRETS
  const prevKeys = process.env.INTERNAL_API_KEYS
  const prevMock = process.env.ALLOW_MOCK_TRANSPORT
  process.env.WEBHOOK_SECRETS = `${ORG_X}:${SECRET_X},${ORG_Y}:${SECRET_Y}`
  process.env.INTERNAL_API_KEYS = `${ORG_X}:${CRED_X}:admin,${ORG_Y}:${CRED_Y}:admin`
  process.env.ALLOW_MOCK_TRANSPORT = 'true'
  const { server, db } = createAgenticServer({
    dbPath: ':memory:',
    transport: new MT(),
    crm: new MC(),
  })
  return {
    server,
    db,
    restore: () => {
      if (prevSecrets === undefined) delete process.env.WEBHOOK_SECRETS; else process.env.WEBHOOK_SECRETS = prevSecrets
      if (prevKeys === undefined) delete process.env.INTERNAL_API_KEYS; else process.env.INTERNAL_API_KEYS = prevKeys
      if (prevMock === undefined) delete process.env.ALLOW_MOCK_TRANSPORT; else process.env.ALLOW_MOCK_TRANSPORT = prevMock
    },
  }
}

async function listen(server: Boot['server']): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as { port: number }
  return `http://127.0.0.1:${addr.port}`
}

function seed(db: Boot['db']): void {
  const now = Date.now()
  db.prepare('INSERT INTO sequences (id, organization_id, name, is_active, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(SEQ_X, ORG_X, 'Bienvenida X', 1, now - 1000)
  db.prepare('INSERT INTO sequences (id, organization_id, name, is_active, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(SEQ_Y, ORG_Y, 'Renovación Y', 1, now - 1000)
  // Inscripciones activas: una por organización, con el teléfono ya normalizado.
  db.prepare("INSERT INTO sequence_enrollments (id, organization_id, sequence_id, contact_phone, current_step, next_run_at, status) VALUES (?, ?, ?, ?, 1, ?, 'ACTIVE')")
    .run('enr_x_1', ORG_X, SEQ_X, TEL_DIGITOS, now + 60000)
  db.prepare("INSERT INTO sequence_enrollments (id, organization_id, sequence_id, contact_phone, current_step, next_run_at, status) VALUES (?, ?, ?, ?, 1, ?, 'ACTIVE')")
    .run('enr_y_1', ORG_Y, SEQ_Y, TEL_DIGITOS, now + 60000)
}

function estado(db: Boot['db'], org: string, seq: string): string | undefined {
  const row = db.prepare('SELECT status FROM sequence_enrollments WHERE organization_id = ? AND sequence_id = ?')
    .get(org, seq) as { status: string } | undefined
  return row?.status
}

async function postExit(base: string, seqId: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(`${base}/api/sequences/${seqId}/exit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = null
  try { data = JSON.parse(text) } catch { /* dejar null */ }
  return { status: res.status, data, text }
}

test('SEQXIT-01: un teléfono con adornos sí saca al contacto (cancelled 1)', async () => {
  const b = boot()
  seed(b.db)
  const base = await listen(b.server)
  try {
    const r = await postExit(base, SEQ_X, { phone: TEL_ADORNADO }, { Authorization: `Bearer ${CRED_X}`, 'X-Org-Id': ORG_X })
    assert.strictEqual(r.status, 200, `debe ser 200 (fue ${r.status}: ${r.text})`)
    assert.strictEqual(r.data.cancelled, 1, 'debe haber cancelado exactamente una inscripción')
    assert.strictEqual(r.data.phone, TEL_DIGITOS, 'la respuesta debe devolver el teléfono normalizado')
    assert.strictEqual(estado(b.db, ORG_X, SEQ_X), 'CANCELLED', 'la inscripción debe quedar CANCELLED')
  } finally {
    b.server.close(); b.restore()
  }
})

test('SEQXIT-02: repetir la salida no finge que canceló algo (cancelled 0)', async () => {
  const b = boot()
  seed(b.db)
  const base = await listen(b.server)
  const headers = { Authorization: `Bearer ${CRED_X}`, 'X-Org-Id': ORG_X }
  try {
    const primera = await postExit(base, SEQ_X, { phone: TEL_ADORNADO }, headers)
    assert.strictEqual(primera.status, 200)
    assert.strictEqual(primera.data.cancelled, 1)
    const segunda = await postExit(base, SEQ_X, { phone: TEL_ADORNADO }, headers)
    assert.strictEqual(segunda.status, 200, 'reintentar debe seguir siendo inofensivo')
    assert.strictEqual(segunda.data.cancelled, 0, 'la segunda vez no había nada que cancelar')
    assert.ok(typeof segunda.data.note === 'string' && segunda.data.note.length > 0, 'debe explicar por qué cancelled es 0')
  } finally {
    b.server.close(); b.restore()
  }
})

test('SEQXIT-03: un teléfono imposible → 400 y no toca ninguna fila', async () => {
  const b = boot()
  seed(b.db)
  const base = await listen(b.server)
  try {
    const r = await postExit(base, SEQ_X, { phone: '12' }, { Authorization: `Bearer ${CRED_X}`, 'X-Org-Id': ORG_X })
    assert.strictEqual(r.status, 400, `un teléfono de 2 dígitos debe ser 400 (fue ${r.status})`)
    assert.strictEqual(estado(b.db, ORG_X, SEQ_X), 'ACTIVE', 'la inscripción no debía cambiar')
  } finally {
    b.server.close(); b.restore()
  }
})

test('SEQXIT-04: sin X-Org-Id → 400', async () => {
  const b = boot()
  seed(b.db)
  const base = await listen(b.server)
  try {
    const r = await postExit(base, SEQ_X, { phone: TEL_DIGITOS }, { Authorization: `Bearer ${CRED_X}` })
    assert.strictEqual(r.status, 400, `sin X-Org-Id debe ser 400 (fue ${r.status})`)
    assert.strictEqual(estado(b.db, ORG_X, SEQ_X), 'ACTIVE', 'sin organización no se cancela nada')
  } finally {
    b.server.close(); b.restore()
  }
})

test('SEQXIT-05: otra organización no puede sacar a un contacto ajeno', async () => {
  const b = boot()
  seed(b.db)
  const base = await listen(b.server)
  try {
    const r = await postExit(base, SEQ_X, { phone: TEL_DIGITOS }, { Authorization: `Bearer ${CRED_Y}`, 'X-Org-Id': ORG_Y })
    assert.strictEqual(r.status, 200, `la petición es válida (fue ${r.status})`)
    assert.strictEqual(r.data.cancelled, 0, 'la organización Y no tiene esa secuencia')
    assert.strictEqual(estado(b.db, ORG_X, SEQ_X), 'ACTIVE', 'la inscripción de X debe seguir intacta')
    assert.strictEqual(estado(b.db, ORG_Y, SEQ_Y), 'ACTIVE', 'y la de Y tampoco se toca')
  } finally {
    b.server.close(); b.restore()
  }
})

/* ------------------------------------------------------------------ */
/* (ronda 20) Una sola forma de teléfono en toda la tabla de           */
/* inscripciones: el panel, el mensaje entrante y la lista de bajas     */
/* tienen que hablar del mismo contacto.                              */
/* ------------------------------------------------------------------ */

async function postPanel(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}/api/dashboard${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CRED_X}`, 'X-Org-Id': ORG_X },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = null
  try { data = JSON.parse(text) } catch { /* dejar null */ }
  return { status: res.status, data, text }
}

function filas(db: Boot['db'], org: string, seq: string): Array<{ contact_phone: string; status: string }> {
  return db.prepare('SELECT contact_phone, status FROM sequence_enrollments WHERE organization_id = ? AND sequence_id = ?')
    .all(org, seq) as Array<{ contact_phone: string; status: string }>
}

test('SEQXIT-06: inscribir desde el panel guarda la forma canónica, y sacarla funciona', async () => {
  const b = boot()
  seed(b.db)
  const base = await listen(b.server)
  try {
    const alta = await postPanel(base, `/sequences/${SEQ_X}/enroll`, { phone: '300 123 4567' })
    assert.strictEqual(alta.status, 200, `la inscripción debe aceptarse (fue ${alta.status}: ${alta.text})`)
    const guardado = b.db.prepare('SELECT contact_phone FROM sequence_enrollments WHERE organization_id = ? AND sequence_id = ? AND status = \'ACTIVE\'')
      .all(ORG_X, SEQ_X) as Array<{ contact_phone: string }>
    assert.ok(guardado.some((r) => r.contact_phone === TEL_DIGITOS),
      `el panel debe guardar «${TEL_DIGITOS}», no lo que se teclee (guardó: ${guardado.map((r) => r.contact_phone).join(', ')})`)

    // El mensaje entrante y la salida usan la forma canónica: tienen que encontrarla.
    const baja = await postExit(base, SEQ_X, { phone: TEL_DIGITOS }, { Authorization: `Bearer ${CRED_X}`, 'X-Org-Id': ORG_X })
    assert.strictEqual(baja.status, 200)
    assert.ok(baja.data.cancelled >= 1, 'la salida debe encontrar la inscripción que hizo el panel')
    assert.strictEqual(estado(b.db, ORG_X, SEQ_X), 'CANCELLED')
  } finally {
    b.server.close(); b.restore()
  }
})

test('SEQXIT-07: la misma persona escrita de dos formas no se inscribe dos veces', async () => {
  const b = boot()
  seed(b.db)
  const base = await listen(b.server)
  try {
    const una = await postPanel(base, `/sequences/${SEQ_X}/enroll`, { phone: '3001234567' })
    assert.strictEqual(una.status, 200)
    const otra = await postPanel(base, `/sequences/${SEQ_X}/enroll`, { phone: '+57 300 123 4567' })
    assert.strictEqual(otra.status, 200)
    const rows = filas(b.db, ORG_X, SEQ_X).filter((r) => r.status === 'ACTIVE')
    assert.strictEqual(rows.length, 1, `debe haber una sola inscripción activa (hay ${rows.length})`)
    assert.strictEqual(rows[0].contact_phone, TEL_DIGITOS, 'y debe estar en la forma canónica')
  } finally {
    b.server.close(); b.restore()
  }
})
