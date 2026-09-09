import { MEMORY_ENTRIES_V1_FEATURE, MEMORY_ENTRIES_WRITE_V1_FEATURE } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { LaunchRepo } from '../persistence/ports.js'
import { ConnectionRegistry, type ConnChannel, type DaemonConnState } from '../ws/registry.js'
import { ControlSender, NoConnection } from './outbound.js'

const DAEMON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OFFLINE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** A sender over one READY connection at epoch 7, recording every issued REQ. */
function senderWith(features: string[] = []): {
  sender: ControlSender
  sent: Array<{ type: string; payload: unknown; ext: unknown; budget: unknown }>
  fail: () => void
} {
  const sent: Array<{ type: string; payload: unknown; ext: unknown; budget: unknown }> = []
  let fail = false
  const request = vi.fn(async (type: string, payload: unknown, ext?: unknown, budget?: unknown) => {
    sent.push({ type, payload, ext, budget })
    if (fail) throw new Error('connection closed')
    return {}
  })
  const conn = { daemonId: DAEMON, request, send: vi.fn(), close: vi.fn() } as unknown as ConnChannel
  const registry = new ConnectionRegistry()
  const state: DaemonConnState = {
    daemonId: DAEMON,
    conn,
    sessionEpoch: 7,
    state: 'READY',
    capabilities: { platforms: [], runtimes: [], acp: true, features },
    maxAgents: 2,
    load: { cpu: 0, mem: 0, agents: 1 },
    health: 'ok',
    lastBeatAt: 0,
    reachable: true,
    assignments: new Set(),
    launches: new Map()
  }
  registry.add(state)
  return {
    sender: new ControlSender(registry, {} as LaunchRepo),
    sent,
    fail: () => {
      fail = true
    }
  }
}

describe('ControlSender.memoryEntriesRead', () => {
  it('refuses an old daemon without sending an unknown frame', async () => {
    const { sender, sent } = senderWith()
    expect(await sender.memoryEntriesRead(DAEMON, { agentId: DAEMON, operation: 'describe' })).toMatchObject({
      operation: 'error',
      code: 'UNSUPPORTED'
    })
    expect(sent).toEqual([])
  })
  it('uses the current epoch and refuses an offline daemon', async () => {
    const { sender, sent } = senderWith([MEMORY_ENTRIES_V1_FEATURE])
    const req = { agentId: DAEMON, operation: 'list' as const, request: { limit: 20 } }
    await sender.memoryEntriesRead(DAEMON, req)
    expect(sent).toEqual([{ type: 'memory/entries/read/v1', payload: req, ext: { epoch: 7 }, budget: undefined }])
    await expect(sender.memoryEntriesRead(OFFLINE, req)).rejects.toBeInstanceOf(NoConnection)
  })
})

it('gates mutations, bounds escaped JSON before sending, and never replays uncertain writes', async () => {
  const req = { agentId: DAEMON, operation: 'create' as const, request: { text: 'hello' } }
  const old = senderWith([MEMORY_ENTRIES_V1_FEATURE])
  expect(await old.sender.memoryEntriesWrite(DAEMON, req)).toMatchObject({ code: 'UNSUPPORTED' })
  expect(old.sent).toHaveLength(0)
  const live = senderWith([MEMORY_ENTRIES_WRITE_V1_FEATURE])
  expect(
    await live.sender.memoryEntriesWrite(DAEMON, { ...req, request: { text: '\u0000'.repeat(40000) } })
  ).toMatchObject({ code: 'TOO_LARGE' })
  expect(live.sent).toHaveLength(0)
  await live.sender.memoryEntriesWrite(DAEMON, req)
  expect(live.sent[0]).toMatchObject({ type: 'memory/entries/write/v1', payload: req, ext: { epoch: 7 } })
  live.fail()
  expect(await live.sender.memoryEntriesWrite(DAEMON, req)).toMatchObject({ code: 'AMBIGUOUS_WRITE' })
  expect(live.sent).toHaveLength(2)
})
