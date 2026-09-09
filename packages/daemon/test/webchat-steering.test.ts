import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { RdChatEvent, RdMsgWebchat } from '@agentconnect.md/protocol'
import { WAIT } from './wait-support.js'

// #547 on top of #1847: a console composer that queues locally sends a `steer: true` turn while
// the agent's turn runs. The daemon answers the admission verdict in the ACK — `steered` into
// the live turn, refused `busy` (the browser keeps it queued), or admitted as its own turn.

const AGENT_ID = 'bot-a'
const CONV = '88888888-8888-4888-8888-888888888888'
const TURN = '77777777-7777-4777-8777-777777777777'
const STEER_TURN = '66666666-6666-4666-8666-666666666666'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-wc-steer-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { turnFinalContextRefresh: true },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', AGENT_ID)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: AGENT_ID,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

const rd = (payload: RdMsgWebchat['payload'], over: Partial<RdMsgWebchat> = {}): RdMsgWebchat => ({
  source: 'webchat',
  agentId: AGENT_ID,
  sessionKey: CONV,
  msgId: 'm-1',
  chatId: CONV,
  payload,
  ...over
})

function steeringHost(steer?: () => Promise<string>) {
  const releases: Array<() => void> = []
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-wc-1'),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async () => {
      await new Promise<void>((r) => releases.push(r))
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    steeringSupported: vi.fn(() => true),
    steer: vi.fn(steer ?? (async () => 'injected'))
  }
  return { host, releaseOne: () => releases.shift()?.() }
}

async function boot(host: unknown) {
  const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any })
  await daemon.start()
  ;(daemon as any).cpClient = {
    emitUsageReport: vi.fn(),
    emitSessionActivity: vi.fn(),
    organizationScope: () => 'connection' as const,
    stop: vi.fn(async () => {})
  }
  ;(daemon as any).relays = { stop: vi.fn(async () => {}), sendWebchatPost: vi.fn() }
  return daemon
}

async function startTurn(daemon: Daemon, host: { prompt: ReturnType<typeof vi.fn> }, events: RdChatEvent[]) {
  const ack = await (daemon as any).handleRelayMsg(
    rd({ op: 'turn', text: 'original request', user: 'owner', turnId: TURN, post: { postId: TURN, at: 1_000 } }),
    (event: RdChatEvent) => events.push(event)
  )
  expect(ack).toMatchObject({ accepted: true, turnId: TURN })
  await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)
}

const steerOp = (text: string) =>
  rd(
    { op: 'turn', text, user: 'owner', turnId: STEER_TURN, post: { postId: STEER_TURN, at: 2_000 }, steer: true },
    { msgId: 'm-2' }
  )

describe('webchat steer-only turns', () => {
  it('acks `steered` once the live turn took the message, and ends that turn stream at once', async () => {
    const h = steeringHost()
    const daemon = await boot(h.host)
    const events: RdChatEvent[] = []
    await startTurn(daemon, h.host, events)
    // The running turn's status frame tells the composer it may steer.
    await vi.waitFor(() =>
      expect(events.some((e) => e.kind === 'output' && e.output.status?.steerable === true)).toBe(true)
    )

    const steerEvents: RdChatEvent[] = []
    const ack = await (daemon as any).handleRelayMsg(steerOp('use the staging database'), (event: RdChatEvent) =>
      steerEvents.push(event)
    )
    expect(ack).toEqual({ msgId: 'm-2', accepted: true, turnId: STEER_TURN, steered: true })
    expect(h.host.steer).toHaveBeenCalledOnce()
    expect((h.host.steer as any).mock.calls[0][1]).toEqual([{ type: 'text', text: '[owner] use the staging database' }])
    const done = steerEvents.find((e) => e.kind === 'done')
    expect(done).toMatchObject({ kind: 'done', done: { turnId: STEER_TURN, stopReason: 'steered_into_turn' } })
    // Nothing waits behind the turn, and the first prompt is the only one.
    expect([...(daemon as any).serialQueue.values()].flat()).toHaveLength(0)
    h.releaseOne()
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)
    expect(h.host.prompt).toHaveBeenCalledTimes(1)
    await daemon.stop()
  })

  it('refuses `busy` instead of queueing when the runtime declines, leaving no stream or row behind', async () => {
    const h = steeringHost(async () => 'failed')
    const daemon = await boot(h.host)
    const events: RdChatEvent[] = []
    await startTurn(daemon, h.host, events)

    const steerEvents: RdChatEvent[] = []
    const ack = await (daemon as any).handleRelayMsg(steerOp('follow-up'), (event: RdChatEvent) =>
      steerEvents.push(event)
    )
    expect(ack).toEqual({ msgId: 'm-2', accepted: false, turnId: STEER_TURN, reason: 'busy' })
    expect(steerEvents).toEqual([])
    expect([...(daemon as any).serialQueue.values()].flat()).toHaveLength(0)
    const inbox = await (daemon as any).store.listInboxBySessionKeyFifo()
    expect(inbox.map((row: { id: string }) => row.id)).not.toContain(STEER_TURN)
    // The refused stream is gone: a resume for it finds nothing.
    expect((daemon as any).webchatTransport.webchatStreams.has(`${STEER_TURN}:${AGENT_ID}`)).toBe(false)
    h.releaseOne()
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)
    expect(h.host.prompt).toHaveBeenCalledTimes(1)
    await daemon.stop()
  })

  it('admits a steer whose turn had already ended as an ordinary turn, without `steered`', async () => {
    const h = steeringHost()
    const daemon = await boot(h.host)
    const events: RdChatEvent[] = []
    await startTurn(daemon, h.host, events)
    h.releaseOne()
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)

    const steerEvents: RdChatEvent[] = []
    const ack = await (daemon as any).handleRelayMsg(steerOp('late steer'), (event: RdChatEvent) =>
      steerEvents.push(event)
    )
    expect(ack).toEqual({ msgId: 'm-2', accepted: true, turnId: STEER_TURN })
    expect(h.host.steer).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(h.host.prompt).toHaveBeenCalledTimes(2), WAIT)
    h.releaseOne()
    await vi.waitFor(() => expect(steerEvents.some((e) => e.kind === 'done')).toBe(true), WAIT)
    await daemon.stop()
  })
})
