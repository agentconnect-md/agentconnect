// Teams conversations kept across restarts (teams-integration.md §3, §4.1): a channel's endpoint and team survive without new traffic.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeMsTeamsActivity, type MsTeamsActivity } from '@agentconnect.md/message'
import type { IntegrationChannel } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { storeConversationMemory, type ConversationMemory } from '../src/platforms/conversation-memory.js'
import { msTeamsTeamChannelsUrl, msTeamsTeamUrl, msTeamsTokenEndpoint } from '../src/platforms/msteams/api.js'
import { MsTeamsConnection, msTeamsConnKey, msTeamsMemoryScope } from '../src/platforms/msteams/connection.js'
import { ObservedChannelsSync, type ObservedChannelsSyncHost } from '../src/platforms/observed-channels-sync.js'
import { LocalStore } from '../src/store/local-store.js'
import { openTestStore, tempStorePath } from './store-support.js'

const ZERO = '00000000-0000-0000-0000-000000000000'
const BOT = `28:${ZERO}`
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${ZERO}/`
const TEAM = '19:example-team@thread.tacv2'
const DESIGN = '19:example-design@thread.tacv2'
const UNSEEN = '19:example-unseen@thread.tacv2'
const PERSONAL = 'a:example-personal'
const CONFIG = { appId: ZERO, tenantId: ZERO, clientSecret: 'client-secret-example' }
const SCOPE = msTeamsMemoryScope(CONFIG)

/** A Bot Connector that names the example team, or refuses its details when `details` says so. */
function botConnector(details: () => Response = () => Response.json({ id: TEAM, name: 'Example Team' })) {
  const calls: { url: string; method: string }[] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const target = String(url)
    calls.push({ url: target, method: init?.method ?? 'GET' })
    if (target === msTeamsTokenEndpoint(ZERO)) return Response.json({ access_token: 'tok', expires_in: 3600 })
    if (target === msTeamsTeamUrl(SERVICE_URL, TEAM)) return details()
    if (target === msTeamsTeamChannelsUrl(SERVICE_URL, TEAM))
      return Response.json({ conversations: [{ id: DESIGN, name: 'Design', type: 'standard' }] })
    if (init?.method === 'POST') return Response.json({ id: 'bot-1' }, { status: 201 })
    return new Response(null, { status: 404 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function connection(memory: ConversationMemory | undefined, fetchImpl: typeof fetch): MsTeamsConnection {
  return new MsTeamsConnection({
    group: { key: msTeamsConnKey(CONFIG), agentId: 'a', integrationId: 'i', config: CONFIG, integrations: [] },
    fetchImpl,
    sendIntervalMs: 0,
    ...(memory ? { memory } : {})
  })
}

/** A channel post in `channel` of the example team, as the normalizer hands it on. */
function post(channel: string): NormalizedMessage {
  return {
    platform: 'msteams',
    channel,
    isDm: false,
    sender: { id: '29:sender', isBot: false },
    adapterExt: {
      msteams: { serviceUrl: SERVICE_URL, conversationId: `${channel};messageid=1700000000000`, teamId: TEAM }
    }
  } as unknown as NormalizedMessage
}

function personal(): NormalizedMessage {
  return {
    platform: 'msteams',
    channel: PERSONAL,
    isDm: true,
    sender: { id: '29:sender', name: 'Example Person', isBot: false },
    adapterExt: { msteams: { serviceUrl: SERVICE_URL, conversationId: PERSONAL } }
  } as unknown as NormalizedMessage
}

/** A memory that records every write, over a fixed set of remembered rows. */
function fakeMemory(rows: { id: string; facts: unknown }[] = []) {
  const saves: { id: string; facts: unknown }[] = []
  const memory: ConversationMemory = {
    load: async () => rows,
    save: async (id, facts) => {
      saves.push({ id, facts })
    }
  }
  return { memory, saves }
}

/** The observed-channels rebuild for one Teams integration whose sessions observed `observed`, spaced by `conn`. */
function refreshFor(conn: MsTeamsConnection, observed: { id: string }[]) {
  const snapshots = new Map<string, { channels: IntegrationChannel[]; authoritative: boolean }>()
  const integration = { id: 'i', platform: 'msteams' }
  const host = {
    store: () => ({
      retractedConversations: async () => new Set<string>(),
      observedChannels: async () => observed,
      getDisplayNames: async () => new Map<string, string>(),
      getChannelScopes: async () => new Map()
    }),
    agents: () => new Map([['a', { id: 'a', integrations: [integration] }]]),
    channelSnapshots: () => snapshots,
    integrationConfigById: () => integration,
    liveSpaceFor: async (_integrationId: string, channelId: string) => await conn.spaceOf(channelId),
    transportScopeForIntegration: () => '',
    cpClient: () => undefined
  } as unknown as ObservedChannelsSyncHost
  const sync = new ObservedChannelsSync(host)
  return async () => {
    await sync.refreshObservedChannels()
    return snapshots.get('i')?.channels ?? []
  }
}

describe('Teams conversations across a restart', () => {
  const stores: LocalStore[] = []
  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close().catch(() => undefined)
  })
  const open = async (path: string) => {
    const store = await openTestStore(path)
    stores.push(store)
    return store
  }

  it('answers a seen channel’s team and endpoint from the store, with no new traffic, and the refresh reports it', async () => {
    const path = tempStorePath('ac-msteams-memory-')
    const first = await open(path)
    const before = connection(storeConversationMemory(first, SCOPE, 100), botConnector().fetchImpl)
    await before.start()
    before.noteMessage(post(DESIGN))
    expect(await before.spaceOf(DESIGN)).toEqual({ id: TEAM, name: 'Example Team' })
    await before.stop()
    await first.close()

    const second = await open(path)
    const network = botConnector()
    const after = connection(storeConversationMemory(second, SCOPE, 100), network.fetchImpl)
    await after.start()
    expect(await after.spaceOf(DESIGN)).toEqual({ id: TEAM, name: 'Example Team' })
    expect(after.targetFor(DESIGN, '1700000000000')).toEqual({
      serviceUrl: SERVICE_URL,
      conversationId: `${DESIGN};messageid=1700000000000`
    })
    const refresh = refreshFor(after, [{ id: DESIGN }, { id: UNSEEN }])
    expect(await refresh()).toEqual([{ id: DESIGN, spaceId: TEAM, space: 'Example Team' }, { id: UNSEEN }])
    // A post into the remembered channel goes to the endpoint its traffic carried before the restart.
    await after.postMessage(DESIGN, 'hello')
    expect(network.calls.filter((c) => c.method === 'POST' && c.url.startsWith(SERVICE_URL)).map((c) => c.url)).toEqual(
      [`${SERVICE_URL}v3/conversations/${encodeURIComponent(DESIGN)}/activities`]
    )
  })

  it('keeps a 1:1 chat’s endpoint, and names the team from memory while its details cannot be read', async () => {
    const path = tempStorePath('ac-msteams-memory-')
    const first = await open(path)
    const before = connection(storeConversationMemory(first, SCOPE, 100), botConnector().fetchImpl)
    before.noteMessage(post(DESIGN))
    before.noteMessage(personal())
    await before.spaceOf(DESIGN)
    await before.stop()
    await first.close()

    const second = await open(path)
    const refused = botConnector(() => new Response(null, { status: 403 }))
    const after = connection(storeConversationMemory(second, SCOPE, 100), refused.fetchImpl)
    await after.start()
    expect(await after.spaceOf(DESIGN)).toEqual({ id: TEAM, name: 'Example Team' })
    expect(after.targetFor(PERSONAL)).toEqual({ serviceUrl: SERVICE_URL, conversationId: PERSONAL })
    expect(await after.spaceOf(PERSONAL)).toBeUndefined()
    expect(await after.spaceOf(UNSEEN)).toBeUndefined()
  })

  it('keeps another bot’s conversations apart', async () => {
    const path = tempStorePath('ac-msteams-memory-')
    const store = await open(path)
    const before = connection(storeConversationMemory(store, SCOPE, 100), botConnector().fetchImpl)
    before.noteMessage(post(DESIGN))
    await before.stop()
    const other = msTeamsMemoryScope({ appId: '11111111-1111-1111-1111-111111111111', tenantId: ZERO })
    const after = connection(storeConversationMemory(store, other, 100), botConnector().fetchImpl)
    await after.start()
    expect(after.targetFor(DESIGN)).toBeUndefined()
  })
})

describe('what a Teams connection remembers', () => {
  it('writes a conversation once while nothing about it changes, and again when its team is named', async () => {
    const { memory, saves } = fakeMemory()
    const conn = connection(memory, botConnector().fetchImpl)
    conn.noteMessage(post(DESIGN))
    conn.noteMessage(post(DESIGN))
    await conn.flush()
    expect(saves).toEqual([{ id: DESIGN, facts: { serviceUrl: SERVICE_URL, kind: 'channel', teamId: TEAM } }])
    await conn.spaceOf(DESIGN)
    await conn.getChannelInfo(DESIGN)
    await conn.flush()
    expect(saves.at(-1)).toEqual({
      id: DESIGN,
      facts: { serviceUrl: SERVICE_URL, kind: 'channel', teamId: TEAM, team: 'Example Team', name: 'Design' }
    })
    expect(JSON.stringify(saves)).not.toContain('29:sender')
  })

  it('lets traffic noted while it reloads win over what it remembered, and skips a malformed row', async () => {
    const stale = 'https://smba.trafficmanager.net/emea/stale/'
    const { memory } = fakeMemory([
      { id: DESIGN, facts: { serviceUrl: stale, kind: 'channel', teamId: TEAM } },
      { id: PERSONAL, facts: { serviceUrl: SERVICE_URL, kind: 'personal', name: 'Example Person' } },
      { id: UNSEEN, facts: { serviceUrl: 'http://example.test/', kind: 'channel', teamId: TEAM } },
      { id: 'a:example-malformed', facts: 'not an object' }
    ])
    const conn = connection(memory, botConnector().fetchImpl)
    conn.noteMessage(post(DESIGN))
    await conn.start()
    expect(conn.targetFor(DESIGN)?.serviceUrl).toBe(SERVICE_URL)
    expect(conn.targetFor(PERSONAL)).toEqual({ serviceUrl: SERVICE_URL, conversationId: PERSONAL })
    expect((await conn.getChannelInfo(PERSONAL)).name).toBe('Example Person')
    expect(conn.targetFor(UNSEEN)).toBeUndefined()
    expect(conn.targetFor('a:example-malformed')).toBeUndefined()
  })

  it('starts empty when its memory cannot be read', async () => {
    const memory: ConversationMemory = {
      load: async () => {
        throw new Error('store unavailable')
      },
      save: async () => {}
    }
    const conn = connection(memory, botConnector().fetchImpl)
    await conn.start()
    expect(await conn.spaceOf(DESIGN)).toBeUndefined()
  })
})

// The daemon end to end: a channel's team comes back on the console row after a restart, before anyone speaks there again.
describe('a restarted daemon', () => {
  let root: string | undefined
  let daemon: Daemon | undefined
  afterEach(async () => {
    await daemon?.stop()
    daemon = undefined
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  const AGENT = 'teams-agent'
  const INTEGRATION = 'teams-install'

  function boot(): Daemon {
    return new Daemon({
      root: root!,
      hostFactory: (_agent, update) =>
        ({
          start: async () => {},
          stop: async () => {},
          cancel: async () => {},
          newSession: async () => 'session-1',
          prompt: async (session: string) => {
            update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } })
            return 'end_turn'
          }
        }) as any
    })
  }

  it('reports a seen channel’s team on its row once the connection is back', async () => {
    root = mkdtempSync(join(tmpdir(), 'ac-msteams-memory-'))
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
            core: { mode: 'direct', bindRules: [{ match: { kind: 'mention' } }] },
            config: CONFIG
          }
        ],
        output: { mode: 'low' }
      })
    )
    const network = botConnector()
    vi.stubGlobal('fetch', network.fetchImpl)

    daemon = boot()
    await daemon.start()
    await (daemon as any).connections.reconcileMsTeamsConnections()
    const conn = (daemon as any).msTeamsConnByIntegration.get(INTEGRATION) as MsTeamsConnection
    ;(conn as any).sendIntervalMs = 0
    const activity: MsTeamsActivity = {
      type: 'message',
      id: '1700000000001',
      timestamp: '2026-01-01T00:00:10.000Z',
      serviceUrl: SERVICE_URL,
      channelId: 'msteams',
      from: { id: '29:example-user', name: 'Example Person', aadObjectId: ZERO },
      recipient: { id: BOT, name: 'Example Bot' },
      conversation: { id: `${DESIGN};messageid=1700000000001`, conversationType: 'channel', tenantId: ZERO },
      text: '<at>Example Bot</at> hello',
      entities: [{ type: 'mention', mentioned: { id: BOT, name: 'Example Bot' }, text: '<at>Example Bot</at>' }],
      channelData: { tenant: { id: ZERO }, team: { id: TEAM }, channel: { id: DESIGN } }
    }
    const result = normalizeMsTeamsActivity(activity, { appId: ZERO, tenantId: ZERO, traceId: 'trace-1' })
    if (result.kind !== 'message') throw new Error(`fixture did not normalize: ${result.kind}`)
    const payload = result.message as NormalizedMessage
    const ack = await (daemon as any).handleRelayIm({
      source: 'im',
      agentId: AGENT,
      botId: BOT,
      integrationId: INTEGRATION,
      sessionKey: payload.channel,
      msgId: payload.msgId,
      trustedRouteVia: 'mention',
      payload
    })
    expect(ack.accepted).toBe(true)
    await vi.waitFor(async () => expect(await (daemon as any).store.listSessions()).toHaveLength(1), {
      timeout: 5000
    })
    await conn.flush()
    await daemon.stop()

    // A slow reload lands after the start-up refreshes of other platforms, so the row's team comes from the connection's own.
    const load = LocalStore.prototype.connectionConversations
    vi.spyOn(LocalStore.prototype, 'connectionConversations').mockImplementation(async function (
      this: LocalStore,
      ...args
    ) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return await load.apply(this, args)
    })
    daemon = boot()
    await daemon.start()
    await vi.waitFor(
      () =>
        expect((daemon as any).channelSnapshots.get(INTEGRATION)?.channels).toEqual([
          expect.objectContaining({ id: DESIGN, spaceId: TEAM, space: 'Example Team' })
        ]),
      { timeout: 5000 }
    )
  })
})
