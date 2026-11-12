// What a coordinator is shown of a thread it meets part-way (auto-session-mode.md §4.1).
import type { MessageOrdering } from '../platforms/message-ordering.js'
import type { ThreadHistoryEntry } from '../session/turn/thread-backfill.js'
import { coordinatorMessageId, type CoordinatorThread } from './coordinator-prompt.js'
import { inThread, platformMessageIdOf, type DeliveredMessage } from './coordinator-turns.js'

/** How many of a thread's earlier messages an excerpt shows: its root and the newest of the rest. */
export const THREAD_EXCERPT_MESSAGES = 20
/** How much of one earlier message an excerpt shows. */
export const THREAD_EXCERPT_CHARS = 1_500

export interface CoordinatorThreadContextInput {
  agentId: string
  /** The turn's batch. */
  messages: readonly DeliveredMessage[]
  /** The platform's ordering; without one its ids are opaque and no thread is read. */
  ordering: MessageOrdering | undefined
  /** Whether the coordinator was already given a message of the thread other than those at `exceptIds`. */
  holds(thread: string, exceptIds: readonly string[]): Promise<boolean>
  /** The thread's messages up to `beforeId`, read with the connection that received `integrationId`'s message. */
  fetchHistory(thread: string, beforeId: string, integrationId: string | undefined): Promise<ThreadHistoryEntry[]>
  warn(message: string): void
}

const clipped = (text: string): string =>
  text.length > THREAD_EXCERPT_CHARS ? `${text.slice(0, THREAD_EXCERPT_CHARS)}… [cut]` : text

/** The earlier messages of each thread the batch reaches into and the coordinator holds nothing of, as a thread session catches up one it joins part-way. */
export async function coordinatorThreadContext(input: CoordinatorThreadContextInput): Promise<CoordinatorThread[]> {
  const { ordering } = input
  if (!ordering) return []
  const byThread = new Map<string, DeliveredMessage[]>()
  for (const message of input.messages) {
    const thread = message.msg.thread
    if (message.report || thread === undefined || !inThread(message.msg)) continue
    // A coordinate the platform never issued names no thread it can read.
    if (ordering.coordinate(thread) === null) continue
    byThread.set(thread, [...(byThread.get(thread) ?? []), message])
  }
  const threads: CoordinatorThread[] = []
  for (const [thread, delivered] of byThread) {
    try {
      const ids = delivered.map((message) => platformMessageIdOf(message.msg))
      if (await input.holds(thread, ids)) continue
      const first = ids.reduce((a, b) => (ordering.compare(b, a) < 0 ? b : a))
      const earlier = (await input.fetchHistory(thread, first, delivered[0]!.integrationId))
        .filter((row) => ordering.coordinate(row.ts) !== null && ordering.compare(row.ts, first) < 0)
        .sort((a, b) => ordering.compare(a.ts, b.ts))
      if (earlier.length === 0) continue
      const kept =
        earlier.length > THREAD_EXCERPT_MESSAGES
          ? [earlier[0]!, ...earlier.slice(1 - THREAD_EXCERPT_MESSAGES)]
          : earlier
      threads.push({
        id: coordinatorMessageId(thread),
        earlier: kept.map((row) => ({
          from: row.sender === input.agentId ? 'you' : row.sender,
          text: clipped(row.text)
        })),
        ...(kept.length < earlier.length ? { elided: earlier.length - kept.length } : {})
      })
    } catch (err) {
      input.warn(`reading thread ${thread} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return threads
}
