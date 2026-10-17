// The follow-up tools (assistant-mode.md §5.12): `followUp` in assistant mode only, and `recordCheck` inside a follow-up's check only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import {
  askerIdentity,
  FOLLOW_UP_TOOL,
  FOLLOW_UP_WATCH_TOOL,
  followUpToolsFor,
  PROPOSE_TOOL,
  PROPOSE_WATCH_TOOL,
  RECORD_CHECK_TOOL,
  RECORD_CHECK_WATCH_TOOL,
  type FollowUpWatchToolPort,
  type WatchOutcomeView
} from '../src/mcp/ops/assistant-items.js'
import { watchTarget } from '../src/assistant/follow-up-watches.js'
import { ALL_TOOL_NAMES } from '../src/mcp/tools.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { LocalStore } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { openTestStore } from './store-support.js'

const AGENT = 'agent-a'
const ALICE = 'slack:T0EXAMPLE:U0ALICE'
const NOW = Date.UTC(2026, 9, 9, 0, 0)
const TASK_KEY = 'slack:D0ALICE:subsession:check-1:agent-a:slack:scope-1'

const session = (over: Partial<SessionContext> = {}): SessionContext => ({
  agentId: AGENT,
  platform: 'slack',
  integrationId: 'int-1',
  transportScope: 'slack:scope-1',
  isDm: true,
  channel: 'D0ALICE',
  thread: 'append:1',
  deliveryThread: '1700000000.000100',
  tools: [FOLLOW_UP_TOOL],
  ...over
})
const ALICE_DM = session()
const CHECK = session({ thread: 'subsession:check-1', tools: [RECORD_CHECK_TOOL, PROPOSE_TOOL] })

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

/** A real store behind the deps; the asker is whoever the test says started the turn, and a check runs while `checking` holds. */
async function setup(options: { enabled?: boolean; watches?: FollowUpWatchToolPort } = {}) {
  store = await openTestStore()
  const s = store
  let asker: string | undefined = ALICE
  let checking: string | undefined
  const reports: string[] = []
  const deps = {
    assistantItems: {
      ledgerFor: () => (options.enabled === false ? undefined : s.assistantItems),
      watches: () => options.watches,
      askerFor: async () => asker,
      take: async (
        ctx: SessionContext,
        input: { title: string; doneWhen: string; nextCheck?: number; summary?: string; asker: string }
      ) =>
        await s.assistantItems.create({
          agentId: ctx.agentId,
          title: input.title,
          doneWhen: input.doneWhen,
          ...(input.nextCheck !== undefined ? { nextCheck: input.nextCheck } : {}),
          status: input.nextCheck !== undefined ? 'active' : 'waiting',
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          origin: { platform: ctx.platform, channel: ctx.channel, transportScope: ctx.transportScope ?? null },
          taskKey: TASK_KEY,
          asker: input.asker
        }),
      check: {
        itemFor: async () => checking,
        report: async (_ctx: SessionContext, _itemId: string, text: string) => {
          if (!checking) return false
          reports.push(text)
          return true
        },
        now: () => NOW
      }
    }
  } as unknown as OpsDeps
  const call = (ctx: SessionContext, name: string, args: Record<string, unknown>) =>
    executeTool(ctx, name, args, deps) as Promise<any>
  return {
    s,
    call,
    reports,
    askAs: (identity: string | undefined) => {
      asker = identity
    },
    check: (itemId: string | undefined) => {
      checking = itemId
    }
  }
}

