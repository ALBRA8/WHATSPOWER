// =============================================================================
// MiniWebSocketServer — Servidor WebSocket mínimo en Node puro (zero deps).
// Implementa RFC 6455 handshake + frames de texto (opcode 1) sin fragmentación.
// Pensado para push en tiempo real desde el backend hacia el dashboard.
//
// Limitaciones asumidas (sala limpia):
//   - Solo frames de texto (sin binarios).
//   - Sin fragmentación (cada mensaje = 1 frame completo).
//   - Payload máximo 1MB (alineado con MAX_BODY_BYTES del server HTTP).
//   - Server→client no necesita masking (RFC 6455 §5.3).
//   - Cliente→server: se ignoran los datos entrantes (push-only).
//   - Auto-ping cada 30s para detectar conexiones muertas.
// =============================================================================

import { createHash } from 'node:crypto'
import type { Socket } from 'node:net'
import type { IncomingMessage } from 'node:http'

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface RealtimeEvent {
  type: 'message' | 'lock' | 'suppression' | 'agent' | 'metrics' | 'ping'
  payload?: Record<string, unknown>
}

export class MiniWebSocketServer {
  private clients = new Set<Socket>()
  private pingInterval: NodeJS.Timeout | null = null
  private messageCount = 0
  private path: string

  constructor(path: string = '/ws') {
    this.path = path
  }

  /** Devuelve true si la petición era para esta ruta y se aceptó el upgrade. */
  handleUpgrade(req: IncomingMessage, socket: Socket, _head: Buffer): boolean {
    const url = (req.url || '').split('?')[0]
    if (url !== this.path) return false

    const key = req.headers['sec-websocket-key'] as string | undefined
    const version = req.headers['sec-websocket-version'] as string | undefined

    if (!key || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return false
    }

    const acceptKey = createHash('sha1').update(key + WS_MAGIC).digest('base64')

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        '\r\n'
    )

    this.clients.add(socket)
    socket.on('close', () => this.clients.delete(socket))
    socket.on('error', () => this.clients.delete(socket))

    // Push-only: consumimos los datos entrantes para evitar ECONNRESET pero no los
    // interpretamos (no esperamos mensajes cliente→servidor).
    socket.on('data', () => {})

    return true
  }

  /** Difunde un evento a todos los clientes conectados (serializado a JSON). */
  broadcast(event: RealtimeEvent): void {
    if (this.clients.size === 0) return
    const frame = this.encodeFrame(JSON.stringify(event))
    for (const socket of this.clients) {
      if (socket.destroyed) {
        this.clients.delete(socket)
        continue
      }
      try {
        socket.write(frame)
      } catch {
        this.clients.delete(socket)
      }
    }
    this.messageCount++
  }

  /** Codifica un mensaje a un frame de texto WebSocket (server→client, sin masking). */
  private encodeFrame(message: string): Buffer {
    const msgBuf = Buffer.from(message, 'utf8')
    const len = msgBuf.length

    let header: Buffer
    if (len < 126) {
      header = Buffer.alloc(2)
      header[0] = 0x81 // FIN bit + opcode 0x1 (text)
      header[1] = len
    } else if (len < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x81
      header[1] = 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x81
      header[1] = 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }

    return Buffer.concat([header, msgBuf])
  }

  /** Inicia el ping periódico para mantener vivas las conexiones (30s). */
  startPing(intervalMs: number = 30_000): void {
    this.pingInterval = setInterval(() => {
      const pingFrame = Buffer.from([0x89, 0x00])
      for (const socket of this.clients) {
        if (socket.destroyed) {
          this.clients.delete(socket)
          continue
        }
        try {
          socket.write(pingFrame)
        } catch {
          this.clients.delete(socket)
        }
      }
    }, intervalMs)
    this.pingInterval.unref?.()
  }

  get clientCount(): number {
    return this.clients.size
  }

  get totalMessagesSent(): number {
    return this.messageCount
  }

  close(): void {
    if (this.pingInterval) clearInterval(this.pingInterval)
    for (const socket of this.clients) {
      try {
        socket.end()
      } catch {}
    }
    this.clients.clear()
  }
}
