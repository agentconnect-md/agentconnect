import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_REQUEST_DECLINE_MEMORY_MS,
  CAPABILITY_REQUEST_TTL_MS,
  CAPABILITY_REQUESTS_FEATURE,
  CAPABILITY_WAKE_GIVE_UP_MS,
  type CapabilityRequestReq,
  type SessionCapabilitySettled,
  type SessionCapabilitySettledResult
} from '@agentconnect.md/protocol'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { AgentId, OrgId } from '../domain/ids.js'
import type {
  AgentRecord,
  CapabilityRequestOriginRecord,
  CapabilityRequestRecord,
  CapabilityRequestRepo,
  CapabilitySettlement,
  NewCapabilityOrigin
} from '../persistence/ports.js'
import { CapabilityRequestService, wakeBackoffMs } from './capability-request.service.js'

const NOW = 1_780_000_000_000
const ORG = OrgId('org-a')
const AGENT = AgentId('11111111-1111-4111-8111-111111111111')
const DAEMON = '33333333-3333-4333-8333-333333333333'

/** An in-memory repo with the same compare-and-set semantics as the Postgres one. */
class MemoryRequests implements CapabilityRequestRepo {
  rows = new Map<string, CapabilityRequestRecord>()
  claims = new Map<string, string>()

  private copy(row: CapabilityRequestRecord | undefined): CapabilityRequestRecord | null {
    return row ? structuredClone(row) : null
  }
  async get(orgId: OrgId, id: string) {
    const row = this.rows.get(id)
    return row?.orgId === orgId ? this.copy(row) : null
  }
  async getForAgent(agentId: AgentId, id: string) {
    const row = this.rows.get(id)
    return row?.agentId === agentId ? this.copy(row) : null
  }
  async list(orgId: OrgId) {
    return [...this.rows.values()].filter((r) => r.orgId === orgId).map((r) => this.copy(r)!)
  }
  async open(agentId: AgentId, kind: string, target: string) {
    return this.copy(
      [...this.rows.values()].find(
        (r) => r.agentId === agentId && r.kind === kind && r.target === target && r.status === 'open'
      )
    )
  }
  async openForAgent(agentId: AgentId) {
    return [...this.rows.values()].filter((r) => r.agentId === agentId && r.status === 'open').map((r) => this.copy(r)!)
  }
  async declinedSince(agentId: AgentId, kind: string, target: string, since: Date) {
    return this.copy(
      [...this.rows.values()].find(
        (r) =>
          r.agentId === agentId &&
          r.kind === kind &&
          r.target === target &&
          r.status === 'declined' &&
          r.settledAt !== null &&
          r.settledAt >= since
      )
    )
  }
  async openForSession(sessionId: string) {
    return [...this.rows.values()].filter(
      (r) => r.status === 'open' && r.origins.some((o) => o.sessionId === sessionId)
    ).length
  }
  private origin(requestId: string, o: NewCapabilityOrigin, at: Date): CapabilityRequestOriginRecord {
    return {
      ...o,
      requestId,
      askedAt: at,
      wakeGeneration: 0,
      wakeState: 'none',
      wakeAttempts: 0,
      wakeReason: null,
      wakeSince: null,
      wakeDueAt: null
    }
  }
  async create(input: Parameters<CapabilityRequestRepo['create']>[0]) {
    if (await this.open(input.agentId, input.kind, input.target)) return null
    const { origin, ...rest } = input
    const row: CapabilityRequestRecord = {
      ...rest,
      generation: 1,
      status: 'open',
      outcome: null,
      differs: false,
      note: null,
      settledBy: null,
      settledAt: null,
      settledRevision: null,
      origins: [this.origin(input.id, origin, input.createdAt)]
    }
    this.rows.set(row.id, row)
    return this.copy(row)
  }
  async addOrigin(id: string, origin: NewCapabilityOrigin, at: Date) {
    const row = this.rows.get(id)
    if (row?.status !== 'open') return false
    if (!row.origins.some((o) => o.sessionId === origin.sessionId)) row.origins.push(this.origin(id, origin, at))
    return true
  }
  async withdrawOrigin(id: string, sessionId: string, at: Date) {
    const row = this.rows.get(id)
    if (row?.status !== 'open' || !row.origins.some((o) => o.sessionId === sessionId)) return null
    if (row.origins.length > 1) {
      row.origins = row.origins.filter((o) => o.sessionId !== sessionId)
      return 'left' as const
    }
    row.status = 'withdrawn'
    row.settledAt = at
    return 'withdrawn' as const
  }
  async settle(id: string, generation: number, s: CapabilitySettlement) {
    const row = this.rows.get(id)
    if (row?.status !== 'open' || row.generation !== generation) return false
    Object.assign(row, {
      status: s.status,
      outcome: s.outcome,
      differs: s.differs,
      note: s.note,
      settledBy: s.settledBy,
      settledAt: s.at,
      settledRevision: s.settledRevision
    })
    for (const o of row.origins)
      Object.assign(o, {
        wakeGeneration: generation,
        wakeState: 'pending',
        wakeAttempts: 0,
        wakeReason: null,
        wakeSince: s.at,
        wakeDueAt: s.at
      })
    return true
  }
  async reopen(id: string, generation: number, at: Date, expiresAt: Date) {
    const row = this.rows.get(id)
    if (row?.status !== 'declined' || row.generation !== generation) return null
    if (await this.open(row.agentId, row.kind, row.target)) return null
    Object.assign(row, {
      status: 'open',
      generation: generation + 1,
      outcome: null,
      note: null,
      settledBy: null,
      settledAt: null,
      createdAt: at,
      expiresAt
    })
    for (const o of row.origins) Object.assign(o, { wakeGeneration: generation + 1, wakeState: 'none' })
    return this.copy(row)
  }
  async expired(now: Date) {
    return [...this.rows.values()].filter((r) => r.status === 'open' && r.expiresAt <= now).map((r) => this.copy(r)!)
  }
  async claimWake(owner: string, now: Date) {
    for (const row of this.rows.values()) {
      for (const o of row.origins) {
        const key = `${row.id}:${o.sessionId}`
        if (o.wakeState !== 'pending' || !o.wakeDueAt || o.wakeDueAt > now || this.claims.has(key)) continue
        this.claims.set(key, owner)
        return { request: this.copy(row)!, origin: structuredClone(o) }
      }
    }
    return null
  }
  async finishWake(
    requestId: string,
    sessionId: string,
    owner: string,
    generation: number,
    next: Parameters<CapabilityRequestRepo['finishWake']>[4]
  ) {
    const key = `${requestId}:${sessionId}`
    if (this.claims.get(key) !== owner) return
    this.claims.delete(key)
    const o = this.rows.get(requestId)?.origins.find((x) => x.sessionId === sessionId)
    if (!o || o.wakeGeneration !== generation) return
    Object.assign(o, {
      wakeState: next.state,
      wakeReason: next.reason,
      wakeDueAt: next.dueAt,
      wakeAttempts: next.attempts
    })
  }
}

