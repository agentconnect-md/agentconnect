import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssistantActivity } from '../src/cp/assistant-activity.js'
import {
  CodeTasksViews,
  codeTasksBlocks,
  readCodeTasks,
  type CodeTasksSnapshot
} from '../src/platforms/slack/code-tasks.js'
import { memoryStoreDatabase, openTestStore } from './store-support.js'

const startedAt = '2026-01-01T00:00:00.000Z'
const snapshot = (): CodeTasksSnapshot => ({
  tasks: [],
  truncated: false,
  runtime: {
    agentId: 'a1',
    sessionId: 's1',
    tracked: true,
    truncated: false,
    tasks: [
      { id: 'command', description: 'Run checks', subagent: false, state: 'running', startedAt },
      {
        id: 'agent',
        description: 'Review changes',
        subagent: true,
        state: 'done',
        startedAt,
        endedAt: '2026-01-01T00:00:04.000Z'
      }
    ]
  }
})

afterEach(() => vi.useRealTimers())

describe('Code channel Tasks', () => {
  it('keeps waiting follow-ups and threaded tasks open, and groups finished runtime work', () => {
    const data = snapshot()
    data.tasks = [
      {
        sessionId: 'threaded',
        parentSessionId: 's1',
        state: 'done',
        threaded: true,
        title: 'Discuss changes',
        createdAt: startedAt
      },
      {
        sessionId: null,
        parentSessionId: 's1',
        state: 'open',
        createdAt: startedAt,
        kind: 'follow-up',
        followUp: {
          title: 'Watch checks',
          status: 'waiting',
          doneWhen: null,
          nextCheck: null,
          recentChecks: []
        }
      }
    ]
    const blocks = codeTasksBlocks(data, Date.parse(startedAt) + 26_000)
    const finished = blocks.find((b) => b.type === 'container')
    expect(finished).toMatchObject({ title: { text: '1 finished' }, is_collapsible: true, default_collapsed: true })
    expect(JSON.stringify(finished)).toContain('Review changes')
    expect(JSON.stringify(finished)).not.toContain('Discuss changes')
    const visible = JSON.stringify(blocks.filter((b) => b.type !== 'container'))
    expect(visible).toContain('Run checks\\nRunning · 26s')
    expect(visible).toContain('Watch checks')
    expect(visible).toContain('Discuss changes')
    expect(visible).not.toContain('Stop')
    data.runtime.tracked = false
    expect(JSON.stringify(codeTasksBlocks(data))).toContain('has not reported')
  })

  it('bounds large snapshots and names the truncation instead of inventing a total', () => {
    const data = snapshot()
    data.runtime.tasks = Array.from({ length: 100 }, (_, i) => ({ ...data.runtime.tasks[i % 2]!, id: String(i) }))
    data.runtime.truncated = true
    const blocks = codeTasksBlocks(data)
    const container = blocks.find((b) => b.type === 'container')!
    expect(blocks.length + (container.child_blocks as unknown[]).length).toBeLessThan(50)
    expect(JSON.stringify(blocks)).toContain('50+ finished')
    expect(JSON.stringify(blocks)).toContain('Showing recent tasks')
  })

  it('continues after the reply ends, then stops polling once the background work settles', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(startedAt))
    const data = snapshot()
    const read = vi.fn(async () => data)
    const publish = vi.fn(async () => {})
    const views = new CodeTasksViews({ read, publish, debug: () => {} })
    try {
      views.watch('C1', 'key')
      await vi.advanceTimersByTimeAsync(0)
      views.idle('C1')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(publish).toHaveBeenCalledTimes(2)
      data.runtime.tasks[0] = { ...data.runtime.tasks[0]!, state: 'done', endedAt: '2026-01-01T00:00:06.000Z' }
      await vi.advanceTimersByTimeAsync(5_000)
      expect(JSON.stringify(publish.mock.calls.at(-1))).toContain('2 finished')
      const reads = read.mock.calls.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(read).toHaveBeenCalledTimes(reads)
      views.watch('C1', 'key')
      await vi.advanceTimersByTimeAsync(0)
      expect(read).toHaveBeenCalledTimes(reads + 1)
    } finally {
      views.stop()
    }
  })

  it('does not publish an old read after replacement or shutdown, and retries a failed write', async () => {
    vi.useFakeTimers()
    let release!: (data: CodeTasksSnapshot) => void
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          })
      )
      .mockResolvedValue(snapshot())
    const publish = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const views = new CodeTasksViews({ read, publish, debug: () => {} })
    try {
      views.watch('C1', 'old')
      views.watch('C1', 'new')
      await vi.advanceTimersByTimeAsync(0)
      release(snapshot())
      await vi.advanceTimersByTimeAsync(0)
      expect(publish).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(publish).toHaveBeenCalledTimes(2)
      const signal = publish.mock.calls[1]![2] as AbortSignal
      views.stop()
      expect(signal.aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(publish).toHaveBeenCalledTimes(2)
    } finally {
      views.stop()
    }
  })

  it('reads the console task ledger for exactly the admitted parent and masks its output', async () => {
    const store = await openTestStore({ database: memoryStoreDatabase() })
    try {
      await store.upsertSession({
        key: 'key',
        agentId: 'a1',
        platform: 'slack',
        channel: 'C1',
        thread: 'C1',
        sessionId: 's1',
        acpSessionId: 'runtime',
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: 1
      })
      for (const [parent, child] of [
        ['s1', 'child'],
        ['other', 'other-child']
      ])
        await store.assistantSubsessions.open({
          agentId: 'a1',
          parentSessionId: parent!,
          parentSessionKey: 'key',
          childSessionKey: child!,
          title: child === 'child' ? 'Check SAMPLE_SECRET' : 'Unrelated work',
          now: 1
        })
      const activity = createAssistantActivity({
        store: () => store,
        agent: () => ({}),
        now: () => 1,
        decideDraft: vi.fn(),
        stopSession: vi.fn()
      })
      const consoleRead = await activity.read({
        operation: 'subsessions',
        agentId: 'a1',
        limit: 50,
        parent: { sessionId: 's1' }
      })
      const admitted = vi.fn(async () => ['key'])
      const deps = {
        store,
        admitted,
        open: () => true,
        assistant: () => false,
        runtime: vi.fn(async () => snapshot().runtime),
        link: () => undefined,
        mask: <T>(_agent: string, value: T): T =>
          JSON.parse(JSON.stringify(value).replaceAll('SAMPLE_SECRET', '[redacted]')) as T
      }
      const slack = await readCodeTasks(deps, 'C1', 'key')
      expect(consoleRead.operation === 'subsessions' && consoleRead.subsessions).toHaveLength(1)
      expect(slack?.tasks).toHaveLength(1)
      expect(slack?.tasks[0]?.title).toBe('Check [redacted]')
      expect(deps.runtime).toHaveBeenCalledWith({ agentId: 'a1', sessionId: 's1' })
      expect(await readCodeTasks(deps, 'C2', 'key')).toBeUndefined()
      admitted.mockResolvedValue([])
      expect(await readCodeTasks(deps, 'C1', 'key')).toBeUndefined()
      expect(deps.runtime).toHaveBeenCalledTimes(1)
    } finally {
      await store.close()
    }
  })
})
