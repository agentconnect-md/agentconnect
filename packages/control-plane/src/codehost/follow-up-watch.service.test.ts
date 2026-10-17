import { describe, expect, it } from 'vitest'
import {
  FOLLOW_UP_WAKE_FEATURE,
  FOLLOW_UP_WATCH_MAX,
  type AssistantFollowUpWake,
  type AssistantFollowUpWakeResult,
  type FollowUpWatchTarget,
  type RcFollowUpWatch
} from '@agentconnect.md/protocol'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { AgentId, OrgId } from '../domain/ids.js'
import type {
  AgentRecord,
  FollowUpPendingWake,
  FollowUpWatchObject,
  FollowUpWatchRecord,
  FollowUpWatchRepo
} from '../persistence/ports.js'
import {
  DISCUSSION_MS,
  FollowUpWatchService,
  STATE_CAP_MS,
  STATE_QUIET_MS,
  foldWake,
  wakesFollowUp,
  type FollowUpWatchProvider
} from './follow-up-watch.service.js'

const NOW = 1_780_000_000_000
const ORG = OrgId('org-a')
const AGENT_A = AgentId('11111111-1111-4111-8111-111111111111')
const AGENT_B = AgentId('22222222-2222-4222-8222-222222222222')
const DAEMON = '33333333-3333-4333-8333-333333333333'
const REPO_ID = 456n

const agent = (id: AgentId): AgentRecord =>
  ({ id, orgId: ORG, placementKind: 'daemon', daemonId: DAEMON }) as unknown as AgentRecord
const target = (number: number, subject: 'pull' | 'issue' = 'pull'): FollowUpWatchTarget => ({
  provider: 'github',
  host: 'github.com',
  repoPath: 'example-org/example-repo',
  subject,
  number
})
const object = (number: number, subject: 'pull' | 'issue' = 'pull'): FollowUpWatchObject => ({
  orgId: ORG,
  provider: 'github',
  bindingId: '',
  repoId: REPO_ID,
  subject,
  number
})
const EMPTY: FollowUpPendingWake = {
  pendingSince: null,
  pendingStateSince: null,
  pendingLatestAt: null,
  pendingKinds: [],
  dueAt: null
}

const sameObject = (a: FollowUpWatchObject, b: FollowUpWatchObject) =>
  a.orgId === b.orgId &&
  a.provider === b.provider &&
  a.bindingId === b.bindingId &&
  a.repoId === b.repoId &&
  a.subject === b.subject &&
  a.number === b.number

/** The repository's contract in memory; the Postgres one is exercised by its integration test. */
class MemoryWatches implements FollowUpWatchRepo {
  rows: FollowUpWatchRecord[] = []
  receipts = new Set<string>()

  find(agentId: string, followUpId: string) {
    return this.rows.find((row) => row.agentId === agentId && row.followUpId === followUpId)
  }
  async listForAgent(agentId: AgentId) {
    return this.rows.filter((row) => row.agentId === agentId).map((row) => ({ ...row }))
  }
  async put(input: Parameters<FollowUpWatchRepo['put']>[0]) {
    const existing = this.find(input.agentId, input.followUpId)
    if (existing && sameObject(existing, input)) {
      Object.assign(existing, input, { endedReason: null })
      return
    }
    this.rows = this.rows.filter((row) => row !== existing)
    this.rows.push({
      ...input,
      generation: (existing?.generation ?? 0) + 1,
      wakeSeq: existing?.wakeSeq ?? 0,
      ...EMPTY,
      endedReason: null,
      lastWakeAt: null,
      lastWakeKinds: []
    })
  }
  async remove(agentId: AgentId, followUpIds: string[]) {
    const removed = this.rows.filter((row) => row.agentId === agentId && followUpIds.includes(row.followUpId))
    this.rows = this.rows.filter((row) => !removed.includes(row))
    return removed
  }
  async removeIf(row: FollowUpWatchRecord) {
    const current = this.find(row.agentId, row.followUpId)
    if (!current || current.generation !== row.generation) return false
    this.rows = this.rows.filter((candidate) => candidate !== current)
    return true
  }
  async forObject(o: FollowUpWatchObject) {
    return this.rows.filter((row) => sameObject(row, o) && !row.endedReason).map((row) => ({ ...row }))
  }
  async watched(o: FollowUpWatchObject) {
    return this.rows.some((row) => sameObject(row, o))
  }
  async receive(o: FollowUpWatchObject, deliveryKey: string) {
    const key = `${o.number}:${deliveryKey}`
    if (this.receipts.has(key)) return false
    this.receipts.add(key)
    return true
  }
  async fold(row: FollowUpWatchRecord, pending: FollowUpPendingWake) {
    const current = this.find(row.agentId, row.followUpId)
    if (!current || current.generation !== row.generation || current.wakeSeq !== row.wakeSeq || current.endedReason)
      return false
    Object.assign(current, pending, { wakeSeq: row.wakeSeq + 1 })
    return true
  }
  async claimNext(_owner: string, now: Date) {
    const row = this.rows.find((candidate) => candidate.dueAt !== null && candidate.dueAt <= now)
    return row ? { ...row } : null
  }
  async complete(row: FollowUpWatchRecord, _owner: string, at: Date) {
    const current = this.find(row.agentId, row.followUpId)
    if (!current || current.generation !== row.generation || current.wakeSeq !== row.wakeSeq) return
    Object.assign(current, EMPTY, { lastWakeAt: at, lastWakeKinds: row.pendingKinds })
  }
  async defer(row: FollowUpWatchRecord, _owner: string, nextAttemptAt: Date) {
    const current = this.find(row.agentId, row.followUpId)
    if (current?.generation === row.generation) current.dueAt = nextAttemptAt
  }
  async end(row: FollowUpWatchRecord, reason: 'access_lost', at: Date) {
    const current = this.find(row.agentId, row.followUpId)
    if (current?.generation !== row.generation) return false
    Object.assign(current, EMPTY, { endedReason: reason, dueAt: at })
    return true
  }
  async objects() {
    return this.rows.filter((row) => !row.endedReason)
  }
  async deleteExpiredReceipts() {
    return 0
  }
}

