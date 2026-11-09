// Azure DevOps pull-request status projection (azure-devops-integration.md §11.7): state mapping, lifecycle edges, one POST per state change, fenced and reconciled writes.
import type { AzureDevOpsHookMetadata, CodeHostNoteState } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { AgentId, DaemonId, HookId, OrgId } from '../domain/ids.js'
import type {
  AgentRecord,
  AzureDevOpsConnectionRecord,
  AzureDevOpsRepositoryBindingRecord,
  CodeHostRunProjectionRecord,
  CodeHostRunProjectionWriterRepo,
  UpsertCodeHostRunProjectionInput
} from '../persistence/ports.js'
import { AzureDevOpsApiClient } from './api.js'
import {
  AzureDevOpsStatusCoordinator,
  AzureDevOpsStatusReporter,
  azureDevOpsProjectionSubject,
  azureDevOpsStatusSpec,
  type AzureDevOpsStatusEdge
} from './status-projection.js'

const NOW = 1_700_000_000_000
const hookId = HookId('00000000-0000-4000-8000-000000000001')
const agentId = AgentId('00000000-0000-4000-8000-000000000002')
const daemonId = DaemonId('00000000-0000-4000-8000-000000000003')
const orgId = OrgId('org_1')
const HEAD = 'a'.repeat(40)
const REPO = 41n
const PROJECT = '00000000-0000-4000-8000-0000000000a1'
const REPOSITORY = '00000000-0000-4000-8000-0000000000a2'
const IDENTITY = '00000000-0000-4000-8000-0000000000a3'
const BASE = 'https://dev.azure.example.test'
const PULL_URL = `${BASE}/example-org/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullRequests/12`

const snapshot = {
  configRevision: '3',
  dispatchRevision: '5',
  dispatchDaemonId: daemonId,
  reviewPolicy: 'full' as const,
  reportingMode: 'status' as const,
  gateMode: 'informational' as const
}

function azure(headSha: string | null = HEAD): AzureDevOpsHookMetadata {
  return {
    repoId: REPO.toString(),
    repoPath: 'example-org/Example Project/example-repo',
    organization: 'example-org',
    projectId: PROJECT,
    repositoryId: REPOSITORY,
    deliveryKind: 'opened',
    target: { kind: 'pull', pullRequestId: 12, ...(headSha ? { headSha } : {}) }
  }
}

function edge(overrides: Partial<AzureDevOpsStatusEdge> = {}): AzureDevOpsStatusEdge {
  return {
    hookId,
    agentId,
    deliveryKey: 'delivery-1',
    orgId,
    state: 'queued',
    azureDevOps: azure(),
    snapshot,
    at: new Date(NOW),
    ...overrides
  }
}

function projection(overrides: Partial<CodeHostRunProjectionRecord> = {}): CodeHostRunProjectionRecord {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    provider: 'azure-devops',
    hookId,
    orgId,
    agentId,
    agentName: 'reviewer',
    projectId: REPO,
    projectPath: 'example-org/Example Project/example-repo',
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
    reviewPolicySnapshot: 'full',
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
  projectId: PROJECT,
  repositoryId: REPOSITORY,
  repoPath: 'example-org/Example Project/example-repo',
  state: 'ready',
  createdAt: new Date(NOW)
} as unknown as AzureDevOpsRepositoryBindingRecord
const connection = {
  id: 'connection-1',
  orgId,
  organization: 'example-org',
  identityId: IDENTITY,
  credentialEpoch: 2n,
  state: 'connected'
} as unknown as AzureDevOpsConnectionRecord

describe('azureDevOpsStatusSpec (§11.7)', () => {
  it.each([
    ['queued', 'pending'],
    ['running', 'pending'],
    ['completed', 'succeeded'],
    ['failed', 'error'],
    ['interrupted', 'error'],
    ['skipped', 'succeeded'],
    ['superseded', 'succeeded']
  ] as Array<[CodeHostNoteState, string]>)('maps %s to %s and never to notApplicable', (state, expected) => {
    const spec = azureDevOpsStatusSpec(projection({ desiredState: state }))
    expect(spec.state).toBe(expected)
    expect(spec.state).not.toBe('notApplicable')
    expect(spec.context).toEqual({ genre: 'agentconnect', name: 'reviewer' })
    expect(spec.description.length).toBeLessThan(120)
  })

  it('names a normalized reason on a skipped or failed status, and drops anything else', () => {
    expect(azureDevOpsStatusSpec(projection({ desiredState: 'skipped', reason: 'daemon_offline' })).description).toBe(
      'AgentConnect review skipped (daemon_offline)'
    )
    expect(azureDevOpsStatusSpec(projection({ desiredState: 'failed', reason: 'Error: boom' })).description).toBe(
      'AgentConnect review failed'
    )
    const linked = azureDevOpsStatusSpec(projection({ agentName: null }), 'https://console.example.test/acme/s')
    expect(linked.context.name).toBe(agentId)
    expect(linked.targetUrl).toBe('https://console.example.test/acme/s')
  })

  it('projects only a headed pull request', () => {
    expect(azureDevOpsProjectionSubject(azure())).toEqual({
      projectId: REPO,
      projectPath: 'example-org/Example Project/example-repo',
      mergeRequestIid: 12,
      headSha: HEAD
    })
    expect(azureDevOpsProjectionSubject(azure(null))).toBeNull()
    expect(azureDevOpsProjectionSubject({ ...azure(), target: { kind: 'push', ref: 'refs/heads/main' } })).toBeNull()
  })
})