describe('the follow-up tools are offered only to assistant-mode agents', () => {
  it('derives the offered set from the agent’s switch and reserves every name, the item tools gone', () => {
    expect(followUpToolsFor({})).toEqual([])
    expect(followUpToolsFor({ assistantMode: { enabled: false } })).toEqual([])
    expect(followUpToolsFor({ assistantMode: { enabled: true } }).map((t) => t.name)).toEqual(['followUp'])
    expect(ALL_TOOL_NAMES).toEqual(expect.arrayContaining(['followUp', 'recordCheck', 'propose']))
    for (const gone of ['takeItem', 'listItems', 'updateItem', 'followItem']) expect(ALL_TOOL_NAMES).not.toContain(gone)
  })

  it('refuses followUp once the agent is not in assistant mode', async () => {
    const { call } = await setup({ enabled: false })
    await expect(call(ALICE_DM, 'followUp', { title: 'x', doneWhen: 'y' })).rejects.toThrow(
      'only to an agent in assistant mode'
    )
  })

  it('carries the confirmation and duplicate rules in followUp’s description', () => {
    const text = FOLLOW_UP_TOOL.description
    expect(text).toContain('call this only after the person confirms')
    expect(text).toContain('Call listTasks before restating')
    expect(text).toContain(
      'offer to send the change to it with sendMessage action `messageTask` instead of taking a second one'
    )
    expect(text).toContain('promise a check then, never an action')
    expect(text).toContain('by the `taskId` this returns')
  })

  it('keeps the taskId to its own calls and has people know a follow-up by its title', async () => {
    expect(FOLLOW_UP_TOOL.description).toContain(
      'That id is for those calls alone: never show it to people, who know the follow-up by its title.'
    )
    const { call } = await setup()
    const taken = await call(ALICE_DM, 'followUp', { title: 'Watch the deploy', doneWhen: 'It is live' })
    expect(taken.note).toMatch(/ Never show the taskId to people; name the follow-up by its title\.$/)
  })
})

describe('followUp', () => {
  it('takes a follow-up of this conversation for the person asking and hands back its taskId', async () => {
    const { call, s } = await setup()
    const taken = await call(ALICE_DM, 'followUp', {
      title: 'Ship the release notes',
      doneWhen: 'The notes are posted in the release channel',
      nextCheck: '2026-10-09T09:00:00+08:00',
      summary: 'Alice asked for the release notes.'
    })
    expect(taken).toEqual({
      taskId: TASK_KEY,
      followUp: {
        title: 'Ship the release notes',
        doneWhen: 'The notes are posted in the release channel',
        nextCheck: '2026-10-09T01:00:00.000Z',
        summary: 'Alice asked for the release notes.'
      },
      note: expect.stringMatching(/Its first check runs at nextCheck.* Never show the taskId to people/)
    })
    expect(await s.assistantItems.byTaskKey(AGENT, TASK_KEY)).toMatchObject({
      status: 'active',
      asker: ALICE,
      origin: { platform: 'slack', channel: 'D0ALICE', transportScope: 'slack:scope-1' }
    })
  })

  it('needs a person who asked, a done-when and an instant with an offset', async () => {
    const { call, askAs, s } = await setup()
    await expect(call(ALICE_DM, 'followUp', { title: 'x' })).rejects.toThrow('doneWhen')
    await expect(
      call(ALICE_DM, 'followUp', { title: 'x', doneWhen: 'y', nextCheck: '2026-10-09T09:00:00' })
    ).rejects.toThrow('ISO-8601 instant with an offset')
    await expect(call(ALICE_DM, 'followUp', { title: 'x'.repeat(301), doneWhen: 'y' })).rejects.toThrow('300')
    askAs(undefined)
    await expect(call(ALICE_DM, 'followUp', { title: 'x', doneWhen: 'y' })).rejects.toThrow("needs a person's request")
    expect(await s.assistantItems.list(AGENT)).toEqual([])
  })

  it('takes one with no next check as waiting until it is messaged', async () => {
    const { call, s } = await setup()
    const taken = await call(ALICE_DM, 'followUp', { title: 'Watch the deploy', doneWhen: 'It is live' })
    expect(taken.note).toContain('until you message it with messageTask')
    expect(await s.assistantItems.byTaskKey(AGENT, TASK_KEY)).toMatchObject({ status: 'waiting', nextCheck: null })
  })
})

