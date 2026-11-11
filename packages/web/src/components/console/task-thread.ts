'use client'

// A coordinator's threads (auto-session-mode.md §10, webchat-threads.md §6.2): the task rows its footers and panel read, and a thread's messages from its record or its task's session.

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import {
  ApiError,
  fetchAssistantSubsession,
  fetchAssistantSubsessions,
  fetchSessionMessages,
  fetchSessionThreadMessages,
  type AssistantSubsessionDto,
  type SessionHistoryDto,
  type SessionMessageDto,
  type SessionThreadMessagesDto,
  type SessionThreadSummaryDto
} from '@/lib/api'
import { CONSOLE_SWR_CONFIG, readOnceRegistered } from '@/lib/console-swr'
import type { SessionStep } from '@/lib/data'
import type { TaskLink } from '@/components/console/task-link'

/** Rows the conversation's list reads in one page; a task older than these reads its own row. */
const ROWS_PAGE = 50
const RUNNING_POLL_MS = 5_000
const IDLE_POLL_MS = 30_000
/** Rows one thread read takes, work included: the newest page; earlier ones are on the task's own page. */
const THREAD_PAGE = 100
/** Browser and daemon clocks differ, so a saved prompt may be stamped a little before this visit sent it. */
const PROMPT_CLOCK_SLACK_MS = 60_000

const running = (row: AssistantSubsessionDto | undefined) => row?.state === 'open'

/** The conversation's rows: a map once read, null while that read is out, undefined where it is not listed or cannot be read. */
type ListedTasks = ReadonlyMap<string, AssistantSubsessionDto> | null | undefined

/** A poll interval that is the same value until what it polls changes. SWR restarts its timer whenever its interval is a new value, and an interval given as a function is one on every render, so under a parent that re-renders more often than the interval the poll never fired. */
function usePollMs(): [number, (want: number) => void] {
  const [ms, setMs] = useState(IDLE_POLL_MS)
  return [
    ms,
    (want) => {
      if (want !== ms) setMs(want)
    }
  ]
}

/** This conversation's tasks by their session id, read once for every card in it and polled faster while one runs. */
function useConversationTasks(agentId: string, parentSessionId: string | null): ListedTasks {
  const [pollMs, pollEvery] = usePollMs()
  const { data, error } = useSWR(
    parentSessionId ? ['conversation-tasks', agentId, parentSessionId] : null,
    ([, agent, parent]) => fetchAssistantSubsessions(agent, { parentSessionId: parent, limit: ROWS_PAGE }),
    {
      ...CONSOLE_SWR_CONFIG,
      keepPreviousData: true,
      refreshInterval: pollMs
    }
  )
  pollEvery(data?.subsessions.some((row) => row.state === 'open') ? RUNNING_POLL_MS : IDLE_POLL_MS)
  if (!parentSessionId || (error && !data)) return undefined
  if (!data) return null
  return new Map(data.subsessions.flatMap((row) => (row.sessionId ? [[row.sessionId, row] as const] : [])))
}

/** A coordinator conversation's tasks by the platform id of the message each was opened for, as the transcript places their cards. */
export function useTasksByMessage(agentId: string, parentSessionId: string | null): ReadonlyMap<string, TaskLink[]> {
  const listed = useConversationTasks(agentId, parentSessionId)
  const byMessage = new Map<string, TaskLink[]>()
  for (const row of listed?.values() ?? []) {
    if (!row.sessionId || !row.openedForMessageId) continue
    const link: TaskLink = { sessionId: row.sessionId, title: row.title ?? '', how: 'opened' }
    byMessage.set(row.openedForMessageId, [...(byMessage.get(row.openedForMessageId) ?? []), link])
  }
  return byMessage
}

/** One task's row: its conversation's list when that carries it, else the task's own read. */
export function useTaskRow(
  agentId: string,
  /** The task's session; null, for a thread no task holds, reads nothing. */
  sessionId: string | null,
  /** The conversation whose list to read it from; null reads the task alone. */
  parentSessionId: string | null
): AssistantSubsessionDto | undefined {
  const listed = useConversationTasks(agentId, sessionId ? parentSessionId : null)
  const fromList = sessionId ? listed?.get(sessionId) : undefined
  const [pollMs, pollEvery] = usePollMs()
  const { data } = useSWR(
    sessionId && listed !== null && !fromList ? ['task-row', agentId, sessionId] : null,
    ([, agent, id]) => readOnceRegistered(() => fetchAssistantSubsession(agent, id)),
    {
      ...CONSOLE_SWR_CONFIG,
      refreshInterval: pollMs
    }
  )
  pollEvery(running(data) ? RUNNING_POLL_MS : IDLE_POLL_MS)
  return fromList ?? data
}

