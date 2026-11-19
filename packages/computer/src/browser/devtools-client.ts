import { ComputerError } from '../computer.js'
import type { DevtoolsEndpoint } from './devtools-endpoint.js'

export interface DevtoolsEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

const TIMEOUT_MS = 5000

/** The viewer uses its own socket to the checked browser endpoint. */
export class DevtoolsClient {
  private readonly socket: WebSocket
  private readonly ready: Promise<void>
  private readonly pending = new Map<number, { accept: (value: unknown) => void; reject: (error: Error) => void }>()
  private sequence = 0

  constructor(endpoint: DevtoolsEndpoint, onEvent: (event: DevtoolsEvent) => void) {
    this.socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`)
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), TIMEOUT_MS)
      const finished = (error?: Error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      this.socket.addEventListener('open', () => finished(), { once: true })
      this.socket.addEventListener('error', () => finished(this.unavailable()), { once: true })
      this.socket.addEventListener('close', () => finished(this.unavailable()), { once: true })
    })
    // A socket can close before the first DevTools command starts awaiting it.
    void this.ready.catch(() => undefined)
    this.socket.addEventListener('message', (message) => {
      if (typeof message.data !== 'string') return
      let reply: { id?: number; result?: unknown; error?: unknown } & Partial<DevtoolsEvent>
      try {
        reply = JSON.parse(message.data)
      } catch {
        return
      }
      if (reply.id !== undefined) {
        const pending = this.pending.get(reply.id)
        if (reply.error) pending?.reject(new ComputerError('unavailable', 'Chrome could not complete the request.'))
        else pending?.accept(reply.result)
      } else if (typeof reply.method === 'string' && reply.params) {
        onEvent({
          method: reply.method,
          params: reply.params,
          ...(reply.sessionId ? { sessionId: reply.sessionId } : {})
        })
      }
    })
    this.socket.addEventListener('close', () => this.fail())
  }

  get closed(): boolean {
    return this.socket.readyState >= WebSocket.CLOSING
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    await this.ready
    if (this.closed) throw this.unavailable()
    const id = ++this.sequence
    let timer: NodeJS.Timeout | undefined
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, { accept: (value) => resolve(value as T), reject })
        timer = setTimeout(() => reject(this.unavailable()), TIMEOUT_MS)
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    } finally {
      clearTimeout(timer)
      this.pending.delete(id)
    }
  }

  close(): void {
    if (!this.closed) this.socket.close()
    this.fail()
  }

  private fail(): void {
    for (const pending of this.pending.values()) pending.reject(this.unavailable())
    this.pending.clear()
  }

  private unavailable(): ComputerError {
    return new ComputerError('unavailable', 'Chrome is unavailable.')
  }
}
