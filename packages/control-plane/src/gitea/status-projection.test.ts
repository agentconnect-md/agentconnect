// Gitea commit-status projection (gitea-integration.md §10.4): state mapping, lifecycle edges, fenced and reconciled writes, token rejection.
import { randomUUID } from 'node:crypto'
import {
  HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
  type CodeHostNoteState,
  type GiteaHookMetadata
} from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { AgentId, DaemonId, HookId, OrgId } from '../domain/ids.js'
import type {
  AgentRecord,
  CodeHostRunProjectionRecord,
  CodeHostRunProjectionWriterRepo,
  GiteaConnectionRecord,
  GiteaRepositoryBindingRecord,
  UpsertCodeHostRunProjectionInput
} from '../persistence/ports.js'
import { GiteaApiClient } from './api.js'
import { GiteaConnectDenied } from './connection.service.js'
import {
  GiteaStatusCoordinator,
  GiteaStatusReporter,
  giteaProjectionSubject,
  giteaStatusSpec,
  type GiteaStatusEdge
} from './status-projection.js'

const NOW = 1_700_000_000_000
const hookId = HookId('00000000-0000-4000-8000-000000000001')
const agentId = AgentId('00000000-0000-4000-8000-000000000002')
const daemonId = DaemonId('00000000-0000-4000-8000-000000000003')
const orgId = OrgId('org_1')
const HEAD = 'a'.repeat(40)
const REPO = 556677n
const BOT = 9042n
const BASE = 'https://gitea.example.test'

const snapshot = {
  configRevision: '3',
  dispatchRevision: '5',
  dispatchDaemonId: daemonId,
  reviewPolicy: 'off' as const,
  reportingMode: 'status' as const,
  gateMode: 'informational' as const
}

function gitea(overrides: Partial<{ headSha: string; index: number }> = {}): GiteaHookMetadata {
  return {
    repoId: REPO.toString(),
    repoPath: 'example-org/example-repo',
    target: { kind: 'pull', index: overrides.index ?? 12, headSha: overrides.headSha ?? HEAD }
  }
}

function edge(overrides: Partial<GiteaStatusEdge> = {}): GiteaStatusEdge {
  return {
    hookId,
    agentId,
    deliveryKey: 'delivery-1',
    orgId,
    state: 'queued',
    gitea: gitea(),
    snapshot,
    at: new Date(NOW),
    ...overrides
  }
}

function projection(overrides: Partial<CodeHostRunProjectionRecord> = {}): CodeHostRunProjectionRecord {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    provider: 'gitea',
    hookId,
    orgId,
    agentId,
    agentName: 'reviewer',
    projectId: REPO,
    projectPath: 'example-org/example-repo',
    mergeRequestIid: 12,
    headSha: HEAD,
    projectionEpoch: 1n,
    generation: 1n,
    currentDeliveryKey: 'delivery-1',
    currentRunAt: new Date(NOW),
    externalId: '10000000-0000-4000-8000-000000000001',
    noteId: null,
    desiredState: 'queued',
    observedState: null,
    reason: null,
    sealedThrough: 0n,
    queuedAt: new Date(NOW),
    startedAt: null,
    completedAt: null,
    sessionId: null,
    credentialEpoch: 2n,
    configRevision: 3n,
    dispatchRevision: 5n,
    dispatchDaemonId: daemonId,
    reviewPolicySnapshot: 'off',
    reportingModeSnapshot: 'status',
    gateModeSnapshot: 'informational',
    leaseOwner: null,
    leaseUntil: null,
    nextAttemptAt: new Date(NOW),
    attempts: 0,
    lastErrorCode: null,
    pendingIntent: null,
    writeMarker: null,
    writePhase: null,
    writeStartedAt: null,
    tombstonedAt: null,
    updatedAt: new Date(NOW),
    ...overrides
  }
}

const agent = { id: agentId, orgId, name: 'reviewer' } as unknown as AgentRecord
const binding = {
  id: 'binding-1',
  orgId,
  connectionId: 'connection-1',
  repoId: REPO,
  repoPath: 'example-org/example-repo',
  state: 'ready'
} as unknown as GiteaRepositoryBindingRecord
const connection = {
  id: 'connection-1',
  orgId,
  botUserId: BOT,
  botUsername: 'example-bot',
  credentialEpoch: 2n,
  state: 'connected'
} as unknown as GiteaConnectionRecord

