'use client'

// A coordinator's tasks as webchat threads (auto-session-mode.md §10): the rows its cards and dock thread read, and the thread's own messages.

import useSWR from 'swr'
import {
  fetchAssistantSubsession,
  fetchAssistantSubsessions,
  fetchSessionMessages,
  type AssistantSubsessionDto,
  type SessionHistoryDto,
  type SessionMessageDto
} from '@/lib/api'
import { CONSOLE_SWR_CONFIG } from '@/lib/console-swr'
import type { SessionStep } from '@/lib/data'

/** Rows the conversation's list reads in one page; a task older than these reads its own row. */
const ROWS_PAGE = 50
const RUNNING_POLL_MS = 5_000
const IDLE_POLL_MS = 30_000
/** Messages one thread read takes: the newest page; earlier ones are on the task's own page. */
const THREAD_PAGE = 50

const running = (row: AssistantSubsessionDto | undefined) => row?.state === 'open'

/** The conversation's rows: a map once read, null while that read is out, undefined where it is not listed or cannot be read. */
type ListedTasks = ReadonlyMap<string, AssistantSubsessionDto> | null | undefined

/** This conversation's tasks by their session id, read once for every card in it and polled faster while one runs. */
function useConversationTasks(agentId: string, parentSessionId: string | null): ListedTasks {
  const { data, error } = useSWR(
    parentSessionId ? ['conversation-tasks', agentId, parentSessionId] : null,
    ([, agent, parent]) => fetchAssistantSubsessions(agent, { parentSessionId: parent, limit: ROWS_PAGE }),
    {
      ...CONSOLE_SWR_CONFIG,
      keepPreviousData: true,
      refreshInterval: (page) =>
        page?.subsessions.some((row) => row.state === 'open') ? RUNNING_POLL_MS : IDLE_POLL_MS
    }
  )
  if (!parentSessionId || (error && !data)) return undefined
  if (!data) return null
  return new Map(data.subsessions.flatMap((row) => (row.sessionId ? [[row.sessionId, row] as const] : [])))
}

/** One task's row: its conversation's list when that carries it, else the task's own read. */
export function useTaskRow(
  agentId: string,
  sessionId: string,
  /** The conversation whose list to read it from; null reads the task alone. */
  parentSessionId: string | null
): AssistantSubsessionDto | undefined {
  const listed = useConversationTasks(agentId, parentSessionId)
  const fromList = listed?.get(sessionId)
  const { data } = useSWR(
    listed !== null && !fromList ? ['task-row', agentId, sessionId] : null,
    ([, agent, id]) => fetchAssistantSubsession(agent, id),
    {
      ...CONSOLE_SWR_CONFIG,
      refreshInterval: (row) => (running(row) ? RUNNING_POLL_MS : IDLE_POLL_MS)
    }
  )
  return fromList ?? data
}

/** A row's moment as an ISO string: the daemon's event time, else its own timestamp when that is a date. */
export function messageTime(m: Pick<SessionMessageDto, 'ts' | 'eventTimeUs'>): string | null {
  if (m.eventTimeUs !== undefined) return new Date(m.eventTimeUs / 1000).toISOString()
  const parsed = Date.parse(m.ts)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

/** The thread's spoken messages, oldest first; tool and reasoning rows stay on the task's own page. */
export function threadMessages(page: SessionHistoryDto | undefined): SessionMessageDto[] {
  return [...(page?.messages ?? [])]
    .filter((m) => (m.kind || 'text').toLowerCase() === 'text' && m.text.trim() !== '')
    .sort((a, b) => a.seq - b.seq)
}

/** The thread's newest page; re-read while the task runs, and whenever its row says something changed. */
export function useTaskThread(
  sessionId: string,
  row: AssistantSubsessionDto | undefined,
  options: { busy?: boolean } = {}
): { page: SessionHistoryDto | undefined; error: unknown; reload: () => Promise<unknown> } {
  // The row's summary time and state move when the task speaks, so they key a fresh read for an idle thread too.
  const version = `${row?.state ?? ''}:${row?.summaryUpdatedAt ?? ''}`
  const { data, error, mutate } = useSWR(
    ['task-thread', sessionId, version],
    ([, id]) => fetchSessionMessages(id, { limit: THREAD_PAGE }),
    {
      ...CONSOLE_SWR_CONFIG,
      keepPreviousData: true,
      refreshInterval: running(row) || options.busy ? RUNNING_POLL_MS : 0
    }
  )
  return { page: data, error, reload: () => mutate() }
}

/** One message as the thread draws it. */
export interface ThreadEntry {
  key: string
  who: 'agent' | 'person'
  name: string | null
  text: string
  at: string | null
  /** Still streaming, or sent and not yet on the daemon's record. */
  live: boolean
}

/** Persisted messages, then what this visit sent and is streaming back, which the next read retires. */
export function threadEntries(
  messages: readonly SessionMessageDto[],
  liveSteps: readonly SessionStep[],
  agentId: string
): ThreadEntry[] {
  const persisted: ThreadEntry[] = messages.map((m) => ({
    key: `m:${m.seq}`,
    who: m.sender === agentId ? 'agent' : 'person',
    name: m.senderName ?? null,
    text: m.text,
    at: messageTime(m),
    live: false
  }))
  const live = liveSteps.flatMap((step, i): ThreadEntry[] => {
    if (step.hidden || !step.text.trim()) return []
    if (step.kind === 'msg')
      return [{ key: `l:${i}`, who: 'person', name: null, text: step.text, at: null, live: true }]
    if (step.kind === 'done' && !step.demoted)
      return [{ key: `l:${i}`, who: 'agent', name: null, text: step.text, at: null, live: true }]
    return []
  })
  return [...persisted, ...live]
}
