import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { sessionKey } from '../src/store/local-store.js'
import type { StartOrchestrationReq, OrchestrationOwnerReq } from '../src/mcp/ops.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

/**
 * §3.4/§6.8 main-agent orchestration. These drive the daemon's private orchestration
 * methods directly and stub `dispatch` so we assert record-first persistence, per-subtask
 * delivered|failed, correlation-safety on worker reports, completion, owner checks, and the
 * one-shot cron deadline — without running a real ACP turn.
 */

function scaffold(agentIds: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-daemon-orch-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  for (const id of agentIds) {
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

const fakeHost = () => ({
  __started: true,
  start: vi.fn(async () => {}),
  newSession: vi.fn(async () => 'acp-1'),
  prompt: vi.fn(async () => 'end_turn'),
  cancel: vi.fn(),
  stop: vi.fn()
})

/** Boot a daemon with `dispatch` replaced by a spy so no real ACP turn runs; capture calls. */
async function boot(root: string) {
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost() as any })
  await daemon.start()
  const localAgents = [...(daemon as any).agents.values()].map((agent: any) => ({
    agentId: agent.id,
    daemonId: 'local-daemon',
    callPolicy: agent.callPolicy,
    allowedCallerAgentIds: agent.allowedCallerAgentIds,
    outboundPolicy: agent.outboundPolicy,
    allowedTargetAgentIds: agent.allowedTargetAgentIds
  }))
  const ORG = '00000000-0000-0000-0000-0000000000a1'
  ;(daemon as any).cpCollab.replace({
    generation: 0,
    channels: [{ orgId: ORG, platform: 'slack', channelId: 'C1', agents: localAgents }],
    // A2A authorization reads the FLAT org directory, not channel membership, so a worker
    // that is not on this daemon ('wB' in the not_local case) must still be in the org.
    agents: [...localAgents, { agentId: 'wB', daemonId: 'other-daemon' }, { agentId: 'wA', daemonId: 'other-daemon' }]
      .map((a: any) => ({
        callPolicy: 'all',
        allowedCallerAgentIds: [],
        outboundPolicy: 'all',
        allowedTargetAgentIds: [],
        ...a,
        orgId: ORG
      }))
      // Local placements come first, so a local agent's real policy wins over the remote stub.
      .filter((a: any, i: number, all: any[]) => all.findIndex((b) => b.agentId === a.agentId) === i)
  })
  const calls: { agentId: string; msg: any; integrationId?: string; callMeta?: any }[] = []
  ;(daemon as any).dispatch = vi.fn(
    async (agentId: string, msg: any, integrationId?: string, _wc?: any, callMeta?: any) => {
      calls.push({ agentId, msg, integrationId, callMeta })
      return 'acp-1'
    }
  )
  return { daemon, calls }
}

const store = (daemon: any) => (daemon as any).store

const startReq = (over: Partial<StartOrchestrationReq> = {}): StartOrchestrationReq => ({
  mainAgentId: 'main',
  platform: 'slack',
  channel: 'C1',
  thread: 'T1',
  subtasks: [
    { toAgentId: 'wA', text: 'do A' },
    { toAgentId: 'wB', text: 'do B' }
  ],
  ...over
})

const ownerReq = (orchestrationId: string, over: Partial<OrchestrationOwnerReq> = {}): OrchestrationOwnerReq => ({
  mainAgentId: 'main',
  platform: 'slack',
  channel: 'C1',
  thread: 'T1',
  orchestrationId,
  ...over
})

/** Simulate a worker reporting back into the main's session via the §3.3 hook. */
async function report(daemon: any, correlationId: string, callFrom: string, text = 'result text') {
  const key = sessionKey('slack', 'C1', 'T1', 'main')
  await await (daemon as any).collab.recordWorkerReport(
    key,
    { callFrom, correlationId, hopCount: 1, deliveryId: 'd' },
    text
  )
}

