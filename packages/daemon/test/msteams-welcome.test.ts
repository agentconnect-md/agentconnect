// Teams' first run (teams-integration.md §4.7): a relayed install is welcomed once with a card, and `help` is answered without a turn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeMsTeamsActivity, type MsTeamsActivity } from '@agentconnect.md/message'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { IntegrationChannel } from '@agentconnect.md/protocol'
import { msTeamsTeamChannelsUrl, msTeamsTeamUrl, msTeamsTokenEndpoint } from '../src/platforms/msteams/api.js'
import { isMsTeamsHelp, msTeamsHelpText } from '../src/platforms/msteams/relay-ingress.js'
import { buildWelcome } from '../src/platforms/welcome.js'
import { sessionKey, transcriptChannelKey } from '../src/store/local-store.js'

const ZERO = '00000000-0000-0000-0000-000000000000'
const BOT = `28:${ZERO}`
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${ZERO}/`
const PERSONAL = 'a:example-personal'
const OFF = '19:example-off@thread.tacv2'
const ON = '19:example-on@thread.tacv2'
const TEAM = '19:example-team@thread.tacv2'
const DESIGN = '19:example-design@thread.tacv2'
const PRIVATE = '19:example-private@thread.tacv2'
const AGENT = 'teams-agent'
const INTEGRATION = 'teams-install'

interface Post {
  conversation: string
  text?: string
  card?: { body: { text?: string; inlines?: { text: string }[] }[]; msteams?: { entities?: unknown[] } }
}

let root: string | undefined
let daemon: Daemon | undefined
let realFetch: typeof fetch
let posts: Post[] = []
let host: { newSession: ReturnType<typeof vi.fn>; prompt: ReturnType<typeof vi.fn> } & Record<string, unknown>
let reported: { integrationId: string; channels: IntegrationChannel[] }[] = []

beforeEach(() => {
  posts = []
  reported = []
  host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    prompt: vi.fn(async () => 'end_turn'),
    cancel: vi.fn(),
    stop: vi.fn()
  }
  realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit | undefined) => {
    const target = String(url)
    const json = (status: number, body: unknown) =>
      ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body }) as unknown as Response
    if (target === msTeamsTokenEndpoint(ZERO)) return json(200, { access_token: 'tok', expires_in: 3600 })
    if (!target.startsWith(SERVICE_URL)) return await realFetch(url as string, init)
    const m = /\/v3\/conversations\/([^/]+)\/activities$/.exec(new URL(target).pathname)
    if (init?.method === 'POST' && m) {
      const body = JSON.parse(String(init.body)) as { text?: string; attachments?: { content: Post['card'] }[] }
      posts.push({
        conversation: decodeURIComponent(m[1]!),
        ...(body.text ? { text: body.text } : {}),
        ...(body.attachments ? { card: body.attachments[0]!.content } : {})
      })
      return json(201, { id: `bot-${posts.length}` })
    }
    if (target === msTeamsTeamUrl(SERVICE_URL, TEAM)) return json(200, { id: TEAM, name: 'Example Team' })
    if (target === msTeamsTeamChannelsUrl(SERVICE_URL, TEAM))
      return json(200, {
        conversations: [
          { id: TEAM, name: null, type: 'standard' },
          { id: DESIGN, name: 'Design', type: 'standard' },
          { id: PRIVATE, name: 'Private', type: 'private' }
        ]
      })
    // The roster names a member a team install left nameless.
    if (/\/v3\/conversations\/[^/]+\/members\/[^/]+$/.test(new URL(target).pathname))
      return json(200, { id: '29:example-user', name: 'Looked-up Person' })
    return json(200, {})
  })
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  vi.unstubAllGlobals()
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Daemon> {
  root = mkdtempSync(join(tmpdir(), 'ac-msteams-welcome-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const dir = join(root, 'agents', AGENT)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      runtime: 'claude',
      status: 'active',
      workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
      integrations: [
        {
          id: INTEGRATION,
          platform: 'msteams',
          core: { mode: 'shared', bindRules: [], mutedChannels: [OFF] },
          config: { appId: ZERO, tenantId: ZERO, clientSecret: 'client-secret-example' }
        }
      ],
      output: { mode: 'low' }
    })
  )
  const d = new Daemon({ root, hostFactory: () => host as any })
  await d.start()
  await (d as any).connections.reconcileMsTeamsConnections()
  ;((d as any).msTeamsConnByIntegration.get(INTEGRATION) as { sendIntervalMs: number }).sendIntervalMs = 0
  ;(d as any).cpClient = new Proxy({} as Record<string, unknown>, {
    get: (_target, key) =>
      key === 'emitIntegrationChannels'
        ? (s: { integrationId: string; channels: IntegrationChannel[] }) => reported.push(s)
        : () => undefined
  })
  return d
}

const install = (
  d: Daemon,
  conversationId: string,
  scope: 'personal' | 'groupChat' | 'channel',
  id: string,
  addedBy: { id: string; name?: string } = { id: '29:example-user', name: 'Example Person' },
  team?: { teamId: string; teamWide: boolean }
) =>
  (d as any).handleRelayPlatformAction({
    source: 'platform_action',
    platformId: 'msteams',
    agentId: AGENT,
    integrationId: INTEGRATION,
    botId: BOT,
    sessionKey: `msteams-bot-added:${conversationId}`,
    msgId: id,
    payload: {
      kind: 'bot-added',
      conversationId,
      serviceUrl: SERVICE_URL,
      scope,
      ...team,
      addedBy
    }
  })

function personalText(text: string, id: string): NormalizedMessage {
  const activity: MsTeamsActivity = {
    type: 'message',
    id,
    timestamp: '2026-01-01T00:00:10.000Z',
    serviceUrl: SERVICE_URL,
    channelId: 'msteams',
    from: { id: '29:example-user', name: 'Example Person', aadObjectId: ZERO },
    recipient: { id: BOT, name: 'Example Bot' },
    conversation: { id: PERSONAL, conversationType: 'personal', tenantId: ZERO },
    text,
    channelData: { tenant: { id: ZERO } }
  }
  const result = normalizeMsTeamsActivity(activity, { appId: ZERO, tenantId: ZERO, traceId: `trace-${id}` })
  if (result.kind !== 'message') throw new Error(`fixture did not normalize: ${result.kind}`)
  return { ...result.message, trigger: 'dm' } as NormalizedMessage
}

function channelReply(text: string, id: string, rootId: string): NormalizedMessage {
  const activity: MsTeamsActivity = {
    type: 'message',
    id,
    timestamp: '2026-01-01T00:00:20.000Z',
    serviceUrl: SERVICE_URL,
    channelId: 'msteams',
    from: { id: '29:example-user', name: 'Example Person', aadObjectId: ZERO },
    recipient: { id: BOT, name: 'Example Bot' },
    conversation: { id: `${ON};messageid=${rootId}`, conversationType: 'channel', tenantId: ZERO },
    text,
    channelData: { tenant: { id: ZERO }, team: { id: ON }, channel: { id: ON } }
  }
  const result = normalizeMsTeamsActivity(activity, { appId: ZERO, tenantId: ZERO, traceId: `trace-${id}` })
  if (result.kind !== 'message') throw new Error(`fixture did not normalize: ${result.kind}`)
  return result.message as NormalizedMessage
}

const scopeOf = (d: Daemon): string | undefined => (d as any).transportScopeForIntegrationIds([INTEGRATION])

const cardText = (post: Post) =>
  (post.card?.body ?? []).map((b) => b.text ?? (b.inlines ?? []).map((i) => i.text).join('')).join('\n')

describe('the Teams welcome', () => {
  it('welcomes a 1:1 install with how to use it, naming no app and mentioning no one', async () => {
    daemon = await boot()
    expect(await install(daemon, PERSONAL, 'personal', 'install-1')).toMatchObject({ accepted: true })
    expect(posts).toHaveLength(1)
    const text = cardText(posts[0]!)
    expect(posts[0]!.conversation).toBe(PERSONAL)
    expect(text).toContain('Hi! I’m an AI agent powered by AgentConnect')
    expect(text).toContain('Send me a task here')
    expect(text).toContain('Send help')
    expect(text).not.toContain('not enabled')
    expect(posts[0]!.card?.msteams?.entities).toBeUndefined()
  })

  it('mentions who added it in a channel, and says it is not enabled there yet', async () => {
    daemon = await boot()
    await install(daemon, OFF, 'channel', 'install-2')
    expect(posts).toHaveLength(1)
    const text = cardText(posts[0]!)
    expect(text).toContain('Thanks for adding me, <at>Example Person</at>.')
    expect(text).toContain('I’m not enabled in this conversation yet')
    expect(posts[0]!.card?.msteams?.entities).toEqual([
      { type: 'mention', text: '<at>Example Person</at>', mentioned: { id: '29:example-user', name: 'Example Person' } }
    ])
  })
})

describe('the Teams welcome root', () => {
  it('seeds an idle session at the card in an enabled channel, recording the welcome and running no turn', async () => {
    daemon = await boot()
    expect(await install(daemon, ON, 'channel', 'install-on')).toMatchObject({ accepted: true })
    expect(posts.map((p) => p.conversation)).toEqual([ON])
    const scope = scopeOf(daemon)
    const key = sessionKey('msteams', ON, 'bot-1', AGENT, scope)
    await vi.waitFor(
      async () =>
        expect(await (daemon as any).store.getSession(key)).toMatchObject({ state: 'idle', lastDeliveredTs: null }),
      { timeout: 5000 }
    )
    expect(host.prompt).not.toHaveBeenCalled()
    const rows = await (daemon as any).store.threadTranscript(transcriptChannelKey(ON, scope), 'bot-1')
    expect(JSON.stringify(rows)).toContain('Hi! I’m an AI agent powered by AgentConnect')
    expect(await (daemon as any).sessions.threadOwner(ON, 'bot-1', scope)).toBe(AGENT)
  })

  it('continues the seeded session with an unmentioned reply under the card', async () => {
    daemon = await boot()
    await install(daemon, ON, 'channel', 'install-on')
    const key = sessionKey('msteams', ON, 'bot-1', AGENT, scopeOf(daemon))
    await vi.waitFor(async () => expect(await (daemon as any).store.getSession(key)).toBeTruthy(), { timeout: 5000 })
    const seeded = (await (daemon as any).store.getSession(key)).sessionId
    const reply = channelReply('cool', '1767225640000', 'bot-1')
    expect(reply.thread).toBe('bot-1')
    expect(reply.mentionedBots).toEqual([])
    const ack = await (daemon as any).handleRelayIm({
      source: 'im',
      agentId: AGENT,
      botId: BOT,
      integrationId: INTEGRATION,
      sessionKey: `${ON}/bot-1`,
      msgId: 'reply-1',
      trustedRouteVia: 'implicit',
      payload: reply
    })
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledOnce(), { timeout: 5000 })
    expect(host.newSession).toHaveBeenCalledOnce()
    expect((await (daemon as any).store.getSession(key)).sessionId).toBe(seeded)
    // The first real reply replays the welcome root as context, as after an agent's own root post.
    expect(JSON.stringify(host.prompt.mock.calls[0])).toContain('Hi! I’m an AI agent powered by AgentConnect')
  })

  it('seeds nothing in a channel the agent is not enabled in', async () => {
    daemon = await boot()
    await install(daemon, OFF, 'channel', 'install-off')
    expect(posts).toHaveLength(1)
    expect(await (daemon as any).sessions.threadOwner(OFF, 'bot-1', scopeOf(daemon))).toBeNull()
    expect(host.newSession).not.toHaveBeenCalled()
  })

  it('seeds nothing in a 1:1 chat or a group chat, which root no thread', async () => {
    daemon = await boot()
    await install(daemon, PERSONAL, 'personal', 'install-dm')
    await install(daemon, '19:example-group@thread.v2', 'groupChat', 'install-group')
    expect(posts).toHaveLength(2)
    expect(host.newSession).not.toHaveBeenCalled()
  })

  it('keeps the welcome acknowledged when seeding fails', async () => {
    daemon = await boot()
    ;(daemon as any).collab.spawnChannelRootSession = vi.fn(async () => {
      throw new Error('seed failed')
    })
    expect(await install(daemon, ON, 'channel', 'install-on')).toMatchObject({ accepted: true })
    expect(posts).toHaveLength(1)
  })
})

describe('a Teams team install', () => {
  it('lists the team’s standard channels in the console at once, the team as their space', async () => {
    daemon = await boot()
    expect(
      await install(daemon, TEAM, 'channel', 'install-4', undefined, { teamId: TEAM, teamWide: true })
    ).toMatchObject({ accepted: true })
    expect(reported.at(-1)).toEqual({
      integrationId: INTEGRATION,
      channels: [
        { id: TEAM, name: 'General', spaceId: TEAM, space: 'Example Team', kind: 'channel' },
        { id: DESIGN, name: 'Design', spaceId: TEAM, space: 'Example Team', kind: 'channel' }
      ],
      authoritative: false
    })
    expect(posts).toHaveLength(1)
  })

  it('lists nothing for an install into one channel, a chat or a 1:1 chat', async () => {
    daemon = await boot()
    await install(daemon, PRIVATE, 'channel', 'install-5', undefined, { teamId: TEAM, teamWide: false })
    await install(daemon, PERSONAL, 'personal', 'install-6')
    expect(reported).toEqual([])
    expect(posts).toHaveLength(2)
  })

  it('names a seen channel’s team for its row', async () => {
    daemon = await boot()
    const conn = (daemon as any).msTeamsConnByIntegration.get(INTEGRATION)
    conn.noteMessage({
      platform: 'msteams',
      channel: DESIGN,
      isDm: false,
      sender: { id: '29:example-user', isBot: false },
      adapterExt: { msteams: { serviceUrl: SERVICE_URL, conversationId: `${DESIGN};messageid=1`, teamId: TEAM } }
    })
    expect(await (daemon as any).observedChannelsSync.spaceFor('msteams', DESIGN, INTEGRATION)).toEqual({
      id: TEAM,
      name: 'Example Team'
    })
    expect(await (daemon as any).observedChannelsSync.spaceFor('msteams', PERSONAL, INTEGRATION)).toBeUndefined()
  })
})

describe('the Teams welcome of a nameless installer', () => {
  it('looks the installer up in the roster to mention them', async () => {
    daemon = await boot()
    await install(daemon, OFF, 'channel', 'install-3', { id: '29:example-user' })
    expect(cardText(posts[0]!)).toContain('Thanks for adding me, <at>Looked-up Person</at>.')
    expect(posts[0]!.card?.msteams?.entities).toEqual([
      {
        type: 'mention',
        text: '<at>Looked-up Person</at>',
        mentioned: { id: '29:example-user', name: 'Looked-up Person' }
      }
    ])
  })
})

describe('Teams help', () => {
  it('answers a bare help with every command and no turn', async () => {
    daemon = await boot()
    const ack = await (daemon as any).handleRelayIm({
      source: 'im',
      agentId: AGENT,
      botId: BOT,
      integrationId: INTEGRATION,
      sessionKey: PERSONAL,
      msgId: 'help-1',
      payload: personalText('help', '1700000000001')
    })
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(posts).toEqual([{ conversation: PERSONAL, text: msTeamsHelpText() }]), {
      timeout: 5000
    })
  })

  it('recognizes only the bare word, in any case', () => {
    expect(isMsTeamsHelp(' Help ')).toBe(true)
    expect(isMsTeamsHelp('help me write a test')).toBe(false)
  })

  it('lists the shared commands and where to go next', () => {
    const text = msTeamsHelpText()
    expect(text).toContain('!status')
    expect(text).toContain('help — show this help')
    expect(text).toContain('contact@agentconnect.md')
  })
})

describe('the shared welcome', () => {
  it('calls out an admin only where the agent is not enabled', () => {
    const base = { isDm: false, consoleUrl: 'https://console.example.test' }
    expect(buildWelcome({ ...base, enabled: true }).lines.join(' ')).not.toContain('admin')
    expect(buildWelcome({ ...base, enabled: false }).lines.join(' ')).toContain('An admin')
    expect(buildWelcome({ ...base, enabled: true }).links.map((l) => l.title)).toEqual([
      'Open AgentConnect',
      'Guide',
      'Contact us'
    ])
  })
})
