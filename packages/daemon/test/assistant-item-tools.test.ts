// The assistant item tools (assistant-mode.md §1.2, §5.4): offered only in assistant mode, writing the ledger as the asker.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import {
  ASSISTANT_ITEM_TOOLS,
  askerIdentity,
  assistantItemToolsFor,
  type AssistantItemLedgerPort
} from '../src/mcp/ops/assistant-items.js'
import { ALL_TOOL_NAMES } from '../src/mcp/tools.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { LocalStore } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { openTestStore } from './store-support.js'

const AGENT = 'agent-a'
const ALICE = 'slack:T0EXAMPLE:U0ALICE'
const BOB = 'slack:T0EXAMPLE:U0BOB'
const ITEM_TOOL_NAMES = ['takeItem', 'listItems', 'updateItem', 'followItem']

const session = (over: Partial<SessionContext> = {}): SessionContext => ({
  agentId: AGENT,
  platform: 'slack',
  integrationId: 'int-1',
  transportScope: 'slack:scope-1',
  isDm: true,
  channel: 'D0ALICE',
  thread: 'append:1',
  deliveryThread: '1700000000.000100',
  tools: ASSISTANT_ITEM_TOOLS,
  ...over
})
const ALICE_DM = session()
const GENERAL = session({ channel: 'C0GENERAL', isDm: false })

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

/** Real SQLite ledger behind the deps; the asker is whoever the test says started the turn. */
async function setup(options: { enabled?: boolean } = {}) {
  store = await openTestStore()
  const ledger: AssistantItemLedgerPort = store.assistantItems
  let asker: string | undefined = ALICE
  const deps = {
    assistantItems: {
      ledgerFor: () => (options.enabled === false ? undefined : ledger),
      askerFor: async () => asker
    }
  } as unknown as OpsDeps
  const call = (ctx: SessionContext, name: string, args: Record<string, unknown>) =>
    executeTool(ctx, name, args, deps) as Promise<any>
  return {
    ledger: store.assistantItems,
    call,
    askAs: (identity: string | undefined) => {
      asker = identity
    }
  }
}

describe('item tools are offered only to assistant-mode agents', () => {
  it('derives the offered set from the agent’s switch and reserves every name', () => {
    expect(assistantItemToolsFor({})).toEqual([])
    expect(assistantItemToolsFor({ assistantMode: { enabled: false } })).toEqual([])
    expect(assistantItemToolsFor({ assistantMode: { enabled: true } }).map((t) => t.name)).toEqual(ITEM_TOOL_NAMES)
    expect(ALL_TOOL_NAMES).toEqual(expect.arrayContaining(ITEM_TOOL_NAMES))
  })

  it('refuses every item tool once the agent is not in assistant mode', async () => {
    const { call } = await setup({ enabled: false })
    for (const [name, args] of [
      ['takeItem', { title: 'x', doneWhen: 'y' }],
      ['listItems', {}],
      ['updateItem', { itemId: 'i', observation: 'seen' }],
      ['followItem', { itemId: 'i' }]
    ] as const)
      await expect(call(ALICE_DM, name, args)).rejects.toThrow('only to an agent in assistant mode')
  })

  it('carries the confirmation, team-visibility and duplicate rules in the descriptions', () => {
    const take = ASSISTANT_ITEM_TOOLS.find((t) => t.name === 'takeItem')!.description
    expect(take).toContain('only after the person confirms')
    expect(take).toContain('never quote or paraphrase a direct message')
    expect(take).toContain('attach this to <who>’s item?')
    const update = ASSISTANT_ITEM_TOOLS.find((t) => t.name === 'updateItem')!.description
    expect(update).toContain('record the conflict in the summary')
  })
})