describe('startOrchestration: record-first + per-subtask delivery', () => {
  it('persists all subtasks as pending BEFORE any delivery (record-first)', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon } = await boot(root)
    // Intercept messageAgent to assert the record already exists (subtasks pending) at the
    // moment of the FIRST delivery — a fast worker replying now would find its subtask.
    let sawRecordAtFirstDelivery: any[] | undefined
    let n = 0
    const orig = (daemon as any).collab.messageAgent.bind((daemon as any).collab)
    ;(daemon as any).collab.messageAgent = vi.fn(async (req: any) => {
      if (n++ === 0) {
        // the orchestrationId is embedded in the correlationId
        const oid = req.correlationId.slice(0, req.correlationId.lastIndexOf('.'))
        sawRecordAtFirstDelivery = await store(daemon).getSubtasks(oid)
      }
      return orig(req)
    })

    const res = await (daemon as any).collab.startOrchestration(startReq())
    expect(res.delivered).toHaveLength(2)
    expect(res.failed).toHaveLength(0)
    // Record existed with BOTH subtasks present at first delivery (one already sending).
    expect(sawRecordAtFirstDelivery).toHaveLength(2)
    const statuses = sawRecordAtFirstDelivery!.map((s: any) => s.status).sort()
    expect(statuses).toEqual(['pending', 'sending'])
    // After the run: both delivered.
    const subs = await store(daemon).getSubtasks(res.orchestrationId)
    expect(subs.map((s: any) => s.status)).toEqual(['delivered', 'delivered'])
    await daemon.stop()
  })

  it('marks an undeliverable subtask worker_error and still delivers the rest', async () => {
    const root = scaffold(['main', 'wA']) // wB is NOT local → not_local
    const { daemon } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq())
    expect(res.delivered).toEqual([`${res.orchestrationId}.0`])
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].correlationId).toBe(`${res.orchestrationId}.1`)
    const subs = await store(daemon).getSubtasks(res.orchestrationId)
    expect(subs[0].status).toBe('delivered')
    expect(subs[1].status).toBe('worker_error')
    await daemon.stop()
  })

  it('schedules a deadline when deadlineMs is given and something delivered', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq({ deadlineMs: 30_000 }))
    const orch = await store(daemon).getOrchestration(res.orchestrationId)
    expect(orch.deadline).toBeGreaterThan(Date.now())
    expect((daemon as any).collab.orchestrationDeadlines.has(res.orchestrationId)).toBe(true)
    await daemon.stop()
  })

  it('does NOT arm a deadline when every delivery failed', async () => {
    const root = scaffold(['main']) // both workers not local
    const { daemon } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq({ deadlineMs: 30_000 }))
    expect(res.delivered).toHaveLength(0)
    const orch = await store(daemon).getOrchestration(res.orchestrationId)
    expect(orch.deadline).toBeNull()
    expect((daemon as any).collab.orchestrationDeadlines.has(res.orchestrationId)).toBe(false)
    await daemon.stop()
  })
})

describe('correlation safety (§3.3): worker reports', () => {
  it('a valid report from the tasked worker marks the subtask succeeded + stores result', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq())
    await report(daemon, `${res.orchestrationId}.0`, 'wA', 'A is done')
    const subs = await store(daemon).getSubtasks(res.orchestrationId)
    expect(subs[0].status).toBe('succeeded')
    expect(subs[0].result).toBe('A is done')
    expect(subs[1].status).toBe('delivered') // untouched
    await daemon.stop()
  })

  it('drops a report whose callFrom is NOT the tasked worker', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq())
    // wB claims subtask .0 (tasked to wA) — dropped.
    await report(daemon, `${res.orchestrationId}.0`, 'wB', 'forged')
    expect((await store(daemon).getSubtasks(res.orchestrationId))[0].status).toBe('delivered')
    await daemon.stop()
  })

  it('drops a report for a correlationId belonging to another orchestration', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq())
    // Unknown orchestrationId prefix.
    await report(daemon, `00000000-0000-0000-0000-000000000000.0`, 'wA', 'x')
    expect((await store(daemon).getSubtasks(res.orchestrationId))[0].status).toBe('delivered')
    await daemon.stop()
  })

  it('drops a report arriving in a DIFFERENT (cross) session', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq())
    // Report arrives keyed to a different thread → session mismatch → dropped.
    const otherKey = sessionKey('slack', 'C1', 'OTHER', 'main')
    await (daemon as any).collab.recordWorkerReport(
      otherKey,
      { callFrom: 'wA', correlationId: `${res.orchestrationId}.0`, hopCount: 1, deliveryId: 'd' },
      'x'
    )
    expect((await store(daemon).getSubtasks(res.orchestrationId))[0].status).toBe('delivered')
    await daemon.stop()
  })

  it('is idempotent: a duplicate report does not overwrite / double-count', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq())
    await report(daemon, `${res.orchestrationId}.0`, 'wA', 'first')
    await report(daemon, `${res.orchestrationId}.0`, 'wA', 'second') // duplicate → no-op
    const sub = (await store(daemon).getSubtasks(res.orchestrationId))[0]
    expect(sub.status).toBe('succeeded')
    expect(sub.result).toBe('first')
    await daemon.stop()
  })
})

