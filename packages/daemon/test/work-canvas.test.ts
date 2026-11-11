// A channel's Work page (assistant-mode.md §5.19): what it lists, when it is written, and when it comes down.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeWorkPages, sweepWorkCanvases, type WorkCanvasDeps } from '../src/assistant/work-canvas.js'
import type { WorkPage, WorkPageRef, WorkPageResult } from '../src/platforms/contract.js'
import { renderWorkPage, workBookmarkTitle, workPageTitle } from '../src/platforms/slack/work-page.js'
import type { PlacedSubsession } from '../src/store/assistant-subsessions.js'
import type { LocalStore } from '../src/store/local-store.js'
import { canonicalColumns } from '../src/store/postgres-dialect.js'
import { WORK_CANVAS_SCHEMA, type WorkCanvasRow } from '../src/store/work-canvases.js'
import { openTestStore } from './store-support.js'

const CHANNEL = { platform: 'slack', channel: 'C0ENG', transportScope: 'T0EXAMPLE' }
const NOW = Date.parse('2026-11-10T08:00:00Z')

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

function followUp(over: Partial<PlacedSubsession> = {}): PlacedSubsession {
  return {
    agentId: 'bot-a',
    childSessionKey: 'slack:C0ENG:subsession:check-1',
    parentSessionId: 'sess-parent',
    parentSessionKey: 'slack:C0ENG:root',
    state: 'done',
    createdAt: NOW - 60_000,
    changedAt: NOW - 60_000,
    mode: 'watch',
    watchStatus: 'active',
    nextAt: NOW + 3_600_000,
    place: CHANNEL,
    title: 'Tell Alice when PR #412 merges',
    replyThread: '1761980000.000100',
    sessionId: 'sess-check-1',
    threadSessions: [],
    ...over
  }
}

function delegated(over: Partial<PlacedSubsession> = {}): PlacedSubsession {
  return {
    agentId: 'bot-a',
    childSessionKey: 'slack:C0ENG:subsession:delegated-1',
    parentSessionId: 'sess-parent',
    parentSessionKey: 'slack:C0ENG:root',
    state: 'open',
    createdAt: NOW - 30_000,
    changedAt: NOW - 30_000,
    title: 'Add retry with backoff to the webhook sender',
    owner: { ...CHANNEL, conversationKind: 'channel' },
    threadSessions: [],
    ...over
  }
}

interface Fake {
  deps: WorkCanvasDeps
  rows: PlacedSubsession[]
  agent: { id: string; name: string; assistantMode?: { enabled: boolean }; integrations: never[]; crons: unknown[] }
  put: ReturnType<typeof vi.fn<(channel: string, page: WorkPage, stored?: WorkPageRef) => Promise<WorkPageResult>>>
  remove: ReturnType<typeof vi.fn<(channel: string, stored: WorkPageRef) => Promise<void>>>
  external: { value: boolean }
  paused: { value: boolean }
}

async function fake(rows: PlacedSubsession[] = [], crons: unknown[] = []): Promise<Fake> {
  store = await openTestStore()
  const opened = store
  const agent = { id: 'bot-a', name: 'Butler', assistantMode: { enabled: true }, integrations: [] as never[], crons }
  const put = vi.fn(async (_channel: string, _page: WorkPage, stored?: WorkPageRef): Promise<WorkPageResult> =>
    stored ? { state: 'live', ...stored } : { state: 'live', canvasId: 'F0WORK', bookmarkId: 'Bk0WORK' }
  )
  const remove = vi.fn(async (_channel: string, _stored: WorkPageRef) => undefined)
  const external = { value: false }
  const paused = { value: false }
  const holder: Fake = {
    rows,
    agent,
    put,
    remove,
    external,
    paused,
    deps: {
      stores: {
        assistantSubsessions: { listPlaced: async () => holder.rows },
        assistantItems: { listOpen: async () => [] },
        workCanvases: opened.workCanvases
      },
      agents: () => [holder.agent as never],
      serves: () => true,
      paused: () => paused.value,
      resolve: (_agentId, at) =>
        at.platform === 'slack' ? { integrationId: 'int-slack', transportScope: 'T0EXAMPLE' } : undefined,
      connection: () => ({ putWorkPage: put, removeWorkPage: remove }),
      external: () => external.value,
      taskLink: (row) => (row.sessionId ? `https://console.example.test/sessions/${row.sessionId}` : undefined),
      consoleUrl: () => 'https://console.example.test/agents/bot-a',
      now: () => NOW,
      warn: () => {}
    }
  }
  return holder
}

