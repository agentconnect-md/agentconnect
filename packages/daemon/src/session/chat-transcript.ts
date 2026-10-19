import type { SessionImageAttachment, SharedImage } from '@agentconnect.md/protocol'
import type { LocalStore, TranscriptAdmission } from '../store/local-store.js'
import { monotonicTs } from '../store/monotonic-ts.js'

// Append one canonical chat post without letting a distinct same-millisecond post steal its row.
export async function appendChatTextRow(
  store: LocalStore,
  channel: string,
  thread: string,
  ts: string,
  entry: {
    sender: string
    recipient?: string
    admission?: TranscriptAdmission
    text: string
    // Canonical post identity survives admission and cross-daemon transcript merging.
    postId?: string
    trustedAgentBot?: boolean
    attachments?: SessionImageAttachment[]
    sharedImage?: SharedImage
  }
): Promise<string> {
  let slot = BigInt(ts)
  for (let attempt = 0; attempt < 32; attempt++) {
    const existing = await store.transcriptTextAt(channel, String(slot), entry)
    // Prefer canonical post identity; older rows fall back to matching author and text.
    const samePost =
      existing !== undefined &&
      (entry.postId && existing.postId
        ? existing.postId === entry.postId
        : existing.sender === entry.sender && existing.text === entry.text)
    if (!existing || samePost) {
      await store.appendTranscript({ channel, thread, ts: String(slot), kind: 'text', ...entry })
      return String(slot)
    }
    slot += 1n
  }
  // Pathological pile-up — fall back to the process-monotonic clock (locally unique).
  const fallback = monotonicTs()
  await store.appendTranscript({ channel, thread, ts: fallback, kind: 'text', ...entry })
  return fallback
}
