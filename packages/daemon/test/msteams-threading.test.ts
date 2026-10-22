// Teams' daemon-side ingress (teams-integration.md §4.1, §4.2), with a stubbed `fetch` as the only network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeMsTeamsActivity, type MsTeamsActivity } from '@agentconnect.md/message'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { msTeamsTokenEndpoint } from '../src/platforms/msteams/api.js'
import type { MsTeamsConnection } from '../src/platforms/msteams/connection.js'
import { msTeamsChatMemberKey } from '../src/platforms/msteams/module.js'
import { msTeamsDeliveryReceiptId } from '../src/platforms/msteams/relay-ingress.js'
import { canonicalizeMsTeamsThread } from '../src/platforms/msteams/threading.js'

const ZERO = '00000000-0000-0000-0000-000000000000'
const BOT = `28:${ZERO}`
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${ZERO}/`
const PERSONAL = 'a:example-personal'
const GROUP_CHAT = '19:example-group@thread.v2'
const OTHER_GROUP = '19:example-other-group@thread.v2'
const CHANNEL = '19:example-channel@thread.tacv2'
const AGENT = 'teams-agent'
const INTEGRATION = 'teams-install'

function activity(
  id: string,
  conversation: { id: string; conversationType: string },
  opts: { text?: string; quote?: string } = {}
): MsTeamsActivity {
  const text = opts.text ?? `request ${id}`
  return {
    type: 'message',
    id,
    timestamp: '2026-01-01T00:00:10.000Z',
    serviceUrl: SERVICE_URL,
    channelId: 'msteams',
    from: { id: '29:example-user', name: 'Example Person', aadObjectId: ZERO },
    recipient: { id: BOT, name: 'Example Bot' },
    conversation: { ...conversation, tenantId: ZERO },
    text: opts.quote ? `<quoted messageId="${opts.quote}"/>\n${text}` : text,
    entities: opts.quote
      ? [
          {
            type: 'quotedReply',
            quotedReply: { messageId: opts.quote, senderId: BOT, preview: 'earlier', validatedMessageReference: true }
          }
        ]
      : [],
    channelData: { tenant: { id: ZERO } }
  }
}

function normalized(a: MsTeamsActivity): NormalizedMessage {
  const result = normalizeMsTeamsActivity(a, { appId: ZERO, tenantId: ZERO, traceId: `trace-${a.id}` })
  if (result.kind !== 'message') throw new Error(`fixture did not normalize: ${result.kind}`)
  return result.message as NormalizedMessage
}

const group = { id: GROUP_CHAT, conversationType: 'groupChat' }
const personal = { id: PERSONAL, conversationType: 'personal' }

describe('canonicalizeMsTeamsThread', () => {
  const host = (threads: Record<string, string>) => ({
    threadForMessage: vi.fn(async (_channel: string, id: string) => threads[id])
  })

  it('keys a 1:1 chat as one session, a new group message as a session rooted at itself, and leaves a channel thread as it came', async () => {
    const dm = normalized(activity('1700000000001', personal))
    await canonicalizeMsTeamsThread(host({}), dm, 'transcript')
    expect(dm.thread).toBe('dm')
    const fresh = normalized(activity('1700000000002', group))
    await canonicalizeMsTeamsThread(host({}), fresh, 'transcript')
    expect(fresh.thread).toBe('msteams:1700000000002')
    const channel = normalized(
      activity('1700000000004', { id: `${CHANNEL};messageid=1700000000003`, conversationType: 'channel' })
    )
    const lookup = host({})
    await canonicalizeMsTeamsThread(lookup, channel, 'transcript')
    expect(channel.thread).toBe('1700000000003')
    expect(lookup.threadForMessage).not.toHaveBeenCalled()
    const other = { ...fresh, platform: 'dingtalk', thread: undefined } as NormalizedMessage
    await canonicalizeMsTeamsThread(host({}), other, 'transcript')
    expect(other.thread).toBeUndefined()
  })

  it('follows a quote to its recorded session and starts fresh when it maps to nothing or to an append coordinate', async () => {
    const lookup = host({ 'bot-1': 'msteams:1700000000001', 'bot-append': 'append:example' })
    const mapped = normalized(activity('1700000000005', group, { quote: 'bot-1' }))
    await canonicalizeMsTeamsThread(lookup, mapped, 'transcript')
    expect(mapped.thread).toBe('msteams:1700000000001')
    expect(lookup.threadForMessage).toHaveBeenCalledWith('transcript', 'bot-1')
    const unknown = normalized(activity('1700000000006', group, { quote: 'bot-unknown' }))
    await canonicalizeMsTeamsThread(lookup, unknown, 'transcript')
    expect(unknown.thread).toBe('msteams:1700000000006')
    const append = normalized(activity('1700000000007', group, { quote: 'bot-append' }))
    await canonicalizeMsTeamsThread(lookup, append, 'transcript')
    expect(append.thread).toBe('msteams:1700000000007')
  })
})

describe('msTeamsDeliveryReceiptId', () => {
  it('differs for the same activity ID in two conversations and for two bots', () => {
    const one = { ...normalized(activity('1700000000001', group)), transportScope: 'bot-a' }
    const two = {
      ...normalized(activity('1700000000001', { id: OTHER_GROUP, conversationType: 'groupChat' })),
      transportScope: 'bot-a'
    }
    expect(msTeamsDeliveryReceiptId(one)).not.toBe(msTeamsDeliveryReceiptId(two))
    expect(msTeamsDeliveryReceiptId({ ...one, transportScope: 'bot-b' })).not.toBe(msTeamsDeliveryReceiptId(one))
    // Two threads of one channel are two conversations as well.
    const threadA = normalized(
      activity('1700000000009', { id: `${CHANNEL};messageid=1700000000001`, conversationType: 'channel' })
    )
    const threadB = normalized(
      activity('1700000000009', { id: `${CHANNEL};messageid=1700000000002`, conversationType: 'channel' })
    )
    expect(msTeamsDeliveryReceiptId(threadA)).not.toBe(msTeamsDeliveryReceiptId(threadB))
  })
})

describe('msTeamsChatMemberKey', () => {
  it('matches a clicker by their Entra object ID and refuses a bot-specific ID', () => {
    const upper = ZERO.replace(/0/g, 'A')
    expect(msTeamsChatMemberKey({ userId: '29:example-user', memberId: upper })).toBe(upper.toLowerCase())
    expect(msTeamsChatMemberKey({ userId: ZERO })).toBe(ZERO)
    expect(msTeamsChatMemberKey({ userId: '29:example-user' })).toBeUndefined()
  })
})

let root: string | undefined
let daemon: Daemon | undefined
let realFetch: typeof fetch
let posts: { conversation: string; text: string; id: string }[] = []

beforeEach(() => {
  posts = []
  realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit | undefined) => {
    const target = String(url)
    const json = (status: number, body: unknown) =>
      ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body }) as unknown as Response
    if (target === msTeamsTokenEndpoint(ZERO)) return json(200, { access_token: 'tok', expires_in: 3600 })
    if (!target.startsWith(SERVICE_URL)) return await realFetch(url as string, init)
    const m = /\/v3\/conversations\/([^/]+)\/activities$/.exec(new URL(target).pathname)
    if (init?.method === 'POST' && m) {
      const id = `bot-${posts.length + 1}`
      posts.push({ conversation: decodeURIComponent(m[1]!), text: JSON.parse(String(init.body)).text, id })
      return json(201, { id })
    }
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

describe('the reply chain through the relay path', () => {
  it('records the bot’s reply by its activity ID, so a quote of it continues that session and nothing else does', async () => {
    root = mkdtempSync(join(tmpdir(), 'ac-msteams-'))
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
            core: { mode: 'direct', bindRules: [{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }] },
            config: { appId: ZERO, tenantId: ZERO, clientSecret: 'client-secret-example' }
          }
        ],
        output: { mode: 'low' }
      })
    )
    let sessions = 0
    const prompts: string[] = []
    daemon = new Daemon({
      root,
      hostFactory: (_agent, update) =>
        ({
          start: async () => {},
          stop: async () => {},
          cancel: async () => {},
          newSession: async () => `session-${++sessions}`,
          prompt: async (session: string) => {
            prompts.push(session)
            update(session, {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `answer ${prompts.length}` }
            })
            return 'end_turn'
          }
        }) as any
    })
    await daemon.start()
    await (daemon as any).connections.reconcileMsTeamsConnections()
    const conn = (daemon as any).msTeamsConnByIntegration.get(INTEGRATION) as MsTeamsConnection
    expect(conn.botUserId).toBe(BOT)
    // No two-second spacing between this test's writes.
    ;(conn as any).sendIntervalMs = 0
    ;(daemon as any).cpClient = new Proxy({} as Record<string, unknown>, { get: () => () => undefined })
    const turns: Promise<unknown>[] = []
    const realDispatch = (daemon as any).dispatch.bind(daemon)
    ;(daemon as any).dispatch = (...args: unknown[]) => {
      const settled = realDispatch(...args)
      turns.push(Promise.resolve(settled).catch(() => undefined))
      return settled
    }
    const deliver = async (a: MsTeamsActivity) => {
      const payload = normalized(a)
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
      await Promise.all(turns)
    }

    await deliver(activity('1700000000001', group))
    await deliver(activity('1700000000002', group, { quote: 'bot-1' }))
    await deliver(activity('1700000000003', group, { quote: 'bot-unknown' }))
    await deliver(activity('1700000000004', group))
    await deliver(activity('1700000000005', personal))
    await deliver(activity('1700000000006', personal))

    expect(prompts).toHaveLength(6)
    // The quote of the bot's first reply lands in the first session; every other group message is its own, and a 1:1 chat is one.
    expect(prompts[1]).toBe(prompts[0])
    expect(new Set([prompts[0], prompts[2], prompts[3], prompts[4]]).size).toBe(4)
    expect(prompts[5]).toBe(prompts[4])
    // Each reply went into its own conversation as extended Markdown, at the recorded serviceUrl.
    expect(posts.map((p) => [p.conversation, p.text])).toEqual([
      [GROUP_CHAT, 'answer 1'],
      [GROUP_CHAT, 'answer 2'],
      [GROUP_CHAT, 'answer 3'],
      [GROUP_CHAT, 'answer 4'],
      [PERSONAL, 'answer 5'],
      [PERSONAL, 'answer 6']
    ])
  })
})
