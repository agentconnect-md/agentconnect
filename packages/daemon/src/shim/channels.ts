import { randomUUID } from 'node:crypto'
import type { ShimConnection } from './listener.js'
import type { ShimCapability, ShimResponse } from './protocol.js'
import { parseShimFrame } from './protocol.js'
import type { FileSink } from './file-sink.js'

/** How a daemon-side caller reaches a bound shim: one authorized request, one reply. */
export interface ShimRequester {
  request(capability: ShimCapability, payload: unknown, timeoutMs?: number): Promise<unknown>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * Issue requests on a bound channel, correlating replies by id.
 *
 * Every request carries the credential and generation the binding was issued with, so the
 * shim can refuse a frame that is not for its own incarnation — and does, independently of
 * this side. The generation travels on each frame rather than being assumed from the
 * connection, because a channel outlives neither a renewal nor a relaunch silently.
 */
export class ShimChannel implements ShimRequester {
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()

  constructor(
    private readonly connection: ShimConnection,
    private readonly credential: string,
    private readonly deps: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void }
  ) {}

  /** Feed an inbound frame; returns true when it was a reply this channel was waiting for. */
  accept(text: string): boolean {
    const frame = parseShimFrame(text)
    if (!frame || frame.type !== 'shim/response') return false
    const waiter = this.pending.get(frame.id)
    if (!waiter) return false
    this.pending.delete(frame.id)
    if (frame.ok) waiter.resolve(frame.payload)
    else waiter.reject(new Error(frame.error ?? 'shim request failed'))
    return true
  }

  request(capability: ShimCapability, payload: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.deps.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`shim ${capability} request timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          this.deps.clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          this.deps.clearTimeout(timer)
          reject(err)
        }
      })
      this.connection.send({
        type: 'shim/request',
        id,
        sessionCredential: this.credential,
        generation: this.connection.binding.generation,
        capability,
        payload
      })
    })
  }

  /** Fail every in-flight request; the channel is gone and a caller must not hang on it. */
  abort(reason: string): void {
    for (const [id, waiter] of [...this.pending]) {
      this.pending.delete(id)
      waiter.reject(new Error(reason))
    }
  }

  pendingCount(): number {
    return this.pending.size
  }
}

/**
 * A {@link FileSink} that writes inside the sandbox by asking the shim to do it.
 *
 * The daemon still decides which files exist and what they contain; this only moves the
 * write. It carries no path logic of its own — the shim validates containment on its side,
 * where the filesystem actually is.
 */
export class ShimFileSink implements FileSink {
  constructor(private readonly requester: ShimRequester) {}

  async clear(root: string): Promise<string | undefined> {
    try {
      await this.requester.request('materialize', { op: 'clear', root })
      return undefined
    } catch (err) {
      return `config files could not be cleared in the sandbox (${(err as Error).message})`
    }
  }

  async write(root: string, relPath: string[], content: string): Promise<void> {
    await this.requester.request('materialize', { op: 'write', root, relPath, content })
  }
}

/** The response a shim sends for a request it will not serve. */
export function shimRefusal(id: string, error: string): ShimResponse {
  return { type: 'shim/response', id, ok: false, error }
}
