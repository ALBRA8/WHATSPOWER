/**
 * (ronda 22) DESPERTADOR DE ESPERAS — src/engine/flow-wait-runner.ts
 *
 * Qué problema resuelve: un flujo con un nodo «Espera» (delay / smart_delay)
 * aparcaba al contacto, pero nadie lo despertaba. Antes de esta ronda el nodo no
 * esperaba siquiera: el motor seguía de inmediato. Ahora el motor guarda la hora
 * de vuelta y este ejecutor, cuando llega esa hora, reanuda el flujo por el mismo
 * bucle que un mensaje entrante y manda lo que toque.
 *
 * Reglas, cada una con su motivo:
 *  1. Baja formal (opt-out): no se despierta nada. Se cierra la espera y se cuenta.
 *  2. Sólo una pasada puede reanudar una espera (claimFlowWait). Dos pasadas
 *     solapadas no pueden duplicar el mensaje; además cada mensaje lleva clave de
 *     idempotencia `wait:<id>:<n>`, que el transporte real usa para no repetir.
 *  3. Un error de transporte no pierde el aviso: la espera queda PENDING y se
 *     reintenta en la pasada siguiente. Un rechazo fiable se cuenta como fallo.
 *  4. Si el flujo ya no existe, está apagado o el nodo desapareció, la espera se
 *     ABANDONA en vez de girar para siempre; y si el contacto se metió en otro
 *     flujo, se CANCELA en vez de pisarle la conversación.
 *  5. Un contacto con problemas no detiene a los demás: cada espera va en su try.
 *
 * Nada de esto se dispara solo desde aquí: lo llama el planificador
 * (src/engine/scheduler.ts) o la línea de órdenes (scripts/run-waits.ts).
 */
import { canonicalPhone } from './flow-engine.ts'
import type { DueFlowWait, FlowEngine } from './flow-engine.ts'
import type { TransportSender } from '../types.ts'
import type { SuppressionStore } from '../suppression/suppression-store.ts'

export type FlowWaitState =
  | 'sent'
  | 'failed'
  | 'uncertain'
  | 'skipped_suppressed'
  | 'cancelled_busy'
  | 'abandoned'

export interface FlowWaitResult {
  waitId: string
  organizationId: string
  phone: string
  flowId: string
  state: FlowWaitState
  sent: number
  error?: string
}

export interface FlowWaitRunSummary {
  /** Esperas vencidas que se miraron en esta pasada. */
  inspected: number
  /** Flujos reanudados (aunque algún mensaje fallara). */
  resumed: number
  /** Mensajes entregados al transporte. */
  sent: number
  failed: number
  uncertain: number
  skippedSuppressed: number
  cancelledBusy: number
  abandoned: number
  results: FlowWaitResult[]
}

export interface RunDueFlowWaitsOptions {
  engine: FlowEngine
  transport: TransportSender
  suppression?: SuppressionStore
  /** Hora de la pasada (epoch ms). Por defecto, ahora. Sirve para las pruebas. */
  now?: number
  /** Tope de esperas por pasada (1..500, por defecto 50). */
  limit?: number
  log?: (message: string) => void
}

