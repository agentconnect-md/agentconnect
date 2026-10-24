// The gate notice on Teams (teams-integration.md §4.6): a relay-delivered mention in an undecided Off channel, with a stubbed `fetch` as the only network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeMsTeamsActivity, type MsTeamsActivity } from '@agentconnect.md/message'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { msTeamsTokenEndpoint } from '../src/platforms/msteams/api.js'

const ZERO = '00000000-0000-0000-0000-000000000000'
const BOT = `28:${ZERO}`
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${ZERO}/`
const PENDING = '19:example-pending@thread.tacv2'
const CHOSEN = '19:example-chosen@thread.tacv2'
const AGENT = 'teams-agent'
const INTEGRATION = 'teams-install'
const GATED = '🔒 This agent isn’t enabled in this conversation. Ask an admin to enable it in the AgentConnect console.'

function mention(channel: string, id: string): NormalizedMessage {
  const activity: MsTeamsActivity = {
    type: 'message',
    id,
    timestamp: '2026-01-01T00:00:10.000Z',
    serviceUrl: SERVICE_URL,
    channelId: 'msteams',
    from: { id: '29:example-user', name: 'Example Person', aadObjectId: ZERO },
    recipient: { id: BOT, name: 'Example Bot' },
    conversation: { id: `${channel};messageid=${id}`, conversationType: 'channel', tenantId: ZERO },
    text: '<at>Example Bot</at> hello',
    entities: [{ type: 'mention', text: '<at>Example Bot</at>', mentioned: { id: BOT, name: 'Example Bot' } }],
    channelData: { tenant: { id: ZERO } }
  }
  const result = normalizeMsTeamsActivity(activity, { appId: ZERO, tenantId: ZERO, traceId: `trace-${id}` })
  if (result.kind !== 'message') throw new Error(`fixture did not normalize: ${result.kind}`)
  // The relay stamps the address it saw, as its ingress plugin does.
  return { ...result.message, trigger: 'mention' } as NormalizedMessage
}

let root: string | undefined
let daemon: Daemon | undefined
let realFetch: typeof fetch
let posts: { conversation: string; text: string }[] = []

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
      posts.push({ conversation: decodeURIComponent(m[1]!), text: JSON.parse(String(init.body)).text })
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
  root = mkdtempSync(join(tmpdir(), 'ac-msteams-gate-'))
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
          core: { mode: 'shared', bindRules: [], mutedChannels: [PENDING, CHOSEN], pendingChannels: [PENDING] },
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

const deliver = (d: Daemon, payload: NormalizedMessage) =>
  (d as any).handleRelayIm({
    source: 'im',
    agentId: AGENT,
    botId: BOT,
    integrationId: INTEGRATION,
    sessionKey: payload.channel,
    msgId: payload.msgId,
    trustedRouteVia: 'mention',
    payload
  })

describe('the gate notice on Teams', () => {
  it('answers a mention once in its thread where the Off is undecided, and stays silent where an editor chose it', async () => {
    daemon = await boot()
    expect(await deliver(daemon, mention(CHOSEN, '1700000000001'))).toMatchObject({ routeAdmission: 'rejected' })
    expect(await deliver(daemon, mention(PENDING, '1700000000002'))).toMatchObject({ routeAdmission: 'rejected' })
    await vi.waitFor(
      () => expect(posts).toEqual([{ conversation: `${PENDING};messageid=1700000000002`, text: GATED }]),
      { timeout: 5000 }
    )
    await deliver(daemon, mention(PENDING, '1700000000003'))
    expect(posts).toHaveLength(1)
  })
})