describe('giteaStatusSpec (§10.4)', () => {
  it.each([
    ['queued', 'pending'],
    ['running', 'pending'],
    ['completed', 'success'],
    ['failed', 'error'],
    ['interrupted', 'error'],
    ['skipped', 'success'],
    ['superseded', 'success']
  ] as Array<[CodeHostNoteState, string]>)('maps %s to %s and never to warning', (state, expected) => {
    const spec = giteaStatusSpec(projection({ desiredState: state }))
    expect(spec.state).toBe(expected)
    expect(spec.state).not.toBe('warning')
    expect(spec.context).toBe('agentconnect/reviewer')
    expect(spec.description.length).toBeLessThan(120)
    expect(spec.target_url).toBeUndefined()
  })

  it('names the normalized reason on a skipped or failed status, and drops anything else', () => {
    expect(giteaStatusSpec(projection({ desiredState: 'skipped', reason: 'daemon_offline' })).description).toBe(
      'AgentConnect review skipped (daemon_offline)'
    )
    expect(giteaStatusSpec(projection({ desiredState: 'failed', reason: 'session_start_failed' })).description).toBe(
      'AgentConnect review failed (session_start_failed)'
    )
    // A reason that is not a bounded code never reaches the provider.
    expect(giteaStatusSpec(projection({ desiredState: 'failed', reason: 'Error: boom at line 3' })).description).toBe(
      'AgentConnect review failed'
    )
    // Only the two reasoned states carry one.
    expect(giteaStatusSpec(projection({ desiredState: 'completed', reason: 'whatever' })).description).toBe(
      'AgentConnect review completed'
    )
  })

  it('carries the Console session link as target_url and falls back to the agent id for the context', () => {
    const spec = giteaStatusSpec(
      projection({ agentName: null }),
      'https://console.example.test/acme/sessions/s1?source=gitea'
    )
    expect(spec.context).toBe(`agentconnect/${agentId}`)
    expect(spec.target_url).toBe('https://console.example.test/acme/sessions/s1?source=gitea')
  })

  it('projects only a headed pull request', () => {
    expect(giteaProjectionSubject(gitea())).toEqual({
      projectId: REPO,
      projectPath: 'example-org/example-repo',
      mergeRequestIid: 12,
      headSha: HEAD
    })
    expect(giteaProjectionSubject({ ...gitea(), target: { kind: 'issue', index: 3 } })).toBeNull()
    expect(giteaProjectionSubject({ ...gitea(), target: { kind: 'pull', index: 12 } })).toBeNull()
    expect(giteaProjectionSubject(undefined)).toBeNull()
  })
})

