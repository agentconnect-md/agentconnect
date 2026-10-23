import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { AhpClient, RpcError } from '@microsoft/agent-host-protocol/client'
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws'
import {
  ActionType,
  MessageKind,
  ResponsePartKind,
  SessionLifecycle,
  SessionStatus,
  chatReducer,
  type ChatAction,
  type ActionEnvelope,
  type ChatState,
  type RootState,
  type SessionState
} from '@microsoft/agent-host-protocol'
import type { RdAhpOpen, RdAhpMessage, RdAhpClose } from '@agentconnect.md/protocol'
import { createAhpServer } from '../../../relay/src/ahp-server.js'
import type { RelayDaemonConnection } from '../../../relay/src/relay-daemon-connection.js'
import { AhpActionJournal } from '../../src/ahp/action-journal.js'
import { AhpHostConnection, type AhpHostPort } from '../../src/ahp/connection.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const KEY = 'fixture-personal-key-never-printed'
const run = promisify(execFile)
const example = fileURLToPath(new URL('../../examples/ahp-client.mjs', import.meta.url))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

// Real public route and protocol connection; CP verdict and execution are explicit fixture replacements.
async function fixture(preauth?: { deadlineMs: number; maxMessages: number }) {
  let watermark = 0
  const journal = await AhpActionJournal.create({
    reserve: async (size) => ({ start: watermark + 1, end: (watermark += size) })
  })
  const sessions = new Map<string, SessionState>()
  const chats = new Map<string, ChatState>()
  let creates = 0
  let dispatches = 0
  let pending: Promise<unknown> = Promise.resolve()
  const port: AhpHostPort = {
    provider: { provider: AGENT, displayName: 'Fixture agent', description: '', models: [] },
    journal,
    isAuthorized: () => true,
    serialized: (operation) => {
      const result = pending.then(operation)
      pending = result.catch(() => {})
      return result
    },
    prepare: async (channel) => {
      if (!sessions.has(channel) && !chats.has(channel)) throw new Error('Unknown channel')
    },
    snapshot: (channel) => sessions.get(channel) ?? chats.get(channel),
    listSessions: async () => ({
      items: [...sessions].map(([resource, state]) => ({
        resource,
        provider: AGENT,
        title: state.title,
        status: state.status,
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      }))
    }),
    createSession: async ({ channel }) => {
      creates++
      const chat = `${channel.replace('ahp-session:', 'ahp-chat:')}/main`
      chats.set(chat, {
        resource: chat,
        title: 'Fixture conversation',
        status: SessionStatus.Idle,
        modifiedAt: '2026-01-01T00:00:00.000Z',
        turns: []
      })
      sessions.set(channel, {
        provider: AGENT,
        title: 'Fixture conversation',
        status: SessionStatus.Idle,
        lifecycle: SessionLifecycle.Ready,
        activeClients: [],
        chats: [],
        defaultChat: chat
      })
    },
    dispatch: async ({ channel, action }, origin) => {
      dispatches++
      if (action.type !== ActionType.ChatTurnStarted || action.message.origin?.kind !== MessageKind.User)
        throw new Error('Unexpected action')
      // Inject an unrelated rejection to exercise client correlation; production journals keep rejections private.
      const rejection = await journal.append({
        channel,
        action,
        origin: { clientId: 'another-client', clientSeq: origin.clientSeq },
        rejectionReason: 'fixture rejection'
      })
      for (const [attachmentId, listener] of listeners)
        listener({ attachmentId, message: JSON.stringify({ jsonrpc: '2.0', method: 'action', params: rejection }) })
      for (const update of [
        action,
        {
          type: ActionType.ChatResponsePart,
          turnId: action.turnId,
          part: { kind: ResponsePartKind.Markdown, id: 'answer', content: 'Hello through the relay.' }
        },
        { type: ActionType.ChatTurnComplete, turnId: action.turnId, duration: 1 }
      ] satisfies ChatAction[]) {
        chats.set(channel, chatReducer(chats.get(channel)!, update))
        await journal.append({ channel, action: update, origin })
      }
    }
  }
  const hosts = new Map<string, AhpHostConnection>()
  let opens = 0
  const listeners = new Map<string, (frame: RdAhpMessage | RdAhpClose) => void>()
  const carrier = {
    state: 'READY',
    supports: () => true,
    authorizeAhp: async (input: RdAhpOpen) => {
      if (!hosts.has(input.attachmentId)) {
        const host = new AhpHostConnection({
          port,
          send: (message) => listeners.get(input.attachmentId)?.({ attachmentId: input.attachmentId, message }),
          close: (reason) => listeners.get(input.attachmentId)?.({ attachmentId: input.attachmentId, reason })
        })
        hosts.set(input.attachmentId, host)
        opens++
        if (input.handshake) await host.adopt(input.handshake)
      }
      return true
    },
    sendAhp: (frame: RdAhpMessage | RdAhpClose) => {
      const host = hosts.get(frame.attachmentId)
      if ('message' in frame) void host?.receive(frame.message)
      else {
        host?.dispose()
        hosts.delete(frame.attachmentId)
      }
    },
    listenAhp: (id: string, listener: (frame: RdAhpMessage | RdAhpClose) => void) => {
      listeners.set(id, listener)
      return () => listeners.delete(id)
    },
    onceClosed: () => () => {}
  } as unknown as RelayDaemonConnection
  const verified: Array<{ credential: string; agentId: string; kind: string }> = []
  const server = createServer()
  const edge = createAhpServer({ server } as Parameters<typeof createAhpServer>[0], {
    ...(preauth ? { preauth } : {}),
    mode: () => 'on',
    daemon: () => carrier,
    verify: async (credential, agentId, kind) => {
      verified.push({ credential, agentId, kind })
      return credential !== KEY
        ? { ok: false, reason: 'forbidden' }
        : {
            ok: true,
            orgId: 'fixture-org',
            agentId,
            daemonId: '22222222-2222-4222-8222-222222222222',
            userId: 'fixture-user',
            user: 'Fixture User',
            callerRole: 'owner',
            callerApproves: true,
            apiProtocols: ['ahp'],
            ahpGrant: { token: 'fixture-signed-grant', expiresAtMs: Date.now() + 60_000 }
          }
    }
  })
  cleanups.push(async () => {
    for (const ws of edge.wss.clients) ws.terminate()
    edge.close()
    for (const host of hosts.values()) host.dispose()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing address')
  return {
    url: `ws://127.0.0.1:${address.port}/ahp/agents/${AGENT}`,
    verified,
    opens: () => opens,
    counts: () => ({ creates, dispatches })
  }
}

it('runs the SDK CLI through authenticated relay discovery, create, streaming, resume and refusal', async () => {
  const host = await fixture()
  const invoke = (args: string[], key = KEY) =>
    run(process.execPath, [example, ...args], {
      env: { ...process.env, AHP_URL: host.url, AHP_API_KEY: key },
      timeout: 5000
    })
  expect(JSON.parse((await invoke([])).stdout)).toMatchObject({ type: 'sessions', items: [] })
  const first = await invoke(['--message', 'Hello'])
  const rows = first.stdout
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row))
  expect(rows).toContainEqual(expect.objectContaining({ type: 'output', text: 'Hello through the relay.' }))
  expect(rows.at(-1)).toMatchObject({ type: 'complete' })
  const session = rows.find((row) => row.type === 'session').uri
  const resumed = await invoke(['--session', session, '--message', 'Again'])
  expect(resumed.stdout).toContain('Hello through the relay.')
  expect(host.counts()).toEqual({ creates: 1, dispatches: 2 })
  expect(host.verified).toHaveLength(3)
  expect(
    host.verified.every((item) => item.credential === KEY && item.agentId === AGENT && item.kind === 'ahp-client-key')
  ).toBe(true)
  expect(`${first.stdout}${first.stderr}${resumed.stdout}${resumed.stderr}`).not.toContain(KEY)
  await expect(invoke([], 'bad-secret-never-printed')).rejects.toMatchObject({
    code: 1,
    stderr: expect.not.stringContaining('bad-secret-never-printed')
  })
})