function harness(opts: { agent?: Partial<AgentRecord>; reply?: SessionCapabilitySettledResult } = {}) {
  const clock = new FakeClock(NOW)
  const requests = new MemoryRequests()
  let agent = {
    id: AGENT,
    orgId: ORG,
    name: 'helper',
    displayName: null,
    placementKind: 'daemon',
    daemonId: DAEMON,
    model: 'small',
    reasoningEffort: null,
    fastMode: null,
    outputMode: null,
    permissionMode: null,
    mcpServers: [],
    skills: [],
    runtime: 'claude-acp',
    configRevision: 1n,
    lastModifiedBy: null,
    ...opts.agent
  } as unknown as AgentRecord
  const sent: SessionCapabilitySettled[] = []
  let reply: SessionCapabilitySettledResult = opts.reply ?? { accepted: true }
  const service = new CapabilityRequestService({
    clock,
    requests,
    agents: { getUnscoped: async () => agent },
    mcpProviders: { listForOrg: async () => [{ name: 'Linear' }, { name: 'GitHub' }] as never },
    skillSources: { getByName: async (_org, name) => (name === 'acme' ? ({ name } as never) : null) },
    orgs: { slugById: async () => 'example-org' },
    webAppUrl: 'https://console.example.test/',
    placement: { dispatchDaemon: async () => DAEMON as never },
    daemon: () => ({ state: 'READY', capabilities: { features: [CAPABILITY_REQUESTS_FEATURE] } }),
    sendSettled: async (_d, _o, wake) => {
      sent.push(wake)
      return reply
    },
    sendReopened: async () => undefined,
    sendForward: async () => ({ delivered: true }),
    log: { debug: () => undefined, warn: () => undefined }
  })
  service.start()
  const pass = async () => {
    clock.advance(0)
    await service.settle()
  }
  return {
    clock,
    requests,
    service,
    sent,
    pass,
    setAgent: (patch: Partial<AgentRecord>) => (agent = { ...agent, ...patch } as AgentRecord),
    agent: () => agent,
    setReply: (next: SessionCapabilitySettledResult) => (reply = next)
  }
}