describe('completion + timeout', () => {
  it('N-of-N: all subtasks reported → all succeeded', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq())
    await report(daemon, `${res.orchestrationId}.0`, 'wA')
    await report(daemon, `${res.orchestrationId}.1`, 'wB')
    const subs = await store(daemon).getSubtasks(res.orchestrationId)
    expect(subs.every((s: any) => s.status === 'succeeded')).toBe(true)
    await daemon.stop()
  })

  it('a worker_error report counts as reported (delivery failure is terminal)', async () => {
    const root = scaffold(['main', 'wA']) // wB not local
    const { daemon } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq())
    const subs = await store(daemon).getSubtasks(res.orchestrationId)
    expect(subs[1].status).toBe('worker_error')
    expect(subs[1].deliveryReason).toBe('not_local')
    await daemon.stop()
  })

  it('deadline fire marks unreported subtasks timed_out and wakes the main session', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon, calls } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq({ deadlineMs: 30_000 }))
    await report(daemon, `${res.orchestrationId}.0`, 'wA') // only A reported
    calls.length = 0
    await (daemon as any).collab.fireOrchestrationDeadline(res.orchestrationId)
    const subs = await store(daemon).getSubtasks(res.orchestrationId)
    expect(subs[0].status).toBe('succeeded') // reported ones untouched
    expect(subs[1].status).toBe('timed_out') // unreported → timed_out
    // The main's session was woken by a DIRECT dispatch (agent source), not a platform post.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.agentId).toBe('main')
    expect(calls[0]!.msg.source).toBe('agent')
    expect(calls[0]!.msg.channel).toBe('C1')
    expect(calls[0]!.msg.thread).toBe('T1')
    await daemon.stop()
  })

  it('a late report AFTER timeout updates the summary (timed_out → succeeded)', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq({ deadlineMs: 30_000 }))
    await (daemon as any).collab.fireOrchestrationDeadline(res.orchestrationId)
    await report(daemon, `${res.orchestrationId}.1`, 'wB', 'late but done')
    const sub = (await store(daemon).getSubtasks(res.orchestrationId))[1]
    expect(sub.status).toBe('succeeded')
    expect(sub.result).toBe('late but done')
    await daemon.stop()
  })
})

describe('getOrchestration / cancelOrchestration owner checks', () => {
  it('owner reads its orchestration; a non-owner session/agent cannot', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq())
    expect(await (daemon as any).collab.getOrchestrationForOwner(ownerReq(res.orchestrationId))).not.toBeNull()
    // wrong agent
    expect(
      await (daemon as any).collab.getOrchestrationForOwner(ownerReq(res.orchestrationId, { mainAgentId: 'wA' }))
    ).toBeNull()
    // wrong session (thread)
    expect(
      await (daemon as any).collab.getOrchestrationForOwner(ownerReq(res.orchestrationId, { thread: 'OTHER' }))
    ).toBeNull()
    await daemon.stop()
  })

  it('cancel writes a cancelled tombstone (record kept) + is owner-checked + idempotent', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq({ deadlineMs: 30_000 }))
    // non-owner cannot cancel
    expect(
      await (daemon as any).collab.cancelOrchestrationForOwner(ownerReq(res.orchestrationId, { mainAgentId: 'wA' }))
    ).toBe(false)
    // owner cancels
    expect(await (daemon as any).collab.cancelOrchestrationForOwner(ownerReq(res.orchestrationId))).toBe(true)
    const orch = await store(daemon).getOrchestration(res.orchestrationId)
    expect(orch.status).toBe('cancelled') // tombstone, not deleted
    expect(orch.deadline).toBeNull()
    expect((daemon as any).collab.orchestrationDeadlines.has(res.orchestrationId)).toBe(false)
    // idempotent second cancel
    expect(await (daemon as any).collab.cancelOrchestrationForOwner(ownerReq(res.orchestrationId))).toBe(true)
    // a late report after cancellation is ignored (orchestration not active)
    await report(daemon, `${res.orchestrationId}.0`, 'wA', 'too late')
    expect((await store(daemon).getSubtasks(res.orchestrationId))[0].status).toBe('delivered')
    await daemon.stop()
  })
})

