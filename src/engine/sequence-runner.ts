/**
 * (ronda 21) EJECUTOR DE PASOS DE SECUENCIA — `sequence-runner.ts`
 *
 * QUÉ PROBLEMA RESUELVE
 * Hasta la ronda 21 el sistema sabía inscribir a un contacto en una secuencia
 * (`sequence_enrollments`) y sabía cuál era la hora del siguiente paso
 * (`next_run_at`), pero NADIE leía esa hora: la inscripción se quedaba ACTIVE
 * para siempre y el contacto nunca recibía el paso 2, el 3 ni ninguno. Este
 * archivo es la pieza que falta: mira qué toca, lo envía por el transporte y
 * mueve el puntero.
 *
 * REGLAS (todas nacen de algo que ya dolió en este proyecto)
 *  1. Se envía sólo lo que YA toca (dueSequenceWork filtra por `next_run_at`).
 *  2. Sólo secuencias activas y de la misma organización (lo filtra el motor).
 *  3. Si el contacto está en la lista de bajas NO se le envía nada y su
 *     inscripción se CIERRA (CANCELLED): dejarla ACTIVE significaría reintentar
 *     para siempre un mensaje que la persona pidió no recibir.
 *  4. El puntero sólo avanza cuando el transporte dice que ACEPTÓ el mensaje
 *     (`ok === true` / outcome 'SENT'). Un rechazo fiable ('REJECTED') no avanza
 *     y se reintenta en la siguiente pasada.
 *  5. Un resultado incierto ('UNCERTAIN', un throw a mitad) TAMPOCO avanza: el
 *     mensaje pudo salir y no se puede afirmar ni lo uno ni lo otro. Se cuenta
 *     aparte para que alguien lo mire. La clave de idempotencia
 *     `seq:<inscripción>:<paso>` hace que reintentar no duplique si el daemon la
 *     respeta.
 *  6. Un fallo en una inscripción no detiene a las demás.
 *  7. Cada paso enviado queda en la bandeja (`inbox_messages`), que es lo que ve
 *     el asesor: nada se envía sin dejar rastro.
 *
 * NO arranca ningún temporizador ni servidor: es una pasada acotada. Quien la
 * llame decide cuándo (un cron, un botón, una prueba).
 */
import { canonicalPhone } from './flow-engine.ts'
import type { FlowEngine, DueSequenceWork } from './flow-engine.ts'
import type { TransportSender } from '../types.ts'
import type { SuppressionStore } from '../suppression/suppression-store.ts'

export type SequenceStepState = 'sent' | 'completed' | 'failed' | 'uncertain' | 'skipped_suppressed'

export interface SequenceStepResult {
  enrollmentId: string
  organizationId: string
  sequenceId: string
  /** El teléfono tal como se usó (forma canónica). */
  phone: string
  stepOrder: number
  state: SequenceStepState
  /** Hora del siguiente paso (null si la inscripción quedó cerrada). */
  nextRunAt?: number | null
  error?: string
}

export interface SequenceRunSummary {
  inspected: number
  /** Mensajes aceptados por el transporte. */
  sent: number
  /** Inscripciones que quedaron cerradas porque ya no tenían más pasos. */
  completed: number
  /** Rechazos fiables: no salió nada y se puede reintentar. */
  failed: number
  /** Resultado incierto: el mensaje pudo salir. Requiere mirada humana. */
  uncertain: number
  /** Contactos en la lista de bajas: no se les envió y se cerró su inscripción. */
  skippedSuppressed: number
  results: SequenceStepResult[]
}

export interface RunDueSequenceStepsOptions {
  engine: FlowEngine
  transport: TransportSender
  /** Si se pasa, se respeta la lista de bajas por organización. */
  suppression?: SuppressionStore
  /** Momento de la pasada (por defecto, ahora). Se inyecta en las pruebas. */
  now?: number
  /** Tope de inscripciones por pasada (1-500, defecto 50). */
  limit?: number
  /** Por dónde contar lo que pasa (por defecto, silencio). */
  log?: (line: string) => void
}

