import { randomUUID } from 'node:crypto'
import type { ShimConnection } from './connection.js'
import type { ShimCapability, ShimResponse } from './protocol.js'
import { parseShimFrame } from './protocol.js'
import type { FileSink } from './file-sink.js'

export interface ShimRequestOptions {
  timeoutMs?: number
  // Cancels the work IN THE SANDBOX, not just this side's wait. Abandoning the wait alone leaves
  // the child running, and a running git keeps index.lock — which is what the local runner's
  // abort-kills-the-child behaviour exists to prevent.
  abort?: AbortSignal
}

/** How a daemon-side caller reaches a bound shim: one authorized request, one reply. */
export interface ShimRequester {
  request(capability: ShimCapability, payload: unknown, options?: ShimRequestOptions): Promise<unknown>
}

/** Raised when a request outlived its deadline, so a caller can tell a slow peer from a broken
 *  one without matching on message text. */
export class ShimRequestTimeoutError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ShimRequestTimeoutError'
  }
}

/** Raised when a request was cancelled rather than failing on its own merits. */
export class ShimRequestAbortedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ShimRequestAbortedError'
  }
}

/**
 * Raised for a request whose CHANNEL went away — the routine half-TTL renewal, or a lost launch.
 *
 * Typed rather than a plain Error because the two outcomes are not alike: this one says the request
 * may never have reached the sandbox at all, so a caller that reads it as an answer is inventing one.
 * `ShimSession.attach` documents that a renewal fails in-flight requests and the caller may simply ask
 * again; that instruction is only actionable if the caller can tell this apart from a real reply.
 */
export class ShimChannelLostError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ShimChannelLostError'
  }
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

  request(capability: ShimCapability, payload: unknown, options: ShimRequestOptions = {}): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.deps.setTimeout(() => {
        this.pending.delete(id)
        // Tell the sandbox too: a timeout that only gives up locally leaves the child running.
        this.sendCancel(id, `timed out after ${timeoutMs}ms`)
        reject(new ShimRequestTimeoutError(`shim ${capability} request timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return
        this.deps.clearTimeout(timer)
        this.sendCancel(id, 'aborted by caller')
        reject(new ShimRequestAbortedError(`shim ${capability} request aborted`))
      }
      if (options.abort?.aborted) {
        this.deps.clearTimeout(timer)
        reject(new ShimRequestAbortedError(`shim ${capability} request aborted`))
        return
      }
      options.abort?.addEventListener('abort', onAbort, { once: true })
      const done = (): void => {
        this.deps.clearTimeout(timer)
        options.abort?.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, {
        resolve: (value) => {
          done()
          resolve(value)
        },
        reject: (err) => {
          done()
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

  // Best-effort: a dead channel cannot deliver it, and the shim's own deadline is the backstop.
  private sendCancel(id: string, reason: string): void {
    try {
      this.connection.send({
        type: 'shim/cancel',
        id,
        sessionCredential: this.credential,
        generation: this.connection.binding.generation,
        reason
      })
    } catch {
      /* channel already gone */
    }
  }

  /** Fail every in-flight request; the channel is gone and a caller must not hang on it. */
  abort(reason: string): void {
    for (const [id, waiter] of [...this.pending]) {
      this.pending.delete(id)
      waiter.reject(new ShimChannelLostError(reason))
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
