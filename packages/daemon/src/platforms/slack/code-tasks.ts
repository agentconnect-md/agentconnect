import type { AssistantActivitySubsession, TaskList, TaskListReq } from '@agentconnect.md/protocol'
import { readTaskSubsessions, type AssistantActivityStore } from '../../cp/assistant-activity.js'
import type { SessionRecord } from '../../store/local-store.js'

export const SLACK_TASKS_VIEW_KEY = 'agentconnect-tasks'

export interface CodeTasksSnapshot {
  runtime: TaskList
  tasks: (AssistantActivitySubsession & { url?: string })[]
  truncated: boolean
  sessionUrl?: string
}

export async function readCodeTasks(
  deps: {
    store: AssistantActivityStore
    admitted(): Promise<string[]>
    open(session: SessionRecord): boolean
    assistant(agentId: string): boolean
    runtime(req: TaskListReq): Promise<TaskList>
    link(sessionId: string): string | undefined
    mask<T>(agentId: string, value: T): T
  },
  channel: string,
  key: string
): Promise<CodeTasksSnapshot | undefined> {
  const session = await deps.store.getSession(key)
  if (
    !session ||
    session.platform !== 'slack' ||
    session.channel !== channel ||
    session.thread !== channel ||
    !deps.open(session) ||
    !(await deps.admitted()).includes(key)
  )
    return undefined
  const sessionId = session.sessionId ?? session.acpSessionId
  if (!sessionId) return undefined
  const [managed, runtime] = await Promise.all([
    readTaskSubsessions(
      deps.store,
      {
        operation: 'subsessions',
        agentId: session.agentId,
        limit: 50,
        parent: { sessionId }
      },
      deps.assistant(session.agentId)
    ),
    deps.runtime({ agentId: session.agentId, sessionId })
  ])
  const tasks = await Promise.all(
    managed.subsessions.map(async (task) => {
      const child = task.sessionId ? await deps.store.getSessionByOutwardId(task.sessionId, session.agentId) : undefined
      return { ...task, title: child?.title ?? task.title, url: task.sessionId ? deps.link(task.sessionId) : undefined }
    })
  )
  return deps.mask(session.agentId, { runtime, tasks, truncated: managed.truncated, sessionUrl: deps.link(sessionId) })
}

interface TaskRow {
  group: string
  title: string
  state: string
  startedAt?: string
  endedAt?: string
  finished: boolean
  running: boolean
  failed: boolean
  summary?: string
  url?: string
}

type TaskBlock = { type: string; [key: string]: unknown }

const elapsed = (start: string, end: number): string => {
  const seconds = Math.max(0, Math.round((end - Date.parse(start)) / 1000))
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

// Share the console's task states: a threaded task stays open between turns, and a follow-up runs only while checking.
function codeTaskRows(snapshot: CodeTasksSnapshot): TaskRow[] {
  return [
    ...snapshot.tasks.map((task): TaskRow => {
      const followUp = task.kind === 'follow-up' ? task.followUp : undefined
      return {
        group: task.kind === 'follow-up' ? 'Follow-ups' : 'Tasks',
        title: followUp?.title ?? task.title ?? 'Untitled task',
        state: followUp?.status ?? (task.threaded && task.state === 'done' ? 'Waiting' : task.state),
        startedAt: followUp || task.threaded ? undefined : task.createdAt,
        finished: task.state !== 'open' && !task.threaded,
        running: followUp ? followUp.status === 'checking' : task.state === 'open',
        failed: task.state === 'failed',
        summary: task.summary ?? task.background,
        url: task.url
      }
    }),
    ...snapshot.runtime.tasks.map((task): TaskRow => ({
      group: task.subagent ? 'Subagents' : 'Commands',
      title: task.description ?? (task.subagent ? 'Unnamed subagent' : 'Unnamed command'),
      state: task.state,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      finished: task.state !== 'running',
      running: task.state === 'running',
      failed: task.state === 'failed'
    }))
  ]
}

// Containers collapse locally in Slack; expanding history needs no bot callback or shared expansion state.
export function codeTasksBlocks(snapshot: CodeTasksSnapshot, now = Date.now()): TaskBlock[] {
  const rows = codeTaskRows(snapshot)
  const open = rows.filter((row) => !row.finished)
  const finished = rows.filter((row) => row.finished)
  const shownOpen = open.slice(0, 30)
  const shownFinished = finished.slice(0, 36 - shownOpen.length)
  const truncated =
    snapshot.truncated ||
    snapshot.runtime.truncated ||
    shownOpen.length < open.length ||
    shownFinished.length < finished.length
  const rowBlock = (row: TaskRow): TaskBlock => {
    const mark = row.running ? '◷' : row.failed ? '✕' : row.finished ? '✓' : '◇'
    const duration =
      row.startedAt && (row.running || row.endedAt)
        ? elapsed(row.startedAt, row.endedAt ? Date.parse(row.endedAt) : now)
        : ''
    const state =
      row.state === 'open'
        ? 'Running'
        : row.state === 'done'
          ? 'Completed'
          : row.state[0]!.toUpperCase() + row.state.slice(1)
    const text = `${mark} ${row.title.slice(0, 240)}\n${[state, row.finished ? row.group : '', duration].filter(Boolean).join(' · ')}${row.summary ? `\n${row.summary.slice(0, 800)}` : ''}`
    return {
      type: 'section',
      text: { type: 'plain_text', text },
      ...(row.url ? { accessory: { type: 'button', text: { type: 'plain_text', text: 'Open' }, url: row.url } } : {})
    }
  }
  const blocks: TaskBlock[] = [{ type: 'header', text: { type: 'plain_text', text: 'Tasks' } }]
  for (const group of ['Tasks', 'Follow-ups', 'Subagents', 'Commands']) {
    const grouped = shownOpen.filter((row) => row.group === group)
    if (!grouped.length) continue
    blocks.push({ type: 'header', text: { type: 'plain_text', text: `${group} · ${grouped.length}` } })
    blocks.push(...grouped.map(rowBlock))
  }
  if (!open.length)
    blocks.push({ type: 'section', text: { type: 'plain_text', text: 'No active tasks in this snapshot.' } })
  if (finished.length)
    blocks.push({
      type: 'container',
      block_id: 'finished_tasks',
      title: {
        type: 'plain_text',
        text: `${finished.length}${snapshot.truncated || snapshot.runtime.truncated ? '+' : ''} finished`
      },
      is_collapsible: true,
      default_collapsed: true,
      child_blocks: shownFinished.map(rowBlock)
    })
  if (!snapshot.runtime.tracked)
    blocks.push({
      type: 'context',
      elements: [{ type: 'plain_text', text: 'This runtime has not reported background subagents or commands.' }]
    })
  if (truncated)
    blocks.push({
      type: 'context',
      elements: [{ type: 'plain_text', text: 'Showing recent tasks. Open the session to see more.' }]
    })
  if (snapshot.sessionUrl)
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open session' }, url: snapshot.sessionUrl }]
    })
  return blocks
}

