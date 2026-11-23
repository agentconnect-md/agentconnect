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

// The daemon persists a prompt with a synthetic `[attached: …]` file list the live step never shows.
const ATTACHED_NOTE = /(?:^|\n)\[attached: [^\n]*\]$/

function promptKey(text: string, shown?: SessionImage): string {
  // A prompt with files is known by its words: its row carries an upload's preview, which the live step holds apart from `image`.
  const image = ATTACHED_NOTE.test(text) ? undefined : shown
  return JSON.stringify([
    text.replace(ATTACHED_NOTE, '').trim(),
    image?.name ?? null,
    image?.mimeType ?? null,
    image?.data ?? null
  ])
}

/** AHP's live/persisted merge: retire streamed work after its prompt and any reply posts are confirmed. */
export function reconcilePersistedLiveSteps(
  all: SessionStep[],
  persisted: SessionMessageDto[],
  agentId: string,
  promptRows: SessionMessageDto[] = persisted
): SessionStep[] {
  if (all.length === 0) return all
  const live = all

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
  let index = -1
  const result = all.flatMap((step) => {
    index += 1
    if (removed.has(index) || (!anchored.has(index) && step.postId && persistedPostIds.has(step.postId))) return []
    return hidden.has(index) && !step.hidden ? [{ ...step, hidden: true }] : [step]
  })
  return result.every((step, i) => step === all[i]) && result.length === all.length ? all : result
}

// Kinds a page backed by transcript rows draws from the rows alone (webchat-transcript-refresh.md §2).
const ROW_ONLY_KINDS: ReadonlySet<SessionStep['kind']> = new Set(['plan', 'tool', 'edit', 'planblock'])

/** The live steps a page backed by transcript rows draws over them: sent prompts, the reply streaming now, cards and notices. */
export function liveOverlay<T extends readonly SessionStep[]>(steps: T): T | SessionStep[] {
  return steps.some((step) => ROW_ONLY_KINDS.has(step.kind))
    ? steps.filter((step) => !ROW_ONLY_KINDS.has(step.kind))
    : steps
}

/** What a transcript read retires: `thread` is the place it read (absent: the root), `readStartedAtMs` when it began. */
export interface LiveRetireRead {
  promptRows?: SessionMessageDto[]
  thread?: string
  readStartedAtMs?: number
}

/** Drop the live copies a read makes redundant: anything its rows carry by post id, and what a lane that ended before the read left (webchat-transcript-refresh.md §3). */
export function retireLiveOverlay(
  all: SessionStep[],
  rows: SessionMessageDto[],
  agentId: string,
  read: LiveRetireRead = {}
): SessionStep[] {
  if (all.length === 0) return all
  const postIds = new Set(rows.flatMap((m) => (m.postId ? [m.postId] : [])))
  const here = (step: SessionStep) => (step.thread ?? undefined) === read.thread
  // The lane ended before the read began, so the read holds everything the lane saved.
  const settled = (step: SessionStep) =>
    step.laneDoneAtMs !== undefined && read.readStartedAtMs !== undefined && step.laneDoneAtMs <= read.readStartedAtMs
  const unnamed = matchUnnamedPrompts(all, read.promptRows ?? rows, agentId, here)
  const result = all.filter((step, index) => {
    if (step.postId && postIds.has(step.postId)) return false
    if (!here(step)) return true
    if (step.kind === 'msg') return !unnamed.has(index)
    // A local warning names no segment or post and stays; streamed text and wait notices go with their lane.
    if (step.kind === 'done') return !((step.segmentId || step.postId) && settled(step))
    if (step.kind === 'notice') return step.standing === true || !settled(step)
    if (ROW_ONLY_KINDS.has(step.kind)) return !settled(step)
    return true
  })
  return result.length === all.length ? all : result
}

// Prompts the relay never named a post for (an older relay), matched to their rows by words and time.
function matchUnnamedPrompts(
  all: SessionStep[],
  promptRows: SessionMessageDto[],
  agentId: string,
  here: (step: SessionStep) => boolean
): Set<number> {
  const open = all.flatMap((step, index) =>
    step.kind === 'msg' && !step.postId && here(step) && step.observedAtMs != null && Number.isFinite(step.observedAtMs)
      ? [{ index, key: promptKey(step.text, step.image), at: step.observedAtMs }]
      : []
  )
  const matched = new Set<number>()
  if (open.length === 0) return matched
  for (const message of promptRows) {
    if (message.kind.toLowerCase() !== 'text' || message.sender === agentId) continue
    const persistedAtMs = transcriptRowTimeMs(message)
    if (persistedAtMs == null) continue
    const key = promptKey(message.text, message.attachments?.[0])
    let best: { index: number; delta: number } | undefined
    for (const prompt of open) {
      if (matched.has(prompt.index) || prompt.key !== key) continue
      const delta = Math.abs(prompt.at - persistedAtMs)
      if (delta <= LIVE_TURN_CONFIRM_WINDOW_MS && (!best || delta < best.delta)) best = { index: prompt.index, delta }
    }
    if (best) matched.add(best.index)
  }
  return matched
}

// A live failure has no post id, so only its words tie it to the row the daemon saved for it.
const failureWords = (text: string) => text.replace(/^\s*⚠️?\s*/u, '').trim()

/** Drop a live failure (a `⚠` warning or an error notice) once a row its agent saved at or after it already says it. */
export function dropPersistedFailures(
  live: readonly SessionStep[],
  rows: readonly SessionMessageDto[],
  agentId: string
): readonly SessionStep[] {
  const failure = (step: SessionStep) =>
    !step.segmentId &&
    !step.postId &&
    ((step.kind === 'done' && step.text.trimStart().startsWith('⚠')) ||
      (step.kind === 'notice' && step.standing === true))
  if (!live.some(failure)) return live
  const result = live.filter((step) => {
    if (!failure(step)) return true
    const words = failureWords(step.text)
    if (!words) return true
    const sender = step.agentId ?? agentId
    return !rows.some(
      (row) =>
        row.kind.toLowerCase() === 'text' &&
        row.sender === sender &&
        row.text.includes(words) &&
        (step.observedAtMs === undefined || (transcriptRowTimeMs(row) ?? -1) >= step.observedAtMs - 5_000)
    )
  })
  return result.length === live.length ? live : result
}
