/**
 * (ronda 22) UNA PASADA DEL DESPERTADOR DE ESPERAS, desde la línea de órdenes.
 *
 * QUÉ HACE
 * Abre la base de datos operativa, mira qué esperas de flujo («Espera» /
 * «Smart Delay») ya vencieron y reanuda esos flujos con el mismo transporte que
 * usa el servidor. Es la misma pasada que hace el planificador de dentro del
 * servidor (src/engine/scheduler.ts); sirve para probarla a mano, para forzarla
 * en un momento concreto y para ponerla en un cron si algún día se prefiere así.
 *
 * SEGURIDAD (nada de atajos)
 *  - El transporte se elige igual que en el servidor: TRANSPORT=mock (defecto) o
 *    TRANSPORT=http. La salvaguarda ALLOW_REAL_DISPATCH sigue dentro del
 *    transporte real, así que con el valor por defecto el envío real se rechaza
 *    (fail-closed) y no sale ningún mensaje.
 *  - Un modo desconocido no se adivina: se para.
 *  - `WAITS_DRY_RUN=true` sólo lista lo que tocaría y no reanuda nada.
 *  - `WAITS_LIMIT` acota cuántas esperas se miran por pasada (máx. 500).
 *
 * USO
 *   npm run waits:run                        (modo mock, no envía nada real)
 *   WAITS_DRY_RUN=true npm run waits:run
 *   TRANSPORT=http ALLOW_REAL_DISPATCH=true ... (sólo con permiso y entorno real)
 *   DB_PATH=... o `npm run waits:run -- ruta.db` para apuntar a otra base.
 */
import { createDatabase } from '../src/db.ts'
import { FlowEngine } from '../src/engine/flow-engine.ts'
import { runDueFlowWaits } from '../src/engine/flow-wait-runner.ts'
import { SuppressionStore } from '../src/suppression/suppression-store.ts'
import { HttpAlbraTransportSender, MockTransportSender } from '../src/adapters/transport.ts'
import type { TransportSender } from '../src/types.ts'

const modo = process.env.TRANSPORT || 'mock'
const limite = Number(process.env.WAITS_LIMIT || 50)
const dryRun = process.env.WAITS_DRY_RUN === 'true'
const dbPath = process.env.DB_PATH || process.argv[2] || undefined

function elegirTransporte(): TransportSender {
  if (modo === 'mock') {
    console.log('[esperas] transporte MOCK: los mensajes se simulan, no salen a WhatsApp.')
    return new MockTransportSender()
  }
  if (modo === 'http') {
    const secreto = process.env.INTERNAL_API_SECRET
    if (!secreto) throw new Error('TRANSPORT=http exige INTERNAL_API_SECRET (falla segura: no se envía nada sin él)')
    if (process.env.ALLOW_REAL_DISPATCH !== 'true') {
      console.warn('[esperas] AVISO: ALLOW_REAL_DISPATCH no está en true; el transporte rechazará cada envío (fail-closed).')
    }
    return new HttpAlbraTransportSender(process.env.WHATSAPP_DAEMON_URL || 'http://localhost:3002', secreto)
  }
  throw new Error(
    `TRANSPORT="${modo}" no se admite aquí (usa mock o http; meta-cloud pide credenciales por organización y se ejecuta desde el servidor)`,
  )
}

async function main() {
  const transport = dryRun ? null : elegirTransporte()
  const db = createDatabase(dbPath)
  const engine = new FlowEngine(db)
  const suppression = new SuppressionStore(db)
  const ahora = Date.now()

  if (dryRun) {
    const vencidas = engine.dueFlowWaits(ahora, limite)
    console.log(`[esperas] SIMULACIÓN: ${vencidas.length} espera(s) vencida(s); no se ha reanudado nada.`)
    for (const v of vencidas) {
      console.log(
        `  ${v.organizationId} · ${v.contactPhone} · flujo ${v.flowId} · nodo ${v.waitNodeId} · vencía ${new Date(v.dueAt).toISOString()} · intentos ${v.attempts}`,
      )
    }
    return
  }

  const resumen = await runDueFlowWaits({
    engine,
    transport: transport as TransportSender,
    suppression,
    now: ahora,
    limit: limite,
    log: (linea) => console.log(linea),
  })

  console.log(
    `[esperas] miradas ${resumen.inspected} · reanudados ${resumen.resumed} · enviados ${resumen.sent} · ` +
      `rechazados ${resumen.failed} · inciertos ${resumen.uncertain} · bajas ${resumen.skippedSuppressed} · ` +
      `abandonadas ${resumen.abandoned} · canceladas por otro flujo ${resumen.cancelledBusy}`,
  )
  // Si algo quedó incierto, se dice en voz alta: no se puede afirmar que no salió.
  if (resumen.uncertain > 0) {
    console.warn(`[esperas] AVISO: ${resumen.uncertain} envío(s) con resultado incierto; revísalos a mano.`)
  }
}

main().catch((e) => {
  console.error('[esperas] error: ' + ((e as Error)?.message || e))
  process.exitCode = 1
})
