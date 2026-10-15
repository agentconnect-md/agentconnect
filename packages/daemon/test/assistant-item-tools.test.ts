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
  followUpToolsFor,
  PROPOSE_TOOL,
  RECORD_CHECK_TOOL
} from '../src/mcp/ops/assistant-items.js'
import { ALL_TOOL_NAMES } from '../src/mcp/tools.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { LocalStore } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { openTestStore } from './store-support.js'

const AGENT = 'agent-a'
const ALICE = 'slack:T0EXAMPLE:U0ALICE'
const NOW = Date.UTC(2026, 9, 9, 0, 0)
const TASK_KEY = 'slack:D0ALICE:subsession:patrol-1:agent-a:slack:scope-1'

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
const CHECK = session({ thread: 'subsession:patrol-1', tools: [RECORD_CHECK_TOOL, PROPOSE_TOOL] })

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

/** A real store behind the deps; the asker is whoever the test says started the turn, and a check runs while `checking` holds. */
async function setup(options: { enabled?: boolean } = {}) {
  store = await openTestStore()
  const s = store
  let asker: string | undefined = ALICE
  let checking: string | undefined
  const reports: string[] = []
  const deps = {
    assistantItems: {
      ledgerFor: () => (options.enabled === false ? undefined : s.assistantItems),
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
      patrol: {
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
    expect(text).toContain('offer to send it the change with sendMessage messageTask instead of taking a second one')
    expect(text).toContain('promise a check then, never an action')
    expect(text).toContain('by the `taskId` this returns')
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
      note: expect.stringContaining('Its first check runs at nextCheck')
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
      const inCheck = registeredTools({ id: on, assistantMode: { enabled: true } }, 'subsession:patrol-1')
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