describe('AzureDevOpsStatusCoordinator', () => {
  function coordinator(row = projection(), turnStartedAt: Date | null = new Date(NOW)) {
    const projections = {
      upsert: vi.fn(async (_input: UpsertCodeHostRunProjectionInput) => row),
      setDesired: vi.fn(async () => true),
      supersede: vi.fn(async () => 0),
      getByNaturalKey: vi.fn(async (): Promise<CodeHostRunProjectionRecord | null> => row)
    }
    const kick = vi.fn()
    const service = new AzureDevOpsStatusCoordinator({
      projections,
      runs: { getRun: vi.fn(async () => ({ projectionEpoch: 1n, startedAt: new Date(NOW), turnStartedAt })) } as never,
      agents: { getUnscoped: vi.fn(async () => agent) },
      bindings: { listForRepo: vi.fn(async () => [binding]) },
      connections: { get: vi.fn(async () => connection) },
      clock: new FakeClock(NOW),
      kick
    })
    return { service, projections, kick }
  }

  it('opens queued with the connection epoch on the hooked binding, and moves running and terminal', async () => {
    const { service, projections, kick } = coordinator()
    await service.afterAccepted(edge())
    expect(projections.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'azure-devops',
        projectId: REPO,
        mergeRequestIid: 12,
        headSha: HEAD,
        desiredState: 'queued',
        credentialEpoch: 2n
      })
    )
    expect(kick).toHaveBeenCalledOnce()
    await service.afterStart(edge({ sessionId: 'session-1' }))
    expect(projections.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ desiredState: 'running' }))
    await service.afterReport(edge({ state: 'completed' }))
    expect(projections.setDesired).toHaveBeenLastCalledWith(
      expect.any(String),
      1n,
      'completed',
      new Date(NOW),
      undefined
    )
  })

  it('restates nothing for a turnless success on a head another delivery holds, or holds nothing on', async () => {
    const ignored = coordinator(projection({ currentDeliveryKey: 'review-delivery' }), null)
    await ignored.service.afterReport(edge({ state: 'completed', reason: 'review_request_not_for_identity' }))
    ignored.projections.getByNaturalKey.mockResolvedValueOnce(null)
    await ignored.service.afterReport(edge({ state: 'completed', reason: 'worktree_cleanup_no_session' }))
    expect(ignored.projections.upsert).not.toHaveBeenCalled()
    // A refusal is no success: it settles whatever the delivery queued.
    await ignored.service.afterReport(edge({ state: 'failed', reason: 'delivery_unresolved' }))
    expect(ignored.projections.upsert).toHaveBeenCalledWith(expect.objectContaining({ desiredState: 'failed' }))
  })

  it('settles its own queued status when the turn ran past a failed start barrier', async () => {
    const { service, projections } = coordinator(projection({ currentDeliveryKey: 'delivery-1' }), null)
    await service.afterReport(edge({ state: 'completed', sessionId: 'session-1' }))
    expect(projections.upsert).toHaveBeenCalledWith(expect.objectContaining({ desiredState: 'completed' }))
    expect(projections.setDesired).toHaveBeenLastCalledWith(
      expect.any(String),
      1n,
      'completed',
      new Date(NOW),
      undefined
    )
  })

  it('opens nothing for an update kind that names no head yet, or a hook that does not report a status', async () => {
    const { service, projections } = coordinator()
    await service.afterAccepted(edge({ azureDevOps: azure(null) }))
    await service.afterAccepted(edge({ snapshot: { ...snapshot, reportingMode: 'off' } }))
    expect(projections.upsert).not.toHaveBeenCalled()
  })
})

