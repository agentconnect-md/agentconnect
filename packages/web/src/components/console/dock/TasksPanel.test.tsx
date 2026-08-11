// @vitest-environment happy-dom

// The dock's Tasks panel: what it reports to its tab, the two DIFFERENT answers it refuses to collapse into one empty state (a daemon that tracks no lease for the session versus a tracked session with nothing running), and what it draws for every degraded answer the task wire can give — a daemon too old to report tasks, a session this reader cannot see, and an offline daemon.
// It also pins the two absences §3.5 argued for, so a later change has to argue with them rather than drift past: there is NO per-task cancel control (no agent-protocol primitive can address one background task, so a row-level stop could only cancel unrelated work or report one it did not perform), and NO progress bar or step line (the runtime reports neither, and inventing them would be a lie the reader cannot check).

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({
  data: null as unknown,
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
    })
  }
})

import { TasksPanel, formatTaskElapsed, tasksTabStatus, type TasksPanelVerdict } from './TasksPanel'
import type { AgentTaskDto, AgentTasksDto } from '@/lib/api'

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

beforeEach(() => {
  wire.data = tasks()
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
    expect(last()).toEqual({ settled: true, running: 0 })
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
    expect(rows()).toHaveLength(3)
    expect(last()).toEqual({ settled: true, running: 2 })
  })
})

describe('TasksPanel answers that are not rows', () => {
  it('says the runtime reports no tasks for an UNTRACKED session, not that there are none', async () => {
    // The distinction the `tracked` field exists for: a non-Claude runtime and an adapter without the lifecycle extension both have no lease, which is a different statement from "idle".
    wire.data = tasks({ tracked: false })
    await render()
    expect(text()).toContain('doesn’t report background tasks')
    expect(rows()).toHaveLength(0)
    // Null rather than 0: an unknown count must not wear a badge saying "none running".
    expect(last()).toEqual({ settled: true, running: null })
  })

  it('says the session is idle when it IS tracked and has nothing', async () => {
    await render()
    expect(text()).toContain('No background tasks in this session')
    expect(text()).not.toContain('doesn’t report background tasks')
  })

  it('names the version answer for a daemon too old to report tasks', async () => {
    wire.failure = { status: 409, code: 'DAEMON_FEATURE_MISSING' }
    await render()
    expect(text()).toContain('cannot report background tasks')
    expect(text()).toContain('Update the agent')
    expect(last()).toEqual({ settled: true, running: null })
  })

  it('says a session it cannot read is unavailable, and folds everything else into the offline story', async () => {
    wire.failure = { status: 404 }
    await render()
    expect(text()).toContain('not available to read')

    await act(async () => root?.unmount())
    container?.remove()
    wire.failure = { status: 503 }
    await render()
    expect(text()).toContain('owning daemon may be offline')
  })

  it('says older tasks are withheld when the daemon truncated its history', async () => {
    wire.data = tasks({ tasks: [task()], truncated: true })
    await render()
    expect(text()).toContain('bounded history')
  })
})