describe('takeItem', () => {
  it('records the asker and the current place as origin and first follower', async () => {
    const { call, ledger } = await setup()
    const { item } = await call(ALICE_DM, 'takeItem', {
      title: 'Ship the release notes',
      doneWhen: 'The notes are posted in the release channel',
      nextCheck: '2026-10-09T09:00:00+08:00',
      summary: 'Alice asked for the release notes.'
    })
    expect(item).toEqual({
      id: expect.any(String),
      title: 'Ship the release notes',
      status: 'active',
      doneWhen: 'The notes are posted in the release channel',
      nextCheck: '2026-10-09T01:00:00.000Z',
      summary: 'Alice asked for the release notes.',
      origin: { platform: 'slack', channel: 'D0ALICE' },
      followers: [{ identity: ALICE, place: { platform: 'slack', channel: 'D0ALICE' }, here: true }],
      version: 1,
      updatedAt: expect.any(String),
      observations: []
    })
    const place = { platform: 'slack', channel: 'D0ALICE', transportScope: 'slack:scope-1' }
    expect(await ledger.get(AGENT, item.id)).toMatchObject({ origin: place, followers: [{ identity: ALICE, place }] })
  })

  it('needs a person who asked, a done-when and an instant with an offset', async () => {
    const { call, askAs, ledger } = await setup()
    await expect(call(ALICE_DM, 'takeItem', { title: 'x' })).rejects.toThrow('doneWhen')
    await expect(
      call(ALICE_DM, 'takeItem', { title: 'x', doneWhen: 'y', nextCheck: '2026-10-09T09:00:00' })
    ).rejects.toThrow('ISO-8601 instant with an offset')
    await expect(call(ALICE_DM, 'takeItem', { title: 'x'.repeat(301), doneWhen: 'y' })).rejects.toThrow('300')
    askAs(undefined)
    await expect(call(ALICE_DM, 'takeItem', { title: 'x', doneWhen: 'y' })).rejects.toThrow("needs a person's request")
    expect(await ledger.list(AGENT)).toEqual([])
  })
})

describe('listItems', () => {
  it('lists active and waiting items by default, one item with its observations on request', async () => {
    const { call, ledger } = await setup()
    const a = (await call(ALICE_DM, 'takeItem', { title: 'a', doneWhen: 'done' })).item
    const b = (await call(ALICE_DM, 'takeItem', { title: 'b', doneWhen: 'done' })).item
    const c = (await call(ALICE_DM, 'takeItem', { title: 'c', doneWhen: 'done' })).item
    await call(ALICE_DM, 'updateItem', { itemId: b.id, version: 1, status: 'waiting' })
    await call(ALICE_DM, 'updateItem', { itemId: c.id, version: 1, status: 'done' })
    await ledger.create({ agentId: 'agent-b', title: 'not mine', origin: { ...a.origin, transportScope: null } })

    const open = await call(GENERAL, 'listItems', {})
    expect(open.items.map((item: { title: string }) => item.title).sort()).toEqual(['a', 'b'])
    expect(open.items[0].followers[0]).not.toHaveProperty('here')
    expect(open).not.toHaveProperty('more')
    expect((await call(GENERAL, 'listItems', { status: ['done'] })).items.map((i: any) => i.id)).toEqual([c.id])
    expect(await call(GENERAL, 'listItems', { limit: 1 })).toMatchObject({ items: [{}], more: true })

    await call(ALICE_DM, 'updateItem', { itemId: a.id, observation: 'Draft is in review' })
    const one = await call(GENERAL, 'listItems', { itemId: a.id })
    expect(one.items).toEqual([
      expect.objectContaining({
        id: a.id,
        observations: [{ text: 'Draft is in review', author: ALICE, at: expect.any(String) }]
      })
    ])
    await expect(call(GENERAL, 'listItems', { itemId: 'missing' })).rejects.toThrow('no item missing')
    await expect(call(GENERAL, 'listItems', { status: ['paused'] })).rejects.toThrow('status')
  })
})