describe('recordCheck', () => {
  it('records what the check saw, sets the next check or ends the follow-up, and keeps a report', async () => {
    const { call, check, reports, s } = await setup()
    const { taskId } = await call(ALICE_DM, 'followUp', { title: 'Watch the deploy', doneWhen: 'It is live' })
    const item = (await s.assistantItems.byTaskKey(AGENT, taskId))!
    check(item.id)

    const later = new Date(NOW + 60 * 60_000).toISOString()
    expect(await call(CHECK, 'recordCheck', { observation: 'Rollout at 40%', nextCheck: later })).toEqual({
      ok: true,
      followUp: { state: 'waiting', nextCheck: later }
    })
    expect(await s.assistantItems.get(AGENT, item.id)).toMatchObject({ status: 'active', nextCheck: NOW + 60 * 60_000 })
    expect(await call(CHECK, 'recordCheck', { observation: 'Rollout paused' })).toMatchObject({
      followUp: { state: 'waiting', nextCheck: null }
    })
    expect(await s.assistantItems.get(AGENT, item.id)).toMatchObject({ status: 'waiting', nextCheck: null })
    expect(
      await call(CHECK, 'recordCheck', { observation: 'It is live', done: true, report: 'The deploy is live.' })
    ).toEqual({ ok: true, followUp: { state: 'done', nextCheck: null }, report: 'passed on when this check ends' })
    expect(reports).toEqual(['The deploy is live.'])
    const after = (await s.assistantItems.get(AGENT, item.id))!
    expect(after.status).toBe('done')
    expect(after.observations.map((o) => [o.text, o.author])).toEqual([
      ['Rollout at 40%', 'check'],
      ['Rollout paused', 'check'],
      ['It is live', 'check']
    ])
    // An ended follow-up still takes what its last check saw, and stays ended.
    expect(await call(CHECK, 'recordCheck', { observation: 'Seen again', nextCheck: later })).toMatchObject({
      followUp: { state: 'ended', nextCheck: null }
    })
    expect((await s.assistantItems.get(AGENT, item.id))?.status).toBe('done')
  })

  it('refuses outside a check, without an observation, too soon, or both ending and rescheduling', async () => {
    const { call, check, s } = await setup()
    const { taskId } = await call(ALICE_DM, 'followUp', { title: 'Watch the deploy', doneWhen: 'It is live' })
    const item = (await s.assistantItems.byTaskKey(AGENT, taskId))!
    await expect(
      call({ ...ALICE_DM, tools: [RECORD_CHECK_TOOL] }, 'recordCheck', { observation: 'x' })
    ).rejects.toThrow('available only in a follow-up’s check')
    await expect(call(CHECK, 'recordCheck', { observation: 'x' })).rejects.toThrow('this check has ended')
    check(item.id)
    await expect(call(CHECK, 'recordCheck', {})).rejects.toThrow('observation')
    await expect(
      call(CHECK, 'recordCheck', { observation: 'x', nextCheck: new Date(NOW + 60_000).toISOString() })
    ).rejects.toThrow('at least five minutes from now')
    await expect(
      call(CHECK, 'recordCheck', { observation: 'x', done: true, nextCheck: new Date(NOW + 3_600_000).toISOString() })
    ).rejects.toThrow('not both')
    // A name a check was not offered is refused, whatever the runtime sends.
    await expect(call(CHECK, 'followUp', { title: 'x', doneWhen: 'y' })).rejects.toThrow(
      'followUp is not available in a follow-up’s read-only check'
    )
    expect((await s.assistantItems.get(AGENT, item.id))?.observations).toEqual([])
  })
})

describe('askerIdentity', () => {
  const message = (over: Partial<NormalizedMessage>): NormalizedMessage => ({
    msgId: 'slack:C0GENERAL:1',
    traceId: 't',
    source: 'user',
    platform: 'slack',
    channel: 'C0GENERAL',
    sender: { id: 'U0ALICE', isBot: false },
    text: 'hi',
    mentionedBots: [],
    isDm: false,
    ...over
  })

  it('names an IM sender by platform, tenant scope and user, and a webchat author by principal', () => {
    expect(askerIdentity(message({}), 'T0EXAMPLE')).toBe(ALICE)
    expect(askerIdentity(message({ platform: 'telegram', sender: { id: '42', isBot: false } }), 'mint:abc')).toBe(
      'telegram:mint:abc:42'
    )
    expect(askerIdentity(message({ platform: 'webchat', sender: { id: 'u-1', isBot: false } }), undefined)).toBe(
      'user:u-1'
    )
  })

  it('names nobody for a turn no person started, or without a tenant scope', () => {
    expect(askerIdentity(message({ source: 'cron' }), 'T0EXAMPLE')).toBeUndefined()
    expect(askerIdentity(message({ source: 'agent' }), 'T0EXAMPLE')).toBeUndefined()
    expect(askerIdentity(message({ sender: { id: 'B0BOT', isBot: true } }), 'T0EXAMPLE')).toBeUndefined()
    expect(askerIdentity(message({}), undefined)).toBeUndefined()
    expect(askerIdentity(message({ platform: 'webchat', sender: { id: 'a name', isBot: false } }), undefined)).toBe(
      undefined
    )
  })
})

