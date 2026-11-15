/**
 * mock-meta-server.ts — Servidor HTTP local simulado de Meta Graph API.
 * Para pruebas de sala limpia sin llamadas de red a Meta.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'

export interface MockMetaErrorOptions {
  status: number
  code: number
  error_subcode?: number
  message: string
  type?: string
}

export function createMockMetaServer() {
  let server: Server | null = null
  let nextError: MockMetaErrorOptions | null = null
  const receivedRequests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any }> = []

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    const rawBody = Buffer.concat(chunks).toString('utf-8')
    let body: any = {}
    try {
      body = JSON.parse(rawBody)
    } catch {}

    receivedRequests.push({
      method: req.method || 'GET',
      url: req.url || '/',
      headers: req.headers,
      body,
    })

    // Si hay un error simulado configurado
    if (nextError) {
      const err = nextError
      nextError = null
      res.writeHead(err.status, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: err.message,
            type: err.type ?? 'OAuthException',
            code: err.code,
            error_subcode: err.error_subcode ?? err.code,
            fbtrace_id: 'mock_trace_' + Date.now(),
          },
        })
      )
      return
    }

    // Ruta de envío de mensajes Graph API: POST /:version/:phoneNumberId/messages
    if (req.method === 'POST' && req.url?.includes('/messages')) {
      // Validar presencia de Bearer
      const auth = req.headers['authorization']
      if (!auth || !auth.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token', code: 190 } }))
        return
      }

      const messageId = `wamid.HBgL${Date.now()}${Math.random().toString(36).substring(2, 7)}`
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          messaging_product: 'whatsapp',
          contacts: [{ input: body.to, wa_id: body.to }],
          messages: [{ id: messageId }],
        })
      )
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found in mock Meta server' }))
  }

  return {
    start(): Promise<number> {
      return new Promise((resolve) => {
        server = createServer(handler)
        server.listen(0, '127.0.0.1', () => {
          const addr = server!.address()
          const port = typeof addr === 'object' && addr ? addr.port : 0
          resolve(port)
        })
      })
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (server) {
          server.close(() => resolve())
        } else {
          resolve()
        }
      })
    },
    simulateNextError(err: MockMetaErrorOptions) {
      nextError = err
    },
    getReceivedRequests() {
      return receivedRequests
    },
    clearReceivedRequests() {
      receivedRequests.length = 0
    },
  }
}
