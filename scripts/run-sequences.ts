/**
 * (ronda 21) UNA PASADA DEL EJECUTOR DE SECUENCIAS, desde la línea de órdenes.
 *
 * QUÉ HACE
 * Abre la base de datos operativa, mira qué pasos de secuencia ya toca enviar y
 * los envía con el mismo transporte que usa el servidor. Es la pieza que se
 * puede poner en un cron (por ejemplo, cada minuto) hasta que exista un
 * planificador dentro del servidor.
 *
 * SEGURIDAD (nada de atajos)
 *  - El transporte se elige igual que en el servidor: TRANSPORT=mock (defecto) o
 *    TRANSPORT=http. La salvaguarda ALLOW_REAL_DISPATCH sigue donde siempre:
 *    dentro del transporte real, así que con el valor por defecto el envío real
 *    se rechaza (fail-closed) y no sale ningún mensaje.
 *  - Un modo desconocido no se adivina: se para.
 *  - `SEQUENCES_DRY_RUN=true` sólo lista lo que tocaría y no envía nada.
 *  - `SEQUENCES_LIMIT` acota cuántas inscripciones se miran por pasada (máx. 500).
 *
 * USO
 *   npm run sequences:run                       (modo mock, no envía nada real)
 *   SEQUENCES_DRY_RUN=true npm run sequences:run
 *   TRANSPORT=http ALLOW_REAL_DISPATCH=true ... (sólo con permiso y entorno real)
 *   DB_PATH=... para apuntar a otra base de datos.
 */
import { createDatabase } from '../src/db.ts'
import { FlowEngine } from '../src/engine/flow-engine.ts'
import { runDueSequenceSteps } from '../src/engine/sequence-runner.ts'
import { SuppressionStore } from '../src/suppression/suppression-store.ts'
import { HttpAlbraTransportSender, MockTransportSender } from '../src/adapters/transport.ts'
import type { TransportSender } from '../src/types.ts'

const modo = process.env.TRANSPORT || 'mock'
const limite = Number(process.env.SEQUENCES_LIMIT || 50)
const dryRun = process.env.SEQUENCES_DRY_RUN === 'true'
const dbPath = process.env.DB_PATH || process.argv[2] || undefined

function elegirTransporte(): TransportSender {
  if (modo === 'mock') {
    console.log('[secuencias] transporte MOCK: los mensajes se simulan, no salen a WhatsApp.')
    return new MockTransportSender()
  }
  if (modo === 'http') {
    const secreto = process.env.INTERNAL_API_SECRET
    if (!secreto) throw new Error('TRANSPORT=http exige INTERNAL_API_SECRET (falla segura: no se envía nada sin él)')
    if (process.env.ALLOW_REAL_DISPATCH !== 'true') {
      console.warn('[secuencias] AVISO: ALLOW_REAL_DISPATCH no está en true; el transporte rechazará cada envío (fail-closed).')
    }
    return new HttpAlbraTransportSender(process.env.WHATSAPP_DAEMON_URL || 'http://localhost:3002', secreto)
  }
  throw new Error(`TRANSPORT="${modo}" no se admite aquí (usa mock o http; meta-cloud pide credenciales por organización y se ejecuta desde el servidor)`)
}

async function main() {
  const transport = dryRun ? null : elegirTransporte()
  const db = createDatabase(dbPath)
  const engine = new FlowEngine(db)
  const suppression = new SuppressionStore(db)
  const ahora = Date.now()

  if (dryRun) {
    const pendientes = engine.dueSequenceWork(ahora, limite)
    console.log(`[secuencias] SIMULACIÓN: ${pendientes.length} paso(s) por enviar; no se ha enviado nada.`)
    for (const p of pendientes) console.log(`  ${p.organizationId} · ${p.phone} · ${p.sequenceId} · paso ${p.stepOrder} · "${p.messageText.slice(0, 60)}"`)
    return
  }

  const resumen = await runDueSequenceSteps({
    engine,
    transport: transport as TransportSender,
    suppression,
    now: ahora,
    limit: limite,
    log: (linea) => console.log(linea),
  })

  console.log(
    `[secuencias] mirados ${resumen.inspected} · enviados ${resumen.sent} · terminados ${resumen.completed} · ` +
      `rechazados ${resumen.failed} · inciertos ${resumen.uncertain} · bajas ${resumen.skippedSuppressed}`,
  )
  // Si algo quedó incierto, se dice en voz alta: no se puede afirmar que no salió.
  if (resumen.uncertain > 0) console.warn(`[secuencias] AVISO: ${resumen.uncertain} envío(s) con resultado incierto; revísalos a mano.`)
}

main().catch((e) => {
  console.error('[secuencias] error: ' + ((e as Error)?.message || e))
  process.exitCode = 1
})
