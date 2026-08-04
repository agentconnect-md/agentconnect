// Merged conversation view — the pure cross-source transcript merge
// (merged-conversation-view.md §6). Pure functions over per-member message
// pages so union/dedupe/ordering are unit-testable, mirroring how
// webchat-lanes.ts isolates lane resolution.
//
// The one non-pure-lib import is the platform registry, which the per-platform
// duplicate-identity rule now lives behind (§10). It costs no route its bundle:
// unlike `lib/data.ts` — the reason `lib/platform-labels.ts` keeps its own
// table — this module is imported by SessionDetailView alone, and the console
// shell already mounts `ModalProvider` → `AddIntegrationModal` → the registry
// on every route it renders.

import { platformMessageIdentity } from '@/components/console/platforms/registry'
import type { SessionMessageDto } from '@/lib/api'

/** One member session's transcript page, in the order the daemon served it
 *  (each source is internally chronological; the merge preserves that
 *  relative order — a stable merge). Callers MUST pass sources in canonical
 *  sessionId order — never an activity-derived order, which is mutable: the
 *  FIRST source holding a duplicate wins when no author copy exists, and a
 *  reordered source list would flip the surviving copy between refreshes. */
export interface MergeSource {
  sessionId: string
  agentId: string
  /** The conversation's platform — selects the duplicate-identity rule. */
  platform: string
  rows: SessionMessageDto[]
}

export interface MergedRow {
  row: SessionMessageDto
  sourceSessionId: string
  sourceAgentId: string
  /** The platform of the source this copy came from — the key the transcript
   *  resolves its text renderer with (§10). Carried out of the merge rather
   *  than re-derived by the caller so a row can never be rendered under a
   *  neighbour's platform: sources interleave by event time, so this varies
   *  ROW BY ROW and any per-conversation shortcut would be wrong. */
  sourcePlatform: string
  /** Maximal owner-authored run in the source transcript. Conversation rendering
   *  uses this to preserve the same bot blocks a single-session page would build,
   *  even after another participant's private work interleaves by event time. */
  sourceTurnKey?: string
  /** True when this copy came from its author's own transcript (full
   *  fidelity); the merge prefers it over recipient copies. */
  authorCopy: boolean
}

/**
 * Normalize the timestamp forms stored in transcript rows onto one
 * epoch-microsecond axis — the ordering coordinate. Mirrors the daemon
 * store's own chronological reader (`transcriptEventTimeUs`,
 * packages/daemon/src/store/local-store.ts): raw `ts` mixes domains
 * (platform decimal seconds vs daemon millisecond stamps) and must never be
 * compared for order directly.
 *
 * - Slack text rows: decimal epoch seconds with up to microsecond precision.
 * - daemon-local activity/replies: integer epoch milliseconds (optionally
 *   `local-` prefixed).
 * - hook rows: epoch milliseconds with a deterministic `|delivery-id` suffix.
 * - legacy/synthetic integer seconds and ISO timestamps.
 *
 * Unknown/unsafe values fall back to 0 — they sort first and stay stable via
 * the per-source order.
 */
export function transcriptEventTimeUs(ts: string | null | undefined): number {
  let raw = ts?.trim() ?? ''
  if (!raw) return 0
  const local = raw.startsWith('local-')
  if (local) raw = raw.slice('local-'.length)
  raw = raw.split('|', 1)[0] ?? ''

  // Discord snowflakes: creation ms in the top 42 bits (BigInt — they exceed
  // Number's safe range, and the generic integer branch below would overflow
  // them to 0).
  if (/^\d{16,20}$/.test(raw)) {
    const ms = Number((BigInt(raw) >> 22n) + 1_420_070_400_000n)
    return Number.isSafeInteger(ms * 1_000) && ms > 0 ? ms * 1_000 : 0
  }

  const decimal = /^(\d+)\.(\d+)$/.exec(raw)
  if (decimal) {
    const seconds = Number(decimal[1]!)
    const micros = Number(decimal[2]!.slice(0, 6).padEnd(6, '0'))
    return safeEventTimeUs(seconds * 1_000_000 + micros)
  }

  if (/^\d+$/.test(raw)) {
    const value = Number(raw)
    // Match the daemon: 10-digit-era values are epoch seconds; modern 13-digit
    // values (and every explicit `local-` value) are epoch milliseconds.
    const micros = local || value >= 10_000_000_000 ? value * 1_000 : value * 1_000_000
    return safeEventTimeUs(micros)
  }

  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) && Number.isSafeInteger(parsed * 1_000) ? parsed * 1_000 : 0
}