interface TasksViewHost {
  read(channel: string, sessionKey: string): Promise<CodeTasksSnapshot | undefined>
  publish(channel: string, blocks: TaskBlock[], signal: AbortSignal): Promise<void>
  debug(message: string): void
}

interface Watch {
  key: string
  abort: AbortController
  timer?: ReturnType<typeof setTimeout>
  digest?: string
  active: boolean
  refreshing: boolean
}

// A channel's task view outlives any one response, including background work after the main turn finishes.
export class CodeTasksViews {
  private readonly watches = new Map<string, Watch>()

  constructor(private readonly host: TasksViewHost) {}

  watch(channel: string, key: string): void {
    const current = this.watches.get(channel)
    if (current?.key === key) {
      current.active = true
      if (!current.timer && !current.refreshing) void this.refresh(channel, current)
      return
    }
    this.stop(channel)
    const watch: Watch = { key, abort: new AbortController(), active: true, refreshing: false }
    this.watches.set(channel, watch)
    void this.refresh(channel, watch)
  }

  private async refresh(channel: string, watch: Watch): Promise<void> {
    watch.refreshing = true
    watch.timer = undefined
    let pending = false
    let running = false
    try {
      const snapshot = await this.host.read(channel, watch.key)
      if (watch.abort.signal.aborted) return
      if (snapshot) {
        const rows = codeTaskRows(snapshot)
        pending = rows.some((row) => !row.finished)
        running = rows.some((row) => row.running)
        const blocks = codeTasksBlocks(snapshot)
        const digest = JSON.stringify(blocks)
        if (digest !== watch.digest) {
          blocks.push({
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Updated <!date^${Math.floor(Date.now() / 1000)}^{date_short} at {time_secs}|${new Date().toISOString()}>`
              }
            ]
          })
          await this.host.publish(channel, blocks, watch.abort.signal)
          watch.digest = digest
        }
      }
    } catch {
      pending = true
      this.host.debug('slack: task view update failed; retrying')
    } finally {
      watch.refreshing = false
      if (!watch.abort.signal.aborted && (watch.active || pending)) {
        watch.timer = setTimeout(() => void this.refresh(channel, watch), watch.active || running ? 5_000 : 20_000)
        watch.timer.unref()
      } else if (!watch.abort.signal.aborted) this.stop(channel)
    }
  }

  idle(channel: string): void {
    const watch = this.watches.get(channel)
    if (!watch) return
    watch.active = false
    clearTimeout(watch.timer)
    watch.timer = undefined
    if (!watch.refreshing) void this.refresh(channel, watch)
  }

  stop(channel?: string): void {
    for (const [id, watch] of this.watches) {
      if (channel !== undefined && id !== channel) continue
      watch.abort.abort()
      clearTimeout(watch.timer)
      this.watches.delete(id)
    }
  }
}
