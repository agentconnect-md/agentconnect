// The doorbell: a local process rings an agent for a turn at a target its config declares, over the local API socket.
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { LocalApiServer } from '../src/local-api/server.js'
import { doorbellRoute } from '../src/local-api/doorbell.js'
import { localIpcPath } from '../src/paths.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'agent-1'
const INT = 'int-s'
const CHANNEL = 'C-ALERTS'
const THREAD = '1690000000.000200'

async function world(sessionModes: { channel: string; mode: 'append' }[] = []) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  daemon.agents.set(AGENT, {
    id: AGENT,
    name: 'Butler',
    chatActions: 'talk',
    doorbells: [{ id: 'builds', target: { platform: 'slack', channel: CHANNEL }, name: 'Build alerts' }],
    integrations: [
      {
        id: INT,
        platform: 'slack',
        core: {
          mode: 'direct',
          bindRules: [],
          mutedChannels: [],
          gated: false,
          sessionModes,
          externalChannels: [],
          decisions: { bindings: [], definitions: [] }
        },
        config: { botToken: 'x', appToken: 'y' }
      }
    ]
  })
  const conn = {
    postMessage: vi.fn(async () => '1700000000.000100'),
    getChannelHistory: vi.fn(async () => ({ messages: [], hasMore: false })),
    joinChannel: vi.fn(async () => undefined),
    getChannelInfo: vi.fn(async (id: string) => ({ id, name: 'alerts', isPrivate: true })),
    listMembers: vi.fn(async () => []),
    listChannels: vi.fn(async () => []),
    getUserProfile: vi.fn(async (u: string) => ({ id: u })),
    downloadFile: vi.fn(async () => null)
  }
  daemon.connByIntegration.set(INT, conn)
  const dispatch = vi.fn(
    async (
      _agent: string,
      _msg: unknown,
      _int: string,
      _w: unknown,
      _c: unknown,
      opts: any
    ): Promise<string | null> => {
      await opts?.onAdmission?.({ accepted: true })
      return 'acp-1'
    }
  )
  daemon.dispatch = dispatch
  return { daemon, store, conn, dispatch }
}