/** The writer ledger's rules the reporter leans on: claim, mutex, fenced settlement. */
class FakeLedger implements Pick<
  CodeHostRunProjectionWriterRepo,
  'claimDue' | 'beginWrite' | 'completeWrite' | 'retryWrite' | 'blockWrite' | 'settleWrite' | 'advancePending' | 'get'
> {
  readonly rows = new Map<string, CodeHostRunProjectionRecord>()

  constructor(...rows: CodeHostRunProjectionRecord[]) {
    for (const row of rows) this.rows.set(row.id, { ...row })
  }

  async claimDue(provider: string, leaseOwner: string, now: Date, leaseUntil: Date) {
    const claimed: CodeHostRunProjectionRecord[] = []
    for (const row of this.rows.values()) {
      if (row.provider !== provider || row.nextAttemptAt === null || row.nextAttemptAt > now) continue
      Object.assign(row, { leaseOwner, leaseUntil })
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
    writeMarker: string
    observedState: CodeHostNoteState
    noteId?: string
  }) {
    const row = this.rows.get(input.projectionId)
    if (!row || row.generation !== input.generation || row.writeMarker !== input.writeMarker) return false
    Object.assign(row, {
      observedState: input.observedState,
      noteId: input.noteId ?? row.noteId,
      writeMarker: null,
      writePhase: null,
      writeStartedAt: null,
      leaseOwner: null,
      nextAttemptAt: row.desiredState !== input.observedState ? new Date(0) : null
    })
    return true
  }

  async retryWrite(
    id: string,
    generation: bigint,
    _owner: string,
    nextAttemptAt: Date,
    errorCode: string,
    keepWriteMutex = false
  ) {
    const row = this.rows.get(id)
    if (!row || row.generation !== generation) return false
    Object.assign(row, { attempts: row.attempts + 1, lastErrorCode: errorCode, nextAttemptAt, leaseOwner: null })
    if (!keepWriteMutex) Object.assign(row, { writeMarker: null, writePhase: null, writeStartedAt: null })
    return true
  }

  async blockWrite(id: string, generation: bigint, errorCode: string) {
    const row = this.rows.get(id)
    if (!row || row.generation !== generation) return false
    Object.assign(row, { lastErrorCode: errorCode, nextAttemptAt: null, writeMarker: null, writePhase: null })
    return true
  }

  async settleWrite(id: string, generation: bigint) {
    const row = this.rows.get(id)
    if (!row || row.generation !== generation) return false
    Object.assign(row, { nextAttemptAt: null, leaseOwner: null })
    return true
  }

  async advancePending() {
    return null
  }

  async get(id: string) {
    const row = this.rows.get(id)
    return row ? { ...row } : null
  }
}

/** A fake Azure DevOps that appends a status per POST and lists them, with a switchable fault. */
function fakeAzure() {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
  const statuses: Array<Record<string, unknown>> = []
  let nextId = 0
  let fault: 'none' | 'network' | 'landed-but-lost' | 400 = 'none'
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    requests.push({ url, method, ...(body ? { body } : {}) })
    if (url.startsWith(`${PULL_URL}/iterations`)) {
      return Response.json({
        value: [
          { id: 1, sourceRefCommit: { commitId: 'b'.repeat(40) } },
          { id: 2, sourceRefCommit: { commitId: HEAD } }
        ]
      })
    }
    if (method === 'GET') return Response.json({ value: statuses, count: statuses.length })
    if (fault === 'network') throw new Error('socket hang up')
    if (fault === 400) return Response.json({ message: 'bad status' }, { status: 400 })
    const status = { id: ++nextId, ...body, createdBy: { id: IDENTITY } }
    statuses.push(status)
    if (fault === 'landed-but-lost') throw new Error('socket hang up')
    return Response.json(status)
  }
  return {
    api: new AzureDevOpsApiClient({ fetch: fetchImpl, devOpsBaseUrl: BASE }),
    statuses,
    posts: () => requests.filter((request) => request.method === 'POST'),
    setFault: (next: typeof fault) => void (fault = next)
  }
}