const rowOf = async (): Promise<WorkCanvasRow | undefined> => (await store!.workCanvases.list('bot-a'))[0]

describe('the Work page store', () => {
  it('keeps one row per place and the latest anchor per cron, and is removed with the agent', async () => {
    store = await openTestStore()
    const pages = store.workCanvases
    const row = { agentId: 'bot-a', ...CHANNEL, state: 'live' as const, canvasId: 'F1', digest: 'd1', updatedAt: 1 }
    await pages.put(row)
    await pages.put({ ...row, digest: 'd2', updatedAt: 2 })
    await pages.noteAnchor('bot-a', { cronId: 'cron-1', channel: 'C0ENG', thread: '1.000', firedAt: 1 })
    await pages.noteAnchor('bot-a', { cronId: 'cron-1', channel: 'C0ENG', thread: '2.000', firedAt: 2 })
    expect(await pages.list('bot-a')).toEqual([{ ...row, digest: 'd2', updatedAt: 2 }])
    expect(await pages.anchors('bot-a')).toEqual([{ cronId: 'cron-1', channel: 'C0ENG', thread: '2.000', firedAt: 2 }])
    expect(await pages.deleteForAgent('bot-a')).toBe(2)
    expect(await pages.list('bot-a')).toEqual([])
  })

  it('lists every camelCase column in canonicalColumns', () => {
    const names = new Set([...WORK_CANVAS_SCHEMA.matchAll(/\b[a-z]+[A-Z][A-Za-z]*\b/g)].map((m) => m[0]))
    const canonical = new Set<string>(canonicalColumns)
    expect([...names].filter((name) => !canonical.has(name))).toEqual([])
  })
})

