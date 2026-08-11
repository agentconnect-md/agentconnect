/**
 * The console's git writes over the WS edge (unit, no socket): each wrapper must issue
 * its OWN frame type, stamp the live connection's fencing epoch, refuse to invent an
 * answer for a daemon that is not connected — and, for the commit-message pass alone,
 * ask for a single-shot request with the model-pass budget instead of the default
 * 5s/5-tries one, which would retransmit an in-flight pass and then fail the request
 * while the answer was still coming.
 */
import { describe, expect, it, vi } from 'vitest'
import { WORKSPACE_GIT_MESSAGE_BUDGET_MS } from '@agentconnect.md/protocol'
import type { LaunchRepo } from '../persistence/ports.js'
import { ConnectionRegistry, type ConnChannel, type DaemonConnState } from '../ws/registry.js'
import { ControlSender, NoConnection } from './outbound.js'

const DAEMON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OFFLINE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

interface Sent {
  type: string
  payload: unknown
  ext: unknown
  opts: unknown
}

/** A sender over one READY connection at epoch 7, recording every issued REQ and its opts. */
function senderWith(): { sender: ControlSender; sent: Sent[] } {
  const sent: Sent[] = []
  const request = vi.fn(async (type: string, payload: unknown, ext?: unknown, opts?: unknown) => {
    sent.push({ type, payload, ext, opts })
    return {}
  })
  const conn = { daemonId: DAEMON, request, send: vi.fn(), close: vi.fn() } as unknown as ConnChannel
  const registry = new ConnectionRegistry()
  const state: DaemonConnState = {
    daemonId: DAEMON,
    conn,
    sessionEpoch: 7,
    state: 'READY',
    maxAgents: 2,
    load: { cpu: 0, mem: 0, agents: 1 },
    health: 'ok',
    lastBeatAt: 0,
    reachable: true,
    assignments: new Set(),
    launches: new Map()
  }
  registry.add(state)
  return { sender: new ControlSender(registry, {} as LaunchRepo), sent }
}

describe('ControlSender workspace git writes', () => {
  it('issues one distinct frame per write under the connection’s epoch fence', async () => {
    const { sender, sent } = senderWith()

    await sender.workspaceGitStage(DAEMON, { agentId: 'a1', sessionId: 's1', paths: ['src/app.ts'] })
    await sender.workspaceGitUnstage(DAEMON, { agentId: 'a1', paths: [] })
    await sender.workspaceGitCommit(DAEMON, { agentId: 'a1', sessionId: 's1', message: 'fix: typo' })
    await sender.workspaceGitPush(DAEMON, { agentId: 'a1' })

    expect(sent).toEqual([
      {
        type: 'workspace/gitstage',
        payload: { agentId: 'a1', sessionId: 's1', paths: ['src/app.ts'] },
        ext: { epoch: 7 },
        opts: undefined
      },
      { type: 'workspace/gitunstage', payload: { agentId: 'a1', paths: [] }, ext: { epoch: 7 }, opts: undefined },
      {
        type: 'workspace/gitcommit',
        payload: { agentId: 'a1', sessionId: 's1', message: 'fix: typo' },
        ext: { epoch: 7 },
        opts: undefined
      },
      { type: 'workspace/gitpush', payload: { agentId: 'a1' }, ext: { epoch: 7 }, opts: undefined }
    ])
  })

  it('sends the commit-message pass single-shot with the model-pass budget', async () => {
    const { sender, sent } = senderWith()

    await sender.workspaceGitMessage(DAEMON, { agentId: 'a1', sessionId: 's1' })

    expect(sent).toEqual([
      {
        type: 'workspace/gitmessage',
        payload: { agentId: 'a1', sessionId: 's1' },
        ext: { epoch: 7 },
        opts: { ackTimeoutMs: WORKSPACE_GIT_MESSAGE_BUDGET_MS, maxTries: 1 }
      }
    ])
    // The budget must outlast the daemon's own, so the REP wins the race rather than the
    // CP failing a request whose answer is already on the way.
    expect(WORKSPACE_GIT_MESSAGE_BUDGET_MS).toBeGreaterThan(60_000)
  })

  it('throws NoConnection for a daemon that is not connected — no write reaches a socket', async () => {
    const { sender, sent } = senderWith()

    await expect(sender.workspaceGitStage(OFFLINE, { agentId: 'a1', paths: ['a.ts'] })).rejects.toBeInstanceOf(
      NoConnection
    )
    await expect(sender.workspaceGitUnstage(OFFLINE, { agentId: 'a1', paths: ['a.ts'] })).rejects.toBeInstanceOf(
      NoConnection
    )
    await expect(sender.workspaceGitCommit(OFFLINE, { agentId: 'a1', message: 'x' })).rejects.toBeInstanceOf(
      NoConnection
    )
    await expect(sender.workspaceGitPush(OFFLINE, { agentId: 'a1' })).rejects.toBeInstanceOf(NoConnection)
    await expect(sender.workspaceGitMessage(OFFLINE, { agentId: 'a1' })).rejects.toBeInstanceOf(NoConnection)
    expect(sent).toEqual([])
  })
})