function safeEventTimeUs(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * The provenance-explicit duplicate identity of a row, or null when the row
 * must never dedupe across sources (§6 step 2). Two rules are CORE — they
 * belong to no platform — and the third is the platform module's:
 *
 * - only `kind === 'text'` rows dedupe — a coincidental `ts` collision with a
 *   work-lane row is inert by construction;
 * - webchat: the canonical `postId` — minted once at origin, identical on
 *   every copy regardless of a collision-bumped `ts`. Rows without one
 *   (daemon-local a2a report-backs, pre-upgrade rows) never dedupe: failing
 *   toward a visible duplicate, never toward data loss. Webchat has no bot
 *   identity to install and therefore no platform module, so this arm is the
 *   host's for good;
 * - everything else: the owning module's `messageIdentity` (§10) — the
 *   provider-native id shape, chosen so a daemon-local 13-digit
 *   `monotonicTs()` millisecond stamp can never match it.
 *
 * AN UNREGISTERED PLATFORM ID NOW DEDUPES NOTHING. It used to take Slack's
 * decimal-`ts` rule, purely because Slack sat in the fall-through arm of an
 * if-chain; the published contract says the opposite (absent ⇒ never dedupe),
 * and the contract is right. Deduping is the only step here that can DELETE a
 * row from the transcript, so guessing that an unknown provider numbers its
 * messages the way Slack does is a guess in the one direction §6 forbids —
 * "toward a visible duplicate, never toward data loss".
 */
export function duplicateIdentity(platform: string, row: SessionMessageDto): string | null {
  if (row.kind !== 'text') return null
  if (platform === 'webchat') return row.postId ? `post:${row.postId}` : null
  return platformMessageIdentity(platform, row)
}

/**
 * Union the sources' rows, dedupe copies by provenance-explicit identity with
 * author-copy precedence, and order on the normalized event-time axis.
 *
 * Ordering is a STABLE merge: rows compare by `eventTimeUs`; ties break by
 * source (deterministic across reloads) and then by each source's own row
 * order, so a source's internal sequence is never reordered.
 */
export function mergeConversation(sources: MergeSource[]): MergedRow[] {
  type Decorated = MergedRow & { us: number; order: number }
  const kept: Decorated[] = []
  // Identity → index into `kept`, so the author-copy replacement is O(1)
  // instead of an indexOf scan per duplicate.
  const byIdentity = new Map<string, { at: number; entry: Decorated }>()
  let order = 0
  for (const source of sources) {
    let sourceTurn = 0
    let previousWasAuthor = false
    for (const row of source.rows) {
      const authorCopy = row.sender === source.agentId
      if (authorCopy && !previousWasAuthor) sourceTurn += 1
      previousWasAuthor = authorCopy
      const candidate: Decorated = {
        row,
        sourceSessionId: source.sessionId,
        sourceAgentId: source.agentId,
        sourcePlatform: source.platform,
        ...(authorCopy ? { sourceTurnKey: `${source.sessionId}\u0000${sourceTurn}` } : {}),
        authorCopy,
        // Prefer the daemon's stored axis (provider-authoritative for
        // Telegram/Feishu, whose ids carry no time); a missing/zero value
        // falls back to deriving from `ts` (which handles snowflakes).
        us: row.eventTimeUs && row.eventTimeUs > 0 ? row.eventTimeUs : transcriptEventTimeUs(row.ts),
        order: order++
      }
      const identity = duplicateIdentity(source.platform, row)
      if (identity === null) {
        kept.push(candidate)
        continue
      }
      const previous = byIdentity.get(identity)
      if (!previous) {
        byIdentity.set(identity, { at: kept.length, entry: candidate })
        kept.push(candidate)
      } else if (!previous.entry.authorCopy && candidate.authorCopy) {
        // The author copy is the full-fidelity one — replace the recipient
        // copy IN PLACE (keeping its coordinates is wrong: the author's
        // canonical position wins for placement).
        kept[previous.at] = candidate
        byIdentity.set(identity, { at: previous.at, entry: candidate })
      }
    }
  }
  // Hierarchical, TRANSITIVE tie-break: equal timestamps group by source first
  // (deterministic across reloads), and within a source the original row order
  // decides — a source's own sequence is never reordered. (A sender-first
  // tie-break would both reverse same-source rows and break comparator
  // transitivity across sources.)
  kept.sort((a, b) => {
    if (a.us !== b.us) return a.us - b.us
    if (a.sourceSessionId !== b.sourceSessionId) return a.sourceSessionId < b.sourceSessionId ? -1 : 1
    return a.order - b.order
  })
  return kept.map(({ row, sourceSessionId, sourceAgentId, sourcePlatform, sourceTurnKey, authorCopy }) => ({
    row,
    sourceSessionId,
    sourceAgentId,
    sourcePlatform,
    ...(sourceTurnKey ? { sourceTurnKey } : {}),
    authorCopy
  }))
}