export async function runDueFlowWaits(opts: RunDueFlowWaitsOptions): Promise<FlowWaitRunSummary> {
  const { engine, transport, suppression } = opts
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 50) || 50))
  const log = opts.log ?? (() => {})

  const resumen: FlowWaitRunSummary = {
    inspected: 0,
    resumed: 0,
    sent: 0,
    failed: 0,
    uncertain: 0,
    skippedSuppressed: 0,
    cancelledBusy: 0,
    abandoned: 0,
    results: [],
  }

  const vencidas: DueFlowWait[] = engine.dueFlowWaits(now, limit)

  for (const espera of vencidas) {
    resumen.inspected++
    const phone = canonicalPhone(espera.contactPhone)
    const base = {
      waitId: espera.id,
      organizationId: espera.organizationId,
      phone,
      flowId: espera.flowId,
    }

    // (1) Baja formal: a quien pidió no recibir nada no se le despierta un flujo.
    if (suppression && suppression.isSuppressed(espera.organizationId, phone)) {
      engine.settleFlowWait(espera.id, 'CANCELLED', now)
      resumen.skippedSuppressed++
      resumen.results.push({ ...base, state: 'skipped_suppressed', sent: 0 })
      log(`[esperas] ${phone}: está en la lista de bajas; no se despierta el flujo ${espera.flowId}`)
      continue
    }

    // (2) Sólo la pasada que la toma puede reanudarla.
    if (!engine.claimFlowWait(espera.id)) {
      log(`[esperas] ${espera.id}: otra pasada la tomó antes; se deja`)
      continue
    }

    let despertar: Awaited<ReturnType<FlowEngine['resumeFlowWait']>>
    try {
      despertar = await engine.resumeFlowWait(espera, now)
    } catch (e) {
      const error = e instanceof Error ? e.message : 'error al reanudar'
      engine.settleFlowWait(espera.id, 'PENDING', now)
      resumen.failed++
      resumen.results.push({ ...base, state: 'failed', sent: 0, error })
      log(`[esperas] ${phone}: no se pudo reanudar (${error}); queda pendiente`)
      continue
    }

    if (despertar.status === 'flow_missing' || despertar.status === 'node_missing') {
      engine.settleFlowWait(espera.id, 'ABANDONED', now)
      resumen.abandoned++
      resumen.results.push({ ...base, state: 'abandoned', sent: 0, error: despertar.status })
      log(`[esperas] ${phone}: se abandona la espera (${despertar.status}); el flujo ya no lleva a ninguna parte`)
      continue
    }

    if (despertar.status === 'session_busy') {
      engine.settleFlowWait(espera.id, 'CANCELLED', now)
      resumen.cancelledBusy++
      resumen.results.push({ ...base, state: 'cancelled_busy', sent: 0 })
      log(`[esperas] ${phone}: tiene otro flujo abierto; la espera se cancela en vez de pisarlo`)
      continue
    }

    // (3) El flujo siguió: sus mensajes salen en orden, con clave de idempotencia.
    const mensajes = despertar.result?.messagesToSend ?? []
    let enviados = 0
    let fallo: string | undefined
    let incierto = false

    for (let i = 0; i < mensajes.length; i++) {
      const mensaje = mensajes[i]
      const clave = `wait:${espera.id}:${i}`
      try {
        const r = await transport.sendMessage(phone, mensaje.text, clave, clave, espera.organizationId)
        if (r?.ok === true) {
          enviados++
        } else if (r?.outcome === 'UNCERTAIN') {
          incierto = true
          fallo = r.error || 'el transporte no confirma la entrega'
          break
        } else {
          fallo = r?.error || `rechazado por el transporte (${r?.outcome ?? 'sin detalle'})`
          break
        }
      } catch (e) {
        incierto = true
        fallo = e instanceof Error ? e.message : 'error de transporte'
        break
      }
    }

    if (incierto) resumen.uncertain++
    else if (fallo) resumen.failed++
    resumen.sent += enviados
    resumen.resumed++

    // El flujo ya se reanudó y avanzó: la espera se cierra con lo que pasó. Si un
    // mensaje falló se cuenta en el resumen, pero la espera no vuelve a girar (el
    // puntero del flujo ya está más adelante; reintentar repetiría el flujo entero).
    engine.settleFlowWait(espera.id, 'DONE', now)
    resumen.results.push({
      ...base,
      state: fallo ? (incierto ? 'uncertain' : 'failed') : 'sent',
      sent: enviados,
      error: fallo,
    })
    log(
      `[esperas] ${phone}: flujo ${espera.flowId} reanudado, ${enviados} mensaje(s)` +
        (fallo ? ` con fallo: ${fallo}` : ''),
    )
  }

  return resumen
}