describe('the daemon offers followUp by the agent’s switch', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('registers it for an assistant-mode agent only, and hands the follow-ups out by the live switch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-assistant-tools-'))
    dirs.push(root)
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { claude: { command: 'node', args: [] } }
      })
    )
    const on = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    const off = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
    for (const [id, assistantMode] of [
      [on, { enabled: true }],
      [off, undefined]
    ] as const) {
      const agentDir = join(root, 'agents', id)
      mkdirSync(agentDir, { recursive: true })
      writeFileSync(
        join(agentDir, 'agent.json'),
        JSON.stringify({
          id,
          name: id.slice(-2),
          status: 'active',
          runtime: 'claude',
          workspace: { mode: 'from-scratch', path: join(agentDir, 'ws') },
          integrations: [],
          output: { mode: 'medium' },
          ...(assistantMode ? { assistantMode } : {})
        })
      )
    }
    const idleHost = (agent: { id: string }) =>
      ({
        id: agent.id,
        start: vi.fn().mockResolvedValue(undefined),
        newSession: vi.fn(),
        prompt: vi.fn(),
        cancel: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined)
      }) as never
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: idleHost })
    await daemon.start()
    try {
      const seam = daemon as unknown as {
        store: LocalStore
        sessions: { deps: { mcpServersFor(input: unknown): { env: { name: string; value: string }[] }[] } }
        mcp: {
          sessions: Map<string, SessionContext>
          deps: OpsDeps
        }
      }
      const registeredTools = (agent: Record<string, unknown>, thread = '1'): string[] => {
        const [server] = seam.sessions.deps.mcpServersFor({
          agent: { name: 'x', runtime: 'claude', integrations: [], mcpServers: [], ...agent },
          platform: 'slack',
          channel: 'C1',
          thread,
          deliveryThread: '1',
          isDm: false,
          sessionKey: `slack:C1:${thread}:${String(agent.id)}`
        })
        const token = server!.env.find((entry) => entry.name === 'AC_MCP_TOKEN')!.value
        return seam.mcp.sessions.get(token)!.tools.map((tool) => tool.name)
      }
      expect(registeredTools({ id: on, assistantMode: { enabled: true } })).toContain('followUp')
      expect(registeredTools({ id: on, assistantMode: { enabled: true } })).not.toContain('recordCheck')
      expect(registeredTools({ id: off })).not.toContain('followUp')
      // A follow-up's check records and proposes, and takes no follow-up of its own.
      const inCheck = registeredTools({ id: on, assistantMode: { enabled: true } }, 'subsession:check-1')
      expect(inCheck).toEqual(expect.arrayContaining(['recordCheck', 'propose']))
      expect(inCheck).not.toContain('followUp')

      const items = seam.mcp.deps.assistantItems!
      expect(items.ledgerFor(on)).toBe(seam.store.assistantItems)
      expect(items.ledgerFor(off)).toBeUndefined()
      expect(await items.askerFor(session({ agentId: on }))).toBeUndefined()
    } finally {
      await daemon.stop()
    }
  })
})

