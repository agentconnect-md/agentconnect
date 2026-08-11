import { ShimChannel, type ShimRequestOptions } from './channels.js'
import type { ShimConnection } from './listener.js'
import type { ShimCapability, ShimEvent } from './protocol.js'
import { parseShimFrame } from './protocol.js'

/**
 * A logical channel to one agent's sandbox that survives the physical connection.
 *
 * A runtime lives for hours; a shim connection does not. The shim renews its credential by
 * dialing a replacement at half the TTL, and the listener closes the superseded socket — so
 * anything holding one `ShimConnection` for a runtime's lifetime is stranded on the first
 * ordinary renewal. This tracks the current connection instead, re-attaching when the same
 * launch rebinds and reporting a genuine loss when a NEW launch takes over.
 */
export class ShimSession {
  private channel?: ShimChannel
  private connection?: ShimConnection
  private readonly eventListeners = new Set<(event: ShimEvent) => void>()
  private readonly lostListeners = new Set<(reason: string) => void>()
  private closed = false

  constructor(
    readonly agentId: string,
    readonly generation: number,
    private readonly timers: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void }
  ) {}

  /**
   * Attach (or re-attach) the physical connection serving this launch.
   *
   * A rebind at the same generation is a renewal: in-flight requests are failed, because
   * their replies would have gone to a socket that no longer exists, but the session itself
   * continues and a caller can simply ask again. A different generation is a new launch, so
   * the session is finished rather than reused.
   */
  attach(connection: ShimConnection): void {
    if (this.closed) return
    if (connection.binding.generation !== this.generation) {
      this.lose(`superseded by generation ${connection.binding.generation}`)
      return
    }
    this.channel?.abort('shim channel renewed')
    this.connection = connection
    const channel = new ShimChannel(connection, connection.issuedCredential, this.timers)
    this.channel = channel
    connection.onFrame((text) => {
      if (channel.accept(text)) return
      const frame = parseShimFrame(text)
      if (frame?.type !== 'shim/event') return
      for (const listener of this.eventListeners) listener(frame)
    })
  }

  /** Report that this launch's channel is gone for good. */
  lose(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.channel?.abort(reason)
    this.channel = undefined
    this.connection = undefined
    for (const listener of this.lostListeners) listener(reason)
  }

  onEvent(listener: (event: ShimEvent) => void): void {
    this.eventListeners.add(listener)
  }

  onLost(listener: (reason: string) => void): void {
    this.lostListeners.add(listener)
  }

  /** Drop a subscription — the runtime it belonged to is gone, and a session outlives it. */
  offEvent(listener: (event: ShimEvent) => void): void {
    this.eventListeners.delete(listener)
  }

  isAttached(): boolean {
    return this.channel !== undefined
  }

  request(capability: ShimCapability, payload: unknown, options?: ShimRequestOptions): Promise<unknown> {
    if (!this.channel) throw new Error(`agent ${this.agentId} has no attached shim channel`)
    return this.channel.request(capability, payload, options)
  }
}