describe('GiteaStatusCoordinator', () => {
  function coordinator(
    options: {
      row?: CodeHostRunProjectionRecord
      binding?: GiteaRepositoryBindingRecord | null
      runEpoch?: bigint | null
    } = {}
  ) {
    const row = options.row ?? projection()
    const projections = {
      upsert: vi.fn(async (_input: UpsertCodeHostRunProjectionInput) => row),
      setDesired: vi.fn(async () => true),
      supersede: vi.fn(async () => 0)
    }
    const kick = vi.fn()
    const service = new GiteaStatusCoordinator({
      projections,
      runs: {
        getRun: vi.fn(async () => ({
          projectionEpoch: options.runEpoch === undefined ? 1n : options.runEpoch,
          startedAt: new Date(NOW)
        }))
      } as never,
      agents: { getUnscoped: vi.fn(async () => agent) },
      bindings: { byRepo: vi.fn(async () => (options.binding === undefined ? binding : options.binding)) },
      connections: { get: vi.fn(async () => connection) },
      clock: new FakeClock(NOW),
      kick
    })
    return { service, projections, kick }
  }

  it('opens queued on an accepted delivery with the connection epoch and the accepted fence, and kicks the reporter', async () => {
    const { service, projections, kick } = coordinator()
    await service.afterAccepted(edge())
    // The row is established first, then older heads are preempted by the run's acceptance rank.
    expect(projections.supersede).toHaveBeenCalledWith(hookId, REPO, 12, HEAD, new Date(NOW), new Date(NOW))
    expect(projections.upsert.mock.invocationCallOrder[0]!).toBeLessThan(
      projections.supersede.mock.invocationCallOrder[0]!
    )
    expect(projections.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gitea',
        hookId,
        orgId,
        agentId,
        agentName: 'reviewer',
        projectId: REPO,
        projectPath: 'example-org/example-repo',
        mergeRequestIid: 12,
        headSha: HEAD,
        projectionEpoch: 1n,
        desiredState: 'queued',
        credentialEpoch: 2n,
        configRevision: 3n,
        dispatchRevision: 5n,
        dispatchDaemonId: daemonId,
        reportingModeSnapshot: 'status',
        queuedAt: new Date(NOW)
      })
    )
    expect(projections.setDesired).toHaveBeenCalledWith(projection().id, 1n, 'queued', new Date(NOW), undefined)
    expect(kick).toHaveBeenCalledOnce()
  })

  it('moves nothing for an edge whose row already belongs to a newer run of the same head', async () => {
    const { service, projections, kick } = coordinator({ row: { ...projection(), currentDeliveryKey: 'delivery-9' } })
    await service.afterReport(edge({ state: 'completed' }))
    expect(projections.upsert).toHaveBeenCalledOnce()
    expect(projections.supersede).not.toHaveBeenCalled()
    expect(projections.setDesired).not.toHaveBeenCalled()
    expect(kick).not.toHaveBeenCalled()
  })

  it('reads a delivery failure as skipped whatever kept the daemon away — the Control Plane writes', async () => {
    const { service, projections } = coordinator()
    await service.afterDeliveryFailed(edge({ reason: HOOK_DELIVERY_REASON_DAEMON_OFFLINE }))
    expect(projections.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        desiredState: 'skipped',
        reason: HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
        completedAt: new Date(NOW)
      })
    )
  })

  it('moves running on the start barrier with the session, and terminal on the report', async () => {
    const { service, projections } = coordinator()
    await service.afterStart(edge({ sessionId: 'session-1' }))
    expect(projections.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ desiredState: 'running', sessionId: 'session-1', startedAt: new Date(NOW) })
    )
    await service.afterReport(edge({ state: 'failed', reason: 'session_start_failed' }))
    expect(projections.setDesired).toHaveBeenLastCalledWith(
      expect.any(String),
      1n,
      'failed',
      new Date(NOW),
      'session_start_failed'
    )
  })

  it('opens nothing for reporting off, an issue, an incomplete fence, a retired run, or a missing binding', async () => {
    const cases: Array<[string, Partial<GiteaStatusEdge>, { binding?: null; runEpoch?: null }]> = [
      ['reporting off', { snapshot: { ...snapshot, reportingMode: 'off' } }, {}],
      ['issue subject', { gitea: { ...gitea(), target: { kind: 'issue', index: 3 } } }, {}],
      ['incomplete fence', { snapshot: { ...snapshot, dispatchDaemonId: undefined } }, {}],
      ['retired run', {}, { runEpoch: null }],
      ['no binding', {}, { binding: null }]
    ]
    for (const [, over, options] of cases) {
      const { service, projections } = coordinator(options)
      await service.afterAccepted(edge(over))
      expect(projections.upsert).not.toHaveBeenCalled()
    }
  })

  it('parks rather than moves the state while a write is in flight, and never touches a tombstone', async () => {
    const held = coordinator({ row: projection({ writePhase: 'create', writeMarker: randomUUID() }) })
    await held.service.afterStart(edge())
    expect(held.projections.setDesired).not.toHaveBeenCalled()
    expect(held.kick).not.toHaveBeenCalled()
    const dead = coordinator({ row: projection({ tombstonedAt: new Date(NOW) }) })
    await dead.service.afterStart(edge())
    expect(dead.projections.setDesired).not.toHaveBeenCalled()
  })
})

/** An in-memory writer ledger carrying the rules the reporter leans on: claim, mutex, fenced settlement. */
class FakeLedger implements Pick<
  CodeHostRunProjectionWriterRepo,
  'claimDue' | 'beginWrite' | 'completeWrite' | 'retryWrite' | 'blockWrite' | 'settleWrite' | 'advancePending' | 'get'