/** A row's moment as an ISO string: the daemon's event time, else its own timestamp when that is a date. */
export function messageTime(m: Pick<SessionMessageDto, 'ts' | 'eventTimeUs'>): string | null {
  if (m.eventTimeUs !== undefined) return new Date(m.eventTimeUs / 1000).toISOString()
  const parsed = Date.parse(m.ts)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

/** The thread's rows, oldest first. */
export function threadMessages(page: Pick<SessionHistoryDto, 'messages'> | undefined): SessionMessageDto[] {
  return [...(page?.messages ?? [])].sort((a, b) => a.seq - b.seq)
}

/** The task's newest page; re-read while the task runs, and whenever its row says something changed. */
export function useTaskThread(
  /** The task's session; null reads nothing. */
  sessionId: string | null,
  row: AssistantSubsessionDto | undefined,
  options: { busy?: boolean } = {}
): { page: SessionHistoryDto | undefined; error: unknown; reload: () => Promise<unknown> } {
  // The row's summary time and state move when the task speaks, so they key a fresh read for an idle thread too.
  const version = `${row?.state ?? ''}:${row?.summaryUpdatedAt ?? ''}`
  const { data, error, mutate } = useSWR(
    sessionId ? ['task-thread', sessionId, version] : null,
    ([, id]) => readOnceRegistered(() => fetchSessionMessages(id, { limit: THREAD_PAGE })),
    {
      ...CONSOLE_SWR_CONFIG,
      keepPreviousData: true,
      refreshInterval: running(row) || options.busy ? RUNNING_POLL_MS : 0
    }
  )
  return { page: data, error, reload: () => mutate() }
}

/** A thread read through the conversation's session that received its root (webchat-threads.md §8). */
export interface ThreadRecordRef {
  sessionId: string
  rootId: string
}

/** What one thread's record read gives: its newest page with what was paged in before it, its footer, and why it may be unread. */
export interface ThreadRecord {
  /** Earlier pages and the newest, oldest first, each row once. */
  messages: SessionMessageDto[] | undefined
  summary: SessionThreadSummaryDto | undefined
  error: unknown
  /** The daemon cannot serve thread reads, so a task's thread is read from its session instead. */
  unsupported: boolean
  /** The session never received this root, or it names a reply. */
  missing: boolean
  /** An earlier page is there to read. */
  hasEarlier: boolean
  loadingEarlier: boolean
  loadEarlier: () => Promise<void>
  reload: () => Promise<unknown>
}

const NO_ROWS: SessionMessageDto[] = []

/** Rows of overlapping pages, each once; a later list's copy of a row wins. */
const mergeRows = (...lists: readonly SessionMessageDto[][]): SessionMessageDto[] => [
  ...new Map(lists.flat().map((m) => [m.seq, m])).values()
]

/** One thread's record: its newest page, polled faster while a turn runs in it or this visit is answered there. */
/** How often a thread's record is re-read: quickly while its task runs or is starting, whose thread shows within seconds; an idle thread is still polled, since people and the coordinator write in it whether or not a task runs. */
export function threadPollMs(
  summary: Pick<SessionThreadSummaryDto, 'running' | 'task'> | undefined,
  busy: (sessionId: string) => boolean
): number {
  const holder = summary?.task?.sessionId
  return summary?.running || summary?.task?.starting || (holder && busy(holder)) ? RUNNING_POLL_MS : IDLE_POLL_MS
}

export function useThreadRecord(
  ref: ThreadRecordRef | null,
  /** Whether this visit is waiting on a turn of the holding task's session. */
  busy: (sessionId: string) => boolean = () => false
): ThreadRecord {
  const [pollMs, pollEvery] = usePollMs()
  // No previous data across keys: another thread's footer would name its task as this panel's reply target.
  const {
    data: read,
    error,
    mutate
  } = useSWR(
    ref ? ['thread-record', ref.sessionId, ref.rootId] : null,
    ([, sessionId, rootId]) => fetchSessionThreadMessages(sessionId, rootId, { limit: THREAD_PAGE }),
    {
      ...CONSOLE_SWR_CONFIG,
      refreshInterval: pollMs
    }
  )
  const data = read && ref && read.sessionId === ref.sessionId && read.rootId === ref.rootId ? read : undefined
  pollEvery(threadPollMs(data?.summary, busy))
  const key = ref ? `${ref.sessionId}\n${ref.rootId}` : ''
  const [older, setOlder] = useState<{ key: string; messages: SessionMessageDto[]; nextCursor: string | null } | null>(
    null
  )
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const earlier = older?.key === key ? older : null
  const nextCursor = earlier ? earlier.nextCursor : (data?.nextCursor ?? null)
  // Every row a read returned stays, so a poll whose newest page has moved past a row leaves no gap.
  const [seen, setSeen] = useState<{
    key: string
    page: SessionThreadMessagesDto | undefined
    rows: SessionMessageDto[]
  }>({ key: '', page: undefined, rows: [] })
  if (data && (seen.key !== key || seen.page !== data))
    setSeen({ key, page: data, rows: mergeRows(seen.key === key ? seen.rows : [], data.messages) })
  const kept = seen.key === key ? seen.rows : NO_ROWS
  const messages = useMemo(
    () => (data ? mergeRows(earlier?.messages ?? [], kept, data.messages) : undefined),
    [data, earlier, kept]
  )
  const loadEarlier = async () => {
    if (!ref || !nextCursor || loadingEarlier) return
    setLoadingEarlier(true)
    try {
      const page = await fetchSessionThreadMessages(ref.sessionId, ref.rootId, {
        cursor: nextCursor,
        limit: THREAD_PAGE
      })
      setOlder({ key, messages: [...page.messages, ...(earlier?.messages ?? [])], nextCursor: page.nextCursor })
    } finally {
      setLoadingEarlier(false)
    }
  }
  const featureMissing = error instanceof ApiError && error.status === 409 && error.code === 'DAEMON_FEATURE_MISSING'
  return {
    messages,
    summary: data?.summary,
    error,
    unsupported: featureMissing,
    missing: error instanceof ApiError && error.status === 404,
    hasEarlier: nextCursor !== null,
    loadingEarlier,
    loadEarlier,
    reload: () => mutate()
  }
}

/** A peer agent's text without its trailing "sent by" line, which the thread draws as the speaker instead. */
export function withoutAttribution(text: string): string {
  return text.replace(/\n*sent by <https?:\/\/[^\n]*\/agents\/[^\n]*$/, '').trimEnd()
}

/** The record's rows less the work this visit is streaming: a running reply's tool and reasoning rows are saved while it streams, and the live turn shows them once. */
export function threadRows(messages: readonly SessionMessageDto[], live: readonly SessionStep[]): SessionMessageDto[] {
  const liveTools = new Set(live.flatMap((step) => (step.kind === 'tool' && step.toolCallId ? [step.toolCallId] : [])))
  const liveStarts = live.flatMap((step) => (step.observedAtMs !== undefined ? [step.observedAtMs] : []))
  const liveSince = liveStarts.length ? Math.min(...liveStarts) : undefined
  return messages.filter((m) => {
    const kind = (m.kind || 'text').toLowerCase()
    if (kind === 'tool') return !m.toolCallId || !liveTools.has(m.toolCallId)
    if (kind !== 'reasoning' || liveSince === undefined) return true
    const at = Date.parse(messageTime(m) ?? '')
    return !Number.isFinite(at) || at < liveSince
  })
}

/** This visit's live steps less the prompts already on the record: a person's row saying the same since it was sent, which the poll reads while the reply still runs. */
export function unsavedLive(
  live: readonly SessionStep[],
  messages: readonly SessionMessageDto[],
  agentId: string
): SessionStep[] {
  const savedPrompt = (step: SessionStep): boolean =>
    messages.some((m) => {
      if ((m.kind || 'text').toLowerCase() !== 'text' || m.sender === agentId || m.text.trim() !== step.text.trim())
        return false
      const at = Date.parse(messageTime(m) ?? '')
      return step.observedAtMs === undefined || !Number.isFinite(at) || at >= step.observedAtMs - PROMPT_CLOCK_SLACK_MS
    })
  return live.filter((step) => step.kind !== 'msg' || (step.text.trim() !== '' && !savedPrompt(step)))
}
