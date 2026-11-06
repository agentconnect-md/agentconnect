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
  type SessionThreadSummaryDto
} from '@/lib/api'
import { CONSOLE_SWR_CONFIG } from '@/lib/console-swr'
import type { SessionStep } from '@/lib/data'
import type { TaskLink } from '@/components/console/task-link'
import { elicitCard, WORK_LANES } from '@/components/console/session-work'
import { fmtStep, msgStep, type FmtStep } from '@/components/console/transcript-steps'

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
  const { data } = useSWR(
    sessionId && listed !== null && !fromList ? ['task-row', agentId, sessionId] : null,
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

/** The thread's messages, the agent's work and its open questions, oldest first. */
export function threadMessages(page: Pick<SessionHistoryDto, 'messages'> | undefined): SessionMessageDto[] {
  return [...(page?.messages ?? [])]
    .filter((m) => {
      const kind = (m.kind || 'text').toLowerCase()
      if (kind === 'text') return m.text.trim() !== ''
      if (kind === 'elicit') return openQuestion(elicitCard(m.body)) !== null
      return kind === 'tool' || kind === 'reasoning'
    })
    .sort((a, b) => a.seq - b.seq)
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
    ([, id]) => fetchSessionMessages(id, { limit: THREAD_PAGE }),
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

/** One thread's record: its newest page, polled faster while a turn runs in it or this visit is answered there. */
export function useThreadRecord(
  ref: ThreadRecordRef | null,
  /** Whether this visit is waiting on a turn of the holding task's session. */
  busy: (sessionId: string) => boolean = () => false
): ThreadRecord {
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
      // People and the coordinator write in a thread whether or not a task runs in it, so an idle thread is still polled.
      refreshInterval: (page) => {
        const holder = page?.summary.task?.sessionId
        return page?.summary.running || (holder && busy(holder)) ? RUNNING_POLL_MS : IDLE_POLL_MS
      }
    }
  )
  const data = read && ref && read.sessionId === ref.sessionId && read.rootId === ref.rootId ? read : undefined
  const key = ref ? `${ref.sessionId}\n${ref.rootId}` : ''
  const [older, setOlder] = useState<{ key: string; messages: SessionMessageDto[]; nextCursor: string | null } | null>(
    null
  )
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const earlier = older?.key === key ? older : null
  const nextCursor = earlier ? earlier.nextCursor : (data?.nextCursor ?? null)
  // An earlier page and the newest may overlap once the thread grows between reads; each row is drawn once.
  const messages = useMemo(
    () =>
      data ? [...new Map([...(earlier?.messages ?? []), ...data.messages].map((m) => [m.seq, m])).values()] : undefined,
    [data, earlier]
  )
  const loadEarlier = async () => {
    if (!ref || !nextCursor || loadingEarlier) return
    setLoadingEarlier(true)
    try {
      const page = await fetchSessionThreadMessages(ref.sessionId, ref.rootId, {
        cursor: nextCursor,
        limit: THREAD_PAGE
      })
      // Everything shown so far is kept, so a later poll whose newest page has moved on leaves no gap behind it.
      setOlder({ key, messages: [...page.messages, ...(messages ?? [])], nextCursor: page.nextCursor })
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

/** One message as the thread draws it. */
export interface ThreadEntry {
  key: string
  who: 'agent' | 'person'
  /** Another agent that spoke here, as its attribution names it; absent for the task's own agent. */
  agentId?: string
  name: string | null
  /** A person's provider-hosted picture. */
  avatarUrl?: string
  /** A recorded person's sender, which the panel's console-photo lookup keys on. */
  sender?: string
  text: string
  /** An agent turn's answer, one block per message it posted. */
  prose?: string[]
  /** An agent turn's work rows, which its header folds as the session page does. */
  work?: FmtStep[]
  /** When each of an agent turn's rows happened, which dates its duration. */
  times?: number[]
  at: string | null
  /** Still streaming, or sent and not yet on the daemon's record. */
  live: boolean
  /** The agent's open question: a plain choice or a line of text the panel answers, else one it only points to. */
  question?: {
    requestId: string
    choices: { value: string; label: string }[] | null
    /** A line of text, with the constraints the daemon checks it against. */
    text: NonNullable<NonNullable<SessionStep['elicit']>['text']> | null
  }
}

/** A question the agent is still waiting on, and how the panel can answer it. */
function openQuestion(ask: SessionStep['elicit'] | null | undefined): ThreadEntry['question'] | null {
  if (!ask || ask.outcome) return null
  const plain = !ask.multi && !ask.number && !ask.fields && !ask.url
  return {
    requestId: ask.requestId,
    choices: plain && !ask.text && ask.options.length > 0 ? ask.options : null,
    text: plain && ask.text ? ask.text : null
  }
}

/** A peer agent's text without its trailing "sent by" line, which the thread draws as the speaker instead. */
export function withoutAttribution(text: string): string {
  return text.replace(/\n*sent by <https?:\/\/[^\n]*\/agents\/[^\n]*$/, '').trimEnd()
}

/** Persisted messages, then what this visit sent and is streaming back; one agent's consecutive work and replies make one turn. */
export function threadEntries(
  messages: readonly SessionMessageDto[],
  liveSteps: readonly SessionStep[],
  agentId: string,
  /** Which other agent wrote a message, when one did. */
  peerAgent?: (m: SessionMessageDto) => string | undefined
): ThreadEntry[] {
  const entries: ThreadEntry[] = []
  let turn: ThreadEntry | null = null
  const ownTurn = (key: string, at: string | null, live: boolean): ThreadEntry => {
    if (turn) return turn
    turn = { key, who: 'agent', name: null, text: '', prose: [], work: [], times: [], at, live }
    entries.push(turn)
    return turn
  }
  const say = (entry: ThreadEntry, text: string) => {
    entry.prose!.push(text)
    entry.text = entry.prose!.join('\n\n')
  }
  const stamp = (entry: ThreadEntry, at: string | number | null | undefined) => {
    const ms = typeof at === 'string' ? Date.parse(at) : at
    if (ms !== null && ms !== undefined && Number.isFinite(ms)) entry.times!.push(ms)
  }
  // While a reply streams, its tool and reasoning rows are already saved; the live turn shows them once.
  const shown = liveSteps.filter((step) => !step.hidden)
  const liveTools = new Set(shown.flatMap((step) => (step.kind === 'tool' && step.toolCallId ? [step.toolCallId] : [])))
  const liveStarts = shown.flatMap((step) => (step.observedAtMs !== undefined ? [step.observedAtMs] : []))
  const liveSince = liveStarts.length ? Math.min(...liveStarts) : undefined
  const streamedHere = (m: SessionMessageDto, kind: string): boolean => {
    if (kind === 'tool') return !!m.toolCallId && liveTools.has(m.toolCallId)
    const at = Date.parse(messageTime(m) ?? '')
    return kind === 'reasoning' && liveSince !== undefined && Number.isFinite(at) && at >= liveSince
  }
  // A prompt this visit sent is on the record once a person's row says the same since it was sent; the poll reads it while the reply still runs.
  const savedPrompt = (step: SessionStep): boolean =>
    messages.some((m) => {
      if ((m.kind || 'text').toLowerCase() !== 'text' || m.sender === agentId || m.text.trim() !== step.text.trim())
        return false
      const at = Date.parse(messageTime(m) ?? '')
      return step.observedAtMs === undefined || !Number.isFinite(at) || at >= step.observedAtMs - PROMPT_CLOCK_SLACK_MS
    })
  for (const m of messages) {
    const kind = (m.kind || 'text').toLowerCase()
    const question = kind === 'elicit' ? openQuestion(elicitCard(m.body)) : null
    if (question) {
      turn = null
      entries.push({
        key: `m:${m.seq}`,
        who: 'agent',
        name: m.senderName ?? null,
        text: m.text,
        at: messageTime(m),
        live: false,
        question
      })
      continue
    }
    if (kind === 'tool' || kind === 'reasoning') {
      if (streamedHere(m, kind)) continue
      const own = ownTurn(`m:${m.seq}`, messageTime(m), false)
      own.work!.push(msgStep(m))
      stamp(own, messageTime(m))
      continue
    }
    if (m.sender === agentId) {
      const own = ownTurn(`m:${m.seq}`, messageTime(m), false)
      say(own, m.text)
      stamp(own, messageTime(m))
      continue
    }
    turn = null
    const peer = peerAgent?.(m)
    entries.push({
      key: `m:${m.seq}`,
      who: peer ? 'agent' : 'person',
      ...(peer && peer !== agentId ? { agentId: peer } : {}),
      name: m.senderName ?? null,
      ...(!peer && m.senderAvatarUrl ? { avatarUrl: m.senderAvatarUrl } : {}),
      ...(!peer ? { sender: m.sender } : {}),
      text: peer ? withoutAttribution(m.text) : m.text,
      at: messageTime(m),
      live: false
    })
  }
  const recorded = new Set(entries.flatMap((entry) => (entry.question ? [entry.question.requestId] : [])))
  turn = null
  liveSteps.forEach((step, i) => {
    const question = step.kind === 'elicit' ? openQuestion(step.elicit) : null
    // A question is never left out: the task waits on it, so the thread shows it even with no text.
    if (question) {
      turn = null
      if (!recorded.has(question.requestId))
        entries.push({ key: `l:${i}`, who: 'agent', name: null, text: step.text, at: null, live: true, question })
      return
    }
    if (step.hidden) return
    if (step.kind === 'msg') {
      turn = null
      if (step.text.trim() && !savedPrompt(step))
        entries.push({ key: `l:${i}`, who: 'person', name: null, text: step.text, at: null, live: true })
      return
    }
    if (step.kind === 'done' && !step.demoted) {
      if (!step.text.trim()) return
      const own = ownTurn(`l:${i}`, null, true)
      say(own, step.text)
      stamp(own, step.observedAtMs)
      return
    }
    const fmt = fmtStep(step)
    if (!WORK_LANES.has(fmt.lane)) return
    const own = ownTurn(`l:${i}`, null, true)
    own.work!.push(fmt)
    stamp(own, step.observedAtMs)
  })
  return entries
}