describe('updateItem', () => {
  it('changes fields only on the current version and reports a stale one as a conflict', async () => {
    const { call, ledger } = await setup()
    const { item } = await call(ALICE_DM, 'takeItem', {
      title: 'Fix the flaky test',
      doneWhen: 'Ten green runs in a row',
      nextCheck: '2026-10-09T09:00:00Z'
    })
    const moved = await call(ALICE_DM, 'updateItem', {
      itemId: item.id,
      version: 1,
      status: 'waiting',
      summary: 'Waiting on the CI fix; Bob wants it skipped instead, Alice wants it fixed.'
    })
    expect(moved).toMatchObject({ ok: true, item: { status: 'waiting', version: 2 } })

    const stale = await call(ALICE_DM, 'updateItem', {
      itemId: item.id,
      version: 1,
      status: 'dropped',
      observation: 'should not land'
    })
    expect(stale).toMatchObject({
      ok: false,
      reason: 'conflict',
      message: expect.stringContaining('retry with version 2'),
      current: { status: 'waiting', version: 2 }
    })
    expect((await ledger.get(AGENT, item.id))?.observations).toEqual([])

    const closed = await call(ALICE_DM, 'updateItem', { itemId: item.id, version: 2, status: 'done' })
    expect(closed).toMatchObject({ ok: true, item: { status: 'done', nextCheck: null, version: 3 } })
  })

  it('appends an observation without a version and refuses empty or unversioned changes', async () => {
    const { call, askAs } = await setup()
    const { item } = await call(ALICE_DM, 'takeItem', { title: 'Watch the deploy', doneWhen: 'It is live' })
    askAs(undefined)
    const observed = await call(ALICE_DM, 'updateItem', { itemId: item.id, observation: 'Rollout at 40%' })
    expect(observed).toMatchObject({
      ok: true,
      item: { version: 1, observations: [{ text: 'Rollout at 40%', author: null }] }
    })
    await expect(call(ALICE_DM, 'updateItem', { itemId: item.id })).rejects.toThrow('needs a change')
    await expect(call(ALICE_DM, 'updateItem', { itemId: item.id, status: 'done' })).rejects.toThrow('version')
    await expect(call(ALICE_DM, 'updateItem', { itemId: 'missing', version: 1, status: 'done' })).rejects.toThrow(
      'no item missing'
    )
    await expect(call(ALICE_DM, 'updateItem', { itemId: 'missing', observation: 'x' })).rejects.toThrow(
      'no item missing'
    )
  })
})

describe('followItem', () => {
  it('attaches the asker in the current place once', async () => {
    const { call, askAs } = await setup()
    const { item } = await call(ALICE_DM, 'takeItem', { title: 'Renew the certificate', doneWhen: 'Renewed' })
    askAs(BOB)
    const followed = await call(GENERAL, 'followItem', { itemId: item.id })
    expect(followed).toMatchObject({
      added: true,
      item: {
        version: 1,
        followers: [
          { identity: ALICE, place: { platform: 'slack', channel: 'D0ALICE' } },
          { identity: BOB, place: { platform: 'slack', channel: 'C0GENERAL' }, here: true }
        ]
      }
    })
    expect((await call(GENERAL, 'followItem', { itemId: item.id })).added).toBe(false)
    await expect(call(GENERAL, 'followItem', { itemId: 'missing' })).rejects.toThrow('no item missing')
    askAs(undefined)
    await expect(call(GENERAL, 'followItem', { itemId: item.id })).rejects.toThrow("needs a person's request")
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

describe('the daemon offers the item tools by the agent’s switch', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('registers them for an assistant-mode agent only, and hands the ledger out by the live switch', async () => {
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
      [on, { enabled: true, responsibleUserId: 'usr_1' }],
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
      const registeredTools = (agent: Record<string, unknown>): string[] => {
        const [server] = seam.sessions.deps.mcpServersFor({
          agent: { name: 'x', runtime: 'claude', integrations: [], mcpServers: [], ...agent },
          platform: 'slack',
          channel: 'C1',
          thread: '1',
          deliveryThread: '1',
          isDm: false,
          sessionKey: `slack:C1:1:${String(agent.id)}`
        })
        const token = server!.env.find((entry) => entry.name === 'AC_MCP_TOKEN')!.value
        return seam.mcp.sessions.get(token)!.tools.map((tool) => tool.name)
      }
      expect(registeredTools({ id: on, assistantMode: { enabled: true } })).toEqual(
        expect.arrayContaining(ITEM_TOOL_NAMES)
      )
      const plain = registeredTools({ id: off })
      for (const name of ITEM_TOOL_NAMES) expect(plain).not.toContain(name)

      const items = seam.mcp.deps.assistantItems!
      expect(items.ledgerFor(on)).toBe(seam.store.assistantItems)
      expect(items.ledgerFor(off)).toBeUndefined()
      expect(await items.askerFor(session({ agentId: on }))).toBeUndefined()
    } finally {
      await daemon.stop()
    }
  })
})
