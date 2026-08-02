import type { LocalStore, TranscriptEntry, TranscriptRow } from '../store/local-store.js'
import { NO_RESPONSE_SENTINEL } from './no-response.js'

export const MAX_CONTEXT_REFRESH_EVENTS = 50

/** How a delta row's sender is presented to the model. Resolved by the daemon edge
 *  (agent registry + CP collab snapshot + verified Slack bot authorship); the
 *  coordinator itself stays platform- and registry-agnostic. */
export interface ContextEventSender {
  /** Directory display name when known; callers fall back to the raw transcript sender. */
  label: string
  /** True only when the daemon VERIFIED this sender is another AgentConnect agent. */
  peerAgent: boolean
}

type SenderResolver = (event: TranscriptRow) => ContextEventSender | undefined

function renderEventRows(
  events: readonly TranscriptRow[],
  quoteFor?: (event: TranscriptRow) => string | undefined,
  senderFor?: SenderResolver
): string[] {
  return events.flatMap((event) => {
    const quote = quoteFor?.(event)
    const sender = senderFor?.(event)
    // A raw agent UUID gives the model no way to tell that a delta row is a peer
    // assistant's own answer rather than the human moving on — name it and say so.
    const label = sender?.peerAgent ? `${sender.label} (another agent)` : (sender?.label ?? event.sender)
    return [...(quote ? [quote] : []), `[${label}] ${event.text}`]
  })
}

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

  observeInbound(event: TranscriptEntry): void {
    this.store.appendTranscript(event)
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
        for (const event of snapshot.events) this.store.appendTranscript(event)
        completeness = snapshot.completeness
        providerCheckpoint = snapshot.checkpoint ?? providerCheckpoint
      } else {
        snapshotFailed = true
        this.onSnapshotFailure?.(lastError)
      }
    }

    // No await is allowed between these reads. One JavaScript turn therefore forms
    // the daemon-local observation fence: an ingress callback runs either before both
    // reads (and is included) or after both reads (and belongs to the next turn).
    const rows = this.store
      .transcriptSinceRevision(input.transcriptChannel, input.thread, input.afterRevision)
      .filter((row) => row.kind === 'text' && row.sender !== input.agentId)
      .sort((a, b) => a.eventTimeUs - b.eventTimeUs || a.seq - b.seq)
    const revision = this.store.threadTranscriptRevision(input.transcriptChannel, input.thread)

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
 *
 * Two headings, chosen by what actually churned. When the delta is ONLY peer-agent
 * replies (a parallel answer race, the multi-agent-webchat norm), the generic
 * "conversation changed — re-evaluate the task" wording reads as "you were scooped"
 * and steers the response-choice rule into declining COMPLEMENTARY answers (each
 * agent introducing itself, each reporting its own status). That branch instead
 * states the one decision that matters: the activation is still addressed to you —
 * deliver unless the peer replies made your answer fully redundant. Any human
 * message in the delta keeps the original re-evaluate framing: the task itself may
 * genuinely have changed. */
export function contextUpdateText(
  events: readonly TranscriptRow[],
  quoteFor?: (event: TranscriptRow) => string | undefined,
  senderFor?: SenderResolver
): string {
  const suffix = events.slice(-MAX_CONTEXT_REFRESH_EVENTS)
  const elided = events.length - suffix.length
  const peerOnly = events.length > 0 && events.every((event) => senderFor?.(event)?.peerAgent === true)
  const heading = peerOnly
    ? '(AgentConnect context update: while you were answering, other agents in this\n' +
      'conversation posted the replies below. The message that activated you is still\n' +
      'addressed to you, and you have not answered it yet; your previous candidate\n' +
      'answer was not delivered. If it still adds information the replies below do not\n' +
      'cover — especially anything only you can provide, such as your own identity,\n' +
      'status, or perspective — produce it again as your final answer, adjusted for\n' +
      `those replies. Reply \`${NO_RESPONSE_SENTINEL}\` only if those replies make your\n` +
      'answer fully redundant. Preserve useful work already completed, do not repeat\n' +
      'side effects blindly, and do not mention this retry unless it matters to the\n' +
      'user.)'
    : '(AgentConnect context update: the conversation changed while you were working.\n' +
      'Your previous candidate answer was not delivered. Re-evaluate the task using the new\n' +
      'thread messages below and produce a replacement final answer. Preserve useful work\n' +
      'already completed, do not repeat side effects blindly, and do not mention this retry\n' +
      'unless it matters to the user.)'
  const deltaLabel = peerOnly ? 'new replies from other agents' : 'new thread messages'
  const deltaHeading = elided > 0 ? `(${deltaLabel} — ${elided} earlier message(s) elided)` : `(${deltaLabel})`
  const rows = renderEventRows(suffix, quoteFor, senderFor)
  return `${heading}\n\n${deltaHeading}\n${rows.join('\n')}`
}

/** Initial-fence deltas use a shorter heading: there is no discarded candidate yet. */
export function initialContextDeltaText(
  events: readonly TranscriptRow[],
  quoteFor?: (event: TranscriptRow) => string | undefined,
  senderFor?: SenderResolver
): string {
  const suffix = events.slice(-MAX_CONTEXT_REFRESH_EVENTS)
  const elided = events.length - suffix.length
  const heading =
    elided > 0
      ? `(additional thread messages before this turn started — ${elided} earlier message(s) elided)`
      : '(additional thread messages before this turn started)'
  const rows = renderEventRows(suffix, quoteFor, senderFor)
  return `${heading}\n${rows.join('\n')}`
}
