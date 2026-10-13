// Every agent detects outsiders in a conversation (assistant-mode.md §5.3); only assistant mode drafts its replies there.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { CLOSED_LOOKUPS, type TurnAskers } from '../src/assistant/place-access.js'
import { PLACE_SHARE_TTL_MS } from '../src/assistant/place-trust.js'
import type { CronDef } from '../src/agents/agent-schema.js'
import { Daemon } from '../src/daemon.js'
import { judgePlaceWrite } from '../src/mcp/ops/place-gate.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { conversationTrustLevel } from '../src/router/routing-rule.js'
import { buildSyntheticMessage } from '../src/scheduler/scheduler.js'
import type { SlackAppFactory } from '../src/slack/connection.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const INT = 'int-bot-a'
const TS = '1700000000.000100'
const REPLY = 'The answer is 42.'

/** Who joins, as Slack's `users.info` describes them to a bot of workspace THOME in organization EHOME. */
const USERS: Record<string, object> = {
  UFULL: { id: 'UFULL', team_id: 'THOME', enterprise_user: { enterprise_id: 'EHOME' } },
  USIBLING: { id: 'USIBLING', team_id: 'TSIBLING', enterprise_user: { enterprise_id: 'EHOME' } },
  UGUEST: { id: 'UGUEST', team_id: 'THOME', is_restricted: true }
}

function scaffold(assistant: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-outsiders-'))
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
            bindRules: ['C_PUB', 'C_OTHER'].map((channel) => ({ match: { kind: 'auto' }, channel }))
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'medium' },
      ...(assistant ? { assistantMode: { enabled: true } } : {})
    })
  )
  return root
}

/** A Slack app whose events the test fires and whose answers it controls: who people are and which channels are shared. */
function slackApp(state: { shared: Set<string>; handlers: Map<string, (a: unknown) => Promise<unknown>> }) {
  const base = fakeSlackAppFactory({ userId: 'U_BOT', teamId: 'THOME' })
  const usersInfo = vi.fn(async ({ user }: { user: string }) => ({ user: USERS[user] ?? {} }))
  const channelInfo = vi.fn(async ({ channel }: { channel: string }) => ({
    channel: {
      id: channel,
      name: channel.toLowerCase(),
      is_im: channel.startsWith('D'),
      is_private: false,
      ...(state.shared.has(channel) ? { is_ext_shared: true } : {})
    }
  }))
  const factory: SlackAppFactory = (...args: Parameters<SlackAppFactory>) => {
    const app = base(...args) as any
    app.event = (type: string, handler: (a: unknown) => Promise<unknown>) => void state.handlers.set(type, handler)
    app.client.auth.test = async () => ({
      user_id: 'U_BOT',
      bot_id: 'B_BOT',
      team_id: 'THOME',
      enterprise_id: 'EHOME',
      url: 'https://example.slack.test/'
    })
    app.client.users.info = usersInfo
    app.client.conversations.info = channelInfo
    app.client.users.conversations = async () => ({
      channels: [
        { id: 'C_PUB', name: 'pub', is_private: false },
        { id: 'C_OTHER', name: 'other', is_private: false }
      ]
    })
    return app
  }
  return { factory, usersInfo, channelInfo }
}

