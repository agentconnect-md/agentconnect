// A place learns it became shared from its next event, so a post no event from it triggered asks the platform first (assistant-mode.md §5.3); its own posts go out directly (#2979, B4).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import type { CronDef } from '../src/agents/agent-schema.js'
import { PLACE_SHARE_TTL_MS } from '../src/assistant/place-trust.js'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { conversationTrustLevel } from '../src/router/routing-rule.js'
import { buildSyntheticMessage } from '../src/scheduler/scheduler.js'
import type { AssistantDraft } from '../src/store/assistant-drafts.js'
import { sessionKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const INT = 'int-bot-a'
const TS = '1700000000.000100'
const REPLY = 'The digest is ready.'

function scaffold(assistant: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-shared-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: INT,
          platform: 'slack',
          core: {
            gated: true,
            bindRules: ['C_ROOM', 'C_EXT', 'D_U1'].map((channel) => ({ match: { kind: 'auto' }, channel })),
            externalChannels: ['C_EXT']
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'medium' },
      ...(assistant ? { assistantMode: { enabled: true, responsibleUserId: 'usr-1' } } : {})
    })
  )
  return root
}

/** A daemon whose Slack says which channels are shared now, or fails to say. */
async function boot(assistant = true) {
  const root = scaffold(assistant)
  const clock = new FakeClock(Date.now())
  const daemon = new Daemon({
    root,
    clock,
    slackAppFactory: fakeSlackAppFactory(),
    hostFactory: (_agent, onUpdate) =>
      ({
        __started: true,
        start: async () => {},
        stop: async () => {},
        cancel: async () => {},
        newSession: async () => 'acp-1',
        loadSession: async () => true,
        hasSession: () => true,
        prompt: async (id: string) => {
          onUpdate(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } })
          return { stopReason: 'end_turn' }
        }
      }) as never
  })
  await daemon.start()
  const slack = { shared: new Set<string>(), failing: false }
  const conn = {
    workspaceId: () => 'T_FAKE_TEAM',
    workspaceUrl: 'https://example.slack.test',
    setStatus: vi.fn(async () => true),
    setTitle: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    postMessage: vi.fn(async () => '1700000000.000900'),
    postContext: vi.fn(async () => {}),
    postBlocks: vi.fn(async () => 'card-1'),
    updateBlocks: vi.fn(async () => true),
    updateMessage: vi.fn(async () => true),
    openDirectMessage: vi.fn(async (user: string) => `D_${user}`),
    isFullMember: vi.fn(async () => true),
    getChannelInfo: vi.fn(async (id: string) => {
      if (slack.failing) throw new Error('ratelimited')
      return {
        id,
        isIm: id.startsWith('D'),
        isPrivate: false,
        externalReason: slack.shared.has(id) ? ('externallyShared' as const) : null
      }
    })
  }
  const d = daemon as any
  d.connByIntegration.set(INT, conn)
  // The membership listing describes the room, so every lookup counted below is a share check.
  d.channelSnapshots.set(INT, {
    channels: [{ id: 'C_ROOM', kind: 'channel', isPrivate: false, externalReason: null }],
    authoritative: true
  })
  const cron: CronDef = {
    id: 'cron-digest',
    schedule: '0 9 * * *',
    trigger: 'post the digest',
    enabled: true,
    target: { platform: 'slack', channel: 'C_ROOM', integrationId: INT }
  }
  let delivery = 0
  return {
    d,
    conn,
    slack,
    /** Past the age at which Slack's last answer on a share is asked again. */
    later: () => clock.advance(PLACE_SHARE_TTL_MS),
    /** A scheduled run fires into a channel. */
    fire: async (channel = 'C_ROOM') => {
      const run = { ...cron, target: { ...cron.target!, channel } }
      const { msg } = buildSyntheticMessage('bot-a', run, `trace-${++delivery}`)
      await d.onCronFire('bot-a', msg, run)
    },
    /** A sub-session's report round resumes the place's conversation, as the parent-report path builds it. */
    report: async (channel = 'C_ROOM') => {
      const id = `d-${++delivery}`
      const msg: NormalizedMessage = {
        msgId: `agentcall:${channel}:${id}`,
        traceId: id,
        source: 'agent',
        platform: 'slack',
        channel,
        thread: TS,
        transcriptTs: `1700000001.00000${delivery}`,
        sender: { id: 'bot-a', isBot: true },
        text: '[sub-session report] the flaky test is fixed',
        parentReport: true,
        mentionedBots: [],
        isDm: false
      }
      await d.dispatch('bot-a', msg, INT, undefined, { callFrom: 'bot-a', hopCount: 1, deliveryId: id })
    },
    /** Whether the write rule holds a post from the asker's DM into a channel for approval as shared. */
    sharedFromElsewhere: async (channel = 'C_ROOM'): Promise<boolean> =>
      await d.mcp.deps.targetExternal('bot-a', INT, channel, false),
    /** The channel and text of every post made, in order. */
    posts: () => conn.postMessage.mock.calls.map((call) => (call as unknown[]).slice(0, 2)),
    drafts: async (): Promise<AssistantDraft[]> => {
      const rows = (await d.store.assistantDrafts.db.query('SELECT id FROM assistant_draft ORDER BY createdAt', []))
        .rows as { id: string }[]
      return Promise.all(rows.map(async (row) => (await d.store.assistantDrafts.get(row.id)) as AssistantDraft))
    },
    lookups: (channel: string) => conn.getChannelInfo.mock.calls.filter(([id]) => id === channel).length,
    trust: (channel: string) => conversationTrustLevel(d.agents.get('bot-a').integrations[0], channel),
    async close() {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('a channel shared with no event since', () => {
  it('posts a scheduled run’s anchor and reply directly, drafting nothing, and reads external from then on', async () => {
    const h = await boot()
    try {
      h.slack.shared.add('C_ROOM')
      await h.fire()
      expect(h.posts()).toEqual([
        ['C_ROOM', '⏰ post the digest'],
        ['C_ROOM', REPLY]
      ])
      expect(await h.drafts()).toEqual([])
      expect(h.trust('C_ROOM')).toBe('external')
    } finally {
      await h.close()
    }
  })

  it('posts a report round directly, drafting nothing', async () => {
    const h = await boot()
    try {
      h.slack.shared.add('C_ROOM')
      await h.report()
      expect(h.conn.postMessage).toHaveBeenCalledWith('C_ROOM', REPLY, TS, expect.any(Object))
      expect(await h.drafts()).toEqual([])
      expect(h.trust('C_ROOM')).toBe('external')
    } finally {
      await h.close()
    }
  })

  it('holds a post from another conversation for approval', async () => {
    const h = await boot()
    try {
      h.slack.shared.add('C_ROOM')
      expect(await h.sharedFromElsewhere()).toBe(true)
      expect(h.conn.postMessage).not.toHaveBeenCalled()
      expect(h.trust('C_ROOM')).toBe('external')
    } finally {
      await h.close()
    }
  })
})

describe('a channel Slack confirms is not shared', () => {
  it('posts report rounds and posts from another conversation normally, from one lookup across them', async () => {
    const h = await boot()
    try {
      await h.report()
      await h.report()
      expect(await h.sharedFromElsewhere()).toBe(false)
      expect(h.conn.postMessage).toHaveBeenCalledTimes(2)
      expect(h.conn.postMessage).toHaveBeenCalledWith('C_ROOM', REPLY, TS, expect.any(Object))
      expect(await h.drafts()).toEqual([])
      expect(h.lookups('C_ROOM')).toBe(1)
    } finally {
      await h.close()
    }
  })
})

describe('a lookup that fails', () => {
  it('still holds a post from another conversation, posts the place’s own reply, and marks nothing', async () => {
    const h = await boot()
    try {
      h.slack.failing = true
      await h.report()
      expect(await h.sharedFromElsewhere()).toBe(true)
      expect(h.conn.postMessage).toHaveBeenCalledWith('C_ROOM', REPLY, TS, expect.any(Object))
      expect(await h.drafts()).toEqual([])
      expect(h.trust('C_ROOM')).toBe('internal')
    } finally {
      await h.close()
    }
  })
})

describe('an agent outside assistant mode', () => {
  it('asks Slack too and marks the place external, but posts its reply as before', async () => {
    const h = await boot(false)
    try {
      h.slack.shared.add('C_ROOM')
      await h.report()
      expect(h.conn.postMessage).toHaveBeenCalledWith('C_ROOM', REPLY, TS, expect.any(Object))
      expect(h.lookups('C_ROOM')).toBe(1)
      expect(h.trust('C_ROOM')).toBe('external')
      expect(await h.drafts()).toEqual([])
    } finally {
      await h.close()
    }
  })
})

describe('a scheduled run in a place already known external', () => {
  it('posts its anchor and reply directly, like any other post there', async () => {
    const h = await boot()
    try {
      await h.fire('C_EXT')
      expect(h.posts()).toEqual([
        ['C_EXT', '⏰ post the digest'],
        ['C_EXT', REPLY]
      ])
      expect(await h.drafts()).toEqual([])
    } finally {
      await h.close()
    }
  })
})

describe('cards no event from the place triggered', () => {
  /** The place's long session in C_ROOM, which a sub-session or a patrol item belongs to. */
  async function placeSession(h: Awaited<ReturnType<typeof boot>>) {
    const scope: string = h.d.transportScopeForIntegrationIds([INT])
    const key = sessionKey('slack', 'C_ROOM', 'append:1', 'bot-a', scope)
    await h.d.store.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C_ROOM',
      thread: 'append:1',
      transportScope: scope,
      acpSessionId: 'acp-parent',
      sessionId: 'sid-parent',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    return { scope, key }
  }

  it('sends a sub-session’s permission card to the approver instead of a channel shared with no event since', async () => {
    const h = await boot()
    try {
      const parent = await placeSession(h)
      const child = sessionKey('slack', 'C_ROOM', 'subsession:1', 'bot-a', parent.scope)
      await h.d.store.assistantSubsessions.open({
        agentId: 'bot-a',
        childSessionKey: child,
        parentSessionId: 'sid-parent',
        parentSessionKey: parent.key
      })
      const route = () =>
        h.d.subsessionApprovalRoute({
          plan: { agentId: 'bot-a', sessionKey: child },
          entry: { msg: { text: 'fix it' } }
        })
      expect((await route()).place).toMatchObject({ kind: 'chat', channel: 'C_ROOM', external: false })
      h.slack.shared.add('C_ROOM')
      h.later()
      expect((await route()).place).toMatchObject({ kind: 'chat', channel: 'C_ROOM', external: true })
    } finally {
      await h.close()
    }
  })

  it('cards a patrol’s proposal in its place only while the place is confirmed internal', async () => {
    const h = await boot()
    try {
      const { scope } = await placeSession(h)
      const propose = vi
        .spyOn(h.d.drafts, 'propose')
        .mockResolvedValue({ draft: { id: 'p-1', expiresAt: Date.now() }, approver: null } as never)
      const run = {
        agentId: 'bot-a',
        key: 'k-patrol',
        item: { id: 'item-1', version: 1, origin: { platform: 'slack', channel: 'C_ROOM', transportScope: scope } }
      }
      const input = { task: 'rerun the job', sentence: 'Rerun the nightly job?', why: 'it failed twice' }
      await h.d.proposeFromPatrol(run, input)
      h.slack.shared.add('C_ROOM')
      h.later()
      await h.d.proposeFromPatrol(run, input)
      expect(propose.mock.calls.map(([call]) => (call as { place?: { channel: string } }).place?.channel)).toEqual([
        'C_ROOM',
        undefined
      ])
    } finally {
      await h.close()
    }
  })
})