describe('TasksPanel rows', () => {
  it('draws each state with its own row marker', async () => {
    wire.data = tasks({
      tasks: [
        task({ id: 'a' }),
        task({ id: 'b', state: 'done', endedAt: NOW_ISO }),
        task({ id: 'c', state: 'failed', endedAt: NOW_ISO, detail: 'exit 1' })
      ]
    })
    await render()
    expect(states()).toEqual(['running', 'done', 'failed'])
  })

  it('shows the terminal status the runtime reported, and nothing when it named none', async () => {
    // `done` never asserts success on its own — most settle edges carry no status at all, which is exactly why `detail` is the only place a reported outcome may appear.
    wire.data = tasks({
      tasks: [task({ id: 'a', state: 'failed', endedAt: NOW_ISO, detail: 'killed' }), task({ id: 'b' })]
    })
    await render()
    expect(text()).toContain('killed')
  })

  it('keeps a task the runtime did not name, and says so instead of dropping the row', async () => {
    // An unnamed task is still the thing fencing host reclaim, so a panel that hid it would show "no tasks" beside a host refusing to be reclaimed.
    wire.data = tasks({ tasks: [task({ description: null })] })
    await render()
    expect(rows()).toHaveLength(1)
    expect(text()).toContain('Unnamed task')
  })

  it('CARRIES subagent rows and marks them, rather than filtering them out', async () => {
    // Same reason: the wire deliberately does not filter them at the source because the same records fence reclaim, so hiding them at render would recreate the lie one layer down.
    wire.data = tasks({ tasks: [task({ subagent: true })] })
    await render()
    expect(rows()).toHaveLength(1)
    expect(text()).toContain('subagent')
  })

  it('counts what is on screen in its header, so the census cannot disagree with the rows', async () => {
    wire.data = tasks({
      tasks: [
        task({ id: 'a' }),
        task({ id: 'b', state: 'done', endedAt: NOW_ISO }),
        task({ id: 'c', state: 'failed', endedAt: NOW_ISO })
      ]
    })
    await render()
    // Read off the census line itself rather than the panel's whole text, so a row that happens to carry the same words cannot satisfy it.
    expect(container?.querySelector('[data-tasks-census]')?.textContent).toBe('1 running · 1 done · 1 failed')
  })

  it('says how many are running even when nothing has finished, and stays silent about the states with none', async () => {
    wire.data = tasks({ tasks: [task({ id: 'a' }), task({ id: 'b' })] })
    await render()
    expect(container?.querySelector('[data-tasks-census]')?.textContent).toBe('2 running')
  })

  it('shows elapsed for a running task and a settled-ago for a finished one', async () => {
    wire.data = tasks({
      tasks: [
        task({ id: 'a', startedAt: '2026-08-11T11:57:46.000Z' }),
        task({ id: 'b', state: 'done', endedAt: '2026-08-11T11:48:00.000Z' })
      ]
    })
    await render()
    expect(text()).toContain('2m 14s')
    expect(text()).toContain('12m ago')
  })
})

describe('TasksPanel withheld controls (§3.5)', () => {
  it('offers NO cancel, stop, rerun or clear control on any row or in the header', async () => {
    // PREMISE: no ACP primitive can address one background task. `session/cancel` cancels a whole prompt turn, the only hard stop kills the agent's shared adapter and every session on it, and a background task outlives its turn so the turn-scoped interrupt is a no-op exactly when this panel matters. A row control could therefore only cancel unrelated work or report a cancellation it did not perform. If a task-addressed cancel ever lands upstream, re-aim this assertion at the new control — do not delete it.
    wire.data = tasks({ tasks: [task(), task({ id: 'b', state: 'failed', endedAt: NOW_ISO })] })
    await render()
    expect(container?.querySelectorAll('button')).toHaveLength(0)
    expect(text().toLowerCase()).not.toContain('cancel')
    expect(text().toLowerCase()).not.toContain('rerun')
    expect(text().toLowerCase()).not.toContain('clear finished')
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

  it('does NOT poll an idle list, because a settled task has no transition left to find', async () => {
    vi.useFakeTimers()
    wire.data = tasks({ tasks: [task({ state: 'done', endedAt: NOW_ISO })] })
    await render({ active: true })
    expect(wire.calls).toHaveLength(1)

    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(wire.calls).toHaveLength(1)
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
    expect(last()).toEqual({ settled: false, running: null })

    await act(async () => {
      release?.(tasks({ sessionId: 'session-2', tasks: [task({ id: 't2', description: 'the new scope’s task' })] }))
      await Promise.resolve()
    })
    expect(text()).toContain('the new scope’s task')
    expect(last()).toEqual({ settled: true, running: 1 })
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
    expect(last()).toEqual({ settled: false, running: null })

    await act(async () => {
      release?.(tasks({ tasks: [task()] }))
      await Promise.resolve()
    })
    expect(container?.querySelector('[data-tasks-panel]')).not.toBeNull()
    expect(last()).toEqual({ settled: true, running: 1 })
  })
})
