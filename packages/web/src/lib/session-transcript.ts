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

/** Drop exact post duplicates from all rows and fuzzy prompt duplicates from prompt rows. */
export function reconcilePersistedLiveSteps(
  live: SessionStep[],
  persisted: SessionMessageDto[],
  agentId: string,
  promptRows: SessionMessageDto[] = persisted
): SessionStep[] {
  if (live.length === 0 || persisted.length === 0) return live

  const persistedPostIds = new Set(persisted.flatMap((m) => (m.postId ? [m.postId] : [])))
  const withoutConfirmedPosts =
    persistedPostIds.size === 0 ? live : live.filter((step) => !(step.postId && persistedPostIds.has(step.postId)))
  if (withoutConfirmedPosts.length === 0) return withoutConfirmedPosts

  const turns: Array<{ start: number; end: number; key: string; observedAtMs: number }> = []
  for (let start = 0; start < withoutConfirmedPosts.length;) {
    if (withoutConfirmedPosts[start]!.kind !== 'msg') {
      start += 1
      continue
    }
    let end = start + 1
    while (end < withoutConfirmedPosts.length && withoutConfirmedPosts[end]!.kind !== 'msg') end += 1
    const prompt = withoutConfirmedPosts[start]!
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
  if (turns.length === 0) return withoutConfirmedPosts

  const confirmed = new Set<number>()
  for (const message of promptRows) {
    if (message.kind.toLowerCase() !== 'text' || message.sender === agentId) continue
    const persistedAtMs = transcriptRowTimeMs(message)
    if (persistedAtMs == null) continue
    const key = promptKey(message.text, message.attachments?.[0])
    let bestTurn = -1
    let bestDelta = Number.POSITIVE_INFINITY
    for (let index = 0; index < turns.length; index++) {
      if (confirmed.has(index) || turns[index]!.key !== key) continue
      const delta = Math.abs(turns[index]!.observedAtMs - persistedAtMs)
      if (delta <= LIVE_TURN_CONFIRM_WINDOW_MS && delta < bestDelta) {
        bestTurn = index
        bestDelta = delta
      }
    }
    if (bestTurn >= 0) confirmed.add(bestTurn)
  }
  if (confirmed.size === 0) return withoutConfirmedPosts

  const removed = new Set<number>()
  for (const index of confirmed) {
    const turn = turns[index]!
    for (let step = turn.start; step < turn.end; step++) removed.add(step)
  }
  return withoutConfirmedPosts.filter((_, index) => !removed.has(index))
}
