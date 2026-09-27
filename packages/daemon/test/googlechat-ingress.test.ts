/**
 * Google Chat's daemon-side ingress (google-chat-integration.md §4): the strategy's shape on the shared
 * relay-ingress host, receipts scoped to the installed app plus the Google message identity, and the strict
 * admission verdict a relayed delivery gets — with the receipt outliving the turn so a redelivery runs nothing.
 *
 * Platform-neutral: the only network is a stubbed `fetch` answering Google's fixed endpoints.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { stableMessageId, type NormalizedMessage } from '../src/messages/normalized.js'
import { GOOGLE_CHAT_API_ROOT, GOOGLE_TOKEN_ENDPOINT } from '../src/platforms/googlechat/connection.js'
import {
  googleChatDeliveryReceiptId,
  googleChatPlatformModule,
  type GoogleChatRelayIngressHost
} from '../src/platforms/googlechat/relay-ingress.js'

const AGENT = 'chat-bot'
const INTEGRATION = 'int-googlechat'
const BOT = '8f0a1c62-9a0f-4c6e-8b2b-7d3f5a1c0001'
const PROJECT_NUMBER = '100000000000'
const SPACE = 'spaces/EXAMPLE_SPACE'
const THREAD = `${SPACE}/threads/EXAMPLE_THREAD_3`
const MESSAGE = `${SPACE}/messages/EXAMPLE_THREAD_3.EXAMPLE_MSG_ROOT`
const APP_USER = 'users/100000000000000000009'
const SENDER = 'users/100000000000000000001'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KEY_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'example-project',
  private_key_id: 'kid-1',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'chat-app@example.test'
})

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-googlechat-ingress-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
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
      displayName: 'Chat Bot',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: INTEGRATION,
          platform: 'googlechat',
          core: { mode: 'shared', bindRules: [{ match: { kind: 'mention' } }] },
          config: { projectId: 'example-project', projectNumber: PROJECT_NUMBER, serviceAccountKey: KEY_JSON }
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

const fakeHost = () => ({
  __started: true,
  start: vi.fn(async () => {}),
  newSession: vi.fn(async () => 'acp-1'),
  prompt: vi.fn(async () => 'end_turn'),
  cancel: vi.fn(),
  stop: vi.fn()
})

/** Every Chat API request the daemon made, by method and path. */
let chatCalls: { method: string; path: string }[] = []
let realFetch: typeof fetch
beforeEach(() => {
  chatCalls = []
  realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (url: unknown, init: unknown) => {
    const target = String(url)
    const json = (status: number, body: unknown) =>
      ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body }) as unknown as Response
    if (target === GOOGLE_TOKEN_ENDPOINT) return json(200, { access_token: 'tok', expires_in: 3600 })
    if (!target.startsWith(GOOGLE_CHAT_API_ROOT)) return await realFetch(url as string, init as RequestInit)
    const path = new URL(target).pathname.slice('/v1/'.length)
    chatCalls.push({ method: (init as { method?: string }).method ?? 'GET', path })
    if (path === 'spaces')
      return json(200, { spaces: [{ name: SPACE, spaceType: 'SPACE', displayName: 'Example Space' }] })
    if (path === `${SPACE}/members/app`) return json(200, { member: { name: APP_USER, type: 'BOT' } })
    if (path === SPACE) return json(200, { name: SPACE, spaceType: 'SPACE', displayName: 'Example Space' })
    return json(404, { error: { message: 'not found' } })
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function boot() {
  const root = scaffold()
  const daemon = new Daemon({ root, hostFactory: () => fakeHost() as any })
  await daemon.start()
  await (daemon as any).connections.reconcileGoogleChatConnections()
  ;(daemon as any).cpClient = new Proxy({} as Record<string, unknown>, { get: () => () => undefined })
  const store = (daemon as any).store
  const turns: Promise<unknown>[] = []
  const realDispatch = (daemon as any).dispatch.bind(daemon)
  ;(daemon as any).dispatch = (...args: unknown[]) => {
    const settled = realDispatch(...args)
    turns.push(Promise.resolve(settled).catch(() => undefined))
    return settled
  }
  const pendingRows = async (): Promise<number> =>
    (await store.listInboxBySessionKeyFifo()).filter((row: { completedAt: number | null }) => row.completedAt === null)
      .length
  const turnSettled = async (): Promise<void> => {
    await Promise.all(turns)
    for (let i = 0; i < 4; i += 1) await pendingRows()
    expect(await pendingRows()).toBe(0)
  }
  return { daemon, store, turnSettled }
}

function delivery(msgId = `googlechat:${SPACE}:${MESSAGE}`) {
  return {
    source: 'im' as const,
    agentId: AGENT,
    botId: BOT,
    integrationId: INTEGRATION,
    sessionKey: `${SPACE}/${THREAD}`,
    msgId,
    payload: {
      msgId,
      traceId: msgId,
      source: 'user' as const,
      platform: 'googlechat' as const,
      channel: SPACE,
      thread: THREAD,
      sender: { id: SENDER, isBot: false, name: 'Example Person' },
      text: 'hello',
      mentionedBots: [APP_USER],
      isDm: false,
      trigger: 'mention' as const
    }
  }
}

const im = async (daemon: Daemon, msg: unknown) => await (daemon as any).handleRelayIm(msg)

describe('the strategy on the shared relay-ingress host', () => {
  const normalized = (transportScope?: string): NormalizedMessage =>
    ({ ...delivery().payload, ...(transportScope ? { transportScope } : {}) }) as NormalizedMessage

  function host(): GoogleChatRelayIngressHost {
    return {
      log: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {} }),
      store: () => ({}) as never,
      now: () => 0,
      connection: () => undefined,
      agent: () => undefined,
      noteMessage: () => {},
      observePlatformChat: async () => {}
    }
  }

  it('requires the durable row, mints no acknowledgement, and dispatches every delivery', async () => {
    const strategy = googleChatPlatformModule(host()).relayIngress!
    expect(strategy.requireDurable).toBe(true)
    expect(strategy.onAdmitted).toBeUndefined()
    const trace = { stage: 'prepare' }
    expect(await strategy.prepare(delivery() as never, normalized(), trace)).toBe('dispatch')
    expect(trace.stage).toBe('googlechat:dispatch')
  })

  it('scopes the receipt to the installed app and the stable Google message identity', () => {
    const strategy = googleChatPlatformModule(host()).relayIngress!
    const receipt = strategy.receiptId!(normalized('app-a'))
    expect(receipt).toBe(googleChatDeliveryReceiptId(`app-a\u001fgooglechat:${SPACE}:${MESSAGE}`))
    expect(receipt).toContain(MESSAGE)
    // The same Google message reaching a second installed app is a different delivery.
    expect(strategy.receiptId!(normalized('app-b'))).not.toBe(receipt)
    // And a receipt can never collide with the dispatch row it outlives.
    expect(receipt).not.toBe(stableMessageId(normalized('app-a')))
  })
})

