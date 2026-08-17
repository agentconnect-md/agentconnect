import type { ContentBlock } from '@agentclientprotocol/sdk'
import { recalledMemoryBlock, sanitizeRecallRecords } from '../../memory/recall.js'
import type { memoryKindOf, MemoryProvider, MemoryScope } from '../../memory/provider.js'
import type { RecallPolicy } from '../../memory/types.js'

/** Metadata-only semantic lifecycle for one provider-neutral recall attempt. Query
 * and recalled record bodies deliberately stay out of this observer contract. */
export type MemoryRecallLifecycleEvent =
  | {
      kind: 'requested'
      sessionId: string
      turnId: string
      provider: ReturnType<typeof memoryKindOf>
      topK: number
      maxBytes: number
      timeoutMs: number
    }
  | {
      kind: 'completed'
      sessionId: string
      turnId: string
      provider: ReturnType<typeof memoryKindOf>
      recordCount: number
      injectedBytes: number
    }
  | {
      kind: 'failed'
      sessionId: string
      turnId: string
      provider: ReturnType<typeof memoryKindOf>
      errorName: string
      timedOut: boolean
      aborted: boolean
    }

/** The three independently-injected recall observability callbacks, exactly as
 * SessionManagerDeps declares them. */
export type RecallObserverCallbacks = {
  onMemoryRecallError?: (agentId: string, error: unknown) => void
  onMemoryRecallInjected?: (agentId: string, bytes: number) => void
  onMemoryRecallEvent?: (agentId: string, event: MemoryRecallLifecycleEvent) => void
}

/** One agent-bound facade over the recall observability callbacks. Every emission
 * goes through `safeEmit`, so an observer that throws can never change recall's
 * prompt assembly or its fail-open policy. */
export class RecallObserver {
  constructor(
    private readonly agentId: string,
    private readonly callbacks: RecallObserverCallbacks
  ) {}

  lifecycle(event: MemoryRecallLifecycleEvent): void {
    this.safeEmit(() => this.callbacks.onMemoryRecallEvent?.(this.agentId, event))
  }

  injected(bytes: number): void {
    this.safeEmit(() => this.callbacks.onMemoryRecallInjected?.(this.agentId, bytes))
  }

  degraded(error: unknown): void {
    this.safeEmit(() => this.callbacks.onMemoryRecallError?.(this.agentId, error))
  }

  private safeEmit(emit: () => void): void {
    try {
      emit()
    } catch {
      // Observability must never change recall or prompt assembly.
    }
  }
}

/** Everything one recall attempt reads. The caller resolves the policy and the
 * bounded query, and supplies its own turn-scoped abort fence. */
export type TurnRecallInput = {
  /** The memory plane this turn recalls from. */
  memory: Pick<MemoryProvider, 'recallForTurn'>
  /** Session-qualified scope the records must belong to. */
  scope: MemoryScope & { sessionId: string }
  /** The resolved `auto` policy — topK/maxBytes/timeoutMs budgets. */
  policy: RecallPolicy
  /** Durable per-turn operation fence. */
  turnId: string
  /** Bounded query text derived from the delivered prompt blocks. */
  query: string
  /** Provider kind, metadata only. */
  provider: ReturnType<typeof memoryKindOf>
  /** Where lifecycle/diagnostic emissions go. */
  observer: RecallObserver
  /** The turn's abort fence; recall cancels with it. */
  signal?: AbortSignal
  /** The caller's abort-fenced await helper, so an aborted turn's continuation cannot resume. */
  abortable: <T>(start: () => PromiseLike<T> | T, signal?: AbortSignal) => Promise<T>
  /** Turn the turn's abort into the caller's interruption error. */
  interrupted: (signal: AbortSignal) => Error
}

/**
 * One provider-neutral recall attempt. Returns the trailing, explicitly untrusted
 * reference block to append, or `undefined` when there is nothing to inject.
 * Runtime recall is fail-open: a provider error, a timeout, or an empty result all
 * answer without memory. Only a turn abort propagates, as the caller's interruption.
 */
export async function runTurnRecall(input: TurnRecallInput): Promise<ContentBlock | undefined> {
  const { scope, policy, turnId, provider, observer, signal, abortable, interrupted } = input
  const recallAbort = new AbortController()
  const req = {
    turnId,
    query: input.query,
    topK: policy.topK,
    maxBytes: policy.maxBytes,
    timeoutMs: policy.timeoutMs,
    signal: recallAbort.signal
  }
  let timer: NodeJS.Timeout | undefined
  const abortRecall = (): void => recallAbort.abort(signal?.reason)
  signal?.addEventListener('abort', abortRecall, { once: true })
  try {
    observer.lifecycle({
      kind: 'requested',
      sessionId: scope.sessionId,
      turnId,
      provider,
      topK: req.topK,
      maxBytes: req.maxBytes,
      timeoutMs: req.timeoutMs
    })
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('memory recall timed out')
        recallAbort.abort(error)
        reject(error)
      }, req.timeoutMs)
      timer.unref?.()
    })
    const raw = await Promise.race([abortable(() => input.memory.recallForTurn(scope, req), signal), timeout])
    const records = sanitizeRecallRecords(raw, scope, req)
    const reference = recalledMemoryBlock(records, req.maxBytes)
    const injectedBytes = reference?.type === 'text' ? Buffer.byteLength(reference.text) : 0
    if (reference?.type === 'text') observer.injected(injectedBytes)
    observer.lifecycle({
      kind: 'completed',
      sessionId: scope.sessionId,
      turnId,
      provider,
      recordCount: records.length,
      injectedBytes
    })
    return reference ?? undefined
  } catch (error) {
    observer.lifecycle({
      kind: 'failed',
      sessionId: scope.sessionId,
      turnId,
      provider,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      timedOut: error instanceof Error && /timed out/i.test(error.message),
      aborted: signal?.aborted === true
    })
    if (signal?.aborted) throw interrupted(signal)
    // Fail open: answer without memory and emit only a metadata-safe diagnostic.
    observer.degraded(error)
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', abortRecall)
  }
}
