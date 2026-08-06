import { describe, expect, it, vi } from 'vitest'
import type { RcGithubRerequest } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, HookId, OrgId } from '../domain/ids.js'
import type { HookRecord, HookRepo, HookReviewProjectionRecord, HookRunRecord } from '../persistence/ports.js'
import { GithubRerequestService } from './rerequest.service.js'

const HOOK_ID = HookId('88888888-8888-4888-8888-888888888888')
const AGENT_ID = AgentId('33333333-3333-4333-8333-333333333333')
const DAEMON_ID = DaemonId('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
const HEAD_SHA = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)
const CHECK_RUN_ID = '86617583005'
const REPO_ID = 987654321n
const APP_ID = 4157507
const INSTALLATION_ID = 1234567n

const request: RcGithubRerequest = {
  checkRunId: CHECK_RUN_ID,
  repoId: REPO_ID.toString(),
  headSha: HEAD_SHA,
  deliveryKey: 'delivery-rerun-1',
  includeBaseSha: true
}
const suiteRequest: RcGithubRerequest = {
  scope: 'suite',
  appId: String(APP_ID),
  installationId: String(INSTALLATION_ID),
  repoId: REPO_ID.toString(),
  headSha: HEAD_SHA,
  deliveryKey: 'delivery-suite-rerun-1'
}

function projection(overrides: Partial<HookReviewProjectionRecord> = {}): HookReviewProjectionRecord {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    hookId: HOOK_ID,
    orgId: OrgId('org-a'),
    agentId: AGENT_ID,
    agentName: 'review-bot',
    lastResolvedInstallationId: INSTALLATION_ID,
    repoId: REPO_ID,
    repoFullName: 'acme/infra',
    headSha: HEAD_SHA,
    reportSha: HEAD_SHA,
    projectionEpoch: 2n,
    generation: 3n,
    currentHookRunId: 'run-1',
    externalId: 'projection-external-id',
    checkRunId: CHECK_RUN_ID,
    mode: 'check',
    gateMode: 'informational',
    desiredState: 'failure',
    observedState: 'failure',
    sealedThrough: 3n,
    subjectSyncGeneration: 3n,
    subjectSyncErrorCode: null,
    leaseOwner: null,
    leaseUntil: null,
    nextAttemptAt: null,
    attempts: 0,
    lastErrorCode: null,
    pendingIntent: null,
    writeMarker: null,
    writePhase: null,
    writeStartedAt: null,
    tombstonedAt: null,
    updatedAt: new Date(0),
    ...overrides
  }
}

function hook(overrides: Partial<HookRecord> = {}): HookRecord {
  return {
    id: HOOK_ID,
    orgId: OrgId('org-a'),
    agentId: AGENT_ID,
    kind: 'github',
    enabled: true,
    repoId: REPO_ID,
    reportingMode: 'check',
    gateMode: 'informational',
    projectionEpoch: 2n,
    configRevision: 7n,
    dispatchRevision: 9n,
    ...overrides
  } as HookRecord
}

function run(overrides: Partial<HookRunRecord> = {}): HookRunRecord {
  return {
    id: 'run-1',
    hookId: HOOK_ID,
    deliveryKey: 'delivery-original',
    event: 'pull_request:opened',
    agentId: AGENT_ID,
    configRevision: 6n,
    dispatchRevision: 8n,
    projectionEpoch: 2n,
    dispatchDaemonId: DAEMON_ID,
    reviewPolicySnapshot: 'full',
    reportingModeSnapshot: 'check',
    gateModeSnapshot: 'informational',
    projectionIntent: 'revision_event',
    repoId: REPO_ID,
    repoFullName: 'acme/infra',
    sourceInstallationId: INSTALLATION_ID,
    subjectKind: 'pull_request',
    pullNumber: 585,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    reportSha: HEAD_SHA,
    isDraft: false,
    baseChanged: false,
    projectionId: projection().id,
    projectionGeneration: 3n,
    status: 'failed',
    ...overrides
  } as HookRunRecord
}