describe('§4 admission and receipts through the daemon', () => {
  it('admits a relayed delivery only once its receipt is durable, and keeps the receipt after the turn', async () => {
    const { daemon, store, turnSettled } = await boot()
    const ack = await im(daemon, delivery())
    expect(ack).toEqual({ msgId: `googlechat:${SPACE}:${MESSAGE}`, accepted: true, routeAdmission: 'admitted' })
    const scope = (daemon as any).transportScopeForIntegrationIds([INTEGRATION])
    const receipt = googleChatDeliveryReceiptId(stableMessageId({ ...delivery().payload, transportScope: scope }))
    expect(await store.hasInbox(receipt)).toBe(true)
    await turnSettled()
    // The dispatch row is gone; the born-completed receipt is what a redelivery finds.
    expect(await store.hasInbox(receipt)).toBe(true)
    await daemon.stop()
  })

  it('runs no second turn for a redelivery after the first turn settled', async () => {
    const { daemon, store, turnSettled } = await boot()
    await im(daemon, delivery())
    await turnSettled()
    const handle = vi.fn()
    ;(daemon as any).sessions.handle = handle
    // The dispatch row is gone by now; the receipt CAS inside dispatch answers `admitted` for the redelivery.
    const ack = await im(daemon, delivery())
    expect(ack).toEqual({ msgId: `googlechat:${SPACE}:${MESSAGE}`, accepted: true, routeAdmission: 'admitted' })
    expect(handle).not.toHaveBeenCalled()
    // No new dispatch row was born for it either.
    const rows = await store.listInboxBySessionKeyFifo()
    expect(rows.filter((row: { completedAt: number | null }) => row.completedAt === null)).toEqual([])
    await daemon.stop()
  })

  it('learns the app identity at connect and reports the named Spaces it is in', async () => {
    const { daemon } = await boot()
    // Boot's own reconcile owns the in-flight connect, so the identity lands asynchronously.
    await vi.waitFor(() => {
      expect((daemon as any).gcConnByIntegration.get(INTEGRATION)?.botUserId).toBe(APP_USER)
      expect((daemon as any).botUserIds[INTEGRATION]).toBe(APP_USER)
    })
    await vi.waitFor(() =>
      expect((daemon as any).channelSnapshots.get(INTEGRATION)).toEqual({
        authoritative: false,
        channels: [{ id: SPACE, name: 'Example Space', isPrivate: false, kind: 'channel' }]
      })
    )
    expect(chatCalls.some((c) => c.method === 'POST')).toBe(false)
    await daemon.stop()
  })
})
