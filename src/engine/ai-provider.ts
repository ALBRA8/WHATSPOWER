/**
 * ai-provider.ts — PROVEEDOR DE IA del motor de flujos (nodo ai_response)
 * (hallazgo 3, auditoría funcional 2026-11-12).
 *
 * El nodo AI_RESPONSE declaraba aiPrompt/aiModel pero devolvía un texto fijo
 * sin ejecutar IA. Este módulo integra el nodo con un proveedor REAL de
 * completions compatible con la API de OpenAI (estándar de facto soportado
 * por múltiples proveedores), reutilizando el patrón del proyecto:
 *
 *  - CONFIGURACIÓN POR ENTORNO (sin secretos en código):
 *      AI_API_KEY   → clave del proveedor (obligatoria para activar IA real)
 *      AI_API_URL   → endpoint chat/completions (default OpenAI)
 *      AI_MODEL     → modelo por defecto (el nodo puede sobreescribir con
 *                     aiModel; nunca se registra la clave en logs)
 *      AI_TIMEOUT_MS→ timeout de la llamada (default 20000)
 *
 *  - FAIL-CLOSED HONESTO: sin AI_API_KEY configurada NO hay simulación de IA.
 *    El llamador recibe { ok:false, fallback:true, error } y el motor continúa
 *    con un aviso EXPLÍCITO de indisponibilidad (jamás un texto que aparente
 *    ser generado por IA).
 *
 *  - ERRORES/TIEMPOS/RESPUESTAS VACÍAS se clasifican y devuelven; nunca se
 *    lanza desde aquí para no romper el flujo conversacional.
 */

export interface AiCompletionResult {
  ok: boolean
  text?: string
  error?: string
  /** true cuando NO hubo llamada real (sin configuración) o el resultado no es usable. */
  fallback?: boolean
}

export interface AiCompletionOptions {
  model?: string
}

export interface AiCompletionProvider {
  complete(prompt: string, context: Record<string, string>, options?: AiCompletionOptions): Promise<AiCompletionResult>
}

export const DEFAULT_AI_API_URL = 'https://api.openai.com/v1/chat/completions'
export const DEFAULT_AI_MODEL = 'gpt-4o-mini'
export const DEFAULT_AI_TIMEOUT_MS = 20_000

/** Proveedor REAL compatible con OpenAI chat/completions (fetch nativo). */
export class OpenAiCompatibleProvider implements AiCompletionProvider {
  private apiKey: string
  private apiUrl: string
  private defaultModel: string
  private timeoutMs: number
  /** Inyectable para pruebas (sin red real). */
  private fetchImpl: typeof fetch

  constructor(opts: {
    apiKey: string
    apiUrl?: string
    defaultModel?: string
    timeoutMs?: number
    fetchImpl?: typeof fetch
  }) {
    this.apiKey = opts.apiKey
    this.apiUrl = opts.apiUrl || process.env.AI_API_URL || DEFAULT_AI_API_URL
    this.defaultModel = opts.defaultModel || process.env.AI_MODEL || DEFAULT_AI_MODEL
    this.timeoutMs = opts.timeoutMs ?? (Number(process.env.AI_TIMEOUT_MS) || DEFAULT_AI_TIMEOUT_MS)
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async complete(prompt: string, context: Record<string, string>, options?: AiCompletionOptions): Promise<AiCompletionResult> {
    const model = options?.model || this.defaultModel
    const contextLines = Object.entries(context)
      .slice(0, 25) // límite de contexto enviado (no exponer campos ilimitados)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
    try {
      const res = await this.fetchImpl(this.apiUrl, {
        method: 'POST',
        headers: {
          // La clave SOLO viaja en el header de autorización; jamás se registra.
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'Eres un asistente comercial por WhatsApp. Responde breve, claro y en el idioma del cliente.' },
            { role: 'user', content: `${prompt}\n\nContexto del contacto:\n${contextLines}` },
          ],
          max_tokens: 300,
          temperature: 0.4,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) {
        return { ok: false, fallback: true, error: `proveedor IA respondió HTTP ${res.status}` }
      }
      let parsed: { choices?: Array<{ message?: { content?: string } }> }
      try {
        parsed = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      } catch {
        return { ok: false, fallback: true, error: 'respuesta del proveedor IA ilegible (no-JSON)' }
      }
      const text = parsed.choices?.[0]?.message?.content
      if (!text || !text.trim()) {
        return { ok: false, fallback: true, error: 'el proveedor IA devolvió una respuesta vacía' }
      }
      return { ok: true, text }
    } catch (err) {
      // timeout / conexión cortada / error de red: resultado clasificado, sin lanzar.
      return { ok: false, fallback: true, error: `fallo de conexión con el proveedor IA: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

/**
 * Proveedor SIN CONFIGURACIÓN (fail-closed honesto): nunca simula IA.
 */
export class UnconfiguredAiProvider implements AiCompletionProvider {
  async complete(_prompt: string, _context: Record<string, string>, _options?: AiCompletionOptions): Promise<AiCompletionResult> {
    return { ok: false, fallback: true, error: 'IA no configurada: define AI_API_KEY (proveedor compatible OpenAI) para activar el nodo AI_RESPONSE' }
  }
}

/**
 * (reparación 2026-11-17, FASE 1.E) La IA está DESACTIVADA POR DEFECTO.
 *
 * Regla de activación (todas deben cumplirse):
 *  1. AI_ENABLED no está explícitamente en 'false' (el switch maestro puede
 *     apagar la IA aunque exista credencial).
 *  2. Existe credencial (AI_API_KEY no vacía).
 *
 * Sin ambas, el nodo AI_RESPONSE usa UnconfiguredAiProvider: CERO llamadas
 * HTTP a terceros (el texto de las conversaciones de clientes jamás sale del
 * servidor por descuido). Al activarla, el texto conversacional se transmite
 * al proveedor externo configurado en AI_API_URL (ver .env.example y README).
 */
export function isAiEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (String(env.AI_ENABLED ?? '').trim().toLowerCase() === 'false') return false
  const apiKey = env.AI_API_KEY
  return Boolean(apiKey && typeof apiKey === 'string' && apiKey.trim() !== '')
}

/** Resuelve el proveedor por configuración de entorno (inyección para pruebas aparte). */
export function resolveAiProvider(env: Record<string, string | undefined> = process.env): AiCompletionProvider {
  if (!isAiEnabled(env)) {
    return new UnconfiguredAiProvider()
  }
  return new OpenAiCompatibleProvider({ apiKey: String(env.AI_API_KEY) })
}
