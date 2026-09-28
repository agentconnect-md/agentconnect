// Core's out-of-turn notices on Google Chat (§7.4 command chrome `notice`): the gated notice and the turn-cut notice reach the Space.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { GOOGLE_CHAT_API_ROOT, GOOGLE_TOKEN_ENDPOINT } from '../src/platforms/googlechat/connection.js'
import { WAIT } from './wait-support.js'

const AGENT = 'chat-bot'
const INTEGRATION = 'int-googlechat'
const BOT = '8f0a1c62-9a0f-4c6e-8b2b-7d3f5a1c0001'
const PROJECT_NUMBER = '100000000000'
const SPACE = 'spaces/EXAMPLE_SPACE'
const THREAD = `${SPACE}/threads/EXAMPLE_THREAD`
const DM = 'spaces/EXAMPLE_DM'
const APP_USER = 'users/100000000000000000009'
const SENDER = 'users/100000000000000000001'
const GATED = '🔒 This agent isn’t enabled in this conversation. Ask an admin to enable it in the AgentConnect console.'
const SHUTDOWN = '⚠️ The agent is restarting — this message will be picked up again.'
const REPLAYED = '⚠️ The agent is restarting to apply its new configuration — this message will be picked up again.'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KEY_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'example-project',
  private_key_id: 'kid-1',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'chat-app@example.test'
})

function scaffold(core: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-googlechat-notices-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { turnFinalContextRefresh: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', AGENT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: INTEGRATION,
          platform: 'googlechat',
          core: { mode: 'shared', ...core },
          config: { projectId: 'example-project', projectNumber: PROJECT_NUMBER, serviceAccountKey: KEY_JSON }
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

/** A runtime whose prompts block until the process is cancelled or stopped. */
function blockingHost() {
  const blocked: Array<(value: unknown) => void> = []
  return {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    hasSession: vi.fn(() => true),
    modelOptions: vi.fn(() => null),
    prompt: vi.fn(() => new Promise((resolve) => blocked.push(resolve))),
    cancel: vi.fn(async () => blocked.shift()?.({ stopReason: 'cancelled' })),
    stop: vi.fn(async () => blocked.shift()?.({ stopReason: 'cancelled' }))
  }
}

/** A runtime whose session start never returns until the process is stopped. */
function stuckStartHost() {
  let fail!: (reason: Error) => void
  const session = new Promise<never>((_resolve, reject) => (fail = reject))
  void session.catch(() => {})
  return {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => session),
    hasSession: vi.fn(() => true),
    modelOptions: vi.fn(() => null),
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => fail(new Error('host stopped')))
  }
}

