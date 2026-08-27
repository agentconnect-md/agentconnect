import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Daemon } from '../src/daemon.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { statePath } from '../src/paths.js'
import { FakeClock } from './cp/fake-clock.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

/**
 * #1038 — the loop guard's durable backlog is one inbox table for the whole install, but a
 * trip can only interrupt the turns living in the memory of the member that ran it. So the
 * trip acts on what this member serves: a peer's queued row is skipped, never destroyed,
 * and the peer stops its own turns on the first admission its latched circuit refuses.
 */

const AGENT_A = 'bot-a'
const AGENT_B = 'bot-b'
const GROUP_A = '11111111-1111-4111-8111-111111111111'
const GROUP_B = '22222222-2222-4222-8222-222222222222'
const SCOPE = 'slack:C1:T1'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-loop-guard-pool-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  for (const id of [AGENT_A, AGENT_B]) {
    const adir = join(root, 'agents', id)
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id,
        name: id,
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [],
        output: { mode: 'low' }
      })
    )
  }
  return root
}

async function boot(root: string, daemonId: string, scope: 'frame' | 'legacy') {
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    root,
    hostFactory: () => ({}) as any,
    clock: new FakeClock()
  })
  await daemon.start()
  const inner = daemon as any
  inner.cfg.daemonId = daemonId
  inner.cpClient = {
    organizationScope: () => scope,
    // Membership, not tenancy, is what makes duties enforced (daemon-groups.md §3).
    memberSet: () => (scope === 'frame' ? { setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' } : null),
    state: 'READY',
    stop: async () => {},
    releaseDuties: vi.fn(async () => {}),
    reportDutiesNow: vi.fn(() => {}),
    fetchDutyAgent: vi.fn()
  }
  return { daemon, inner }
}

/** Two members over ONE store: the same root, so both open the same database. */
async function bootPool() {
  const root = scaffold()
  const a = await boot(root, 'daemon-a', 'frame')
  const b = await boot(root, 'daemon-b', 'frame')
  const path = statePath(root)
  const locals: LocalStore[] = [a.inner.store, b.inner.store]
  a.inner.store = await LocalStore.open({
    database: SqliteAsyncDatabase.adopt(new DatabaseSync(path)),
    shared: true,
    ownerId: 'daemon-a',
    orgForAgent: () => 'org-1'
  })
  b.inner.store = await LocalStore.open({
    database: SqliteAsyncDatabase.adopt(new DatabaseSync(path)),
    shared: true,
    ownerId: 'daemon-b',
    orgForAgent: () => 'org-1'
  })
  const stop = async () => {
    await Promise.all([a.daemon.stop(), b.daemon.stop()])
    for (const local of locals) await local.close()
  }
  return { a, b, shared: a.inner.store as LocalStore, stop }
}

const grant = (groupId: string, agentId: string) => ({
  groupId,
  orgId: 'org-1',
  term: '1',
  members: [{ kind: 'agent' as const, refId: agentId }]
})
const hold = (inner: any, groupId: string, agentId: string) => inner.duties.applyGrant([grant(groupId, agentId)])

/** A plain Slack reply inside thread T1 — the coordinates that key SCOPE. */
function scopedMessage(agentId: string, ts: string) {
  return {
    msgId: `slack:C1:${ts}`,
    platform: 'slack',
    channel: 'C1',
    thread: 'T1',
    isDm: false,
    source: 'user',
    text: 'loop',
    sender: { id: `U-${agentId}`, name: agentId, isBot: true },
    headless: true
  }
}

async function seedInbox(store: LocalStore, id: string, agentId: string, ts: string): Promise<void> {
  await store.appendInbox({
    id,
    sessionKey: `slack:C1:T1:${agentId}`,
    agentId,
    msg: JSON.stringify(scopedMessage(agentId, ts)),
    enqueuedAt: `0000000000000000000${ts.at(-1)}`
  })
}

/** The Slack poison shape — an anonymous, empty, attachment-less user turn — in a DM. */
function malformedDm(ts: string) {
  return {
    msgId: `slack:D1:${ts}`,
    platform: 'slack',
    channel: 'D1',
    thread: ts,
    isDm: true,
    source: 'user',
    text: '',
    attachments: [],
    sender: { id: 'unknown', name: 'unknown', isBot: false },
    headless: true
  }
}

/** A live turn in the member's serial gate: state only that member can cancel. */
function liveTurn(inner: any, key: string, agentId: string, msg?: any): any {
  const entry = {
    agentId,
    msg: msg ?? scopedMessage(agentId, '900.1'),
    initAbort: new AbortController(),
    resolve: () => {},
    reject: () => {}
  }
  inner.activeGateEntries.set(key, entry)
  return entry
}

describe('loop guard on a daemon pool acts only on what the member serves (#1038)', () => {
  it("a trip neither deletes a peer's durable rows nor pretends to stop its turns", async () => {
    const { a, b, shared, stop } = await bootPool()
    hold(a.inner, GROUP_A, AGENT_A)
    hold(b.inner, GROUP_B, AGENT_B)
    await seedInbox(shared, 'inbox-a', AGENT_A, '100.1')
    await seedInbox(shared, 'inbox-b', AGENT_B, '200.1')
    const turnA = liveTurn(a.inner, 'key-a', AGENT_A)
    const turnB = liveTurn(b.inner, 'key-b', AGENT_B)

    await shared.tripLoopGuard(SCOPE, 1_000, 'turn_rate_burst')
    await a.inner.onLoopGuardTripped(SCOPE, 'turn_rate_burst', {
      agentId: AGENT_A,
      msg: scopedMessage(AGENT_A, '100.1')
    })

    // A's own backlog and turn are terminal; B's row is left for B, which is still running it.
    expect((await shared.listInboxBySessionKeyFifo()).map((row: any) => row.id)).toEqual(['inbox-b'])
    expect(turnA.cancelledReason).toBe('loop protection')
    expect(turnB.cancelledReason).toBeUndefined()

    // B enforces the latch on its own work the first time the open circuit refuses a turn.
    await b.inner.enforceLatchedLoopScope(SCOPE)
    expect(turnB.cancelledReason).toBe('loop protection')
    expect(await b.inner.purgeLoopScopeInbox(SCOPE)).toBe(1)
    expect(await shared.listInboxBySessionKeyFifo()).toEqual([])

    // The latch is enforced once per member, not on every subsequent refusal.
    const turnBAgain = liveTurn(b.inner, 'key-b2', AGENT_B)
    await b.inner.enforceLatchedLoopScope(SCOPE)
    expect(turnBAgain.cancelledReason).toBeUndefined()
    // These heads have no dispatch behind them, so release them before shutdown drains the gate.
    for (const member of [a, b]) member.inner.activeGateEntries.clear()
    await stop()
  })

  it('a member that loses the structural trip still stops its own turns', async () => {
    const { a, b, shared, stop } = await bootPool()
    hold(a.inner, GROUP_A, AGENT_A)
    hold(b.inner, GROUP_B, AGENT_B)
    const dmScope = 'slack:D1:dm'
    const turnA = liveTurn(a.inner, 'key-dm-a', AGENT_A, malformedDm('900.1'))

    // B latches the DM circuit first; A read it as closed a moment earlier, which is the
    // exact race the trip's CAS resolves — A's own trip returns trippedNow: false.
    expect((await shared.tripLoopGuard(dmScope, 2_000, 'malformed_platform_event')).trippedNow).toBe(true)
    a.inner.store.isLoopGuardOpen = () => false
    await a.inner.dispatch(AGENT_A, malformedDm('300.1'))

    expect(turnA.cancelledReason).toBe('loop protection')
    for (const member of [a, b]) member.inner.activeGateEntries.clear()
    await stop()
  })

  it('a single local daemon still purges the whole conversation backlog', async () => {
    const root = scaffold()
    const { daemon, inner } = await boot(root, 'daemon-solo', 'legacy')
    const store: LocalStore = inner.store
    await seedInbox(store, 'inbox-a', AGENT_A, '100.1')
    await seedInbox(store, 'inbox-b', AGENT_B, '200.1')

    // No duty enforcement: every agent is served here, so nothing is left behind.
    expect(await inner.purgeLoopScopeInbox(SCOPE)).toBe(2)
    expect(await store.listInboxBySessionKeyFifo()).toEqual([])
    await daemon.stop()
  })
})
