import { SLACK_RESPONSE_FINAL_EVENT_TAG } from '@agentconnect.md/message'
import type { LocalStore } from '../../store/local-store.js'
import type { Attachment, NormalizedMessage } from '../../messages/normalized.js'
import { attachmentMention, hydrateTranscriptImage, transcriptImageAttachments } from '../attachment-block.js'

/** The two transcript seams the ingest owns — the slot probe and the row append. */
type IngestStore = Pick<LocalStore, 'transcriptTextAt' | 'appendTranscript'>

/** What a probe found sitting on a candidate webchat slot. */
export interface SlotOccupant {
  sender: string
  text: string
  postId: string | null
}

/** The identity a webchat row must carry to be recognized as this same post. */
export interface SlotClaim {
  sender: string
  text: string
  /** Canonical relay-minted post id, when the turn carries one. */
  postId?: string
}

/** Webchat rows dedup on (channel, thread, ts) alone, and a carried canonical `at` can land
 *  on a millisecond a DIFFERENT post (a peer's context copy) already occupies on this daemon —
 *  walk forward to the first free-or-same slot instead of letting INSERT OR IGNORE silently
 *  drop this message. An identical row (the co-hosted-participant fan-out case) keeps the
 *  shared slot. Pure: the caller injects the probe. */
export async function probeWebchatSlot(
  start: string,
  claim: SlotClaim,
  probe: (ts: string) => Promise<SlotOccupant | undefined>
): Promise<string> {
  let slot = BigInt(start)
  for (let attempt = 0; attempt < 32; attempt++) {
    const existing = await probe(String(slot))
    // Mirror the daemon-side probe (§6): matching canonical postId is what proves the occupant
    // is this same post; (sender, text) only decides for legacy rows without an id on either side.
    const samePost =
      existing !== undefined &&
      (claim.postId && existing.postId
        ? existing.postId === claim.postId
        : existing.sender === claim.sender && existing.text === claim.text)
    if (!existing || samePost) break
    slot += 1n
  }
  return String(slot)
}

export interface TranscriptIngestInput {
  store: IngestStore
  /** The agent this activation runs for — the transcript row's recipient. */
  agentId: string
  msg: NormalizedMessage
  /** The conversation's transcript channel, already resolved by the caller. */
  transcriptChannel: string
  /** The SESSION coordinate — it names the admission, never the row. */
  thread: string
  /** The PHYSICAL platform thread the row itself carries. */
  deliveryThread: string
  /** `sessions.key` this delivery is admitted into. */
  sessionKey: string
  ts: string
  /** Download an inbound attachment's bytes (§9.2); resolves null when unavailable. */
  download: (att: Attachment) => Promise<Buffer | null>
  /** Inline cap (bytes) for attachments; files over it stay un-hydrated. */
  attachmentMaxBytes?: number
}

export interface TranscriptIngestResult {
  /** The ts the row actually landed on — bumped when a webchat slot was already taken. */
  ts: string
  /** The inbound attachments after image hydration; their bytes are memoized on the
   *  attachment objects and reused by the prompt blocks (one fetch per image). */
  attachments: Attachment[] | undefined
}

/**
 * Record the triggering message in the transcript (with an attachment mention for prompt
 * replay; a bounded inline image stays daemon-local for UI replay). A platform image is only
 * an auth-gated URL, so fetch it here — the bytes are memoized on the attachment and reused
 * by the prompt blocks the caller builds later.
 */
export async function ingestInboundTranscript(input: TranscriptIngestInput): Promise<TranscriptIngestResult> {
  const { store, agentId, msg, transcriptChannel } = input
  await hydrateTranscriptImage(msg.attachments, {
    download: input.download,
    ...(input.attachmentMaxBytes !== undefined ? { maxBytes: input.attachmentMaxBytes } : {})
  })
  const mention = attachmentMention(msg.attachments)
  const transcriptAttachments = transcriptImageAttachments(msg.attachments)
  const transcriptText = mention ? `${msg.text}\n${mention}`.trim() : msg.text
  // Webchat only, so it never collides with a step-1 row: chat ingress is what writes those, and
  // webchat is not chat ingress (message-intake.md §5 step 1).
  const ts =
    msg.platform === 'webchat'
      ? await probeWebchatSlot(
          input.ts,
          {
            sender: msg.sender.id,
            text: transcriptText,
            ...(msg.transcriptPostId ? { postId: msg.transcriptPostId } : {})
          },
          async (slot) =>
            await store.transcriptTextAt(transcriptChannel, slot, { sender: msg.sender.id, recipient: agentId })
        )
      : input.ts
  await store.appendTranscript({
    channel: transcriptChannel,
    thread: input.deliveryThread,
    admission: { agentId, sessionKey: input.sessionKey },
    ts,
    sender: msg.sender.id,
    // The canonical webchat post identity travels with the canonical ts —
    // identical on every participant copy even when `ts` was bumped (§6).
    ...(msg.transcriptPostId ? { postId: msg.transcriptPostId } : {}),
    // Provider send time for platforms whose message ids are not chronological
    // (Telegram/Feishu; Discord decodes its snowflake at normalization) — the
    // merged conversation view orders on this axis.
    ...(msg.platformTimeMs ? { eventTimeUs: msg.platformTimeMs * 1000 } : {}),
    // First-delivery provenance; the admission above is what the session's view reads.
    recipient: agentId,
    // A response finalization is the same Slack message as the post that opened it, so
    // it lands on that row and refreshes it to the completed text.
    ...(msg.ingressEventTag === SLACK_RESPONSE_FINAL_EVENT_TAG ? { authoritative: true } : {}),
    kind: 'text',
    text: transcriptText,
    // The model prompt and platform facts behind the row, when the turn assembled them.
    ...(msg.turnBody ? { body: JSON.stringify(msg.turnBody) } : {}),
    ...(transcriptAttachments.length ? { attachments: transcriptAttachments } : {})
  })
  return { ts, attachments: msg.attachments }
}
