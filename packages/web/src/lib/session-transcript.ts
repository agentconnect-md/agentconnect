import type { SessionMessageDto } from '@/lib/api'
import type { SessionImage, SessionStep } from '@/lib/data'
import { parseTranscriptTime } from '@/lib/transcript-time'

const LIVE_TURN_CONFIRM_WINDOW_MS = 5 * 60_000

/** Upsert stable transcript rows and restore the platform's display ordering. */
export function mergeSessionMessages(
  current: SessionMessageDto[],
  incoming: SessionMessageDto[],
  platform: string
): SessionMessageDto[] {
  if (incoming.length === 0) return current
  const bySeq = new Map(current.map((message) => [message.seq, message]))
  for (const message of incoming) bySeq.set(message.seq, message)
  return [...bySeq.values()].sort((a, b) => {
    if (platform !== 'slack') return a.seq - b.seq
    return (parseTranscriptTime(a.ts) ?? 0) - (parseTranscriptTime(b.ts) ?? 0) || a.seq - b.seq
  })
}

function promptKey(text: string, image?: SessionImage): string {
  return JSON.stringify([text, image?.name ?? null, image?.mimeType ?? null, image?.data ?? null])
}

/**
 * Drop only adopted-WebChat turns whose optimistic user prompt has a matching,
 * newly persisted transcript row. Failed pre-admission turns have no such row
 * and therefore retain both the attempted prompt and its error feedback.
 */
export function reconcilePersistedLiveSteps(
  live: SessionStep[],
  persisted: SessionMessageDto[],
  agentId: string
): SessionStep[] {
  if (live.length === 0 || persisted.length === 0) return live

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
  if (turns.length === 0) return live

  const confirmed = new Set<number>()
  for (const message of persisted) {
    if (message.kind.toLowerCase() !== 'text' || message.sender === agentId) continue
    const persistedAtMs = parseTranscriptTime(message.ts)
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
  if (confirmed.size === 0) return live

  const removed = new Set<number>()
  for (const index of confirmed) {
    const turn = turns[index]!
    for (let step = turn.start; step < turn.end; step++) removed.add(step)
  }
  return live.filter((_, index) => !removed.has(index))
}