function make(
  opts: {
    projection?: HookReviewProjectionRecord | null
    hook?: HookRecord | null
    run?: HookRunRecord | null
  } = {}
) {
  const findReviewProjectionByCheckRunId = vi.fn(async () =>
    opts.projection === undefined ? projection() : opts.projection
  )
  const listReviewProjectionsForSuiteRerequest = vi.fn(async () => {
    const candidate = opts.projection === undefined ? projection() : opts.projection
    return candidate ? [candidate] : []
  })
  const get = vi.fn(async () => (opts.hook === undefined ? hook() : opts.hook))
  const getMany = vi.fn(async () => {
    const candidate = opts.hook === undefined ? hook() : opts.hook
    return candidate ? [candidate] : []
  })
  const getRunById = vi.fn(async () => (opts.run === undefined ? run() : opts.run))
  const service = new GithubRerequestService({
    hooks: {
      findReviewProjectionByCheckRunId,
      listReviewProjectionsForSuiteRerequest,
      getUnscoped: get,
      getManyUnscoped: getMany,
      getRunById
    } as Pick<
      HookRepo,
      | 'findReviewProjectionByCheckRunId'
      | 'listReviewProjectionsForSuiteRerequest'
      | 'getUnscoped'
      | 'getManyUnscoped'
      | 'getRunById'
    >,
    appId: APP_ID
  })
  return {
    service,
    findReviewProjectionByCheckRunId,
    listReviewProjectionsForSuiteRerequest,
    get,
    getMany,
    getRunById
  }
}

describe('GithubRerequestService', () => {
  it('resolves an App-owned terminal informational Check to the current hook and PR', async () => {
    await expect(make().service.resolve(request)).resolves.toEqual({
      allowed: true,
      hookId: HOOK_ID,
      pullNumber: 585,
      baseSha: BASE_SHA,
      configRevision: '7',
      dispatchRevision: '9'
    })
  })

  it('keeps replies compatible when an older relay does not request the stored base SHA', async () => {
    const { includeBaseSha: _, ...legacyRequest } = request
    await expect(make().service.resolve(legacyRequest)).resolves.toEqual({
      allowed: true,
      hookId: HOOK_ID,
      pullNumber: 585,
      configRevision: '7',
      dispatchRevision: '9'
    })
  })

  it('resolves an App-owned Check Suite to its current projection targets', async () => {
    const h = make()
    await expect(h.service.resolve(suiteRequest)).resolves.toEqual({
      allowed: true,
      targets: [
        {
          hookId: HOOK_ID,
          pullNumber: 585,
          baseSha: BASE_SHA,
          configRevision: '7',
          dispatchRevision: '9'
        }
      ]
    })
    expect(h.listReviewProjectionsForSuiteRerequest).toHaveBeenCalledWith(REPO_ID, HEAD_SHA, INSTALLATION_ID)
    expect(h.findReviewProjectionByCheckRunId).not.toHaveBeenCalled()
  })

  it('denies a Check Suite from a different GitHub App before reading projections', async () => {
    const h = make()
    await expect(h.service.resolve({ ...suiteRequest, appId: String(APP_ID + 1) })).resolves.toEqual({ allowed: false })
    expect(h.listReviewProjectionsForSuiteRerequest).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown Check', null],
    ['wrong repository', projection({ repoId: REPO_ID + 1n })],
    ['wrong revision', projection({ headSha: 'c'.repeat(40), reportSha: 'c'.repeat(40) })],
    ['required gate', projection({ gateMode: 'required' })],
    ['nonterminal Check', projection({ observedState: 'in_progress' })],
    ['write in flight', projection({ writePhase: 'update' })],
    ['pending generation', projection({ pendingIntent: { desiredState: 'queued' } })],
    ['tombstoned projection', projection({ tombstonedAt: new Date(0) })]
  ])('denies %s before reading hook/run authority', async (_label, candidate) => {
    const h = make({ projection: candidate })
    await expect(h.service.resolve(request)).resolves.toEqual({ allowed: false })
    expect(h.get).not.toHaveBeenCalled()
    expect(h.getRunById).not.toHaveBeenCalled()
  })

  it.each([
    ['disabled hook', hook({ enabled: false }), run()],
    ['retargeted hook', hook({ repoId: REPO_ID + 1n }), run()],
    ['changed projection epoch', hook({ projectionEpoch: 3n }), run()],
    ['missing current run', hook(), null],
    ['different PR revision', hook(), run({ headSha: 'c'.repeat(40) })],
    ['incomplete PR metadata', hook(), run({ baseSha: null })]
  ])('denies %s', async (_label, currentHook, currentRun) => {
    await expect(make({ hook: currentHook, run: currentRun }).service.resolve(request)).resolves.toEqual({
      allowed: false
    })
  })

  it('propagates persistence failures for the wire handler to return a retryable error', async () => {
    const h = make()
    h.findReviewProjectionByCheckRunId.mockRejectedValueOnce(new Error('db unavailable'))
    await expect(h.service.resolve(request)).rejects.toThrow('db unavailable')
  })
})