/**
 * Da una pasada: envía los pasos de secuencia que ya toca enviar.
 * Devuelve un resumen contable; no lanza por un fallo de transporte de un
 * contacto (eso queda en `results`), sólo por un error de programación.
 */
export async function runDueSequenceSteps(opts: RunDueSequenceStepsOptions): Promise<SequenceRunSummary> {
  const { engine, transport, suppression } = opts
  const now = Number.isFinite(opts.now as number) ? (opts.now as number) : Date.now()
  const limit = opts.limit ?? 50
  const log = opts.log ?? (() => {})

  const summary: SequenceRunSummary = {
    inspected: 0,
    sent: 0,
    completed: 0,
    failed: 0,
    uncertain: 0,
    skippedSuppressed: 0,
    results: [],
  }

  const work: DueSequenceWork[] = engine.dueSequenceWork(now, limit)

  for (const item of work) {
    summary.inspected++
    const phone = canonicalPhone(item.phone)
    const base = {
      enrollmentId: item.enrollmentId,
      organizationId: item.organizationId,
      sequenceId: item.sequenceId,
      phone,
      stepOrder: item.stepOrder,
    }

    // (3) Baja formal: ni un mensaje más, y fuera de la secuencia.
    if (suppression && suppression.isSuppressed(item.organizationId, phone)) {
      engine.closeSequenceEnrollment(item.organizationId, item.enrollmentId, 'CANCELLED')
      summary.skippedSuppressed++
      summary.results.push({ ...base, state: 'skipped_suppressed', nextRunAt: null })
      log(`[secuencias] ${phone}: está en la lista de bajas; no se envía el paso ${item.stepOrder}`)
      continue
    }

    // La misma clave para la correlación y para la idempotencia: si esta pasada
    // se repite, el daemon puede reconocer el mensaje en vez de duplicarlo.
    const clave = `seq:${item.enrollmentId}:${item.stepOrder}`
    let outcome: { ok?: boolean; error?: string; outcome?: string }
    try {
      outcome = await transport.sendMessage(phone, item.messageText, clave, clave, item.organizationId)
    } catch (e) {
      // (5) Un throw a mitad de envío no prueba que no salió.
      const error = (e as Error)?.message || 'error de transporte'
      summary.uncertain++
      summary.results.push({ ...base, state: 'uncertain', error })
      log(`[secuencias] ${phone} paso ${item.stepOrder}: resultado incierto (${error}); no se avanza`)
      continue
    }

    if (outcome?.ok === true) {
      // (7) Primero el rastro, después mover el puntero.
      engine.recordSequenceOutboundMessage(item.organizationId, phone, item.messageText)
      const next = engine.advanceSequenceEnrollment(item.organizationId, item.enrollmentId, now)
      summary.sent++
      if (next.status !== 'ACTIVE') summary.completed++
      summary.results.push({
        ...base,
        state: next.status === 'ACTIVE' ? 'sent' : 'completed',
        nextRunAt: next.nextRunAt,
      })
      log(`[secuencias] ${phone} paso ${item.stepOrder} enviado${next.status === 'ACTIVE' ? `; siguiente: ${next.nextStepOrder}` : '; secuencia terminada'}`)
      continue
    }

    if (outcome?.outcome === 'REJECTED') {
      // (4) Rechazo fiable: no salió nada. Se reintenta en la próxima pasada.
      const error = outcome.error || 'rechazado por el transporte'
      summary.failed++
      summary.results.push({ ...base, state: 'failed', error })
      log(`[secuencias] ${phone} paso ${item.stepOrder}: rechazado (${error})`)
      continue
    }

    // (5) UNCERTAIN o una respuesta que no sabemos leer: no se avanza.
    const error = outcome?.error || `resultado sin clasificar (${outcome?.outcome ?? 'sin outcome'})`
    summary.uncertain++
    summary.results.push({ ...base, state: 'uncertain', error })
    log(`[secuencias] ${phone} paso ${item.stepOrder}: resultado incierto (${error}); no se avanza`)
  }

  return summary
}
