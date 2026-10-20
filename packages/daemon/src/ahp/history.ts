import { createHash } from 'node:crypto'
import { MessageKind, ResponsePartKind, TurnState, type Turn } from '@microsoft/agent-host-protocol'
import { AHP_MAX_MESSAGE_BYTES, ToolBody } from '@agentconnect.md/protocol'
import { z } from 'zod'
import { hasNativeMessageOrder } from '../platforms/message-ordering.js'
import { transcriptChannelKey, type LocalStore, type TranscriptRow } from '../store/local-store.js'

export interface AhpHistoryScope {
  orgId: string
  agentId: string
  sessionId: string
  cursor?: string
  limit?: number
}

export interface AhpHistoryPage {
  turns: Turn[]
  hasMore: boolean
  cursor?: string
}

const Cursor = z.strictObject({
  version: z.literal(1),
  orgId: z.string().min(1).max(64),
  agentId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  order: z.enum(['seq', 'event']),
  seq: z.number().int().positive(),
  eventTimeUs: z.number().int().nonnegative()
})

// Opaque cursors are read positions, never authority; every page independently uses its verified scope.
function decodeCursor(scope: AhpHistoryScope, order: 'seq' | 'event'): z.infer<typeof Cursor> | undefined {
  if (scope.cursor === undefined) return undefined
  if (!/^history:[A-Za-z0-9_-]+$/.test(scope.cursor) || scope.cursor.length > 2048)
    throw Error('Invalid history cursor')
  const encoded = scope.cursor.slice('history:'.length)
  const bytes = Buffer.from(encoded, 'base64url')
  if (bytes.toString('base64url') !== encoded) throw Error('Invalid history cursor')
  const cursor = Cursor.parse(JSON.parse(bytes.toString('utf8')))
  if (
    cursor.orgId !== scope.orgId ||
    cursor.agentId !== scope.agentId ||
    cursor.sessionId !== scope.sessionId ||
    cursor.order !== order
  )
    throw Error('History cursor scope mismatch')
  return cursor
}

function clip(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  return bytes.length <= maxBytes
    ? text
    : bytes
        .subarray(0, maxBytes - 4)
        .toString('utf8')
        .replace(/\ufffd$/, '') + '…'
}

// Old rows have no durable turn identity or final outcome; these are completed imports, not reconstructed executions.
function importRecord(row: TranscriptRow, mask: (value: string) => string): Turn {
  const postId =
    row.postId && row.postId.length <= 256
      ? row.postId
      : row.postId
        ? createHash('sha256').update(row.postId).digest('hex')
        : undefined
  const id = postId ? `history:post:${postId}` : `history:row:${row.seq}`
  let text = row.text
  if (row.kind === 'tool' && row.body) {
    try {
      const parsed = ToolBody.safeParse(JSON.parse(row.body))
      if (parsed.success) {
        const { status, rawInput: input, rawOutput: output, content } = parsed.data
        text += `\n${JSON.stringify({ status, input, output, content })}`
      }
    } catch {
      /* Corrupt optional detail cannot hide the visible transcript text. */
    }
  }
  const at = row.eventTimeUs / 1000
  return {
    id,
    ...(Number.isFinite(at) && at > 0 && at <= 8.64e15 ? { startedAt: new Date(at).toISOString() } : {}),
    message: {
      text: `Historical ${row.kind} record`,
      origin: { kind: MessageKind.SystemNotification },
      _meta: {
        'agentconnect.md.history': {
          originalOutcome: 'unknown',
          kind: row.kind,
          sender: clip(mask(row.sender), 256),
          seq: row.seq,
          ...(postId ? { postId } : {})
        }
      }
    },
    responseParts: [
      {
        kind: row.kind === 'reasoning' ? ResponsePartKind.Reasoning : ResponsePartKind.Markdown,
        id: `${id}:record`,
        content: clip(mask(text), 4096)
      },
      {
        kind: ResponsePartKind.SystemNotification,
        content: 'Imported transcript record. Original turn boundaries and execution outcome are unavailable.'
      }
    ],
    usage: undefined,
    state: TurnState.Complete
  }
}

// Bounded pages from the sole authoritative transcript; no runtime, optimistic messages, or recovery state is created.
export async function readAhpHistory(
  store: Pick<LocalStore, 'getSessionByOutwardIdOnly' | 'transcriptPageForAgent' | 'transcriptPageForAgentByEventTime'>,
  scope: AhpHistoryScope,
  mask: (value: string) => string
): Promise<AhpHistoryPage> {
  if (scope.limit !== undefined && (!Number.isSafeInteger(scope.limit) || scope.limit < 1))
    throw Error('Invalid history page limit')
  const limit = Math.min(scope.limit ?? 30, 100)
  const session = await store.getSessionByOutwardIdOnly(scope.sessionId, scope.agentId)
  if (!session) throw Error('Unknown session')
  const order = hasNativeMessageOrder(session.platform) ? 'event' : 'seq'
  const cursor = decodeCursor(scope, order)
  const readScope = {
    orgId: scope.orgId,
    agentId: scope.agentId,
    sessionKey: session.key,
    transcriptChannel: transcriptChannelKey(session.channel, session.transportScope),
    coordinate: session.thread
  }
  const page =
    order === 'event'
      ? await store.transcriptPageForAgentByEventTime(
          readScope,
          cursor ? { eventTimeUs: cursor.eventTimeUs, seq: cursor.seq } : null,
          limit
        )
      : await store.transcriptPageForAgent(readScope, cursor?.seq ?? null, limit)
  const turns: Turn[] = []
  let bytes = 0
  for (const row of page.rows) {
    const turn = importRecord(row, mask)
    const size = Buffer.byteLength(JSON.stringify(turn))
    if (turns.length && bytes + size > AHP_MAX_MESSAGE_BYTES / 2) break
    turns.push(turn)
    bytes += size
  }
  const hasMore = page.hasMore || turns.length < page.rows.length
  const last = page.rows[turns.length - 1]
  const next =
    hasMore && last
      ? `history:${Buffer.from(
          JSON.stringify({
            version: 1,
            orgId: scope.orgId,
            agentId: scope.agentId,
            sessionId: scope.sessionId,
            order,
            seq: last.seq,
            eventTimeUs: last.eventTimeUs
          })
        ).toString('base64url')}`
      : undefined
  return { turns: turns.reverse(), hasMore, ...(next ? { cursor: next } : {}) }
}
