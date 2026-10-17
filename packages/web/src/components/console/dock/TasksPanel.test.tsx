// @vitest-environment happy-dom

// The dock's Tasks panel: its four groups by kind, the finished toggle, the one verdict it reports to its tab, the untracked session it does not draw, and every degraded answer the task wire can give.
// It also pins §3.5's two absences: NO stop on a runtime row (no agent-protocol primitive can address one background task) and NO progress bar or step line (the runtime reports neither).

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({
  data: null as unknown,
  /** The delegated group's one page. */
  delegated: { subsessions: [] as unknown[], truncated: false, nextCursor: null as string | null },
  failure: null as null | { status: number; code?: string },
  calls: [] as Array<{ agentId: string; sessionId: string }>,
  // Set to hand back a promise the test resolves by hand, so the panel is observable WHILE its first read is in flight.
  hold: null as null | (() => Promise<unknown>)
}))

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string
    ) {
      super(message)
      this.name = 'ApiError'
    }
  }
  return {
    ApiError,
    fetchAgentTasks: vi.fn((agentId: string, sessionId: string) => {
      wire.calls.push({ agentId, sessionId })
      if (wire.failure) return Promise.reject(new ApiError('nope', wire.failure.status, wire.failure.code))
      if (wire.hold) return wire.hold()
      return Promise.resolve(wire.data)
    }),
    fetchAssistantSubsessions: vi.fn(() => Promise.resolve(wire.delegated)),
    stopAssistantSubsession: vi.fn(() => Promise.resolve({ result: 'stopped' }))
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))

import { TasksPanel, formatTaskElapsed, tasksTabShown, tasksTabStatus, type TasksPanelVerdict } from './TasksPanel'
import type { AgentTaskDto, AgentTasksDto, AssistantSubsessionDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
let verdicts: TasksPanelVerdict[] = []

const NOW = Date.parse('2026-08-11T12:00:00.000Z')
const NOW_ISO = '2026-08-11T11:59:30.000Z'

function task(overrides: Partial<AgentTaskDto> = {}): AgentTaskDto {
  return {
    id: 't1',
    description: 'Reindex the workspace',
    state: 'running',
    subagent: false,
    startedAt: '2026-08-11T11:58:00.000Z',
    endedAt: null,
    detail: null,
    ...overrides
  }
}

function tasks(overrides: Partial<AgentTasksDto> = {}): AgentTasksDto {
  return { sessionId: 'session-1', tracked: true, tasks: [], truncated: false, ...overrides }
}

type PanelProps = Parameters<typeof TasksPanel>[0]

function panel(props: Partial<PanelProps> = {}) {
  return (
    <TasksPanel
      agentId="agent-a"
      sessionId="session-1"
      onVerdictChange={(verdict) => verdicts.push(verdict)}
      {...props}
    />
  )
}

async function render(props: Partial<PanelProps> = {}) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(panel(props))
    await Promise.resolve()
  })
}

async function rerender(props: Partial<PanelProps> = {}) {
  await act(async () => {
    root?.render(panel(props))
    await Promise.resolve()
  })
}

const text = () => container?.textContent ?? ''
const rows = () => Array.from(container?.querySelectorAll<HTMLElement>('[data-task-row]') ?? [])
const states = () => rows().map((row) => row.dataset.taskRow ?? '')
const last = () => verdicts.at(-1)
const groups = () =>
  Array.from(container?.querySelectorAll<HTMLElement>('[data-task-group]') ?? []).map((g) => g.dataset.taskGroup)
const headings = () => Array.from(container?.querySelectorAll('h3') ?? []).map((h) => h.textContent)
const finishedToggle = () => container?.querySelector<HTMLButtonElement>('[data-finished-toggle]') ?? null

async function showFinished() {
  await act(async () => {
    finishedToggle()?.click()
    await Promise.resolve()
  })
}

function delegatedRow(overrides: Partial<AssistantSubsessionDto> = {}): AssistantSubsessionDto {
  return {
    sessionId: 'child-1',
    title: 'Check the changelog',
    state: 'open',
    startedAt: '2026-08-11T11:57:46.000Z',
    visible: true,
    canStop: true,
    parent: null,
    ...overrides
  }
}

