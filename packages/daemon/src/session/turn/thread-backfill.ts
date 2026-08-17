import type { LocalStore } from '../../store/local-store.js'
import type { MessageOrdering } from '../../platforms/message-ordering.js'

/** Mint a Slack message id for a wall-clock instant. This is NOT part of the
 * message-ordering strategy: its only callers are the warm-thread provider
 * snapshot's cutoff and the daemon's final-fence checkpoint, both of which are
 * `threadBackfill` — the Layer-1 read port — and both of which exist solely
 * because Slack is the only platform with a thread-history adapter today. It
 * moves into that port when the second adapter lands, not with `cursorOrdering`. */
export function slackTsForWallClock(ms: number): string {
  const whole = Math.floor(ms / 1_000)
  return `${whole}.${String(Math.floor(ms % 1_000) * 1_000).padStart(6, '0')}`
}

/** One provider-history row as the Layer-1 thread-history read port returns it. */
export type ThreadHistoryEntry = { sender: string; ts: string; text: string; trustedAgentBot?: boolean }

/** Everything the warm-thread snapshot reads. The caller resolves every field, and
 * wraps the read port in its own turn-scoped abort fence before handing it over. */
export type ThreadBackfillInput = {
  /** The activating message's platform — only Slack has a thread-history adapter today. */
  platform: string
  /** The agent whose turn this is; its own rows are never re-recorded. */
  agentId: string
  /** Transcript-key channel the fetched rows are written under. */
  transcriptChannel: string
  /** The thread root's id. */
  thread: string
  /** The activating message's id. */
  ts: string
  /** The read cursor this turn started from, or `null` for a from-scratch catch-up. */
  markerBefore: string | null
  /** This platform's ordering strategy; `undefined` means the ids are opaque. */
  ordering: MessageOrdering | undefined
  /** Where the fetched rows land. */
  store: Pick<LocalStore, 'appendTranscript'>
  /** Abort-fenced provider read; omitted when the host has no thread-history port. */
  fetchHistory?: (cutoffTs: string, afterTs: string | null) => Promise<ThreadHistoryEntry[]>
}

/** The turn's stable window. */
export type ThreadBackfillResult = {
  /** The wall-clock cutoff this turn snapshotted at, or `undefined` when it did not snapshot. */
  snapshotCutoffTs: string | undefined
  /** Is this id inside the turn's stable window? */
  withinSnapshot: (id: string) => boolean
}

/**
 * §8.4/§8.5 authoritative warm-thread snapshot (#649): Socket Mode is the low-latency
 * trigger, not an ordered/complete unread source. Slack may deliver a minutes-old event
 * only after the current agent turn has ended, while newer plain replies and even
 * @mentions already exist in conversations.replies. Snapshot every human mid-thread
 * activation through a fixed wall-clock cutoff, then assemble the prompt from that stable
 * window. Messages after the cutoff belong to the next turn. Agent-authored `messageAgent`
 * rows are first-class thread events too: the direct delivery is only an attention signal,
 * so its target snapshots/catches up exactly like a human-triggered turn.
 */
export async function backfillThreadHistory(input: ThreadBackfillInput): Promise<ThreadBackfillResult> {
  const { agentId, transcriptChannel, thread, markerBefore, ordering, store, fetchHistory } = input
  const snapshotCutoffTs =
    input.platform === 'slack' && thread !== input.ts && fetchHistory ? slackTsForWallClock(Date.now()) : undefined
  // Provider history and locally recorded rows share one test: an id the platform issued
  // must land at or before the wall-clock cutoff, while a synthetic / legacy coordinate —
  // which cannot be compared with a wall-clock marker at all — is always kept, so it stays
  // usable in tests and recovery. No cutoff (or no native ordering) means no window to fall
  // outside of.
  const withinSnapshot = (id: string): boolean =>
    snapshotCutoffTs === undefined || ordering === undefined || ordering.withinCutoff(id, snapshotCutoffTs)
  if (snapshotCutoffTs === undefined) return { snapshotCutoffTs, withinSnapshot }

  const history = await fetchHistory!(snapshotCutoffTs, markerBefore)
  for (const h of history) {
    // Provider history carries canonical platform ids; anything the provider
    // issued after the cutoff belongs to the next turn.
    if (!withinSnapshot(h.ts)) continue
    // Skip the agent's OWN messages: they're already recorded at the send boundary and
    // are always self-filtered from the model (participantGap in replay-plan). Re-recording
    // them here is redundant — and in `minimal` mode it produces a DUPLICATE transcript row,
    // because the send-boundary `recordReplySegment` stamps a monotonic ts while this path
    // uses the real Slack ts, so the (channel,thread,ts) dedup index can't collapse them
    // (low/medium/high record at the send boundary WITH the Slack ts, so they dedup).
    if (h.sender === agentId) continue
    await store.appendTranscript({
      channel: transcriptChannel,
      thread,
      ts: h.ts,
      sender: h.sender,
      ...(h.trustedAgentBot ? { trustedAgentBot: true } : {}),
      // Snapshotted thread history is context THIS agent's turn receives.
      recipient: agentId,
      kind: 'text',
      text: h.text
    })
  }
  return { snapshotCutoffTs, withinSnapshot }
}