describe('end-to-end: worker reply auto-closes the loop (§6.7 auto-inherit)', () => {
  it('worker replies via messageAgent (no correlationId passed) → subtask succeeded, not timed_out', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon, calls } = await boot(root)
    // (1) main starts an orchestration; both subtasks are delivered to workers, each carrying
    // an explicit subtask correlationId in its (captured) callMeta.
    const res = await (daemon as any).collab.startOrchestration(startReq({ deadlineMs: 30_000 }))
    const cidA = `${res.orchestrationId}.0`
    // The subtask delivery to wA installed wA's inbound turn callMeta {callFrom: main, correlationId: cidA}.
    // With `dispatch` stubbed, replicate that install exactly as dispatchOne would (§6.7).
    const deliverToA = calls.find((c) => c.agentId === 'wA')!
    expect(deliverToA.callMeta).toMatchObject({ callFrom: 'main', correlationId: cidA })
    const wAKey = sessionKey('slack', 'C1', deliverToA.msg.thread ?? deliverToA.msg.msgId, 'wA')
    ;(daemon as any).activeTurnCallMeta.set(wAKey, deliverToA.callMeta)

    // (2) wA replies to main via the REAL messageAgent path, WITHOUT passing correlationId.
    calls.length = 0
    const reply = await (daemon as any).collab.messageAgent({
      callerAgentId: 'wA',
      platform: 'slack',
      callerChannel: 'C1',
      callerThread: deliverToA.msg.thread ?? deliverToA.msg.msgId,
      toAgentId: 'main',
      text: 'A finished',
      channel: 'C1',
      thread: 'T1'
    })
    expect(reply.delivered).toBe(true)
    // The reply auto-inherited the correlation back to main.
    const replyToMain = calls.find((c) => c.agentId === 'main')!
    expect(replyToMain.callMeta.correlationId).toBe(cidA)

    // (3) main's turn processes the reply: dispatchOne's §3.3 hook fires recordWorkerReport
    // with the reply's callMeta. Drive that step exactly as dispatchOne does.
    const mainKey = sessionKey('slack', 'C1', 'T1', 'main')
    await (daemon as any).collab.recordWorkerReport(mainKey, replyToMain.callMeta, replyToMain.msg.text)

    // (4) getOrchestration shows the subtask SUCCEEDED — the loop closed without a timeout.
    const subs = await store(daemon).getSubtasks(res.orchestrationId)
    expect(subs[0].status).toBe('succeeded')
    expect(subs[0].result).toContain('A finished')
    await daemon.stop()
  })
})

describe('startup re-arm', () => {
  it('re-arms an active orchestration deadline from the durable record on startup', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon } = await boot(root)
    const res = await (daemon as any).collab.startOrchestration(startReq({ deadlineMs: 60_000 }))
    await daemon.stop()

    // Fresh daemon over the SAME root/store → re-arm should re-schedule the deadline.
    const daemon2 = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost() as any })
    ;(daemon2 as any).__noop = true
    await daemon2.start()
    expect((daemon2 as any).collab.orchestrationDeadlines.has(res.orchestrationId)).toBe(true)
    await daemon2.stop()
  })
})

