import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import {
  ActionType,
  MessageKind,
  ResponsePartKind,
  SessionLifecycle,
  SessionStatus,
  chatReducer,
  type ChatAction,
  type ChatState,
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
async function fixture() {
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
  const listeners = new Map<string, (frame: RdAhpMessage | RdAhpClose) => void>()
  const carrier = {
    state: 'READY',
    supports: () => true,
    authorizeAhp: async (input: RdAhpOpen) => {
      if (!hosts.has(input.attachmentId))
        hosts.set(
          input.attachmentId,
          new AhpHostConnection({
            port,
            send: (message) => listeners.get(input.attachmentId)?.({ attachmentId: input.attachmentId, message }),
            close: (reason) => listeners.get(input.attachmentId)?.({ attachmentId: input.attachmentId, reason })
          })
        )
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