function harness(opts: { opener?: AgentId | null } = {}) {
  const clock = new FakeClock(NOW)
  const watches = new MemoryWatches()
  const sent: AssistantFollowUpWake[] = []
  const relayed: RcFollowUpWatch[] = []
  const state = {
    covers: true,
    features: [FOLLOW_UP_WAKE_FEATURE] as string[],
    answer: { accepted: true } as AssistantFollowUpWakeResult,
    resolve: undefined as undefined | ((t: FollowUpWatchTarget) => ReturnType<FollowUpWatchProvider['resolve']>)
  }
  const provider: FollowUpWatchProvider = {
    provider: 'github',
    resolve: async (_agent, t) =>
      state.resolve
        ? state.resolve(t)
        : {
            installationId: 99n,
            bindingId: '',
            host: 'github.com',
            repoId: REPO_ID,
            repoPath: 'example-org/example-repo',
            subject: t.subject,
            number: t.number
          },
    covers: async () => state.covers,
    relayWatch: (o, watched) => ({
      provider: 'github',
      installationId: String(o.installationId),
      repoId: String(o.repoId),
      subject: o.subject,
      number: o.number,
      watched
    })
  }
  const agents = new Map([AGENT_A, AGENT_B].map((id) => [id, agent(id)]))
  const service = new FollowUpWatchService({
    clock,
    watches,
    agents: { getUnscoped: async (id) => agents.get(AgentId(id)) ?? null },
    providers: [provider],
    opener: async () => opts.opener ?? null,
    placement: { dispatchDaemon: async () => DAEMON as never },
    daemon: () => ({ state: 'READY', capabilities: { features: state.features } }),
    send: async (_daemonId, request) => {
      sent.push(request)
      return state.answer
    },
    broadcast: (watch) => relayed.push(watch),
    log: { debug: () => {}, warn: () => {} }
  })
  const deliver = async () => {
    service.start()
    clock.advance(0)
    await service.settle()
    service.stop()
  }
  return { clock, watches, sent, relayed, state, service, deliver }
}

describe('foldWake', () => {
  const at = (ms: number) => new Date(NOW + ms)

  it('wakes a change of state after one quiet minute, at most ten after the first', () => {
    let pending = foldWake(EMPTY, 'merged', at(0))
    expect(pending.dueAt).toEqual(at(STATE_QUIET_MS))
    for (let minute = 1; minute <= 12; minute++) pending = foldWake(pending, 'checks', at(minute * 50_000))
    expect(pending.dueAt).toEqual(at(STATE_CAP_MS))
    expect(pending.pendingKinds).toEqual(['merged', 'checks'])
  })

  it('holds discussion 30 minutes from the first, and a change of state takes it along sooner', () => {
    let pending = foldWake(EMPTY, 'comment', at(0))
    pending = foldWake(pending, 'commits', at(20 * 60_000))
    expect(pending.dueAt).toEqual(at(DISCUSSION_MS))
    pending = foldWake(pending, 'approved', at(21 * 60_000))
    expect(pending.dueAt).toEqual(at(21 * 60_000 + STATE_QUIET_MS))
    expect(pending.pendingKinds).toEqual(['comment', 'commits', 'approved'])
    expect(pending.pendingSince).toEqual(at(0))
  })
})

