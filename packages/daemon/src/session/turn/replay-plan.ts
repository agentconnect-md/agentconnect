import { transcriptPromptText, type TranscriptEntry } from '../../store/local-store.js'
import type { MessageOrdering } from '../../platforms/message-ordering.js'

// Cap on transcript entries replayed as catch-up context in one prompt (§8.5),
// so a long-quiet thread / large backfilled history can't blow up the prompt.
export const MAX_REPLAY_ENTRIES = 50

/** Everything the gap-replay decision reads. Every field is already resolved by the
 * caller — this input carries no store, no host, and no live message object. */
export type ReplayPlanInput = {
  /** The unread transcript rows since the read cursor, already snapshot-filtered. */
  gap: readonly TranscriptEntry[]
  /** The agent whose turn this is; its own rows are never replayed back to it. */
  agentId: string
  /** The activating message's id. */
  triggerTs: string
  /** The thread root's id — the one own-authored row an initialized session replays. */
  thread: string
  /** The read cursor this turn started from, or `null` for a from-scratch catch-up. */
  markerBefore: string | null
  /** This platform's ordering strategy; `undefined` means the ids are opaque. */
  ordering: MessageOrdering | undefined
  /** Is this the first real prompt of a session initialized from the agent's own root post? */
  firstPromptAfterOwnRootInitialization: boolean
  /** Replay cap override, for tests. */
  maxReplayEntries?: number
}

/** The decided replay for one activation. `batch` delivers one chronological unread
 * run (the trigger is stale or already delivered), `inorder` keeps the established
 * context-prefix + current-prompt shape, and `skip` means the activation has nothing
 * left to say and should return early while still advancing the cursor. */
export type ReplayPlan = {
  shape: 'batch' | 'inorder' | 'skip'
  /** The entries to render as replayed context, oldest to newest. */
  context: readonly TranscriptEntry[]
  /** How many older entries the bounded suffix dropped. */
  elided: number
  /** Heading line that precedes the rendered context; empty on `skip`. */
  head: string
  /** Where the read cursor should land, or `null` when nothing can advance it. */
  deliveredThrough: string | null
}

/** Decide how one activation replays its transcript gap (§8.5 thread catch-up). Pure:
 * the caller fetches the gap, then applies the returned plan (pushes blocks, advances
 * the cursor, takes the early return on `skip`). */
export function planReplay(input: ReplayPlanInput): ReplayPlan {
  const { agentId, thread, triggerTs: ts, markerBefore, ordering, firstPromptAfterOwnRootInitialization } = input
  const cap = input.maxReplayEntries ?? MAX_REPLAY_ENTRIES

  // SQLite's text order puts UUID-like legacy coordinates after real platform
  // ids. Keep those old rows as context, but before the real timeline — which
  // only a platform whose ids carry a native order can express.
  const gap = ordering !== undefined ? [...input.gap].sort((a, b) => ordering.compare(a.ts, b.ts)) : [...input.gap]
  // A session initialized from this agent's own channel-root post has never run a model
  // turn. Replay that one root exactly once, alongside the first real reply, so the new ACP
  // session understands what the thread is about. Ordinary own-authored rows stay filtered:
  // after this activation advances the cursor, the root cannot re-enter a later prompt.
  const participantGap = gap.filter(
    (e) => e.sender !== agentId || (firstPromptAfterOwnRootInitialization && e.ts === thread)
  )
  // The initialized root is the only own-authored row admitted above, and it is the
  // founding context for a runtime session that has never seen a prompt. Keep it outside
  // the ordinary bounded suffix so a busy thread cannot evict it before first activation.
  const initializedRoot = firstPromptAfterOwnRootInitialization
    ? participantGap.find((e) => e.sender === agentId && e.ts === thread)
    : undefined
  const boundedReplay = (entries: readonly TranscriptEntry[]) => {
    const includesInitializedRoot = initializedRoot !== undefined && entries.some((e) => e.ts === initializedRoot.ts)
    const remainder = includesInitializedRoot ? entries.filter((e) => e.ts !== initializedRoot.ts) : entries
    const suffix = remainder.slice(-cap)
    return {
      context: includesInitializedRoot ? [initializedRoot, ...suffix] : suffix,
      elided: remainder.length - suffix.length
    }
  }
  // Own authored rows are not repeated to the model, but they ARE first-class events
  // in the shared log and therefore may advance this agent's read cursor once the
  // surrounding stable window is consumed. With no native ordering there is no "newest
  // row" to reason about, so the cursor advances to the trigger itself.
  const deliveredThrough =
    ordering !== undefined
      ? ordering.coordinate(ts) !== null
        ? (gap.filter((e) => ordering.coordinate(e.ts) !== null).at(-1)?.ts ?? markerBefore)
        : (participantGap.at(-1)?.ts ?? markerBefore)
      : ts
  const triggerWasAlreadyDelivered =
    markerBefore !== null && ordering !== undefined && ordering.compare(ts, markerBefore) <= 0
  // A stale Socket Mode event may be the wake-up signal even though the snapshot
  // contains newer instructions. In that case the old `context + current` shape is
  // actively wrong: it puts the obsolete trigger last. Deliver one chronological
  // unread batch so the newest human instruction is last and therefore salient.
  // Only a natively ordered platform can tell "newer" from "older" at all.
  const hasMessageAfterTrigger = ordering !== undefined && participantGap.some((e) => ordering.compare(e.ts, ts) > 0)

  if (hasMessageAfterTrigger || triggerWasAlreadyDelivered) {
    const { context, elided } = boundedReplay(participantGap)
    if (context.length === 0) return { shape: 'skip', context: [], elided: 0, head: '', deliveredThrough }
    const head =
      elided > 0
        ? `(unread thread messages, oldest to newest — ${elided} earlier message(s) elided)`
        : '(unread thread messages, oldest to newest)'
    return { shape: 'batch', context, elided, head, deliveredThrough }
  }

  // Normal in-order activation: preserve the established context-prefix + current
  // prompt shape, while never replaying this agent's own recorded messages.
  const { context, elided } = boundedReplay(participantGap.filter((e) => e.ts !== ts))
  const head =
    elided > 0
      ? `(thread context you may have missed — ${elided} earlier message(s) elided)`
      : '(thread context you may have missed)'
  return { shape: 'inorder', context, elided, head, deliveredThrough }
}

/** Render replayed entries as the `[sender] text` lines the prompt carries, with each
 * entry's optional quote line ahead of it. */
export function renderReplayContext(
  entries: readonly TranscriptEntry[],
  quoteFor?: (event: TranscriptEntry, replayed: readonly TranscriptEntry[]) => string | undefined
): string {
  return entries
    .flatMap((event) => {
      const quote = quoteFor?.(event, entries)
      return [...(quote ? [quote] : []), `[${event.sender}] ${transcriptPromptText(event)}`]
    })
    .join('\n')
}
