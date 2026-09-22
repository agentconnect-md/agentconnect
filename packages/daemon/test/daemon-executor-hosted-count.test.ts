// The holder's own load at a session's birth (session-executors.md §6): its isolated sessions with a live runtime here, however that runtime is hosted.
import { describe, expect, it } from 'vitest'
import { agentHostKey, sessionHostKey } from '../src/acp/host-key.js'
import { Daemon } from '../src/daemon.js'
import { sessionKey, type SessionRecord } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'

const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }

interface CountingDaemon {
  ownIsolatedSessionCount: number
  executorFacet?: { hostedSessions(): number | undefined }
  hostedSessionCount(placing: string): Promise<number>
}

const sharedHost = (loaded: string[]) => ({ hasSession: (id: string) => loaded.includes(id) })

function row(agentId: string, thread: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    key: sessionKey('webchat', 'C1', thread, agentId),
    agentId,
    platform: 'webchat',
    channel: 'C1',
    thread,
    acpSessionId: `acp-${thread}`,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: 1,
    workspaceIsolation: 'session',
    ...over
  }
}

describe("the holder's hosted-session count", () => {
  it('counts live runtimes: worktree sessions its agent host has loaded and a session with its own host', async () => {
    const store = await openTestStore()
    const agentId = `agent-${crypto.randomUUID()}`
    const worktreeA = row(agentId, 't1')
    const worktreeB = row(agentId, 't2')
    const ownHost = row(agentId, 't3')
    const placed = row(agentId, 't4')
    // Open rows that run nothing here: a turn a crash left `prompting`, and a session whose runtime was reclaimed.
    const stuck = row(agentId, 't5', { state: 'prompting' })
    const reclaimed = row(agentId, 't6')
    for (const rec of [worktreeA, worktreeB, ownHost, placed, stuck, reclaimed]) await store.upsertSession(rec)
    await store.setSessionExecutor(placed.key, { executorDaemonId: 'd2222222-2222-4222-8222-222222222222' })
    const daemon = Object.assign(Object.create(Daemon.prototype), {
      agents: new Map([[agentId, { id: agentId }]]),
      store,
      log: quiet,
      ownIsolatedSessionCount: 0,
      dutyCoordinator: { dutyEnforced: () => false },
      hosts: new Map<string, unknown>([
        [agentHostKey(agentId), sharedHost(['acp-t1', 'acp-t2'])],
        [sessionHostKey(agentId, ownHost.key), {}],
        // A placed session's host here is only the pipe to its executor, which counts it.
        [sessionHostKey(agentId, placed.key), {}]
      ])
    }) as CountingDaemon

    expect(await daemon.hostedSessionCount(row(agentId, 't7').key)).toBe(3)
    // The session being placed is not load yet.
    expect(await daemon.hostedSessionCount(worktreeB.key)).toBe(2)
    // A hosting facet adds what it runs for others to the same count.
    daemon.executorFacet = { hostedSessions: () => 1 + daemon.ownIsolatedSessionCount }
    expect(await daemon.hostedSessionCount(row(agentId, 't7').key)).toBe(4)
    await store.close()
  })

  it('does not count the sessions of an agent whose duty moved to another member', async () => {
    const store = await openTestStore()
    const held = `agent-${crypto.randomUUID()}`
    const revoked = `agent-${crypto.randomUUID()}`
    const rows = [row(held, 't1'), row(revoked, 't1')]
    for (const rec of rows) await store.upsertSession(rec)
    // A revoke keeps the replica and its rows; only the ledger says this member no longer serves it.
    const daemon = Object.assign(Object.create(Daemon.prototype), {
      agents: new Map([
        [held, { id: held }],
        [revoked, { id: revoked }]
      ]),
      store,
      log: quiet,
      ownIsolatedSessionCount: 0,
      dutyCoordinator: { dutyEnforced: () => true },
      duties: { holdsAgent: (agentId: string) => agentId === held },
      hosts: new Map<string, unknown>(rows.map((rec) => [sessionHostKey(rec.agentId, rec.key), {}]))
    }) as CountingDaemon

    expect(await daemon.hostedSessionCount('placing')).toBe(1)
    await store.close()
  })
})
