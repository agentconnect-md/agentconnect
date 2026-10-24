// Teams' first run (teams-integration.md §4.7): a relayed install is welcomed once with a card, and `help` is answered without a turn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeMsTeamsActivity, type MsTeamsActivity } from '@agentconnect.md/message'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { msTeamsTokenEndpoint } from '../src/platforms/msteams/api.js'
import { isMsTeamsHelp, msTeamsHelpText } from '../src/platforms/msteams/relay-ingress.js'
import { buildWelcome } from '../src/platforms/welcome.js'

const ZERO = '00000000-0000-0000-0000-000000000000'
const BOT = `28:${ZERO}`
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${ZERO}/`
const PERSONAL = 'a:example-personal'
const OFF = '19:example-off@thread.tacv2'
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
      const body = JSON.parse(String(init.body)) as { text?: string; attachments?: { content: Post['card'] }[] }
      posts.push({
        conversation: decodeURIComponent(m[1]!),
        ...(body.text ? { text: body.text } : {}),
        ...(body.attachments ? { card: body.attachments[0]!.content } : {})
      })
      return json(201, { id: `bot-${posts.length}` })
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
  const d = new Daemon({ root, hostFactory: () => ({}) as any })
  await d.start()
  await (d as any).connections.reconcileMsTeamsConnections()
  ;((d as any).msTeamsConnByIntegration.get(INTEGRATION) as { sendIntervalMs: number }).sendIntervalMs = 0
  ;(d as any).cpClient = new Proxy({} as Record<string, unknown>, { get: () => () => undefined })
  return d
}

const install = (d: Daemon, conversationId: string, scope: 'personal' | 'channel', id: string) =>
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
      botName: 'Example Bot',
      addedBy: { id: '29:example-user', name: 'Example Person' }
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

const cardText = (post: Post) =>
  (post.card?.body ?? []).map((b) => b.text ?? (b.inlines ?? []).map((i) => i.text).join('')).join('\n')

describe('the Teams welcome', () => {
  it('welcomes a 1:1 install by the app’s name, with how to use it and no mention', async () => {
    daemon = await boot()
    expect(await install(daemon, PERSONAL, 'personal', 'install-1')).toMatchObject({ accepted: true })
    expect(posts).toHaveLength(1)
    const text = cardText(posts[0]!)
    expect(posts[0]!.conversation).toBe(PERSONAL)
    expect(text).toContain('Hi, I’m Example Bot')
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
    const base = { name: 'Bot', isDm: false, consoleUrl: 'https://console.example.test' }
    expect(buildWelcome({ ...base, enabled: true }).lines.join(' ')).not.toContain('admin')
    expect(buildWelcome({ ...base, enabled: false }).lines.join(' ')).toContain('An admin')
    expect(buildWelcome({ ...base, enabled: true }).links.map((l) => l.title)).toEqual([
      'Open AgentConnect',
      'Guide',
      'Contact us'
    ])
  })
})
