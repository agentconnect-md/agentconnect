import type { SessionMessageDto } from '@/lib/api'
import type { SessionImage, SessionStep } from '@/lib/data'
import { transcriptRowTimeMs } from '@/lib/transcript-time'

const LIVE_TURN_CONFIRM_WINDOW_MS = 5 * 60_000

/**
 * Upsert stable transcript rows and restore the requested display ordering.
 *
 * `ordering` replaces the `platform !== 'slack'` literal this used to carry:
 * it is the owning platform module's `transcriptOrdering` (§10), resolved by
 * the caller through `platformTranscriptOrdering`. Same two arms and the same
 * platforms in each — a module that declares nothing, and every id no module
 * claims, takes `'seq'`.
 *
 * The RESOLUTION deliberately stays at the call site rather than moving in
 * here: this module is shared with `PlaygroundProvider` (for
 * `reconcilePersistedLiveSteps`), and a registry import would pull all four
 * platform modules — wizard panes and CP bindings included — into the
 * playground's graph for a value it never reads. Same trade `lib/data.ts`
 * makes by keeping `lib/platform-labels.ts` out of the registry.
 */
export function mergeSessionMessages(
  current: SessionMessageDto[],
  incoming: SessionMessageDto[],
  ordering: 'seq' | 'event-time'
): SessionMessageDto[] {
  if (incoming.length === 0) return current
  const bySeq = new Map(current.map((message) => [message.seq, message]))
  for (const message of incoming) bySeq.set(message.seq, message)
  return [...bySeq.values()].sort((a, b) => {
    if (ordering !== 'event-time') return a.seq - b.seq
    return (transcriptRowTimeMs(a) ?? 0) - (transcriptRowTimeMs(b) ?? 0) || a.seq - b.seq
  })
}

function promptKey(text: string, image?: SessionImage): string {
  return JSON.stringify([text, image?.name ?? null, image?.mimeType ?? null, image?.data ?? null])
}

/** Retire streamed work after its prompt and any reply posts are confirmed. */
export function reconcilePersistedLiveSteps(
  live: SessionStep[],
  persisted: SessionMessageDto[],
  agentId: string,
  promptRows: SessionMessageDto[] = persisted
): SessionStep[] {
  if (live.length === 0) return live

  const persistedPostIds = new Set(persisted.flatMap((m) => (m.postId ? [m.postId] : [])))
  const turns: Array<{ start: number; end: number; key: string; observedAtMs: number }> = []
  for (let start = 0; start < live.length;) {
    if (live[start]!.kind !== 'msg') {
      start += 1
      continue
    }
    let end = start + 1
    while (end < live.length && live[end]!.kind !== 'msg') end += 1
    const prompt = live[start]!
    if (prompt.observedAtMs != null && Number.isFinite(prompt.observedAtMs)) {
      turns.push({
        start,
        end,
        key: promptKey(prompt.text, prompt.image),
        observedAtMs: prompt.observedAtMs
      })
    }
    start = end
  }
  const matched = new Set(turns.flatMap((turn, index) => (live[turn.start]!.hidden ? [index] : [])))
  for (const message of promptRows) {
    if (message.kind.toLowerCase() !== 'text' || message.sender === agentId) continue
    const persistedAtMs = transcriptRowTimeMs(message)
    if (persistedAtMs == null) continue
    const key = promptKey(message.text, message.attachments?.[0])
    let bestTurn = -1
    let bestDelta = Number.POSITIVE_INFINITY
    for (let index = 0; index < turns.length; index++) {
      if (matched.has(index) || turns[index]!.key !== key) continue
      const delta = Math.abs(turns[index]!.observedAtMs - persistedAtMs)
      if (delta <= LIVE_TURN_CONFIRM_WINDOW_MS && delta < bestDelta) {
        bestTurn = index
        bestDelta = delta
      }
    }
    if (bestTurn >= 0) matched.add(bestTurn)
  }
  const removed = new Set<number>()
  const hidden = new Set<number>()
  const anchored = new Set<number>()
  for (const index of matched) {
    const turn = turns[index]!
    const replies = live.slice(turn.start + 1, turn.end).filter((step) => step.kind === 'done' && !step.demoted)
    const persistedReply = (sender: string): boolean =>
      persisted.some(
        (row) =>
          row.kind.toLowerCase() === 'text' &&
          row.sender === sender &&
          (transcriptRowTimeMs(row) ?? -1) >= turn.observedAtMs
      )
    const replyPersisted = (step: SessionStep): boolean =>
      !!step.hidden || (step.postId ? persistedPostIds.has(step.postId) : persistedReply(step.agentId ?? agentId))
    const confirmed = replies.length > 0 ? replies.every(replyPersisted) : live[turn.start]!.turnComplete === true
    if (confirmed) {
      for (let step = turn.start; step < turn.end; step++) {
        if (replies.length > 0 || !live[step]!.standing) removed.add(step)
      }
    } else {
      hidden.add(turn.start)
      for (let step = turn.start + 1; step < turn.end; step++) {
        if (live[step]!.kind === 'done' && replyPersisted(live[step]!)) hidden.add(step)
      }
    }
    for (let step = turn.start; step < turn.end; step++) anchored.add(step)
  }
  const result = live.flatMap((step, index) => {
    if (removed.has(index) || (!anchored.has(index) && step.postId && persistedPostIds.has(step.postId))) return []
    return hidden.has(index) && !step.hidden ? [{ ...step, hidden: true }] : [step]
  })
  return result.every((step, index) => step === live[index]) && result.length === live.length ? live : result
}