> {
  readonly rows = new Map<string, CodeHostRunProjectionRecord>()

  constructor(...rows: CodeHostRunProjectionRecord[]) {
    for (const row of rows) this.rows.set(row.id, { ...row })
  }

  async claimDue(
    provider: string,
    leaseOwner: string,
    now: Date,
    leaseUntil: Date
  ): Promise<CodeHostRunProjectionRecord[]> {
    const claimed: CodeHostRunProjectionRecord[] = []
    for (const row of this.rows.values()) {
      if (row.provider !== provider || row.nextAttemptAt === null || row.nextAttemptAt > now) continue
      if (row.leaseUntil !== null && row.leaseUntil >= now && row.leaseOwner !== leaseOwner) continue
      row.leaseOwner = leaseOwner
      row.leaseUntil = leaseUntil
      claimed.push({ ...row })
    }
    return claimed
  }

  async beginWrite(id: string, generation: bigint, leaseOwner: string, marker: string, phase: string, startedAt: Date) {
    const row = this.rows.get(id)
    if (!row || row.generation !== generation || row.writeMarker !== null) return false
    Object.assign(row, { leaseOwner, writeMarker: marker, writePhase: phase, writeStartedAt: startedAt })
    return true
  }

  async completeWrite(input: {
    projectionId: string
    generation: bigint
    leaseOwner: string
    writeMarker: string
    observedState: CodeHostNoteState
    noteId?: string
  }) {
    const row = this.rows.get(input.projectionId)
    if (
      !row ||
      row.generation !== input.generation ||
      row.leaseOwner !== input.leaseOwner ||
      row.writeMarker !== input.writeMarker
    )
      return false
    Object.assign(row, {
      observedState: input.observedState,
      noteId: input.noteId ?? row.noteId,
      writeMarker: null,
      writePhase: null,
      writeStartedAt: null,
      leaseOwner: null,
      leaseUntil: null,
      nextAttemptAt: row.pendingIntent !== null || row.desiredState !== input.observedState ? new Date(0) : null,
      attempts: 0,
      lastErrorCode: null
    })
    return true
  }

  async retryWrite(
    id: string,
    generation: bigint,
    leaseOwner: string,
    nextAttemptAt: Date,
    errorCode: string,
    keepWriteMutex = false
  ) {
    const row = this.rows.get(id)
    if (!row || row.generation !== generation || row.leaseOwner !== leaseOwner) return false
    Object.assign(row, {
      attempts: row.attempts + 1,
      lastErrorCode: errorCode,
      nextAttemptAt,
      leaseOwner: null,
      leaseUntil: null
    })
    if (!keepWriteMutex) Object.assign(row, { writeMarker: null, writePhase: null, writeStartedAt: null })
    return true
  }

  async blockWrite(id: string, generation: bigint, errorCode: string, keepWriteMutex = false) {
    const row = this.rows.get(id)
    if (!row || row.generation !== generation) return false
    Object.assign(row, { lastErrorCode: errorCode, nextAttemptAt: null, leaseOwner: null, leaseUntil: null })
    if (!keepWriteMutex) Object.assign(row, { writeMarker: null, writePhase: null, writeStartedAt: null })
    return true
  }

  async settleWrite(id: string, generation: bigint, leaseOwner: string) {
    const row = this.rows.get(id)
    if (!row || row.generation !== generation || row.leaseOwner !== leaseOwner) return false
    Object.assign(row, { nextAttemptAt: null, leaseOwner: null, leaseUntil: null, lastErrorCode: null, attempts: 0 })
    return true
  }

  async advancePending(id: string, generation: bigint) {
    const row = this.rows.get(id)
    if (!row || row.generation !== generation || row.writeMarker !== null || row.pendingIntent === null) return null
    const pending = row.pendingIntent as { desiredState: CodeHostNoteState }
    Object.assign(row, {
      generation: generation + 1n,
      desiredState: pending.desiredState,
      observedState: null,
      pendingIntent: null,
      nextAttemptAt: new Date(0)
    })
    return { ...row }
  }

  async get(id: string) {
    const row = this.rows.get(id)
    return row ? { ...row } : null
  }
}

interface Posted {
  url: string
  method: string
  body?: Record<string, unknown>
}

/** A fake Gitea edge that appends statuses and lists them newest-first, with a switchable fault per request. */
function fakeGitea() {
  const posted: Posted[] = []
  const statuses: Array<Record<string, unknown>> = []
  let nextId = 500
  let fault: 'none' | 'network' | 'landed-but-lost' | 401 | 422 | 500 = 'none'
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    posted.push({ url, method, ...(body ? { body } : {}) })
    if (method === 'POST') {
      if (fault === 'network') throw new Error('socket hang up')
      if (fault === 500) return Response.json({ message: 'internal' }, { status: 500 })
      if (fault === 401) return Response.json({ message: 'token is required' }, { status: 401 })
      if (fault === 422) return Response.json({ message: 'sha is not a valid commit' }, { status: 422 })
      const status = {
        id: ++nextId,
        status: body?.state,
        context: body?.context,
        description: body?.description,
        target_url: body?.target_url ?? '',
        creator: { id: Number(BOT) }
      }
      statuses.push(status)
      if (fault === 'landed-but-lost') throw new Error('socket hang up')
      return Response.json(status, { status: 201 })
    }
    return Response.json([...statuses].reverse(), { headers: { 'x-total-count': String(statuses.length) } })
  }
  return {
    api: new GiteaApiClient(BASE, fetchImpl),
    posted,
    statuses,
    posts: () => posted.filter((call) => call.method === 'POST'),
    setFault: (next: typeof fault) => void (fault = next)
  }
}

