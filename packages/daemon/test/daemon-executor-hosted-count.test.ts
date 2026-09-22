// The holder's own load at a session's birth (session-executors.md §6): its open isolated sessions, however their runtimes are hosted.
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

describe("the holder's hosted-session count", () => {
  it('counts worktree sessions sharing one agent host, and not a session placed on another machine', async () => {
    const store = await openTestStore()
    const agentId = `agent-${crypto.randomUUID()}`
    const row = (thread: string): SessionRecord => ({
      key: sessionKey('webchat', 'C1', thread, agentId),
      agentId,
      platform: 'webchat',
      channel: 'C1',
      thread,
      acpSessionId: null,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1,
      workspaceIsolation: 'session'
    })
    const first = row('t1')
    const second = row('t2')
    const placed = row('t3')
    for (const rec of [first, second, placed]) await store.upsertSession(rec)
    await store.setSessionExecutor(placed.key, { executorDaemonId: 'd2222222-2222-4222-8222-222222222222' })
    const daemon = Object.assign(Object.create(Daemon.prototype), {
      agents: new Map([[agentId, { id: agentId }]]),
      store,
      log: quiet,
      ownIsolatedSessionCount: 0,
      dutyCoordinator: { dutyEnforced: () => false },
      // What the machine really holds: one agent host for both worktree sessions, and a session host that is only the placed session's pipe.
      hosts: new Map<string, unknown>([
        [agentHostKey(agentId), {}],
        [sessionHostKey(agentId, placed.key), {}]
      ])
    }) as CountingDaemon

    expect(await daemon.hostedSessionCount(row('t4').key)).toBe(2)
    // The session being placed is not load yet.
    expect(await daemon.hostedSessionCount(second.key)).toBe(1)
    // A hosting facet adds what it runs for others to the same count.
    daemon.executorFacet = { hostedSessions: () => 1 + daemon.ownIsolatedSessionCount }
    expect(await daemon.hostedSessionCount(row('t4').key)).toBe(3)
    await store.close()
  })

  it('does not count the sessions of an agent whose duty moved to another member', async () => {
    const store = await openTestStore()
    const held = `agent-${crypto.randomUUID()}`
    const revoked = `agent-${crypto.randomUUID()}`
    for (const agentId of [held, revoked]) {
      await store.upsertSession({
        key: sessionKey('webchat', 'C1', 't1', agentId),
        agentId,
        platform: 'webchat',
        channel: 'C1',
        thread: 't1',
        acpSessionId: null,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: 1,
        workspaceIsolation: 'session'
      })
    }
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
      duties: { holdsAgent: (agentId: string) => agentId === held }
    }) as CountingDaemon

    expect(await daemon.hostedSessionCount('placing')).toBe(1)
    await store.close()
  })
})