describe('doorbell', () => {
  it('posts at top level in the declared target and runs a doorbell turn in the new thread', async () => {
    const w = await world()
    const reply = await w.daemon.ringDoorbell({
      agent: AGENT,
      target: 'builds',
      text: 'Build 42 failed; look at it',
      post: 'New alert: build 42 failed'
    })
    expect(reply).toEqual({ status: 202, body: { channel: CHANNEL, thread: '1700000000.000100' } })
    expect(w.conn.postMessage.mock.calls[0]!.slice(0, 2)).toEqual([CHANNEL, 'New alert: build 42 failed'])
    const [agentId, msg, integrationId] = w.dispatch.mock.calls[0]!
    expect(agentId).toBe(AGENT)
    expect(integrationId).toBe(INT)
    expect(msg).toMatchObject({
      channel: CHANNEL,
      thread: '1700000000.000100',
      text: 'Build 42 failed; look at it',
      source: 'doorbell',
      trigger: 'doorbell',
      sender: { id: 'doorbell:builds', isBot: true, name: 'Build alerts' },
      sessionTriggerId: 'doorbell:builds'
    })
    expect((msg as { msgId: string }).msgId).toMatch(/^doorbell:agent-1:builds:[0-9a-f-]{36}$/)
    await w.store.close()
  })

  it('runs a turn in an existing thread of the target channel without posting', async () => {
    const w = await world()
    const reply = await w.daemon.ringDoorbell({
      agent: AGENT,
      target: 'builds',
      thread: THREAD,
      text: 'A reply arrived'
    })
    expect(reply.status).toBe(202)
    expect(w.conn.postMessage).not.toHaveBeenCalled()
    expect(w.dispatch.mock.calls[0]![1]).toMatchObject({ channel: CHANNEL, thread: THREAD, isDm: false })
    await w.store.close()
  })

  it('continues the session a person in that thread would reach when the room is in append mode', async () => {
    const w = await world([{ channel: CHANNEL, mode: 'append' }])
    await w.daemon.ringDoorbell({ agent: AGENT, target: 'builds', thread: THREAD, text: 'A reply arrived' })
    const rung = w.dispatch.mock.calls[0]![1] as { sessionThread?: string; transportScope?: string }
    // A person's message in the same thread, scoped the way ingress scopes it.
    const person: any = {
      msgId: '1690000000.000300',
      traceId: 't',
      source: 'user',
      platform: 'slack',
      channel: CHANNEL,
      thread: THREAD,
      transportScope: w.daemon.transportScopeForIntegrationIds([INT]),
      sender: { id: 'U1', isBot: false },
      text: 'hi',
      mentionedBots: [],
      isDm: false
    }
    await w.daemon.keySession(AGENT, INT, person)
    expect(person.sessionThread).toMatch(/^append:/)
    expect(rung.sessionThread).toBe(person.sessionThread)
    expect(rung.transportScope).toBe(person.transportScope)
    await w.store.close()
  })

  it('names agents by id and places by declared target only', async () => {
    const w = await world()
    expect((await w.daemon.ringDoorbell({ agent: 'Butler', target: 'builds', text: 'x' })).status).toBe(404)
    expect((await w.daemon.ringDoorbell({ agent: AGENT, target: 'C-ALERTS', text: 'x' })).status).toBe(404)
    w.daemon.servesAgent = () => false
    expect((await w.daemon.ringDoorbell({ agent: AGENT, target: 'builds', text: 'x' })).status).toBe(409)
    expect(w.dispatch).not.toHaveBeenCalled()
    await w.store.close()
  })

  it('reports a turn the daemon does not admit', async () => {
    const w = await world()
    w.dispatch.mockImplementationOnce(async () => null)
    const refused = await w.daemon.ringDoorbell({ agent: AGENT, target: 'builds', thread: '1.2', text: 'x' })
    expect(refused.status).toBe(409)
    await w.store.close()
  })
})

function call(socketPath: string, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; json: unknown }>((resolve, reject) => {
    const req = request({ socketPath, method, path }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

describe('local api server', () => {
  let server: LocalApiServer | undefined
  let root: string | undefined
  afterEach(async () => {
    await server?.stop()
    if (root) rmSync(root, { recursive: true, force: true })
    server = root = undefined
  })

  it.skipIf(process.platform === 'win32')(
    'serves on an owner-only unix socket, validates the body, and removes the socket on stop',
    async () => {
      root = mkdtempSync(join(tmpdir(), 'ac-local-'))
      const socketPath = localIpcPath(root, 'local')
      const ring = vi.fn(async () => ({ status: 202, body: { thread: 't' } }))
      server = new LocalApiServer({ socketPath, routes: [doorbellRoute(ring)] })
      expect(await server.start()).toBe(true)
      expect(statSync(socketPath).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700)
      expect((await call(socketPath, 'POST', '/v1/doorbell', { agent: 'a', target: 'b' })).status).toBe(400)
      // No free-form place: a channel in the body is refused, not ignored.
      expect(
        (await call(socketPath, 'POST', '/v1/doorbell', { agent: 'a', target: 'b', channel: 'C', text: 'hi' })).status
      ).toBe(400)
      const ok = await call(socketPath, 'POST', '/v1/doorbell', { agent: 'a', target: 'b', text: 'hi' })
      expect(ok).toEqual({ status: 202, json: { thread: 't' } })
      expect(ring).toHaveBeenCalledWith({ agent: 'a', target: 'b', text: 'hi' })
      expect((await call(socketPath, 'GET', '/v1/nope')).status).toBe(404)
      await server.stop()
      expect(existsSync(socketPath)).toBe(false)
    }
  )

  it('refuses to start on a Windows named pipe', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    server = new LocalApiServer({ socketPath: localIpcPath('C:\\agentconnect', 'local', 'win32'), routes: [], log })
    expect(await server.start()).toBe(false)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.info).not.toHaveBeenCalled()
  })
})