describe('GiteaStatusReporter', () => {
  function reporter(ledger: FakeLedger, options: { tokenRejected?: boolean; webAppUrl?: string } = {}) {
    const gitea = fakeGitea()
    const clock = new FakeClock(NOW)
    const onAuthRejected = vi.fn(async () => {})
    const service = new GiteaStatusReporter({
      projections: ledger,
      bindings: { byRepo: vi.fn(async () => binding) },
      connections: { get: vi.fn(async () => connection) },
      tokens: {
        withToken: vi.fn(async () => {
          if (options.tokenRejected)
            throw new GiteaConnectDenied('the Gitea token was rejected — replace it', 409, 'token_rejected')
          return 'gitea-token-1'
        }),
        onAuthRejected
      },
      orgs: { slugById: vi.fn(async () => 'acme') },
      api: gitea.api,
      clock,
      workerId: 'worker-1',
      ...(options.webAppUrl ? { webAppUrl: options.webAppUrl } : {})
    })
    return { service, gitea, clock, onAuthRejected }
  }

  it('writes one status under a marker and settles the generation against the status id', async () => {
    const ledger = new FakeLedger(projection({ sessionId: 'session-1' }))
    const { service, gitea } = reporter(ledger, { webAppUrl: 'https://console.example.test' })
    await service.tick()
    expect(gitea.posts()).toHaveLength(1)
    const [post] = gitea.posts()
    expect(post!.url).toBe(`${BASE}/api/v1/repos/example-org/example-repo/statuses/${HEAD}`)
    expect(post!.body).toEqual({
      context: 'agentconnect/reviewer',
      state: 'pending',
      description: 'AgentConnect review queued',
      target_url: 'https://console.example.test/acme/sessions/session-1?source=gitea'
    })
    const row = (await ledger.get(projection().id))!
    expect(row).toMatchObject({
      observedState: 'queued',
      noteId: '501',
      writeMarker: null,
      leaseOwner: null,
      nextAttemptAt: null
    })
  })

  it('never replays an ambiguous write: the marker is held, then the landed status is reconciled by content', async () => {
    const ledger = new FakeLedger(projection({ desiredState: 'running', observedState: 'queued', noteId: '400' }))
    const { service, gitea, clock } = reporter(ledger)
    gitea.setFault('landed-but-lost')
    await service.tick()
    expect(gitea.posts()).toHaveLength(1)
    let row = (await ledger.get(projection().id))!
    expect(row.writeMarker).not.toBeNull()
    expect(row.observedState).toBe('queued')
    expect(row.lastErrorCode).toBe('ambiguous_write')

    // The retry pass reads the commit's statuses and finds the newer row that says exactly what it sent.
    gitea.setFault('none')
    clock.advance(5_000)
    await service.tick()
    expect(gitea.posts()).toHaveLength(1)
    row = (await ledger.get(projection().id))!
    expect(row).toMatchObject({ observedState: 'running', noteId: '501', writeMarker: null, nextAttemptAt: null })
  })

  it('reissues an ambiguous write only once its absence has outlived the grace window', async () => {
    const ledger = new FakeLedger(projection())
    const { service, gitea, clock } = reporter(ledger)
    gitea.setFault('network')
    await service.tick()
    expect(gitea.posts()).toHaveLength(1)
    gitea.setFault('none')
    // Inside the window the marker holds and nothing is written again.
    clock.advance(5_000)
    await service.tick()
    expect(gitea.posts()).toHaveLength(1)
    expect((await ledger.get(projection().id))!.writeMarker).not.toBeNull()
    // Past it, absence proves the request never reached Gitea: the mutex is released and the next pass writes.
    clock.advance(11 * 60_000)
    await service.tick()
    expect((await ledger.get(projection().id))!.lastErrorCode).toBe('ambiguous_write_reissued')
    await service.tick()
    expect(gitea.posts()).toHaveLength(2)
    expect((await ledger.get(projection().id))!.observedState).toBe('queued')
  })

  it('treats a 5xx like a lost reply and a 4xx as a definite refusal', async () => {
    const ledger = new FakeLedger(
      projection({ id: 'a'.repeat(8) + '-0000-4000-8000-000000000001' }),
      projection({ id: 'b'.repeat(8) + '-0000-4000-8000-000000000002', headSha: 'c'.repeat(40) })
    )
    const { service, gitea } = reporter(ledger)
    gitea.setFault(500)
    await service.tick()
    for (const row of ledger.rows.values()) {
      expect(row.writeMarker).not.toBeNull()
      expect(row.lastErrorCode).toBe('ambiguous_write')
    }
    const refused = new FakeLedger(projection())
    const second = reporter(refused)
    second.gitea.setFault(422)
    await second.service.tick()
    expect((await refused.get(projection().id))!).toMatchObject({
      writeMarker: null,
      nextAttemptAt: null,
      lastErrorCode: 'validation'
    })
  })

  it('feeds a rejected token into the connection path and waits for the replacement without losing the row', async () => {
    const ledger = new FakeLedger(projection())
    const { service, gitea, onAuthRejected } = reporter(ledger)
    gitea.setFault(401)
    await service.tick()
    expect(onAuthRejected).toHaveBeenCalledWith(orgId, 'connection-1')
    const row = (await ledger.get(projection().id))!
    // A received 401 is a definite non-effect: no marker is held, the row stays due.
    expect(row).toMatchObject({ writeMarker: null, lastErrorCode: 'token_rejected', observedState: null })
    expect(row.nextAttemptAt).not.toBeNull()

    // While the connection refuses to hand out its token, the row is retried — nothing is written.
    const waiting = reporter(new FakeLedger(projection()), { tokenRejected: true })
    await waiting.service.tick()
    expect(waiting.gitea.posts()).toHaveLength(0)
  })

  it('resolves a status a removed hook left pending, and mints nothing for a terminal or never-written one', async () => {
    const pendingRow = projection({
      id: '1'.repeat(8) + '-0000-4000-8000-000000000001',
      desiredState: 'skipped',
      observedState: 'running',
      noteId: '300',
      tombstonedAt: new Date(NOW)
    })
    const terminalRow = projection({
      id: '2'.repeat(8) + '-0000-4000-8000-000000000002',
      headSha: 'd'.repeat(40),
      desiredState: 'skipped',
      observedState: 'completed',
      noteId: '301',
      tombstonedAt: new Date(NOW)
    })
    const neverRow = projection({
      id: '3'.repeat(8) + '-0000-4000-8000-000000000003',
      headSha: 'e'.repeat(40),
      desiredState: 'skipped',
      observedState: null,
      tombstonedAt: new Date(NOW)
    })
    const ledger = new FakeLedger(pendingRow, terminalRow, neverRow)
    const { service, gitea } = reporter(ledger)
    await service.tick()
    expect(gitea.posts()).toHaveLength(1)
    expect(gitea.posts()[0]!.body).toMatchObject({ state: 'success', description: 'AgentConnect review skipped' })
    expect((await ledger.get(pendingRow.id))!.observedState).toBe('skipped')
    expect((await ledger.get(terminalRow.id))!).toMatchObject({
      observedState: 'completed',
      nextAttemptAt: null,
      lastErrorCode: 'cleanup_not_needed'
    })
    expect((await ledger.get(neverRow.id))!).toMatchObject({ observedState: null, nextAttemptAt: null })
  })

  it('leaves a settled row out of the due set and drains a parked edge into its own generation', async () => {
    const settledRow = projection({
      id: '4'.repeat(8) + '-0000-4000-8000-000000000004',
      observedState: 'queued',
      noteId: '300'
    })
    const parkedRow = projection({
      id: '5'.repeat(8) + '-0000-4000-8000-000000000005',
      headSha: 'f'.repeat(40),
      observedState: 'queued',
      noteId: '301',
      pendingIntent: { desiredState: 'completed' }
    })
    const ledger = new FakeLedger(settledRow, parkedRow)
    const { service, gitea } = reporter(ledger)
    await service.tick()
    expect((await ledger.get(settledRow.id))!.nextAttemptAt).toBeNull()
    const drained = (await ledger.get(parkedRow.id))!
    expect(drained).toMatchObject({ generation: 2n, desiredState: 'completed', observedState: 'completed' })
    expect(gitea.posts().map((post) => post.body!.state)).toEqual(['success'])
  })
})