it('refuses URL credentials before dialing and sanitizes failure output', async () => {
  const secret = 'url-secret-never-printed'
  await expect(
    run(process.execPath, [example], {
      env: { ...process.env, AHP_URL: `ws://127.0.0.1:1/ahp/agents/${AGENT}?key=${secret}`, AHP_API_KEY: KEY }
    })
  ).rejects.toMatchObject({ code: 1, stderr: expect.not.stringContaining(secret) })
})

it('authenticates an official SDK client in-band, without headers, and completes a turn', async () => {
  const host = await fixture()
  const client = new AhpClient(await WebSocketTransport.connect(host.url, { protocols: ['ahp'] }), {
    requestTimeoutMs: 5000
  })
  client.connect()
  const actions: ActionEnvelope[] = []
  const events = (async () => {
    for await (const item of client.events()) if (item.event.type === 'action') actions.push(item.event.params)
  })()
  cleanups.push(async () => {
    await client.shutdown()
    await events
  })
  const hello = await client.initialize({
    clientId: 'third-party',
    protocolVersions: ['1.0.0'],
    initialSubscriptions: ['ahp-root://']
  })
  const [agent] = (hello.snapshots[0]!.state as RootState).agents
  const resource = agent!.protectedResources![0]!.resource
  expect(agent!.provider).toBe(AGENT)
  expect(resource).toBe(host.url.replace('ws://', 'https://'))
  expect(host.opens()).toBe(0)
  expect(await client.request('authenticate', { channel: 'ahp-root://', resource, token: KEY })).toEqual({})
  expect(host.verified).toEqual([{ credential: KEY, agentId: AGENT, kind: 'ahp-client-key' }])
  await vi.waitFor(() =>
    expect(actions[0]?.action).toMatchObject({
      type: ActionType.RootAgentsChanged,
      agents: [{ provider: AGENT, displayName: 'Fixture agent' }]
    })
  )
  await client.request('createSession', { channel: 'ahp-session:/third-party', provider: AGENT })
  client.dispatch('ahp-chat:/third-party/main', {
    type: ActionType.ChatTurnStarted,
    turnId: 'turn',
    startedAt: new Date().toISOString(),
    message: { text: 'Hello', origin: { kind: MessageKind.User } }
  })
  await vi.waitFor(() => expect(actions.map((envelope) => envelope.action.type)).toContain(ActionType.ChatTurnComplete))
  expect(actions).toContainEqual(
    expect.objectContaining({
      action: expect.objectContaining({ part: expect.objectContaining({ content: 'Hello through the relay.' }) })
    })
  )
  expect(host.counts()).toEqual({ creates: 1, dispatches: 1 })
})