/** Every message the daemon created through the Chat API: its Space, thread option, and text. */
let posts: { space: string; thread?: string; replyOption?: string; text: string }[] = []
let realFetch: typeof fetch
beforeEach(() => {
  posts = []
  realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (url: unknown, init: unknown) => {
    const target = new URL(String(url))
    const json = (status: number, body: unknown) =>
      ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body }) as unknown as Response
    if (String(url) === GOOGLE_TOKEN_ENDPOINT) return json(200, { access_token: 'tok', expires_in: 3600 })
    if (!String(url).startsWith(GOOGLE_CHAT_API_ROOT)) return await realFetch(url as string, init as RequestInit)
    const path = target.pathname.slice('/v1/'.length)
    const { method, body } = init as { method?: string; body?: string }
    if (path === 'spaces') return json(200, { spaces: [] })
    if (method === 'POST' && path.endsWith('/messages')) {
      const sent = JSON.parse(body ?? '{}') as { text: string; thread?: { name: string } }
      const replyOption = target.searchParams.get('messageReplyOption') ?? undefined
      posts.push({
        space: path.slice(0, -'/messages'.length),
        ...(sent.thread ? { thread: sent.thread.name } : {}),
        ...(replyOption ? { replyOption } : {}),
        text: sent.text
      })
      return json(200, { name: `${path}/M${posts.length}`, sender: { name: APP_USER, type: 'BOT' }, text: sent.text })
    }
    return json(404, { error: { message: 'not found' } })
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function boot(root: string, hosts: unknown[] = []): Promise<Daemon> {
  const queue = [...hosts]
  const daemon = new Daemon({ root, hostFactory: () => queue.shift() as any })
  await daemon.start()
  await (daemon as any).watcher?.close()
  ;(daemon as any).watcher = undefined
  await (daemon as any).connections.reconcileGoogleChatConnections()
  ;(daemon as any).cpClient = new Proxy({} as Record<string, unknown>, { get: () => () => undefined })
  return daemon
}

// A relayed delivery as the relay forwards it: a DM, or a Space mention before the daemon knows the app's identity.
function delivery(where: 'dm' | 'space', id = 'EXAMPLE_MSG') {
  const channel = where === 'dm' ? DM : SPACE
  const thread = where === 'dm' ? DM : THREAD
  const msgId = `googlechat:${channel}:${channel}/messages/${id}`
  return {
    source: 'im' as const,
    agentId: AGENT,
    botId: BOT,
    integrationId: INTEGRATION,
    sessionKey: `${channel}/${thread}`,
    msgId,
    ...(where === 'space' ? { trustedRouteVia: 'mention' as const } : {}),
    payload: {
      msgId,
      traceId: msgId,
      source: 'user' as const,
      platform: 'googlechat' as const,
      channel,
      thread,
      sender: { id: SENDER, isBot: false, name: 'Example Person' },
      text: 'hello',
      mentionedBots: [] as string[],
      isDm: where === 'dm',
      trigger: where === 'dm' ? ('dm' as const) : ('mention' as const)
    }
  }
}

const im = async (daemon: Daemon, msg: unknown) => await (daemon as any).handleRelayIm(msg)

describe('the gated notice on Google Chat', () => {
  it('posts the one-time notice at the top of a DM that is not enabled, through the Chat app', async () => {
    const daemon = await boot(scaffold({ gated: true, bindRules: [] }))
    try {
      expect(await im(daemon, delivery('dm'))).toMatchObject({ accepted: true, routeAdmission: 'rejected' })
      await vi.waitFor(() => expect(posts).toEqual([{ space: DM, text: GATED }]), WAIT)
      // Once per conversation.
      await im(daemon, delivery('dm', 'EXAMPLE_MSG_2'))
      expect(posts).toHaveLength(1)
    } finally {
      await daemon.stop()
    }
  })

  it('answers a Space mention in its thread even before the daemon knows the app’s identity', async () => {
    const daemon = await boot(scaffold({ gated: true, bindRules: [] }))
    try {
      expect((daemon as any).botUserIds[INTEGRATION]).toBe('')
      await im(daemon, delivery('space'))
      await vi.waitFor(
        () =>
          expect(posts).toEqual([{ space: SPACE, thread: THREAD, replyOption: 'REPLY_MESSAGE_OR_FAIL', text: GATED }]),
        WAIT
      )
    } finally {
      await daemon.stop()
    }
  })
})

describe('the turn-cut notice on Google Chat', () => {
  const enabled = { bindRules: [{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }] }

  it('tells a Space thread whose turn the shutdown drain cut that its message will be picked up again', async () => {
    const host = blockingHost()
    const daemon = await boot(scaffold(enabled), [host])
    ;(daemon as any).cfg.limits.shutdownDrainMs = 0
    await im(daemon, delivery('space'))
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)
    await daemon.stop()
    expect(posts).toContainEqual({ space: SPACE, thread: THREAD, replyOption: 'REPLY_MESSAGE_OR_FAIL', text: SHUTDOWN })
  })

  it('tells a DM whose turn a configuration change cut while still starting that it will be picked up again', async () => {
    const root = scaffold(enabled)
    const daemon = await boot(root, [stuckStartHost(), blockingHost()])
    ;(daemon as any).cfg.limits.cancelBackstopMs = 20
    try {
      await im(daemon, delivery('dm'))
      await vi.waitFor(() => expect((daemon as any).activeGateEntries.size).toBe(1), WAIT)
      const file = join(root, 'agents', AGENT, 'agent.json')
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), description: 'be terse' }))
      await daemon.reconcile()
      // A DM create carries no thread option.
      await vi.waitFor(() => expect(posts).toContainEqual({ space: DM, text: REPLAYED }), WAIT)
    } finally {
      await daemon.stop()
    }
  })
})