async function boot(assistant: boolean) {
  const root = scaffold(assistant)
  const clock = new FakeClock(Date.now())
  const state = { shared: new Set<string>(), handlers: new Map<string, (a: unknown) => Promise<unknown>>() }
  const slack = slackApp(state)
  const daemon = new Daemon({
    root,
    clock,
    slackAppFactory: slack.factory,
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
  const d = daemon as any
  // The Socket Mode connection the daemon opened: its member-join lookup is real, its posts are recorded.
  const conn = d.connByIntegration.get(INT)
  Object.assign(conn, {
    setStatus: vi.fn(async () => true),
    setTitle: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    postMessage: vi.fn(async () => '1700000000.000900'),
    postContext: vi.fn(async () => {}),
    postBlocks: vi.fn(async () => 'card-1'),
    updateBlocks: vi.fn(async () => true),
    updateMessage: vi.fn(async () => true),
    openDirectMessage: vi.fn(async (user: string) => `D_${user}`)
  })
  await d.connections.refreshChannels(conn)
  const report = vi.spyOn(d.placeTrust.deps, 'report')
  let n = 0
  return {
    d,
    conn,
    slack,
    state,
    report,
    later: () => clock.advance(PLACE_SHARE_TTL_MS),
    /** Someone joins a channel the bot is in, over the socket. */
    join: async (user: string, channel = 'C_PUB') =>
      await state.handlers.get('member_joined_channel')!({ event: { user, channel }, body: {} }),
    /** A full member of the workspace says something in a channel. */
    ask: async (channel = 'C_PUB') => {
      const msg: NormalizedMessage = {
        msgId: `slack:${channel}:${TS}:${++n}`,
        traceId: `ask-${n}`,
        source: 'user',
        platform: 'slack',
        channel,
        thread: TS,
        sender: { id: 'UFULL', isBot: false },
        text: 'what is the answer?',
        mentionedBots: [],
        isDm: false
      }
      await d.dispatch('bot-a', msg, INT)
    },
    /** A scheduled run fires into a channel. */
    fire: async (channel = 'C_PUB') => {
      const run: CronDef = {
        id: 'cron-digest',
        schedule: '0 9 * * *',
        trigger: 'post the digest',
        enabled: true,
        target: { platform: 'slack', channel, integrationId: INT }
      }
      const { msg } = buildSyntheticMessage('bot-a', run, `trace-${++n}`)
      await d.onCronFire('bot-a', msg, run)
    },
    trust: (channel = 'C_PUB') => conversationTrustLevel(d.agents.get('bot-a').integrations[0], channel),
    approvals: (channel = 'C_PUB') => d.chatSurface('bot-a', INT, channel),
    memoryLayer: async (channel = 'C_PUB') =>
      await d.memoryLayers.layerOf({
        agentId: 'bot-a',
        platform: 'slack',
        channel,
        transportScope: d.transportScopeForIntegrationIds([INT]),
        kinds: ['channel']
      }),
    /** The write rule on a post from C_OTHER into a channel, asked by a full member who may post there. */
    postFromElsewhere: async (channel = 'C_PUB') => {
      const asker: TurnAskers = {
        people: [{ kind: 'member', platform: 'slack', integrationId: INT, userId: 'UFULL' }],
        nobody: false
      }
      const deps = {
        ...d.mcp.deps,
        readAskers: async () => asker,
        readLookups: () => ({ ...CLOSED_LOOKUPS, fullMember: async () => true, member: async () => true })
      }
      const ctx = { agentId: 'bot-a', platform: 'slack', channel: 'C_OTHER', thread: TS, integrationId: INT }
      return await judgePlaceWrite(
        ctx as never,
        'sendMessage',
        { kind: 'conversation', platform: 'slack', integrationId: INT, channel },
        deps,
        true
      )
    },
    drafts: async (): Promise<unknown[]> =>
      (await d.store.assistantDrafts.db.query('SELECT id FROM assistant_draft', [])).rows as unknown[],
    async close() {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('an agent outside assistant mode, when a guest joins a public channel', () => {
  it('marks the channel external, reports it, and treats it as external everywhere but its own reply', async () => {
    const h = await boot(false)
    try {
      expect(h.trust()).toBe('internal')
      expect(await h.memoryLayer()).toBe('shared')
      expect(await h.postFromElsewhere()).toBe('post')

      await h.join('UGUEST')
      expect(h.slack.usersInfo).toHaveBeenCalledWith({ user: 'UGUEST' })
      expect(h.trust()).toBe('external')
      expect(h.report).toHaveBeenCalledWith(INT, { id: 'C_PUB', externalReason: 'guestMember' })
      // Approvals there go to an internal member, its memory is the place's own, and a post from elsewhere is drafted.
      expect(h.approvals()).toBe('external')
      expect(await h.memoryLayer()).toBe('place')
      expect(await h.postFromElsewhere()).toBe('draft')

      // Its own reply there is not drafted: drafting replies stays with assistant mode.
      await h.ask()
      expect(h.conn.postMessage).toHaveBeenCalledWith('C_PUB', REPLY, TS, expect.any(Object))
      expect(await h.drafts()).toEqual([])
    } finally {
      await h.close()
    }
  })

  it.each([
    ['a full member of the workspace', 'UFULL'],
    ['a member of a sibling workspace of the same Enterprise Grid organization', 'USIBLING']
  ])('changes nothing when %s joins', async (_who, user) => {
    const h = await boot(false)
    try {
      await h.join(user)
      expect(h.slack.usersInfo).toHaveBeenCalledWith({ user })
      expect(h.trust()).toBe('internal')
      expect(h.report).not.toHaveBeenCalled()
      expect(h.approvals()).toBe('open')
      expect(await h.memoryLayer()).toBe('shared')
    } finally {
      await h.close()
    }
  })
})

describe('an agent outside assistant mode posting with no event from the place', () => {
  it('finds a channel shared since its last event before a scheduled run posts, and still posts there', async () => {
    const h = await boot(false)
    try {
      h.state.shared.add('C_PUB')
      await h.fire()
      expect(h.slack.channelInfo).toHaveBeenCalledWith({ channel: 'C_PUB' })
      expect(h.trust()).toBe('external')
      expect(h.report).toHaveBeenCalledWith(INT, { id: 'C_PUB', externalReason: 'externallyShared' })
      expect(h.conn.postMessage).toHaveBeenCalledWith('C_PUB', REPLY, expect.anything(), expect.any(Object))
      expect(await h.drafts()).toEqual([])
      expect(h.approvals()).toBe('external')
      expect(await h.postFromElsewhere()).toBe('draft')
    } finally {
      await h.close()
    }
  })

  it('holds a post from elsewhere for approval once Slack says the target is shared, asking once a minute', async () => {
    const h = await boot(false)
    try {
      expect(await h.postFromElsewhere()).toBe('post')
      h.state.shared.add('C_PUB')
      expect(await h.postFromElsewhere()).toBe('post')
      h.later()
      expect(await h.postFromElsewhere()).toBe('draft')
      expect(h.trust()).toBe('external')
    } finally {
      await h.close()
    }
  })
})

describe('an agent in assistant mode, unchanged', () => {
  it('drafts its reply in a channel a guest joined', async () => {
    const h = await boot(true)
    try {
      await h.join('UGUEST')
      expect(h.trust()).toBe('external')
      expect(h.report).toHaveBeenCalledWith(INT, { id: 'C_PUB', externalReason: 'guestMember' })
      await h.ask()
      expect(h.conn.postMessage).not.toHaveBeenCalled()
      expect(await h.drafts()).toHaveLength(1)
    } finally {
      await h.close()
    }
  })
})