describe('what a Work page lists', () => {
  it('lists the channel’s own open tasks and the crons that post there, and nothing a task wrote itself', async () => {
    const f = await fake(
      [followUp(), delegated({ summary: 'Read the private incident channel for Dave', background: 'private' })],
      [
        {
          id: 'cron-1',
          schedule: '0 9 * * 1',
          timezone: 'Asia/Shanghai',
          trigger: 'secret prompt',
          name: 'Weekly digest',
          enabled: true,
          origin: 'cp',
          target: { platform: 'slack', channel: 'C0ENG' }
        },
        {
          id: 'cron-2',
          schedule: '0 9 * * *',
          trigger: 'off',
          enabled: false,
          target: { platform: 'slack', channel: 'C0ENG' }
        },
        { id: 'cron-3', schedule: '0 9 * * *', trigger: 'headless', enabled: true }
      ]
    )
    await store!.workCanvases.noteAnchor('bot-a', {
      cronId: 'cron-1',
      channel: 'C0ENG',
      thread: '1762000000.000200',
      firedAt: NOW - 1
    })
    const pages = await composeWorkPages(f.deps, f.agent as never, new Date(NOW))
    expect([...pages.values()]).toEqual([
      {
        place: { platform: 'slack', channel: 'C0ENG', integrationId: 'int-slack', transportScope: 'T0EXAMPLE' },
        tasks: [
          { kind: 'task', status: 'running', title: 'Add retry with backoff to the webhook sender' },
          {
            kind: 'follow-up',
            status: 'next',
            nextCheck: NOW + 3_600_000,
            title: 'Tell Alice when PR #412 merges',
            thread: '1761980000.000100',
            consoleUrl: 'https://console.example.test/sessions/sess-check-1'
          }
        ],
        schedules: [{ label: 'Weekly digest', nextRun: '2026-11-16 09:00 Asia/Shanghai', thread: '1762000000.000200' }],
        more: 0
      }
    ])
    expect(JSON.stringify([...pages.values()])).not.toMatch(/private|secret prompt/)
  })

  it('renders as Markdown, with titles shown as text linking the console, threads as links and no one mentioned', () => {
    const markdown = renderWorkPage(
      {
        agentName: 'Butler',
        tasks: [
          {
            kind: 'follow-up',
            status: 'next',
            nextCheck: NOW,
            title: 'Fix *all* [the] things',
            thread: '1.000'
          },
          {
            kind: 'task',
            status: 'idle',
            title: 'Draft the FAQ',
            consoleUrl: 'https://console.example.test/sessions/sess-2'
          }
        ],
        schedules: [{ label: 'Weekly digest', nextRun: '2026-11-16 09:00 Asia/Shanghai' }],
        more: 2,
        consoleUrl: 'https://console.example.test/agents/bot-a',
        updatedAt: NOW
      },
      new Map([['1.000', 'https://example.slack.com/archives/C0ENG/p1000']])
    )
    expect(markdown).toBe(
      [
        '## Open work',
        '',
        '- **Next check 2026-11-10 08:00 UTC** · Follow-up · Fix \\*all\\* \\[the\\] things · [thread](https://example.slack.com/archives/C0ENG/p1000)',
        '- **Idle** · Task · [Draft the FAQ](https://console.example.test/sessions/sess-2)',
        '',
        'And 2 more in the console.',
        '',
        '## Scheduled',
        '',
        '- Weekly digest · next 2026-11-16 09:00 Asia/Shanghai',
        '',
        '---',
        '',
        'Updated 2026-11-10 08:00 UTC · [Open in the console](https://console.example.test/agents/bot-a)'
      ].join('\n')
    )
    expect(renderWorkPage({ agentName: 'Butler', tasks: [], schedules: [], updatedAt: NOW })).toContain(
      'Nothing is open.'
    )
    expect(workPageTitle({ agentName: 'Butler' }, 'eng-platform')).toBe('Butler · #eng-platform')
    expect(workBookmarkTitle({ agentName: 'Butler' })).toBe("Butler's work")
  })
})