beforeEach(() => {
  wire.data = tasks()
  wire.delegated = { subsessions: [], truncated: false, nextCursor: null }
  wire.failure = null
  wire.calls = []
  wire.hold = null
  verdicts = []
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('tasksTabStatus', () => {
  it('is loading until the read answers, and never empty', () => {
    // Never `empty`: an untracked session and an idle one each have a sentence explaining themselves, and `empty` would trade that for the dock's centred placeholder — and put `vacant` back in reach, where the dock withholds its whole tab strip.
    expect(tasksTabStatus(false)).toBe('loading')
    expect(tasksTabStatus(true)).toBe('ready')
  })
})

describe('formatTaskElapsed', () => {
  it('reads seconds, then minutes-and-seconds, then hours-and-minutes', () => {
    expect(formatTaskElapsed('2026-08-11T11:59:19.000Z', NOW)).toBe('41s')
    expect(formatTaskElapsed('2026-08-11T11:57:46.000Z', NOW)).toBe('2m 14s')
    expect(formatTaskElapsed('2026-08-11T10:56:00.000Z', NOW)).toBe('1h 04m')
  })

  it('clamps a start in the future to zero rather than reading backwards', () => {
    // The daemon's clock is not ours, so a task can be stamped a few seconds ahead. `-3s` would be a bug the reader cannot distinguish from a bug in the agent.
    expect(formatTaskElapsed('2026-08-11T12:00:03.000Z', NOW)).toBe('0s')
  })

  it('says nothing at all for an unparseable stamp', () => {
    expect(formatTaskElapsed('not a date', NOW)).toBe('')
  })
})

describe('TasksPanel scope', () => {
  it('reads the lease by (agent, session) and reports settled once it answers', async () => {
    await render()
    expect(wire.calls).toEqual([{ agentId: 'agent-a', sessionId: 'session-1' }])
    expect(last()).toEqual({ settled: true, running: 0, shown: true })
    // Reported on the EDGE, against an unstable callback like the fresh closure this harness passes per render: re-reporting the held verdict would write parent state once per render, and a parent that re-renders on it would hand back another fresh closure — a loop.
    const heard = verdicts.length
    await rerender()
    await rerender()
    expect(verdicts).toHaveLength(heard)
  })

  it('reports its running count, not its row count, for the tab badge', async () => {
    wire.data = tasks({
      tasks: [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c', state: 'done', endedAt: NOW_ISO })]
    })
    await render()
    expect(rows()).toHaveLength(2)
    expect(last()).toEqual({ settled: true, running: 2, shown: true })
  })
})

describe('TasksPanel answers that are not rows', () => {
  it('draws no group for an UNTRACKED session, and drops the tab when nothing else has anything to show', async () => {
    // A non-Claude runtime and an adapter without the lifecycle extension have no lease, which is a different statement from "idle".
    wire.data = tasks({ tracked: false })
    await render()
    expect(groups()).toEqual([])
    expect(rows()).toHaveLength(0)
    // Null rather than 0: an unknown count must not wear a badge saying "none running".
    expect(last()).toEqual({ settled: true, running: null, shown: false })
    expect(tasksTabShown(last()!)).toBe(false)
  })

  it('says the session is idle when it IS tracked and has nothing, with no empty group headers', async () => {
    await render()
    expect(groups()).toEqual([])
    expect(text()).toBe('Nothing running in the background.')
  })

  it('names the version answer for a daemon too old to report tasks', async () => {
    wire.failure = { status: 409, code: 'DAEMON_FEATURE_MISSING' }
    await render()
    expect(text()).toContain('Update this agent to see its subagents and commands here.')
    expect(text()).not.toContain('Nothing running')
    expect(last()).toEqual({ settled: true, running: null, shown: true })
  })

  it('says a session it cannot read is unavailable, and folds everything else into the offline story', async () => {
    wire.failure = { status: 404 }
    await render()
    expect(text()).toContain('can’t be read')

    await act(async () => root?.unmount())
    container?.remove()
    wire.failure = { status: 503 }
    await render()
    expect(text()).toContain('daemon may be offline')
  })

  it('says older tasks are withheld with the finished ones when the daemon truncated its history', async () => {
    wire.data = tasks({ tasks: [task(), task({ id: 'b', state: 'done', endedAt: NOW_ISO })], truncated: true })
    await render()
    expect(text()).not.toContain('Older ones')
    await showFinished()
    expect(text()).toContain('Older ones aren’t shown.')
  })
})

describe('TasksPanel rows', () => {
  it('shows running rows by default and puts finished ones back in their group, dimmed, behind one toggle', async () => {
    wire.data = tasks({
      tasks: [
        task({ id: 'b', state: 'done', endedAt: NOW_ISO }),
        task({ id: 'a' }),
        task({ id: 'c', state: 'failed', endedAt: NOW_ISO, detail: 'exit 1' })
      ]
    })
    await render()
    expect(states()).toEqual(['running'])
    expect(finishedToggle()?.textContent).toBe('2 finished')
    expect(finishedToggle()?.getAttribute('aria-expanded')).toBe('false')

    await showFinished()
    expect(states()).toEqual(['running', 'done', 'failed'])
    expect(rows().map((row) => row.className.includes('opacity-60'))).toEqual([false, true, true])
    expect(finishedToggle()?.getAttribute('aria-expanded')).toBe('true')
    expect(container?.querySelector('[data-task-group="commands"] [data-task-group-count]')?.textContent).toBe('3')
  })

  it('shows the terminal status the runtime reported in the meta line, and nothing when it named none', async () => {
    // `done` never asserts success on its own: `detail` is the only place a reported outcome may appear.
    wire.data = tasks({
      tasks: [task({ id: 'a', state: 'failed', endedAt: NOW_ISO, detail: 'killed' }), task({ id: 'b' })]
    })
    await render()
    await showFinished()
    expect(rows()[1]?.textContent).toContain('Failed · killed')
    expect(rows()[0]?.textContent).toBe('Reindex the workspaceRunning · 2m 00s')
  })

  it('keeps a task the runtime did not name, and says so instead of dropping the row', async () => {
    // An unnamed task is still the thing fencing host reclaim, so a panel that hid it would show "no tasks" beside a host refusing to be reclaimed.
    wire.data = tasks({ tasks: [task({ description: null })] })
    await render()
    expect(rows()).toHaveLength(1)
    expect(text()).toContain('Unnamed background command')
  })

  it('sorts subagents and commands into their own groups, each with a sentence-case label and a count', async () => {
    // Subagent rows are carried, not filtered: the same records fence reclaim.
    wire.data = tasks({
      tasks: [
        task({ id: 'a', description: 'pnpm test --watch' }),
        task({ id: 'b', subagent: true, description: 'Find webhook handlers' }),
        task({ id: 'c', subagent: true, description: null })
      ]
    })
    await render()
    expect(groups()).toEqual(['subagents', 'commands'])
    expect(headings()).toEqual(['Subagents2', 'Commands1'])
    expect(text()).toContain('Unnamed subagent')
    expect(text()).not.toContain('(reported by the runtime)')
  })

  it('shows elapsed for a running task and a settled-ago for a finished one', async () => {
    wire.data = tasks({
      tasks: [
        task({ id: 'a', startedAt: '2026-08-11T11:57:46.000Z' }),
        task({ id: 'b', state: 'done', endedAt: '2026-08-11T11:48:00.000Z' })
      ]
    })
    await render()
    expect(text()).toContain('Running · 2m 14s')
    await showFinished()
    expect(text()).toContain('Done · 12m ago')
  })
})

describe('TasksPanel withheld controls (§3.5)', () => {
  it('offers NO cancel, stop, rerun or clear control on any runtime row', async () => {
    // PREMISE: no ACP primitive can address one background task, so a row control could only cancel unrelated work or report a cancellation it did not perform. If a task-addressed cancel lands upstream, re-aim this assertion — do not delete it.
    wire.data = tasks({ tasks: [task(), task({ id: 'b', state: 'failed', endedAt: NOW_ISO })] })
    await render()
    await showFinished()
    expect(rows()).toHaveLength(2)
    expect(container?.querySelectorAll('[data-task-group] button')).toHaveLength(0)
    // The finished toggle is the panel's only control.
    expect(Array.from(container?.querySelectorAll('button') ?? []).map((b) => b.textContent)).toEqual(['1 finished'])
    expect(text().toLowerCase()).not.toContain('cancel')
    expect(text().toLowerCase()).not.toContain('rerun')
  })

  it('draws NO progress bar and NO step line, because the runtime reports neither', async () => {
    // The design drew both. Nothing in the lifecycle feed carries a percentage or a step, so a bar here would be a number the reader cannot check against anything.
    wire.data = tasks({ tasks: [task()] })
    await render()
    expect(container?.querySelector('progress')).toBeNull()
    expect(container?.querySelector('[role="progressbar"]')).toBeNull()
    // A progress track is the only thing in this design that would need a percentage width.
    const widths = Array.from(container?.querySelectorAll<HTMLElement>('[style]') ?? []).map((node) => node.style.width)
    expect(widths.filter((width) => width.endsWith('%'))).toHaveLength(0)
  })
})

describe('TasksPanel polling', () => {
  it('re-reads while it is VISIBLE and something is running', async () => {
    vi.useFakeTimers()
    wire.data = tasks({ tasks: [task()] })
    await render({ active: true })
    expect(wire.calls).toHaveLength(1)

    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(wire.calls.length).toBeGreaterThan(1)
    // A poll REPLACES the rows rather than clearing them first: dropping back to `loading` every five seconds would strobe the list and pull the tab out of `ready` on a timer.
    expect(last()?.settled).toBe(true)
    expect(rows()).toHaveLength(1)
  })

  it('does NOT poll while it is hidden, however much is running', async () => {
    vi.useFakeTimers()
    wire.data = tasks({ tasks: [task()] })
    await render({ active: false })
    expect(wire.calls).toHaveLength(1)

    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(wire.calls).toHaveLength(1)
  })

  // PREMISE CORRECTED (review of #854): this case previously asserted that an idle VISIBLE panel
  // stops polling, on the reasoning that a settled task has no transition left to find. That was
  // wrong about what the panel watches. It watches a SESSION, not the rows on screen, and the
  // session starts new background tasks — most directly when the reader leaves this tab open and
  // sends another prompt from the composer beside it. Nothing in that path bumps the panel's
  // revision, so the old behavior meant the 0 -> running edge was never observed and a new task
  // stayed invisible until a manual refresh. The assertion is re-aimed at the backed-off cadence,
  // not deleted: the thing worth protecting is that an idle panel polls LESS, not that it stops.
  it('keeps polling an idle VISIBLE list at the backed-off cadence, so a task starting later shows up', async () => {
    vi.useFakeTimers()
    wire.data = tasks({ tasks: [task({ state: 'done', endedAt: NOW_ISO })] })
    await render({ active: true })
    expect(wire.calls).toHaveLength(1)

    // Slower than the running cadence: the running interval would have fired by now, the idle one
    // has not. This is what pins the two apart rather than just "it polls sometimes".
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(wire.calls).toHaveLength(1)

    await act(async () => {
      vi.advanceTimersByTime(15_000)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(wire.calls).toHaveLength(2)
  })

  it('discovers a task that starts while an untracked session sits open, with no refresh press', async () => {
    // The reviewer's exact scenario: Tasks opened over an empty/untracked lease, then a prompt sent
    // from the composer starts a background task. `running` is 0 the whole time the panel is
    // waiting, so a poll gated on `running > 0` would never fire and the badge would stay empty.
    vi.useFakeTimers()
    wire.data = tasks({ tracked: false })
    await render({ active: true })
    expect(last()).toEqual({ settled: true, running: null, shown: false })

    wire.data = tasks({ tasks: [task()] })
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(rows()).toHaveLength(1)
    expect(last()).toEqual({ settled: true, running: 1, shown: true })
  })

  it('re-reads on the tab action, without waiting for a poll', async () => {
    await render({ refreshTick: 0 })
    expect(wire.calls).toHaveLength(1)
    await rerender({ refreshTick: 1 })
    expect(wire.calls).toHaveLength(2)
  })

  it('re-reads for a new session rather than showing the previous one’s tasks', async () => {
    // Constructs the switch WINDOW itself: the new scope's read is held open, so serving the held answer of the OLD scope — the M3 bug class — would leave its rows on screen and its census on the new tab's badge for as long as the read takes.
    wire.data = tasks({ tasks: [task()] })
    await render()
    expect(wire.calls).toHaveLength(1)
    expect(rows()).toHaveLength(1)

    let release: ((value: unknown) => void) | undefined
    wire.hold = () => new Promise((resolve) => (release = resolve))
    await rerender({ sessionId: 'session-2' })
    expect(wire.calls.at(-1)).toEqual({ agentId: 'agent-a', sessionId: 'session-2' })
    // Pending for the scope on screen, not answered with the previous one: no rows, and a verdict that pulls the badge rather than carrying session-1's count over.
    expect(rows()).toHaveLength(0)
    expect(last()).toEqual({ settled: false, running: null, shown: false })

    await act(async () => {
      release?.(tasks({ sessionId: 'session-2', tasks: [task({ id: 't2', description: 'the new scope’s task' })] }))
      await Promise.resolve()
    })
    expect(text()).toContain('the new scope’s task')
    expect(last()).toEqual({ settled: true, running: 1, shown: true })
  })

  it('re-reads ONCE for a scope switch and ONCE for a refresh, even after a poll has fired', async () => {
    // MEASURED, not hypothetical: the first version of this panel kept the poll count in its own state and zeroed it whenever the scope or the refresh tick moved. Zeroing it re-triggered the read effect it was there to describe, so past the first poll every session switch and every press of the tab's refresh action issued TWO reads of the daemon's lease instead of one.
    vi.useFakeTimers()
    wire.data = tasks({ tasks: [task()] })
    await render({ active: true })
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(wire.calls).toHaveLength(2)

    await rerender({ sessionId: 'session-2' })
    expect(wire.calls).toEqual([
      { agentId: 'agent-a', sessionId: 'session-1' },
      { agentId: 'agent-a', sessionId: 'session-1' },
      { agentId: 'agent-a', sessionId: 'session-2' }
    ])

    await rerender({ sessionId: 'session-2', refreshTick: 1 })
    expect(wire.calls).toHaveLength(4)
  })

  it('re-reads when the reader OPENS the tab, on the edge and not per render', async () => {
    // A list read when the session page mounted is not an answer about now, and the panel is mounted the whole time the reader is on some other tab (the dock never unmounts it).
    await render({ active: false })
    expect(wire.calls).toHaveLength(1)
    await rerender({ active: true })
    expect(wire.calls).toHaveLength(2)
    // Still visible, nothing running: an edge that fired once must not fire again per render.
    await rerender({ active: true })
    expect(wire.calls).toHaveLength(2)
  })

  it('draws nothing at all until the first read of a scope answers, so the dock speaks alone', async () => {
    // The dock draws its own centred "Loading…" over a non-ready tab AND the panel's body beneath it, so a panel with a loading state of its own would put two on screen at once. The verdict is what makes the tab non-ready, so it has to be reported from the unrendered state.
    let release: ((value: unknown) => void) | undefined
    wire.hold = () => new Promise((resolve) => (release = resolve))
    await render()
    expect(container?.querySelector('[data-tasks-panel]')).toBeNull()
    expect(last()).toEqual({ settled: false, running: null, shown: false })
    expect(tasksTabShown(last()!)).toBe(true)

    await act(async () => {
      release?.(tasks({ tasks: [task()] }))
      await Promise.resolve()
    })
    expect(container?.querySelector('[data-tasks-panel]')).not.toBeNull()
    expect(last()).toEqual({ settled: true, running: 1, shown: true })
  })
})

// Tasks already polled; what the shared cadence adds is a turn's falling edge (a finished turn is where
// a background task comes from) and the browser-visibility gate the other tabs get.
describe('TasksPanel auto refresh', () => {
  it('re-reads when a turn settles, even while the tab is hidden, since that read can reveal the tab', async () => {
    await render({ active: true })
    expect(wire.calls).toHaveLength(1)

    await rerender({ active: true, turnActive: true })
    await rerender({ active: true, turnActive: false })
    expect(wire.calls).toHaveLength(2)

    // A session the runtime starts tracking during the turn is how a hidden Tasks tab comes into the strip.
    await rerender({ active: false, turnActive: true })
    await rerender({ active: false, turnActive: false })
    expect(wire.calls).toHaveLength(3)
  })
})

describe('TasksPanel groups', () => {
  it('orders Tasks, Follow-ups, Subagents and Commands, and badges what runs in all of them', async () => {
    wire.data = tasks({
      tasks: [task(), task({ id: 't2', subagent: true }), task({ id: 't3', state: 'done', endedAt: NOW_ISO })]
    })
    wire.delegated = {
      subsessions: [
        delegatedRow(),
        delegatedRow({
          sessionId: null,
          title: 'CI on the release branch',
          kind: 'follow-up',
          parent: { sessionId: 'session-1', title: null, platform: 'slack', channelName: 'release' },
          followUp: {
            id: 'fu-1',
            status: 'waiting',
            nextCheck: '2026-08-11T15:00:00.000Z',
            doneWhen: 'all checks pass',
            recentChecks: []
          }
        }),
        delegatedRow({ sessionId: 'child-2', state: 'done', canStop: false })
      ],
      truncated: false,
      nextCursor: null
    }
    await render({ delegated: true })
    expect(groups()).toEqual(['tasks', 'follow-ups', 'subagents', 'commands'])
    expect(headings()).toEqual(['Tasks1', 'Follow-ups1', 'Subagents1', 'Commands1'])
    expect(text()).not.toContain('(managed by AgentConnect)')
    // Tasks and follow-ups can be stopped or ended; the runtime's rows stay read-only.
    const buttonsIn = (group: string) =>
      Array.from(container?.querySelectorAll(`[data-task-group="${group}"] .dsbtn`) ?? []).map((b) => b.textContent)
    expect(buttonsIn('tasks')).toEqual(['Stop'])
    expect(buttonsIn('follow-ups')).toEqual(['End'])
    expect(
      container?.querySelectorAll('[data-task-group="subagents"] button, [data-task-group="commands"] button')
    ).toHaveLength(0)
    // One meta line: a task's state and start, a follow-up's next check.
    expect(container?.querySelector('[data-task-group="tasks"] [data-meta-line]')?.textContent).toBe(
      'Running · started 2m ago'
    )
    expect(container?.querySelector('[data-task-group="follow-ups"] [data-subsession-state]')?.textContent).toMatch(
      /^Next check /
    )
    expect(finishedToggle()?.textContent).toBe('2 finished')
    expect(last()).toEqual({ settled: true, running: 3, shown: true })

    await showFinished()
    expect(headings()).toEqual(['Tasks2', 'Follow-ups1', 'Subagents1', 'Commands2'])
  })

  it('keeps the tab for finished delegated tasks alone, leaving out an untracked runtime', async () => {
    wire.data = tasks({ tracked: false })
    wire.delegated = {
      subsessions: [delegatedRow({ state: 'failed', canStop: false })],
      truncated: false,
      nextCursor: null
    }
    await render({ delegated: true })
    expect(groups()).toEqual([])
    expect(text()).toBe('Nothing running in the background.1 finished')
    expect(last()).toEqual({ settled: true, running: 0, shown: true })
    await showFinished()
    expect(groups()).toEqual(['tasks'])
    expect(text()).not.toContain('Nothing running')
  })

  it('leaves the delegated groups out while the conversation has none, and does not read them when not asked', async () => {
    wire.data = tasks({ tasks: [task()] })
    await render({ delegated: true })
    expect(groups()).toEqual(['commands'])
    await act(async () => root?.unmount())
    container?.remove()
    const api = await import('@/lib/api')
    vi.mocked(api.fetchAssistantSubsessions).mockClear()
    await render()
    expect(api.fetchAssistantSubsessions).not.toHaveBeenCalled()
  })
})