// #1036 — on a daemon pool every member shares one store, so every member could arm and fire the
// same deadline. Only the member holding the main agent's duty may wake it (a dispatch binds the
// agent's sandbox), and the fire itself is claimed through the store so a handoff fires once.
// Two daemons on one root, which EADDRINUSEs on Windows: a named pipe has no stale-UDS clear.
describe.skipIf(process.platform === 'win32')('pool duty gate on deadlines', () => {
  const GROUP = '11111111-1111-4111-8111-111111111111'
  const grant = (groupId = GROUP) => ({
    groupId,
    orgId: 'org-1',
    term: '1',
    members: [{ kind: 'agent' as const, refId: 'main' }]
  })
  const armed = (d: Daemon, id: string) => (d as any).collab.orchestrationDeadlines.has(id)

  /** Frame-scoped member: duty leases gate service, exactly like an install-wide pool member. */
  function frameScope(daemon: Daemon) {
    ;(daemon as any).cpClient = {
      organizationScope: () => 'frame',
      memberSet: () => ({ setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' }),
      stop: async () => {},
      releaseDuties: vi.fn(async () => {}),
      reportDutiesNow: vi.fn(() => {}),
      fetchDutyAgent: vi.fn()
    }
  }
  const hold = (d: Daemon) => (d as any).dutyCoordinator.settleDutyChange((d as any).duties.applyGrant([grant()]))
  const drop = (d: Daemon) => (d as any).dutyCoordinator.applyDutyRevoke([{ groupId: GROUP, reason: 'reassigned' }])

  /** Two members over ONE store: the same root, so both LocalStores open the same database. */
  async function bootPool() {
    const root = scaffold(['main', 'wA', 'wB'])
    const a = await boot(root)
    const b = await boot(root)
    frameScope(a.daemon)
    frameScope(b.daemon)
    return { a, b, stop: () => Promise.all([a.daemon.stop(), b.daemon.stop()]) }
  }

  it('only the duty holder arms and fires; a stale timer on a non-holder is refused', async () => {
    const { a, b, stop } = await bootPool()
    await hold(a.daemon)
    const res = await (a.daemon as any).collab.startOrchestration(startReq({ deadlineMs: 30_000 }))
    await (b.daemon as any).collab.syncOrchestrationDeadlines()
    expect(armed(a.daemon, res.orchestrationId)).toBe(true)
    expect(armed(b.daemon, res.orchestrationId)).toBe(false)
    a.calls.length = 0
    b.calls.length = 0
    // The non-holder's timer fires first (the pool has no ordering) — the duty gate drops it.
    await (b.daemon as any).collab.fireOrchestrationDeadline(res.orchestrationId)
    expect(b.calls).toHaveLength(0)
    expect((await store(b.daemon).getOrchestration(res.orchestrationId)).deadline).not.toBeNull()
    await (a.daemon as any).collab.fireOrchestrationDeadline(res.orchestrationId)
    expect(a.calls.map((c) => c.agentId)).toEqual(['main'])
    expect((await store(a.daemon).getOrchestration(res.orchestrationId)).deadline).toBeNull()
    expect((await store(a.daemon).getSubtasks(res.orchestrationId)).every((s: any) => s.status === 'timed_out')).toBe(
      true
    )
    await stop()
  })

  it('a deadline armed by one member fires on the member the duty moved to', async () => {
    const { a, b, stop } = await bootPool()
    await hold(a.daemon)
    const res = await (a.daemon as any).collab.startOrchestration(startReq({ deadlineMs: 30_000 }))
    expect(armed(a.daemon, res.orchestrationId)).toBe(true)
    await drop(a.daemon)
    await hold(b.daemon)
    expect(armed(a.daemon, res.orchestrationId)).toBe(false)
    expect(armed(b.daemon, res.orchestrationId)).toBe(true)
    a.calls.length = 0
    b.calls.length = 0
    await (a.daemon as any).collab.fireOrchestrationDeadline(res.orchestrationId)
    await (b.daemon as any).collab.fireOrchestrationDeadline(res.orchestrationId)
    expect(a.calls).toHaveLength(0)
    expect(b.calls.map((c) => c.agentId)).toEqual(['main'])
    await stop()
  })

  it('a fire during a handoff, when both members still hold the duty, wakes the main once', async () => {
    const { a, b, stop } = await bootPool()
    await hold(a.daemon)
    await hold(b.daemon)
    const res = await (a.daemon as any).collab.startOrchestration(startReq({ deadlineMs: 30_000 }))
    await (b.daemon as any).collab.syncOrchestrationDeadlines()
    expect(armed(b.daemon, res.orchestrationId)).toBe(true)
    a.calls.length = 0
    b.calls.length = 0
    await (a.daemon as any).collab.fireOrchestrationDeadline(res.orchestrationId)
    await (b.daemon as any).collab.fireOrchestrationDeadline(res.orchestrationId)
    expect(a.calls.length + b.calls.length).toBe(1)
    const orch = await store(a.daemon).getOrchestration(res.orchestrationId)
    expect(orch.status).toBe('active')
    expect(orch.deadline).toBeNull()
    await stop()
  })

  it('a machine-placed daemon holds no duties and still fires its own deadlines', async () => {
    const root = scaffold(['main', 'wA', 'wB'])
    const { daemon, calls } = await boot(root)
    ;(daemon as any).cpClient = { organizationScope: () => 'connection', stop: async () => {} }
    const res = await (daemon as any).collab.startOrchestration(startReq({ deadlineMs: 30_000 }))
    calls.length = 0
    await (daemon as any).collab.fireOrchestrationDeadline(res.orchestrationId)
    expect(calls.map((c) => c.agentId)).toEqual(['main'])
    await daemon.stop()
  })
})
