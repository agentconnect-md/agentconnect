// A coordinator page's threads (webchat-threads.md §6, §7): its platform's thread shape, what its rows and live steps say about them, and which one opens on its own.

import type { SessionMessageDto } from '@/lib/api'
import type { SessionStep } from '@/lib/data'
import type { WebThreadShape } from '@/components/console/platforms/contract'
import { platformThreadShape } from '@/components/console/platforms/registry'

/** A daemon or relay that serves a coordinator's threads (protocol `WEBCHAT_THREADS_FEATURE`). */
export const WEBCHAT_THREADS_FEATURE = 'webchat-threads-v1'

/** A daemon or relay that carries a continued coordinator's message into one of its platform's threads (protocol `CONTINUATION_THREADS_FEATURE`). */
export const CONTINUATION_THREADS_FEATURE = 'continuation-threads-v1'

/** The prefix the coordinator names a delivered message by (daemon `coordinatorMessageId`). */
const COORDINATOR_MESSAGE_ID_PREFIX = 'msg-'

/** A webchat thread is named by its root's postId, a UUID (protocol `WebchatThreadId`). */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isThreadId(id: string | null | undefined): id is string {
  return !!id && THREAD_ID.test(id)
}

/** Webchat's thread shape, core's own since webchat is no platform module; a continued task takes the thread it is written in (§6.3). */
export const WEBCHAT_THREAD_SHAPE: WebThreadShape = { isThreadId, continuesInThread: true }

/** A platform's thread shape: webchat's, else what its module declares; undefined keeps the flat transcript. */
export function threadShapeOf(platform: string | null | undefined): WebThreadShape | undefined {
  return platform === 'webchat' ? WEBCHAT_THREAD_SHAPE : platformThreadShape(platform ?? undefined)
}

/** Whether an id names a thread in this shape. */
export function namesThread(shape: WebThreadShape | undefined, id: string | null | undefined): id is string {
  return !!shape && !!id && shape.isThreadId(id)
}

/** The thread a coordinator's `replyToMessage` call answered in, read off its tool row; undefined for any other row. */
export function replyToMessageThread(
  m: Pick<SessionMessageDto, 'kind' | 'body' | 'thread' | 'toolStatus'>,
  shape: WebThreadShape = WEBCHAT_THREAD_SHAPE
): string | undefined {
  if ((m.kind || '').toLowerCase() !== 'tool' || !m.body || m.toolStatus === 'failed') return undefined
  let input: unknown
  try {
    input = (JSON.parse(m.body) as { rawInput?: unknown }).rawInput
  } catch {
    return undefined
  }
  if (!input || typeof input !== 'object') return undefined
  const { action, messageId } = input as { action?: unknown; messageId?: unknown }
  if (action !== 'replyToMessage') return undefined
  // The row sits on the thread its turn answered in, which is where the reply was posted; the message id is its fallback.
  if (m.thread) return m.thread
  if (typeof messageId !== 'string' || !messageId.startsWith(COORDINATOR_MESSAGE_ID_PREFIX)) return undefined
  const id = messageId.slice(COORDINATOR_MESSAGE_ID_PREFIX.length)
  return namesThread(shape, id) ? id : undefined
}

/** The threads agents spoke in this visit, oldest first by their latest step. */
export function liveReplyThreads(steps: readonly SessionStep[]): string[] {
  const order = new Map<string, number>()
  steps.forEach((step, i) => {
    if (step.thread && step.kind !== 'msg') order.set(step.thread, i)
  })
  return [...order.entries()].sort((a, b) => a[1] - b[1]).map(([thread]) => thread)
}

/** A root's first words, for the label of a turn that answered in its thread. */
export function firstWords(text: string, max = 60): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  const cut = line.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`
}

/** What the page has seen of its threads, so only a first reply that starts while the reader watches opens one. */
export interface ThreadAutoOpen {
  /** Each root's reply count when the page first saw it. */
  firstReplies: Map<string, number>
  /** Threads agents had spoken in this visit before the page looked; null until it first does. */
  liveSeen: Set<string> | null
  opened: Set<string>
}

export function threadAutoOpen(): ThreadAutoOpen {
  return { firstReplies: new Map(), liveSeen: null, opened: new Set() }
}

/** The thread to open now, the latest whose first reply started since the page opened; records what it saw. */
export function threadToAutoOpen(
  state: ThreadAutoOpen,
  roots: Iterable<{ rootId: string; replies: number }>,
  liveThreads: readonly string[]
): string | undefined {
  const candidates: string[] = []
  const first = state.liveSeen === null
  for (const { rootId, replies } of roots) {
    const seen = state.firstReplies.get(rootId)
    if (seen === undefined) state.firstReplies.set(rootId, replies)
    else if (seen === 0 && replies > 0) candidates.push(rootId)
  }
  const liveSeen = state.liveSeen ?? new Set<string>()
  state.liveSeen = liveSeen
  for (const thread of liveThreads) {
    if (liveSeen.has(thread)) continue
    liveSeen.add(thread)
    // A thread that already had replies when the page opened was there before the reader watched.
    if (!first && (state.firstReplies.get(thread) ?? 0) === 0) candidates.push(thread)
  }
  const fresh = candidates.filter((id) => !state.opened.has(id))
  for (const id of fresh) {
    state.opened.add(id)
    state.firstReplies.set(id, Math.max(1, state.firstReplies.get(id) ?? 0))
  }
  return fresh[fresh.length - 1]
}

/** A turn as `splitThreadWork` reads it: a person's or an agent's, the agent's with its steps. */
interface SplittableTurn {
  kind: 'user' | 'bot'
  key: string
  agentId?: string
  steps?: readonly { thread?: string }[]
}

/** Moves the coordinator's thread-stamped steps off the main timeline into per-root turns; a turn left empty is dropped. */
export function splitThreadWork<T extends SplittableTurn>(
  turns: readonly T[],
  coordinatorId: string | undefined
): { main: T[]; byThread: ReadonlyMap<string, T[]> } {
  const main: T[] = []
  const byThread = new Map<string, T[]>()
  for (const turn of turns) {
    if (turn.kind !== 'bot' || !coordinatorId || turn.agentId !== coordinatorId || !turn.steps) {
      main.push(turn)
      continue
    }
    const roots = [...new Set(turn.steps.flatMap((step) => (step.thread ? [step.thread] : [])))]
    if (roots.length === 0) {
      main.push(turn)
      continue
    }
    for (const root of roots)
      byThread.set(root, [
        ...(byThread.get(root) ?? []),
        { ...turn, key: `${turn.key}:in:${root}`, steps: turn.steps.filter((step) => step.thread === root) }
      ])
    const rest = turn.steps.filter((step) => !step.thread)
    if (rest.length > 0) main.push({ ...turn, steps: rest })
  }
  return { main, byThread }
}