describe('the Work page sweep', () => {
  it('writes a page once, again only when it changed, in place', async () => {
    const f = await fake([followUp()])
    await sweepWorkCanvases(f.deps)
    await sweepWorkCanvases(f.deps)
    expect(f.put).toHaveBeenCalledTimes(1)
    expect(f.put.mock.calls[0]![2]).toBeUndefined()
    expect(await rowOf()).toMatchObject({ state: 'live', canvasId: 'F0WORK', bookmarkId: 'Bk0WORK' })
    f.rows = [followUp({ state: 'open' })]
    await sweepWorkCanvases(f.deps)
    expect(f.put).toHaveBeenCalledTimes(2)
    expect(f.put.mock.calls[1]![2]).toEqual({ canvasId: 'F0WORK', bookmarkId: 'Bk0WORK' })
  })

  it('keeps a page after its work ends, saying nothing is open, and creates none for a quiet channel', async () => {
    const quiet = await fake()
    await sweepWorkCanvases(quiet.deps)
    expect(quiet.put).not.toHaveBeenCalled()
    await store!.close()
    const f = await fake([followUp()])
    await sweepWorkCanvases(f.deps)
    f.rows = []
    await sweepWorkCanvases(f.deps)
    expect(f.put).toHaveBeenCalledTimes(2)
    expect(f.put.mock.calls[1]![1]).toMatchObject({ tasks: [], schedules: [] })
  })

  it('leaves a page a person deleted alone, until the mode is switched off', async () => {
    const f = await fake([followUp()])
    await sweepWorkCanvases(f.deps)
    f.put.mockResolvedValueOnce({ state: 'deleted' })
    f.rows = [followUp({ state: 'open' })]
    await sweepWorkCanvases(f.deps)
    f.rows = [followUp({ title: 'Something else' })]
    await sweepWorkCanvases(f.deps)
    expect(f.put).toHaveBeenCalledTimes(2)
    expect(await rowOf()).toMatchObject({ state: 'deleted' })
    f.agent.assistantMode = { enabled: false }
    await sweepWorkCanvases(f.deps)
    expect(f.remove).not.toHaveBeenCalled()
    expect(await rowOf()).toBeUndefined()
  })

  it('takes the page down when the mode is switched off or the channel is shared outside', async () => {
    const f = await fake([followUp()])
    await sweepWorkCanvases(f.deps)
    f.agent.assistantMode = { enabled: false }
    await sweepWorkCanvases(f.deps)
    expect(f.remove).toHaveBeenCalledWith('C0ENG', { canvasId: 'F0WORK', bookmarkId: 'Bk0WORK' })
    expect(await rowOf()).toBeUndefined()
    f.agent.assistantMode = { enabled: true }
    await sweepWorkCanvases(f.deps)
    f.external.value = true
    await sweepWorkCanvases(f.deps)
    expect(f.remove).toHaveBeenCalledTimes(2)
    expect(await rowOf()).toBeUndefined()
  })

  it('keeps the page’s record when its removal fails or its connection is away, and retries on the next sweep', async () => {
    const f = await fake([followUp()])
    await sweepWorkCanvases(f.deps)
    f.agent.assistantMode = { enabled: false }
    f.remove.mockRejectedValueOnce(new Error('ratelimited'))
    await sweepWorkCanvases(f.deps)
    expect(await rowOf()).toMatchObject({ state: 'live', canvasId: 'F0WORK' })
    await sweepWorkCanvases({ ...f.deps, connection: () => undefined })
    expect(await rowOf()).toMatchObject({ state: 'live', canvasId: 'F0WORK' })
    await sweepWorkCanvases(f.deps)
    expect(f.remove).toHaveBeenCalledTimes(2)
    expect(await rowOf()).toBeUndefined()
  })

  it('says the agent is paused, and drops that once it is resumed', async () => {
    const f = await fake([followUp()])
    await sweepWorkCanvases(f.deps)
    expect(f.put.mock.calls[0]![1].paused).toBeUndefined()
    f.paused.value = true
    await sweepWorkCanvases(f.deps)
    expect(f.put.mock.calls[1]![1]).toMatchObject({ paused: true })
    expect(renderWorkPage(f.put.mock.calls[1]![1])).toMatch(
      /^\*\*Butler is paused\.\*\* No task runs and no follow-up is checked until it is resumed in the console\./
    )
    f.paused.value = false
    await sweepWorkCanvases(f.deps)
    expect(f.put).toHaveBeenCalledTimes(3)
    expect(renderWorkPage(f.put.mock.calls[2]![1])).toMatch(/^## Open work/)
  })

  it('rewrites the page under the agent’s new name when it is renamed', async () => {
    const f = await fake([followUp()])
    await sweepWorkCanvases(f.deps)
    expect(f.put.mock.calls[0]![1]).toMatchObject({ agentName: 'Butler' })
    f.agent.name = 'Jeeves'
    await sweepWorkCanvases(f.deps)
    expect(f.put).toHaveBeenCalledTimes(2)
    expect(f.put.mock.calls[1]![1]).toMatchObject({ agentName: 'Jeeves' })
  })

  it('records a failed write and retries it only when the page changes', async () => {
    const f = await fake([followUp()])
    f.put.mockRejectedValueOnce(new Error('ratelimited'))
    await sweepWorkCanvases(f.deps)
    await sweepWorkCanvases(f.deps)
    expect(await rowOf()).toMatchObject({ state: 'failed' })
    expect(f.put).toHaveBeenCalledTimes(1)
    f.rows = [followUp({ state: 'open' })]
    await sweepWorkCanvases(f.deps)
    expect(f.put).toHaveBeenCalledTimes(2)
    expect(await rowOf()).toMatchObject({ state: 'live' })
  })

  it('writes nothing for an agent another member serves', async () => {
    const f = await fake([followUp()])
    await sweepWorkCanvases({ ...f.deps, serves: () => false })
    expect(f.put).not.toHaveBeenCalled()
  })
})