describe('wakesFollowUp (who speaks)', () => {
  const rows: Array<[string, boolean, boolean]> = [
    ['changes_requested', true, false],
    ['checks', true, false],
    ['approved', true, false],
    ['approved', false, true],
    ['checks', false, true],
    ['merged', false, true],
    ['comment', true, false],
    ['commits', false, false]
  ]
  it.each(rows)("on the agent's own opened pull request, %s (feedback %s) wakes: %s", (kind, feedback, wakes) => {
    expect(wakesFollowUp({ kind: kind as never, feedback }, AGENT_A, AGENT_A)).toBe(wakes)
  })

  it('wakes on everything where no session of the agent opened it', () => {
    expect(wakesFollowUp({ kind: 'comment', feedback: true }, AGENT_A, null)).toBe(true)
    expect(wakesFollowUp({ kind: 'changes_requested', feedback: true }, AGENT_A, AGENT_B)).toBe(true)
  })
})

describe('FollowUpWatchService', () => {
  it('subscribes, tells the relays, and answers a re-sent watch without a second read', async () => {
    const h = harness()
    let reads = 0
    h.state.resolve = async (t) => {
      reads++
      return {
        installationId: 99n,
        bindingId: '',
        host: 'github.com',
        repoId: REPO_ID,
        repoPath: 'example-org/example-repo',
        subject: t.subject,
        number: t.number
      }
    }
    const first = await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [{ followUpId: 'f1', target: target(12) }]
    })
    expect(first.results).toEqual([
      {
        followUpId: 'f1',
        watched: { provider: 'github', repoPath: 'example-org/example-repo', subject: 'pull', number: 12 }
      }
    ])
    expect(h.relayed).toEqual([expect.objectContaining({ repoId: String(REPO_ID), number: 12, watched: true })])
    await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'full',
      watches: [{ followUpId: 'f1', target: target(12) }]
    })
    expect(reads).toBe(1)
  })

  it('moves a watch, unwatching the old object once nothing names it', async () => {
    const h = harness()
    await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [{ followUpId: 'f1', target: target(12, 'issue') }]
    })
    await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [{ followUpId: 'f1', target: target(13) }]
    })
    expect(h.relayed.map((w) => [w.subject, w.number, w.watched])).toEqual([
      ['issue', 12, true],
      ['issue', 12, false],
      ['pull', 13, true]
    ])
  })

  it('drops what a full set does not name, and a refused move leaves nothing watched', async () => {
    const h = harness()
    await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [
        { followUpId: 'f1', target: target(12) },
        { followUpId: 'f2', target: target(13) }
      ]
    })
    await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'full',
      watches: [{ followUpId: 'f1', target: target(12) }]
    })
    expect(h.watches.rows.map((row) => row.followUpId)).toEqual(['f1'])
    h.state.resolve = async () => 'no_access'
    const moved = await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [{ followUpId: 'f1', target: target(14) }]
    })
    expect(moved.results).toEqual([{ followUpId: 'f1', refused: 'no_access' }])
    expect(h.watches.rows).toEqual([])
  })

  it('refuses a host with no events here and an agent at its limit', async () => {
    const h = harness()
    const gitlab = { ...target(3), provider: 'gitlab' as const, host: 'gitlab.example.test' }
    const refused = await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [{ followUpId: 'g', target: gitlab }]
    })
    expect(refused.results).toEqual([{ followUpId: 'g', refused: 'unsupported' }])
    const full = Array.from({ length: FOLLOW_UP_WATCH_MAX }, (_, i) => ({ followUpId: `f${i}`, target: target(i + 1) }))
    await h.service.apply(agent(AGENT_A), { agentId: AGENT_A, mode: 'set', watches: full })
    const over = await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [{ followUpId: 'one-more', target: target(500) }]
    })
    expect(over.results).toEqual([{ followUpId: 'one-more', refused: 'limit' }])
  })

  it('folds an event into each watch, sends one body-free wake, and ignores a redelivery', async () => {
    const h = harness()
    await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [{ followUpId: 'f1', target: target(12) }]
    })
    const event = { object: object(12), deliveryKey: 'd1', kind: 'merged' as const, feedback: false }
    await h.service.receive(event)
    await h.service.receive(event)
    await h.service.receive({ ...event, deliveryKey: 'd2', kind: 'checks' })
    await h.deliver()
    expect(h.sent).toEqual([])
    h.clock.advance(STATE_QUIET_MS)
    await h.deliver()
    expect(h.sent).toEqual([
      {
        agentId: AGENT_A,
        followUpId: 'f1',
        subscription: 1,
        wakeId: 2,
        kinds: ['merged', 'checks'],
        latestAt: new Date(NOW).toISOString()
      }
    ])
    expect(h.watches.rows[0]).toMatchObject({ dueAt: null, pendingKinds: [], lastWakeKinds: ['merged', 'checks'] })
  })

  it("does not wake the opening agent's follow-up on its session's feedback, but wakes another agent's", async () => {
    const h = harness({ opener: AGENT_A })
    for (const id of [AGENT_A, AGENT_B]) {
      await h.service.apply(agent(id), {
        agentId: id,
        mode: 'set',
        watches: [{ followUpId: `f-${id}`, target: target(12) }]
      })
    }
    await h.service.receive({ object: object(12), deliveryKey: 'd1', kind: 'changes_requested', feedback: true })
    expect(h.watches.find(AGENT_A, `f-${AGENT_A}`)?.pendingKinds).toEqual([])
    expect(h.watches.find(AGENT_B, `f-${AGENT_B}`)?.pendingKinds).toEqual(['changes_requested'])
  })

  it('holds the wake while no daemon can take it', async () => {
    const h = harness()
    await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [{ followUpId: 'f1', target: target(12) }]
    })
    await h.service.receive({ object: object(12), deliveryKey: 'd1', kind: 'merged', feedback: false })
    h.clock.advance(STATE_QUIET_MS)
    h.state.features = []
    await h.deliver()
    h.state.features = [FOLLOW_UP_WAKE_FEATURE]
    h.state.answer = { accepted: false, reason: 'not_holder' }
    h.clock.advance(10_000)
    await h.deliver()
    expect(h.watches.rows[0]?.pendingKinds).toEqual(['merged'])
    h.state.answer = { accepted: true }
    h.clock.advance(10_000)
    await h.deliver()
    expect(h.sent.map((wake) => wake.wakeId)).toEqual([1, 1])
    expect(h.watches.rows[0]?.pendingKinds).toEqual([])
  })

  it('ends a watch whose access is gone with a notice instead of a wake', async () => {
    const h = harness()
    await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [{ followUpId: 'f1', target: target(12) }]
    })
    await h.service.receive({ object: object(12), deliveryKey: 'd1', kind: 'merged', feedback: false })
    h.clock.advance(STATE_QUIET_MS)
    h.state.covers = false
    await h.deliver()
    expect(h.sent).toEqual([
      { agentId: AGENT_A, followUpId: 'f1', subscription: 1, wakeId: 2, kinds: [], ended: 'access_lost' }
    ])
    expect(h.watches.rows).toEqual([])
    expect(h.relayed.at(-1)).toMatchObject({ number: 12, watched: false })
  })

  it('leaves a watch moved while a delivery of its old object was reading access', async () => {
    const h = harness()
    await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [{ followUpId: 'f1', target: target(12) }]
    })
    await h.service.receive({ object: object(12), deliveryKey: 'd1', kind: 'merged', feedback: false })
    h.clock.advance(STATE_QUIET_MS)
    h.state.covers = false
    const claimed = (await h.watches.claimNext('owner', new Date(NOW + STATE_QUIET_MS)))!
    // The move lands between the claim and the old object's failed access check.
    h.state.covers = true
    await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [{ followUpId: 'f1', target: target(13) }]
    })
    await expect(h.watches.end(claimed, 'access_lost', new Date(NOW))).resolves.toBe(false)
    await expect(h.watches.removeIf(claimed)).resolves.toBe(false)
    expect(h.watches.rows).toMatchObject([{ followUpId: 'f1', number: 13, endedReason: null }])
  })

  it("folds no event of a watch's old object into its new one", async () => {
    const h = harness()
    await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [{ followUpId: 'f1', target: target(12) }]
    })
    const [stale] = await h.watches.forObject(object(12))
    await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [{ followUpId: 'f1', target: target(13) }]
    })
    await expect(h.watches.fold(stale!, foldWake(stale!, 'merged', new Date(NOW)))).resolves.toBe(false)
    expect(h.watches.rows[0]).toMatchObject({ number: 13, pendingKinds: [] })
  })

  it('ends the subscription of a follow-up its daemon no longer has', async () => {
    const h = harness()
    await h.service.apply(agent(AGENT_A), {
      agentId: AGENT_A,
      mode: 'set',
      watches: [{ followUpId: 'f1', target: target(12) }]
    })
    await h.service.receive({ object: object(12), deliveryKey: 'd1', kind: 'closed', feedback: false })
    h.clock.advance(STATE_QUIET_MS)
    h.state.answer = { accepted: false, reason: 'not_found' }
    await h.deliver()
    expect(h.watches.rows).toEqual([])
  })
})
