/**
 * (ronda 22) PLANIFICADOR — src/engine/scheduler.ts
 *
 * Hasta la ronda 21 había dos relojes escritos en la base y nadie que los mirase:
 * `sequence_enrollments.next_run_at` (los pasos de secuencia) y, desde esta ronda,
 * `flow_waits.due_at` (los nodos «Espera» de los flujos). Este módulo es el reloj
 * que faltaba: cada cierto tiempo mira qué está vencido y lo ejecuta.
 *
 * Se arranca con el servidor (src/server.ts) y se puede apagar:
 *   SCHEDULER_ENABLED=false  → no se arranca, y lo avisa por consola.
 *   SCHEDULER_INTERVAL_MS=15000 → cada cuánto mira (mínimo 1000 ms, defecto 30 s).
 *
 * Dos precauciones que importan:
 *  - `busy`: si una pasada tarda más que el intervalo, la siguiente se salta en
 *    vez de solaparse (dos pasadas a la vez sobre la misma espera la reclamarían).
 *  - `unref()`: el temporizador no mantiene vivo el proceso; si el servidor se
 *    cierra, se cierra todo. Un planificador que impide apagar el servidor es peor
 *    que no tenerlo.
 */
import type { FlowEngine } from './flow-engine.ts'
import type { TransportSender } from '../types.ts'
import type { SuppressionStore } from '../suppression/suppression-store.ts'
import { runDueFlowWaits, type FlowWaitRunSummary } from './flow-wait-runner.ts'
import { runDueSequenceSteps, type SequenceRunSummary } from './sequence-runner.ts'

export interface SchedulerTick {
  /** Hora de la pasada (epoch ms). */
  at: number
  waits: FlowWaitRunSummary | null
  sequences: SequenceRunSummary | null
  /** true cuando la pasada anterior seguía en marcha y esta se saltó. */
  skippedBecauseBusy: boolean
  error?: string
}

export interface SchedulerHandle {
  intervalMs: number
  /** Una pasada a mano (lo que hace el temporizador, pero ahora mismo). */
  tick: () => Promise<SchedulerTick>
  stop: () => void
  isRunning: () => boolean
}

export interface StartSchedulerOptions {
  engine: FlowEngine
  transport: TransportSender
  suppression?: SuppressionStore
  /** Cada cuánto mira (por defecto SCHEDULER_INTERVAL_MS o 30 000 ms; mínimo 1000). */
  intervalMs?: number
  /** Tope de elementos por pasada y por cola (1..500, por defecto 50). */
  limit?: number
  log?: (message: string) => void
}

export function startScheduler(opts: StartSchedulerOptions): SchedulerHandle {
  const log = opts.log ?? ((m: string) => console.log(m))
  const pedido = Math.trunc(opts.intervalMs ?? Number(process.env.SCHEDULER_INTERVAL_MS || 30000))
  const intervalMs = Number.isFinite(pedido) && pedido >= 1000 ? pedido : 30000
  const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 50) || 50))

  let busy = false
  let stopped = false

  async function tick(): Promise<SchedulerTick> {
    const at = Date.now()
    if (busy) {
      return { at, waits: null, sequences: null, skippedBecauseBusy: true }
    }
    busy = true
    try {
      const waits = await runDueFlowWaits({
        engine: opts.engine,
        transport: opts.transport,
        suppression: opts.suppression,
        now: at,
        limit,
        log,
      })
      const sequences = await runDueSequenceSteps({
        engine: opts.engine,
        transport: opts.transport,
        suppression: opts.suppression,
        now: at,
        limit,
        log,
      })
      return { at, waits, sequences, skippedBecauseBusy: false }
    } catch (e) {
      // Una pasada rota no mata el servidor: se dice y se sigue a la siguiente.
      const error = e instanceof Error ? e.message : 'error en la pasada'
      log(`[planificador] pasada fallida: ${error}`)
      return { at, waits: null, sequences: null, skippedBecauseBusy: false, error }
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, intervalMs)
  // No mantener vivo el proceso solo por este temporizador.
  if (typeof timer.unref === 'function') timer.unref()

  return {
    intervalMs,
    tick,
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      log('[planificador] detenido')
    },
    isRunning() {
      return !stopped
    },
  }
}