const ask = (sessionId: string, server = 'Linear'): CapabilityRequestReq => ({
  agentId: AGENT,
  sessionId,
  sessionKey: `slack:C1:${sessionId}`,
  ask: { kind: 'mcp-server', want: { server } },
  reason: 'filing the bug needs Linear',
  askers: {
    people: [{ kind: 'member', platform: 'slack', integrationId: 'i-1', userId: `U-${sessionId}` }],
    nobody: false
  },
  platform: 'slack'
})

describe('CapabilityRequestService', () => {
  it('opens a request with a console link, and joins a second conversation with its own askers', async () => {
    const h = harness()
    const first = await h.service.request(h.agent(), ask('s1'))
    expect(first).toMatchObject({ status: 'pending', generation: 1, summary: 'add the MCP server "Linear"' })
    expect(first.link).toBe(`https://console.example.test/example-org/requests/${first.requestId}`)
    expect(first.joined).toBeUndefined()
    const second = await h.service.request(h.agent(), ask('s2'))
    expect(second).toMatchObject({ status: 'pending', requestId: first.requestId, joined: true })
    const again = await h.service.request(h.agent(), ask('s1'))
    expect(again.requestId).toBe(first.requestId)
    expect(again.joined).toBeUndefined()
    const row = h.requests.rows.get(first.requestId!)!
    expect(row.origins.map((o) => o.askers.people[0])).toEqual([
      expect.objectContaining({ userId: 'U-s1' }),
      expect.objectContaining({ userId: 'U-s2' })
    ])
  })

  it('refuses unknown targets and answers already_satisfied from the current agent', async () => {
    const h = harness({ agent: { mcpServers: ['GitHub'] } })
    expect(await h.service.request(h.agent(), ask('s1', 'Jira'))).toMatchObject({
      status: 'refused',
      refused: 'unknown_target'
    })
    expect(await h.service.request(h.agent(), ask('s1', 'GitHub'))).toMatchObject({ status: 'already_satisfied' })
    expect(
      await h.service.request(h.agent(), { ...ask('s1'), ask: { kind: 'skill', want: { skill: 'other/lint' } } })
    ).toMatchObject({ status: 'refused', refused: 'unknown_target' })
  })

  it('caps one conversation at three open requests', async () => {
    const h = harness({ agent: { mcpServers: [] } })
    const settings = (field: object) => ({ ...ask('s1'), ask: { kind: 'agent-settings' as const, want: field } })
    expect((await h.service.request(h.agent(), ask('s1'))).status).toBe('pending')
    expect((await h.service.request(h.agent(), settings({ model: 'big' }))).status).toBe('pending')
    expect((await h.service.request(h.agent(), settings({ fastMode: true }))).status).toBe('pending')
    expect(await h.service.request(h.agent(), settings({ outputMode: 'low' }))).toMatchObject({
      status: 'refused',
      refused: 'limit'
    })
  })

  it('settles a chat decline once by generation, wakes every origin, and remembers it for a day', async () => {
    const h = harness()
    const { requestId } = await h.service.request(h.agent(), ask('s1'))
    await h.service.request(h.agent(), ask('s2'))
    const by = { kind: 'member' as const, platform: 'slack', integrationId: 'i-1', userId: 'U9', name: 'Ben' }
    expect(
      await h.service.decide(h.agent(), {
        agentId: AGENT,
        requestId: requestId!,
        generation: 2,
        decision: 'decline',
        by
      })
    ).toEqual({ result: 'already_settled' })
    expect(
      await h.service.decide(h.agent(), {
        agentId: AGENT,
        requestId: requestId!,
        generation: 1,
        decision: 'decline',
        by
      })
    ).toEqual({ result: 'settled' })
    expect(
      await h.service.decide(h.agent(), {
        agentId: AGENT,
        requestId: requestId!,
        generation: 1,
        decision: 'decline',
        by
      })
    ).toEqual({ result: 'already_settled' })
    await h.pass()
    expect(h.sent.map((w) => [w.sessionId, w.status, w.by?.name, w.askers.people[0]])).toEqual([
      ['s1', 'declined', 'Ben', expect.objectContaining({ userId: 'U-s1' })],
      ['s2', 'declined', 'Ben', expect.objectContaining({ userId: 'U-s2' })]
    ])
    expect(await h.service.request(h.agent(), ask('s3'))).toMatchObject({
      status: 'declined_recently',
      declined: { by: 'Ben' }
    })
    h.clock.advance(CAPABILITY_REQUEST_DECLINE_MEMORY_MS + 1)
    expect((await h.service.request(h.agent(), ask('s3'))).status).toBe('pending')
  })

  it('completes when a pushed change satisfies the request, and wakes only after a daemon applied it', async () => {
    const h = harness()
    const { requestId } = await h.service.request(h.agent(), ask('s1'))
    h.setAgent({
      mcpServers: ['Linear'],
      configRevision: 2n,
      lastModifiedBy: { userId: 'u-ana', displayName: 'Ana', email: 'ana@example.test' }
    })
    // Pushed but not acknowledged by any daemon: completed, wake held.
    await h.service.agentUpserted(h.agent(), [])
    expect(h.requests.rows.get(requestId!)!.status).toBe('completed')
    await h.pass()
    expect(h.sent).toEqual([])
    expect(h.requests.rows.get(requestId!)!.origins[0]!.wakeReason).toBe('awaiting_change')
    await h.service.agentUpserted(h.agent(), [DAEMON])
    h.clock.advance(10_000)
    await h.service.settle()
    expect(h.sent).toEqual([
      expect.objectContaining({
        status: 'completed',
        by: { name: 'Ana' },
        outcome: 'MCP server "Linear" was added to this agent. Its tools are available from this turn.',
        reload: false
      })
    ])
  })

  it('completes from the console with what was saved, even when it differs', async () => {
    const h = harness()
    const settings = { ...ask('s1'), ask: { kind: 'agent-settings' as const, want: { model: 'big' } } }
    const { requestId } = await h.service.request(h.agent(), settings)
    h.setAgent({ model: 'medium', configRevision: 2n })
    const done = await h.service.settleFromConsole(ORG, requestId!, { kind: 'console', userId: 'u-ana', name: 'Ana' })
    expect(done).toMatchObject({
      status: 'completed',
      differs: true,
      outcome: 'The model is "medium" (you asked for "big").'
    })
    // Settling again answers with the completed request rather than refusing (the save usually completed it already).
    expect(
      await h.service.settleFromConsole(ORG, requestId!, { kind: 'console', userId: 'u-ana', name: 'Ana' })
    ).toMatchObject({ status: 'completed', differs: true })
  })

  it('reopens a declined request with the next generation; an old card no longer counts', async () => {
    const h = harness()
    const { requestId } = await h.service.request(h.agent(), ask('s1'))
    await h.service.declineFromConsole(ORG, requestId!, { kind: 'console', userId: 'u', name: 'Ben' }, 'not now')
    const reopened = await h.service.reopen(ORG, requestId!)
    expect(reopened).toMatchObject({ status: 'open', generation: 2 })
    const by = { kind: 'console' as const, userId: 'u', name: 'Ben' }
    expect(
      await h.service.decide(h.agent(), {
        agentId: AGENT,
        requestId: requestId!,
        generation: 1,
        decision: 'decline',
        by
      })
    ).toEqual({ result: 'already_settled' })
    expect(await h.service.reopen(ORG, requestId!)).toBe('not_declined')
  })

  it('withdraws one origin, then the request, and wakes nobody', async () => {
    const h = harness()
    const { requestId } = await h.service.request(h.agent(), ask('s1'))
    await h.service.request(h.agent(), ask('s2'))
    expect(await h.service.withdraw(h.agent(), { agentId: AGENT, sessionId: 's9', requestId: requestId! })).toEqual({
      status: 'not_found'
    })
    expect(await h.service.withdraw(h.agent(), { agentId: AGENT, sessionId: 's1', requestId: requestId! })).toEqual({
      status: 'withdrawn'
    })
    expect(h.requests.rows.get(requestId!)!.status).toBe('open')
    expect(await h.service.withdraw(h.agent(), { agentId: AGENT, sessionId: 's2', requestId: requestId! })).toEqual({
      status: 'withdrawn'
    })
    expect(h.requests.rows.get(requestId!)!.status).toBe('withdrawn')
    await h.pass()
    expect(h.sent).toEqual([])
  })

  it('expires an untouched request after seven days and wakes its origin once', async () => {
    const h = harness()
    await h.service.request(h.agent(), ask('s1'))
    h.clock.advance(CAPABILITY_REQUEST_TTL_MS)
    await h.service.settle()
    h.service.kick()
    await h.pass()
    expect(h.sent.map((w) => w.status)).toEqual(['expired'])
    await h.pass()
    expect(h.sent).toHaveLength(1)
  })

  it('retries a deferred wake with backoff, marks not_found gone, and gives up after a day', async () => {
    const h = harness({ reply: { accepted: false, reason: 'busy' } })
    const { requestId } = await h.service.request(h.agent(), ask('s1'))
    await h.service.declineFromConsole(ORG, requestId!, { kind: 'console', userId: 'u', name: 'Ben' }, undefined)
    await h.pass()
    const origin = () => h.requests.rows.get(requestId!)!.origins[0]!
    expect(origin()).toMatchObject({ wakeState: 'pending', wakeReason: 'busy', wakeAttempts: 1 })
    expect(origin().wakeDueAt!.getTime()).toBe(h.clock.now() + wakeBackoffMs(1))
    h.clock.advance(CAPABILITY_WAKE_GIVE_UP_MS)
    await h.service.settle()
    expect(origin().wakeState).toBe('gone')

    const g = harness({ reply: { accepted: false, reason: 'not_found' } })
    const second = await g.service.request(g.agent(), ask('s1'))
    await g.service.declineFromConsole(ORG, second.requestId!, { kind: 'console', userId: 'u', name: 'Ben' }, undefined)
    await g.pass()
    expect(g.requests.rows.get(second.requestId!)!.origins[0]).toMatchObject({
      wakeState: 'gone',
      wakeReason: 'not_found'
    })
  })
})
