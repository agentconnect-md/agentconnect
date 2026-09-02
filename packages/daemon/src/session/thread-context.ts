import {
  transcriptPromptText,
  type LocalStore,
  type TranscriptEntry,
  type TranscriptRow
} from '../store/local-store.js'

export const MAX_CONTEXT_REFRESH_EVENTS = 50

export type ContextCompleteness = 'authoritative' | 'observed-only'

export interface ThreadContextSnapshot {
  events: TranscriptEntry[]
  checkpoint?: string
  completeness: ContextCompleteness
}

export interface ContextRefresh {
  events: TranscriptRow[]
  revision: number
  providerCheckpoint?: string
  completeness: ContextCompleteness
  snapshotFailed: boolean
}

export interface ThreadContextRefreshInput {
  agentId: string
  transcriptChannel: string
  thread: string
  afterRevision: number
  providerCheckpoint?: string
  /** Provider I/O is deliberately supplied by the daemon edge. The coordinator
   * remains independent of Slack/Discord/Feishu SDKs and owns only reconciliation. */
  snapshot?: () => Promise<ThreadContextSnapshot>
  /** Read only rows this agent sent or received. Set by the daemon for sessions
   * on a synthetic pairwise `a2a:<caller>` thread, where every child of one
   * caller shares the physical thread but each row is a private pairwise
   * delivery — an unscoped refresh would show siblings' deliveries (#967). */
  scopeReadsToAgent?: boolean
}

const SNAPSHOT_ATTEMPTS = 3

/**
 * Reconciles provider snapshots with daemon-observed conversation rows. The local
 * transcript revision is the correctness fence; provider checkpoints are only an
 * incremental-read optimization and never become a cross-platform ordering key.
 */
export class ThreadContextCoordinator {
  constructor(
    private readonly store: LocalStore,
    private readonly onSnapshotFailure?: (error: unknown) => void
  ) {}

  async observeInbound(event: TranscriptEntry): Promise<void> {
    await this.store.appendTranscript(event)
  }

  async refresh(input: ThreadContextRefreshInput): Promise<ContextRefresh> {
    let completeness: ContextCompleteness = 'observed-only'
    let providerCheckpoint = input.providerCheckpoint
    let snapshotFailed = false

    if (input.snapshot) {
      let snapshot: ThreadContextSnapshot | undefined
      let lastError: unknown
      for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
        try {
          snapshot = await input.snapshot()
          break
        } catch (error) {
          lastError = error
          // Slack's low commercial tier may require a one-minute Retry-After. A
          // turn-final refresh must degrade immediately instead of multiplying the
          // request or blocking answer delivery for that interval.
          const code =
            typeof error === 'object' && error !== null && 'code' in error ? String(error.code).toLowerCase() : ''
          const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
          if (code.includes('ratelimit') || /rate[ _-]?limit/.test(message)) break
        }
      }
      if (snapshot) {
        // Provider history rows carry a platform author and no recipient: the refreshing
        // agent is what names the org that owns them on a shared store.
        for (const event of snapshot.events) await this.store.appendTranscript({ ...event, orgAgentId: input.agentId })
        completeness = snapshot.completeness
        providerCheckpoint = snapshot.checkpoint ?? providerCheckpoint
      } else {
        snapshotFailed = true
        this.onSnapshotFailure?.(lastError)
      }
    }

    // The fence is read BEFORE the rows and only ever moved up to a revision this read
    // actually returned, so a row appended between the two awaits is re-observed next
    // refresh (a harmless duplicate) instead of being skipped (a permanent gap).
    const fence = await this.store.threadTranscriptRevision(input.transcriptChannel, input.thread, input.agentId)
    const observed = input.scopeReadsToAgent
      ? await this.store.transcriptSinceRevisionForAgent(
          input.transcriptChannel,
          input.thread,
          input.afterRevision,
          input.agentId
        )
      : await this.store.transcriptSinceRevision(
          input.transcriptChannel,
          input.thread,
          input.afterRevision,
          input.agentId
        )
    const rows = observed
      .filter((row) => row.kind === 'text' && row.sender !== input.agentId)
      .sort((a, b) => a.eventTimeUs - b.eventTimeUs || a.seq - b.seq)
    const revision = observed.reduce((max, row) => Math.max(max, row.revision), fence)

    return {
      events: rows,
      revision,
      completeness,
      snapshotFailed,
      ...(providerCheckpoint ? { providerCheckpoint } : {})
    }
  }
}

/** Stable, provider-neutral replacement prompt. The bounded newest suffix matches
 * the daemon's existing replay cap and keeps chronological order inside the suffix.
 * `deliveredPrefix`: segments of the answer already committed at a tool/thought
 * boundary were delivered and stand — only the closing segment is regenerable. */
export function contextUpdateText(
  events: readonly TranscriptRow[],
  quoteFor?: (event: TranscriptRow) => string | undefined,
  opts?: { deliveredPrefix?: boolean }
): string {
  const suffix = events.slice(-MAX_CONTEXT_REFRESH_EVENTS)
  const elided = events.length - suffix.length
  const heading = opts?.deliveredPrefix
    ? '(AgentConnect context update: the conversation changed while you were working.\n' +
      'The parts of your answer written before your last tool or thinking step were\n' +
      'already delivered and stand; only the text after them was not. Re-evaluate with\n' +
      'the new thread messages below and produce a replacement for that undelivered part\n' +
      'alone — do not repeat what was already delivered, do not repeat side effects\n' +
      'blindly, and do not mention this retry unless it matters to the user.)'
    : '(AgentConnect context update: the conversation changed while you were working.\n' +
      'Your previous candidate answer was not delivered. Re-evaluate the task using the new\n' +
      'thread messages below and produce a replacement final answer. Preserve useful work\n' +
      'already completed, do not repeat side effects blindly, and do not mention this retry\n' +
      'unless it matters to the user.)'
  const deltaHeading =
    elided > 0 ? `(new thread messages — ${elided} earlier message(s) elided)` : '(new thread messages)'
  const rows = suffix.flatMap((event) => {
    const quote = quoteFor?.(event)
    return [...(quote ? [quote] : []), `[${event.sender}] ${transcriptPromptText(event)}`]
  })
  return `${heading}\n\n${deltaHeading}\n${rows.join('\n')}`
}

/** Initial-fence deltas use a shorter heading: there is no discarded candidate yet. */
export function initialContextDeltaText(
  events: readonly TranscriptRow[],
  quoteFor?: (event: TranscriptRow) => string | undefined
): string {
  const suffix = events.slice(-MAX_CONTEXT_REFRESH_EVENTS)
  const elided = events.length - suffix.length
  const heading =
    elided > 0
      ? `(additional thread messages before this turn started — ${elided} earlier message(s) elided)`
      : '(additional thread messages before this turn started)'
  const rows = suffix.flatMap((event) => {
    const quote = quoteFor?.(event)
    return [...(quote ? [quote] : []), `[${event.sender}] ${transcriptPromptText(event)}`]
  })
  return `${heading}\n${rows.join('\n')}`
}