describe('AzureDevOpsStatusReporter', () => {
  function reporter(ledger: FakeLedger) {
    const azureDevOps = fakeAzure()
    const clock = new FakeClock(NOW)
    const service = new AzureDevOpsStatusReporter({
      projections: ledger,
      bindings: { listForRepo: vi.fn(async () => [binding]) },
      connections: { get: vi.fn(async () => connection) },
      service: { withApi: async (_connection, call) => call('azure-devops-token') },
      api: azureDevOps.api,
      orgs: { slugById: vi.fn(async () => 'acme') },
      clock,
      webAppUrl: 'https://console.example.test',
      workerId: 'worker-1'
    })
    return { service, azureDevOps, clock }
  }

  it('posts one status per state change, on the head’s iteration, with the Console link', async () => {
    const ledger = new FakeLedger(projection({ sessionId: 'session-1' }))
    const { service, azureDevOps } = reporter(ledger)
    await service.tick()
    expect(azureDevOps.posts()).toHaveLength(1)
    const [post] = azureDevOps.posts()
    expect(post!.url).toBe(`${PULL_URL}/statuses?api-version=7.1`)
    expect(post!.body).toEqual({
      state: 'pending',
      description: 'AgentConnect review queued',
      context: { genre: 'agentconnect', name: 'reviewer' },
      targetUrl: expect.stringMatching(
        /^https:\/\/console\.example\.test\/acme\/sessions\/session-1\?source=azure-devops&write=[0-9a-f-]{36}$/
      ),
      iterationId: 2
    })
    expect(ledger.rows.get(projection().id)).toMatchObject({ observedState: 'queued', noteId: '1', writeMarker: null })
    // The next state is a new entry, never an update of the old one.
    Object.assign(ledger.rows.get(projection().id)!, { desiredState: 'completed', nextAttemptAt: new Date(NOW) })
    await service.tick()
    expect(azureDevOps.posts().map((call) => call.body!.state)).toEqual(['pending', 'succeeded'])
    expect(azureDevOps.statuses).toHaveLength(2)
  })

  it('reconciles a lost answer by the entry it left, and never posts twice', async () => {
    const ledger = new FakeLedger(projection({ sessionId: 'session-1' }))
    const { service, azureDevOps, clock } = reporter(ledger)
    azureDevOps.setFault('landed-but-lost')
    await service.tick()
    expect(ledger.rows.get(projection().id)).toMatchObject({ lastErrorCode: 'ambiguous_write' })
    expect(ledger.rows.get(projection().id)!.writeMarker).not.toBeNull()
    azureDevOps.setFault('none')
    clock.advance(5_000)
    await service.tick()
    expect(azureDevOps.posts()).toHaveLength(1)
    expect(ledger.rows.get(projection().id)).toMatchObject({ observedState: 'queued', noteId: '1', writeMarker: null })
  })

  it('takes no other write’s status as proof: not another head’s, and not one without this write’s marker', async () => {
    const ledger = new FakeLedger(projection({ sessionId: 'session-1' }))
    const { service, azureDevOps, clock } = reporter(ledger)
    // Same agent, state and description, but another head's iteration and an earlier write's link.
    azureDevOps.statuses.push({
      id: 50,
      state: 'pending',
      description: 'AgentConnect review queued',
      context: { genre: 'agentconnect', name: 'reviewer' },
      targetUrl: 'https://console.example.test/acme/sessions/session-1?source=azure-devops&write=earlier',
      iterationId: 1,
      createdBy: { id: IDENTITY }
    })
    azureDevOps.setFault('network')
    await service.tick()
    azureDevOps.setFault('none')
    clock.advance(5_000)
    await service.tick()
    expect(ledger.rows.get(projection().id)).toMatchObject({ lastErrorCode: 'ambiguous_write' })
    expect(ledger.rows.get(projection().id)!.writeMarker).not.toBeNull()
    clock.advance(11 * 60_000)
    await service.tick()
    await service.tick()
    expect(azureDevOps.posts()).toHaveLength(2)
    expect(ledger.rows.get(projection().id)).toMatchObject({ observedState: 'queued', writeMarker: null })
  })

  it('posts again only once a lost write stayed absent past the grace window', async () => {
    const ledger = new FakeLedger(projection())
    const { service, azureDevOps, clock } = reporter(ledger)
    azureDevOps.setFault('network')
    await service.tick()
    azureDevOps.setFault('none')
    clock.advance(5_000)
    await service.tick()
    expect(azureDevOps.posts()).toHaveLength(1)
    clock.advance(11 * 60_000)
    await service.tick()
    expect(ledger.rows.get(projection().id)!.lastErrorCode).toBe('ambiguous_write_reissued')
    await service.tick()
    expect(azureDevOps.posts()).toHaveLength(2)
    expect(ledger.rows.get(projection().id)!.observedState).toBe('queued')
  })

  it('takes a received refusal as definite and leaves the due set', async () => {
    const ledger = new FakeLedger(projection())
    const { service, azureDevOps } = reporter(ledger)
    azureDevOps.setFault(400)
    await service.tick()
    expect(ledger.rows.get(projection().id)).toMatchObject({
      writeMarker: null,
      nextAttemptAt: null,
      lastErrorCode: 'invalid_request'
    })
  })
})