describe('a follow-up’s watch (assistant-mode.md §5.14)', () => {
  const PR = 'https://github.com/example-org/example-repo/pull/12'

  /** A watch port that answers `outcome` and records each call. */
  function port(outcome: WatchOutcomeView = { kind: 'watching', target: 'example-org/example-repo#12' }) {
    const calls: string[] = []
    const watches: FollowUpWatchToolPort = {
      check: (url) => void watchTarget(url),
      set: async (_agentId, itemId, url) => {
        calls.push(`set ${itemId} ${url}`)
        return outcome
      },
      clear: async (_agentId, itemId) => {
        calls.push(`clear ${itemId}`)
        return { kind: 'none' }
      },
      end: async (_agentId, itemId) => {
        calls.push(`end ${itemId}`)
      }
    }
    return { watches, calls }
  }

  it('offers `watch` only toward a Control Plane that takes it, within every runtime’s limits', () => {
    const on = { assistantMode: { enabled: true } }
    expect(followUpToolsFor(on, { watch: true })).toEqual([FOLLOW_UP_WATCH_TOOL])
    expect(followUpToolsFor(on, { watch: false })).toEqual([FOLLOW_UP_TOOL])
    for (const [plain, watched] of [
      [FOLLOW_UP_TOOL, FOLLOW_UP_WATCH_TOOL],
      [RECORD_CHECK_TOOL, RECORD_CHECK_WATCH_TOOL],
      [PROPOSE_TOOL, PROPOSE_WATCH_TOOL]
    ] as const) {
      // The tool's own description is untouched; only one property is added.
      expect(watched.description).toBe(plain.description)
      expect(watched.description.length).toBeLessThanOrEqual(2_048)
      expect(Buffer.byteLength(JSON.stringify(watched.inputSchema))).toBeLessThanOrEqual(5_000)
      expect(watched.inputSchema).not.toHaveProperty('oneOf')
    }
    expect(JSON.stringify(FOLLOW_UP_WATCH_TOOL.inputSchema)).toContain('its events then wake a check early')
    expect(JSON.stringify(RECORD_CHECK_WATCH_TOOL.inputSchema)).toContain('or an empty string to stop watching')
    expect(JSON.stringify(PROPOSE_WATCH_TOOL.inputSchema)).toContain('its events then wake a check early')
  })

  it('takes the follow-up, then watches what it names, and says a refused watch back', async () => {
    const watching = port()
    const { call, s } = await setup({ watches: watching.watches })
    const taken = await call(ALICE_DM, 'followUp', { title: 'PR #12', doneWhen: 'It merged', watch: PR })
    const [item] = await s.assistantItems.list(AGENT)
    expect(watching.calls).toEqual([`set ${item!.id} ${PR}`])
    expect(taken.watch).toBe('Watching example-org/example-repo#12: its events wake a check early.')

    const refusing = port({ kind: 'refused', reason: 'your code-host access does not cover it' })
    const second = await setup({ watches: refusing.watches })
    const result = await second.call(ALICE_DM, 'followUp', { title: 'PR #13', doneWhen: 'It merged', watch: PR })
    // The person confirmed the follow-up, not the watch: it is taken either way.
    expect(await second.s.assistantItems.list(AGENT)).toHaveLength(1)
    expect(result.watch).toBe(
      'Not watched: your code-host access does not cover it. It is checked by time only; tell the person why.'
    )
  })

  it('refuses a URL that names no pull request, merge request or issue, and `watch` where none is taken, before taking anything', async () => {
    const { call, s } = await setup({ watches: port().watches })
    await expect(
      call(ALICE_DM, 'followUp', {
        title: 'Build',
        doneWhen: 'Green',
        watch: 'https://github.com/example-org/example-repo/actions/runs/5'
      })
    ).rejects.toThrow('argument watch must be the URL of one pull request, merge request or issue')
    const none = await setup()
    await expect(none.call(ALICE_DM, 'followUp', { title: 'PR', doneWhen: 'Merged', watch: PR })).rejects.toThrow(
      'watching is not available here'
    )
    expect(await s.assistantItems.list(AGENT)).toEqual([])
    expect(await none.s.assistantItems.list(AGENT)).toEqual([])
  })

  it('moves the watch with a new URL, stops it with an empty one, and ends it with `done`', async () => {
    const watching = port()
    const { call, s, check } = await setup({ watches: watching.watches })
    await call(ALICE_DM, 'followUp', { title: 'Issue #7', doneWhen: 'Its fix merged' })
    const [item] = await s.assistantItems.list(AGENT)
    check(item!.id)
    const moved = await call(CHECK, 'recordCheck', { observation: 'Fixed by #12.', watch: PR })
    expect(moved.watch).toBe('Watching example-org/example-repo#12: its events wake a check early.')
    await call(CHECK, 'recordCheck', { observation: 'Still open.', watch: '' })
    await s.assistantItems.setWatch(AGENT, item!.id, {
      url: PR,
      target: 'example-org/example-repo#12',
      state: 'watching',
      reason: null
    })
    await call(CHECK, 'recordCheck', { observation: 'Merged.', done: true })
    expect(watching.calls).toEqual([`set ${item!.id} ${PR}`, `clear ${item!.id}`, `end ${item!.id}`])
  })
})
