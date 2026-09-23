/** decisions.md §7.3 host limits: active slots per provider and per daemon, with a bounded queue. */
export interface DecisionSlotLimits {
  providerActive: number
  daemonActive: number
  queued: number
  providerQueued: number
}

export type SlotResult =
  | { kind: 'acquired'; release: () => void }
  | { kind: 'capacity'; scope: 'queue' | 'provider_queue' }
  | { kind: 'timeout' }

interface Waiter {
  provider: string
  grant: () => void
}

export class DecisionSlots {
  private active = 0
  private readonly activeBy = new Map<string, number>()
  private readonly queue: Waiter[] = []

  constructor(private readonly limits: DecisionSlotLimits) {}

  /** Wait for a slot until `deadlineAt`; a full queue answers `capacity` at once. Rejects on abort. */
  acquire(provider: string, deadlineAt: number, signal: AbortSignal, now: () => number): Promise<SlotResult> {
    signal.throwIfAborted()
    if (this.free(provider)) return Promise.resolve({ kind: 'acquired', release: this.take(provider) })
    if (this.queue.length >= this.limits.queued) return Promise.resolve({ kind: 'capacity', scope: 'queue' })
    if (this.queue.filter((w) => w.provider === provider).length >= this.limits.providerQueued)
      return Promise.resolve({ kind: 'capacity', scope: 'provider_queue' })
    const remaining = deadlineAt - now()
    if (remaining <= 0) return Promise.resolve({ kind: 'timeout' })
    return new Promise<SlotResult>((resolve, reject) => {
      const waiter: Waiter = {
        provider,
        grant: () => {
          cleanup()
          resolve({ kind: 'acquired', release: this.take(provider) })
        }
      }
      const drop = (): void => {
        const index = this.queue.indexOf(waiter)
        if (index >= 0) this.queue.splice(index, 1)
      }
      const timer = setTimeout(() => {
        drop()
        cleanup()
        resolve({ kind: 'timeout' })
      }, remaining)
      const onAbort = (): void => {
        drop()
        cleanup()
        reject(signal.reason)
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.queue.push(waiter)
    })
  }

  get queued(): number {
    return this.queue.length
  }

  private free(provider: string): boolean {
    return this.active < this.limits.daemonActive && (this.activeBy.get(provider) ?? 0) < this.limits.providerActive
  }

  private take(provider: string): () => void {
    this.active++
    this.activeBy.set(provider, (this.activeBy.get(provider) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.activeBy.set(provider, (this.activeBy.get(provider) ?? 1) - 1)
      this.grantNext()
    }
  }

  private grantNext(): void {
    for (let index = 0; index < this.queue.length; index++) {
      const waiter = this.queue[index]!
      if (!this.free(waiter.provider)) continue
      this.queue.splice(index, 1)
      waiter.grant()
      return
    }
  }
}
