import type { DeliveryAdmission, DeliveryCompletion, DeliveryHandle } from '../evaluation/environment.js'
import type { ChannelRecordRef, DecisionVerdictRow } from '../store/local-store.js'
import { DecisionSlots, type DecisionSlotLimits } from './limiter.js'

/** One conversation lane of one subject; a gate's subject is its agent, a router's `router:<botId>`. */
export interface Lane {
  orgId: string
  channel: string
  subject: string
}

interface Waiter {
  admission: (value: DeliveryAdmission) => void
  completion: (value: DeliveryCompletion) => void
}

export const verdictKey = (seq: number, subject: string): string => `${seq}:${subject}`
export const laneId = (lane: Lane): string => `${lane.orgId}\u0000${lane.channel}\u0000${lane.subject}`
const conversationId = (orgId: string, channel: string): string => `${orgId}\u0000${channel}`

export interface DecisionLaneLimits extends DecisionSlotLimits {
  ingressBarrierMs: number
}

/** The machinery the gate and the router share: one slot budget, the ingress barrier, single-flight drains, and waiters. */
export class DecisionLaneRuntime {
  readonly slots: DecisionSlots
  private readonly waiters = new Map<string, Waiter[]>()
  private readonly draining = new Map<string, Promise<void>>()
  private readonly redrain = new Set<string>()
  private readonly openIngressSeqs = new Map<string, Map<number, number>>()
  private readonly progress = new Set<() => void>()
  private readonly tracked = new Set<Promise<unknown>>()
  private closed = false

  constructor(private readonly limits: DecisionLaneLimits) {
    this.slots = new DecisionSlots(limits)
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Mark one recorded row as still travelling the ladder; later rows of its conversation wait behind it. */
  openIngress(ref: ChannelRecordRef): () => void {
    const id = conversationId(ref.orgId, ref.transcriptChannel)
    const open = this.openIngressSeqs.get(id) ?? new Map<number, number>()
    open.set(ref.seq, (open.get(ref.seq) ?? 0) + 1)
    this.openIngressSeqs.set(id, open)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      const count = (open.get(ref.seq) ?? 1) - 1
      if (count > 0) open.set(ref.seq, count)
      else open.delete(ref.seq)
      if (open.size === 0 && this.openIngressSeqs.get(id) === open) this.openIngressSeqs.delete(id)
      this.notifyProgress()
    }
  }

  /** Hold a settled head while a lower row of its conversation is still on the ladder, bounded; true when it waited. */
  async ingressBarrier(head: Pick<DecisionVerdictRow, 'orgId' | 'channel' | 'seq'>): Promise<boolean> {
    const deadline = Date.now() + this.limits.ingressBarrierMs
    const blocked = (): boolean =>
      [...(this.openIngressSeqs.get(conversationId(head.orgId, head.channel))?.keys() ?? [])].some(
        (seq) => seq < head.seq
      )
    let waited = false
    while (!this.closed && blocked() && Date.now() < deadline) {
      waited = true
      await this.nextProgress(deadline - Date.now())
    }
    return waited
  }

  /** Single-flight per lane: `drainOnce` runs again while a redrain was requested during it. */
  drain(lane: Lane, drainOnce: () => Promise<void>, onError: (err: Error) => void): void {
    if (this.closed) return
    const id = laneId(lane)
    if (this.draining.has(id)) {
      this.redrain.add(id)
      return
    }
    const run = (async () => {
      do {
        this.redrain.delete(id)
        await drainOnce()
      } while (this.redrain.has(id) && !this.closed)
    })()
      .catch((err) => onError(err as Error))
      .finally(() => this.draining.delete(id))
    this.draining.set(id, run)
    this.track(run)
  }

  nextProgress(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.progress.delete(done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, timeoutMs))
      this.progress.add(done)
    })
  }

  notifyProgress(): void {
    for (const done of [...this.progress]) done()
  }

  handleFor(key: string): DeliveryHandle {
    return this.waiterFor(key).handle
  }

  waiterFor(key: string): { handle: DeliveryHandle; drop: () => void } {
    let admission!: (value: DeliveryAdmission) => void
    let completion!: (value: DeliveryCompletion) => void
    const handle: DeliveryHandle = {
      admission: new Promise<DeliveryAdmission>((resolve) => (admission = resolve)),
      completion: new Promise<DeliveryCompletion>((resolve) => (completion = resolve))
    }
    const waiter: Waiter = { admission, completion }
    this.waiters.set(key, [...(this.waiters.get(key) ?? []), waiter])
    const drop = (): void => {
      const rest = (this.waiters.get(key) ?? []).filter((w) => w !== waiter)
      if (rest.length > 0) this.waiters.set(key, rest)
      else this.waiters.delete(key)
    }
    return { handle, drop }
  }

  /** Resolve every waiter of a verdict key with its terminal outcome, then wake lane waits. */
  finished(key: string, state: 'admitted' | 'canceled' | 'skipped', handle?: DeliveryHandle): void {
    const waiters = this.waiters.get(key) ?? []
    this.waiters.delete(key)
    for (const waiter of waiters) {
      if (state === 'admitted' && handle) {
        void handle.admission.then(waiter.admission)
        void handle.completion.then(waiter.completion)
      } else if (state === 'admitted') {
        waiter.admission({ admitted: false, reason: 'deduplicated' })
        waiter.completion({ status: 'not_admitted' })
      } else {
        waiter.admission({ admitted: false, reason: 'gated' })
        waiter.completion({ status: 'not_admitted' })
      }
    }
    this.notifyProgress()
  }

  resolveGated(key: string): void {
    const waiters = this.waiters.get(key) ?? []
    this.waiters.delete(key)
    for (const waiter of waiters) {
      waiter.admission({ admitted: false, reason: 'gated' })
      waiter.completion({ status: 'not_admitted' })
    }
  }

  track<T>(promise: Promise<T>): void {
    const tracked = promise.then(
      () => undefined,
      () => undefined
    )
    this.tracked.add(tracked)
    void tracked.finally(() => this.tracked.delete(tracked))
  }

  /** Settles once no evaluation, drain, or release is in flight on either consumer. */
  async idle(): Promise<void> {
    while (this.tracked.size > 0) await Promise.allSettled([...this.tracked])
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const key of [...this.waiters.keys()]) this.resolveGated(key)
    this.notifyProgress()
  }
}