it('refuses other methods, a bad key and a stalled handshake before any daemon attachment', async () => {
  const host = await fixture({ deadlineMs: 300, maxMessages: 8 })
  const raw = async () => {
    const socket = new WebSocket(host.url, ['ahp'])
    const replies: any[] = []
    socket.on('message', (data) => replies.push(JSON.parse(String(data))))
    const closed = once(socket, 'close').then(([code]) => code as number)
    await once(socket, 'open')
    let id = 0
    const request = async (method: string, params: unknown) => {
      const requestId = ++id
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }))
      await vi.waitFor(() => expect(replies.find((reply) => reply.id === requestId)).toBeDefined())
      return replies.find((reply) => reply.id === requestId)
    }
    const initialize = () =>
      request('initialize', { channel: 'ahp-root://', clientId: 'third-party', protocolVersions: ['1.0.0'] })
    return { request, initialize, closed }
  }
  const resource = host.url.replace('ws://', 'https://')
  const early = await raw()
  await early.initialize()
  expect((await early.request('listSessions', { channel: 'ahp-root://' })).error).toMatchObject({
    code: -32007,
    data: { resources: [{ resource }] }
  })
  expect(await early.closed).toBe(4401)
  const wrong = await raw()
  await wrong.initialize()
  const refused = await wrong.request('authenticate', { channel: 'ahp-root://', resource, token: 'bad-key' })
  expect(refused.error).toMatchObject({ code: -32007, message: 'Invalid credential' })
  expect(JSON.stringify(refused)).not.toContain('bad-key')
  expect(await wrong.closed).toBe(4401)
  const stalled = await raw()
  await stalled.initialize()
  expect(await stalled.closed).toBe(4401)
  const sdk = new AhpClient(await WebSocketTransport.connect(host.url, { protocols: ['ahp'] }), {
    requestTimeoutMs: 5000
  })
  sdk.connect()
  cleanups.push(() => sdk.shutdown())
  const rejected = await sdk.request('listSessions', { channel: 'ahp-root://' }).catch((error: unknown) => error)
  expect(rejected).toBeInstanceOf(RpcError)
  expect((rejected as RpcError).code).toBe(-32007)
  expect(host.verified.map((item) => item.credential)).toEqual(['bad-key'])
  expect(host.opens()).toBe(0)
})
