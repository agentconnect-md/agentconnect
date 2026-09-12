// Gitea commit-status projection end to end (gitea-integration.md §10.4): real ledger, fake Gitea edge, reconciled ambiguity, token rejection.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildGiteaSeam, type GiteaSeam } from '../fakes/gitea-seam.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { trackedTestClock } from '../fakes/tracked-clock.js'
import { GiteaStatusCoordinator, GiteaStatusReporter, type GiteaStatusEdge } from '../../src/gitea/status-projection.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgCodeHostRunProjectionRepo } from '../../src/persistence/repositories/code-host-projection.repo.js'
import { PgHookRepo } from '../../src/persistence/repositories/hook.repo.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { AgentId, HookId, OrgId } from '../../src/domain/ids.js'

const REPO = 556677n
const HEAD = 'a'.repeat(40)
const NEXT_HEAD = 'b'.repeat(40)
const NOW = new Date('2026-09-12T00:00:00.000Z').getTime()
const CONSOLE = 'https://console.example.test'
const seamClock = trackedTestClock()
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)

let seam: GiteaSeam | undefined
afterEach(async () => {
  await seam?.settled()
  seam = undefined
})

async function harness() {
  const built = buildGiteaSeam(prisma, cipher, seamClock)
  seam = built
  const connection = await built.connections.connect(DEFAULT_ORG_ID, built.fake.token)
  const binding = await built.bindings.createWithClaim({
    orgId: DEFAULT_ORG_ID,
    connectionId: connection.id,
    repoId: REPO,
    repoPath: 'example-org/example-repo',
    cloneUrl: 'https://gitea.com/example-org/example-repo.git',
    axisBaseUrl: built.fake.opts.baseUrl
  })
  expect(await built.provisioner.provision(DEFAULT_ORG_ID, binding.id)).toEqual({ state: 'ready', reason: null })
  const daemonId = randomUUID()
  await seedDaemon(prisma, daemonId)
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId, giteaRepoId: REPO, name: 'review-bot' })
  const hookId = randomUUID()
  await prisma.hookDef.create({
    data: {
      id: hookId,
      orgId: DEFAULT_ORG_ID,
      agentId,
      kind: 'gitea',
      name: 'pull reviews',
      sessionMode: 'perThread',
      repoId: REPO,
      repoFullName: 'example-org/example-repo',
      family: 'merge_request',
      events: ['merge_request:*'],
      configRevision: 3n,
      dispatchRevision: 5n,
      reportingMode: 'status'
    }
  })
  const snapshot = {
    configRevision: '3',
    dispatchRevision: '5',
    dispatchDaemonId: daemonId,
    reviewPolicy: 'off' as const,
    reportingMode: 'status' as const,
    gateMode: 'informational' as const
  }
  const accept = async (deliveryKey: string, startedAt: Date = new Date(NOW)) => {
    await prisma.hookRun.create({
      data: {
        hookId,
        orgId: DEFAULT_ORG_ID,
        deliveryKey,
        event: 'merge_request:opened',
        startedAt,
        agentId,
        configRevision: 3n,
        dispatchRevision: 5n,
        dispatchDaemonId: daemonId,
        projectionEpoch: 1n,
        reviewPolicySnapshot: 'off',
        reportingModeSnapshot: 'status',
        gateModeSnapshot: 'informational',
        repoId: REPO,
        subjectKind: 'pull_request',
        status: 'running'
      }
    })
  }
  const clock = new FakeClock(NOW)
  const projections = new PgCodeHostRunProjectionRepo(prisma)
  const coordinator = new GiteaStatusCoordinator({
    projections,
    runs: new PgHookRepo(prisma),
    agents: new PgAgentRepo(prisma),
    bindings: built.bindings,
    connections: built.connectionRepo,
    clock
  })
  const reporter = new GiteaStatusReporter({
    projections,
    bindings: built.bindings,
    connections: built.connectionRepo,
    tokens: built.connections,
    orgs: new PgOrgRepo(prisma),
    api: built.fake.api,
    clock,
    webAppUrl: CONSOLE,
    workerId: 'gitea-status-reporter:test'
  })
  const edge = (over: Partial<GiteaStatusEdge> = {}): GiteaStatusEdge => ({
    hookId,
    agentId,
    deliveryKey: 'delivery-1',
    orgId: OrgId(DEFAULT_ORG_ID),
    state: 'queued',
    gitea: {
      repoId: REPO.toString(),
      repoPath: 'example-org/example-repo',
      target: { kind: 'pull', index: 12, headSha: HEAD }
    },
    snapshot,
    at: new Date(clock.now()),
    ...over
  })
  const statuses = () => built.fake.statuses.filter((status) => status.sha === HEAD)
  const row = async () =>
    (await prisma.codeHostRunProjection.findFirstOrThrow({ where: { hookId, headSha: HEAD, projectId: REPO } }))!
  return {
    seam: built,
    fake: built.fake,
    connection,
    binding,
    hookId: HookId(hookId),
    agentId: AgentId(agentId),
    clock,
    coordinator,
    reporter,
    edge,
    accept,
    statuses,
    row
  }
}

describe('gitea commit-status projection (§10.4)', () => {
  it('writes one status per lifecycle edge with the connection token, the agent context, and the console link', async () => {
    const h = await harness()
    await h.accept('delivery-1')
    await h.coordinator.afterAccepted(h.edge())
    await h.reporter.tick()
    expect(h.statuses()).toHaveLength(1)
    expect(h.statuses()[0]).toMatchObject({
      context: 'agentconnect/review-bot',
      status: 'pending',
      description: 'AgentConnect review queued',
      creator: { id: h.fake.opts.bot.id }
    })
    expect(h.statuses()[0]!.target_url).toBeUndefined()
    const posted = h.fake.requests.filter((request) => request.method === 'POST' && request.url.includes('/statuses/'))
    expect(posted).toHaveLength(1)
    expect(posted[0]!.token).toBe(h.fake.token)
    let stored = await h.row()
    expect(stored).toMatchObject({
      provider: 'gitea',
      desiredState: 'queued',
      observedState: 'queued',
      noteId: String(h.statuses()[0]!.id)
    })
    expect(stored.writeMarker).toBeNull()

    // The start barrier brings the session: the status now links the ordinary authenticated Console page.
    h.clock.advance(1_000)
    await h.coordinator.afterStart(h.edge({ sessionId: 'session-1' }))
    await h.reporter.tick()
    expect(h.statuses()).toHaveLength(2)
    expect(h.statuses()[1]).toMatchObject({
      status: 'pending',
      description: 'AgentConnect review in progress',
      target_url: `${CONSOLE}/${encodeURIComponent((await new PgOrgRepo(prisma).slugById(DEFAULT_ORG_ID))!)}/sessions/session-1?source=gitea`
    })
    expect(h.statuses()[1]!.target_url).not.toContain('token')

    // The terminal report completes it; a settled row leaves the due set.
    h.clock.advance(1_000)
    await h.coordinator.afterReport(h.edge({ state: 'completed', sessionId: 'session-1' }))
    await h.reporter.tick()
    expect(h.statuses()).toHaveLength(3)
    expect(h.statuses()[2]).toMatchObject({ status: 'success', description: 'AgentConnect review completed' })
    stored = await h.row()
    expect(stored).toMatchObject({ observedState: 'completed', generation: 1n })
    await h.reporter.tick()
    expect(h.statuses()).toHaveLength(3)
    expect((await h.row()).nextAttemptAt).toBeNull()
  })

  it('supersedes the older head and maps every terminal state without ever writing warning', async () => {
    const h = await harness()
    await h.accept('delivery-1')
    await h.coordinator.afterAccepted(h.edge())
    await h.reporter.tick()
    const next = {
      repoId: REPO.toString(),
      repoPath: 'example-org/example-repo',
      target: { kind: 'pull' as const, index: 12, headSha: NEXT_HEAD }
    }
    h.clock.advance(1_000)
    await h.accept('delivery-2', new Date(h.clock.now()))
    await h.coordinator.afterAccepted(h.edge({ deliveryKey: 'delivery-2', gitea: next }))
    await h.reporter.tick()
    // The old head reads superseded (success, named as such); the new head reads queued.
    const old = h.fake.statuses.filter((status) => status.sha === HEAD)
    expect(old.at(-1)).toMatchObject({
      status: 'success',
      description: 'AgentConnect review superseded by a newer revision'
    })
    expect(h.fake.statuses.filter((status) => status.sha === NEXT_HEAD).at(-1)).toMatchObject({ status: 'pending' })

    h.clock.advance(1_000)
    await h.coordinator.afterReport(
      h.edge({ deliveryKey: 'delivery-2', gitea: next, state: 'failed', reason: 'session_start_failed' })
    )
    await h.reporter.tick()
    expect(h.fake.statuses.filter((status) => status.sha === NEXT_HEAD).at(-1)).toMatchObject({
      status: 'error',
      description: 'AgentConnect review failed (session_start_failed)'
    })
    expect(h.fake.statuses.some((status) => status.status === 'warning')).toBe(false)
  })

  it('keeps the newest head current when an older head reports late', async () => {
    const h = await harness()
    await h.accept('delivery-1')
    await h.coordinator.afterAccepted(h.edge())
    h.clock.advance(1_000)
    await h.coordinator.afterStart(h.edge({ state: 'running', sessionId: 'session-1' }))
    await h.reporter.tick()
    const next = {
      repoId: REPO.toString(),
      repoPath: 'example-org/example-repo',
      target: { kind: 'pull' as const, index: 12, headSha: NEXT_HEAD }
    }
    h.clock.advance(1_000)
    await h.accept('delivery-2', new Date(h.clock.now()))
    await h.coordinator.afterAccepted(h.edge({ deliveryKey: 'delivery-2', gitea: next }))
    await h.reporter.tick()
    const on = (sha: string) => h.fake.statuses.filter((status) => status.sha === sha)
    expect(on(HEAD).at(-1)).toMatchObject({
      status: 'success',
      description: 'AgentConnect review superseded by a newer revision'
    })
    expect(on(NEXT_HEAD).at(-1)).toMatchObject({ status: 'pending' })
    const written = h.fake.statuses.length

    // The older head's run finishes after the newer head arrived: nothing is written, the newer head stays current, the older stays superseded.
    h.clock.advance(1_000)
    await h.coordinator.afterReport(h.edge({ state: 'completed', sessionId: 'session-1' }))
    await h.reporter.tick()
    expect(h.fake.statuses).toHaveLength(written)
    expect(on(HEAD).at(-1)).toMatchObject({ description: 'AgentConnect review superseded by a newer revision' })
    expect(on(NEXT_HEAD).at(-1)).toMatchObject({ status: 'pending' })
    expect(await h.row()).toMatchObject({ desiredState: 'superseded' })
    const newer = await prisma.codeHostRunProjection.findFirstOrThrow({
      where: { hookId: h.hookId, headSha: NEXT_HEAD }
    })
    expect(newer.desiredState).toBe('queued')
  })

  it('keeps an ambiguous write under its marker and reconciles the landed status instead of replaying it', async () => {
    const h = await harness()
    await h.accept('delivery-1')
    await h.coordinator.afterAccepted(h.edge())
    // The request reaches Gitea; the reply is lost.
    h.fake.opts.intercept = (method, route) => {
      if (method === 'POST' && route.includes('/statuses/')) {
        h.fake.statuses.push({
          id: 9_500,
          sha: HEAD,
          context: 'agentconnect/review-bot',
          status: 'pending',
          description: 'AgentConnect review queued',
          creator: { id: h.fake.opts.bot.id }
        })
        throw new Error('socket hang up')
      }
      return undefined
    }
    await h.reporter.tick()
    let stored = await h.row()
    expect(stored.writeMarker).not.toBeNull()
    expect(stored.observedState).toBeNull()
    expect(stored.lastErrorCode).toBe('ambiguous_write')
    h.fake.opts.intercept = undefined

    // Nothing is written again; the retry pass reads the commit's statuses and adopts the one that landed.
    h.clock.advance(5_000)
    await h.reporter.tick()
    stored = await h.row()
    expect(stored).toMatchObject({ observedState: 'queued', noteId: '9500', writeMarker: null })
    expect(
      h.fake.requests.filter((request) => request.method === 'POST' && request.url.includes('/statuses/'))
    ).toHaveLength(1)
    expect(h.statuses()).toHaveLength(1)
  })

  it('feeds a rejected token into the connection path and resumes once the token is replaced', async () => {
    const h = await harness()
    await h.accept('delivery-1')
    await h.coordinator.afterAccepted(h.edge())
    h.fake.token = 'gitea-token-rotated-elsewhere'
    await h.reporter.tick()
    expect(h.statuses()).toEqual([])
    expect((await h.seam.connectionRepo.get(DEFAULT_ORG_ID, h.connection.id))!.state).toBe('token_rejected')
    expect((await h.seam.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.state).toBe('runtime_degraded')
    let stored = await h.row()
    expect(stored).toMatchObject({ lastErrorCode: 'token_rejected', writeMarker: null, observedState: null })
    // While the connection waits for its replacement the row stays due and nothing is written.
    h.clock.advance(60_000)
    await h.reporter.tick()
    expect(h.statuses()).toEqual([])
    expect((await h.row()).lastErrorCode).toBe('token_rejected')

    // The replacement is the whole recovery: the next pass writes with the new token.
    await h.seam.connections.replaceToken(DEFAULT_ORG_ID, h.connection.id, 'gitea-token-rotated-elsewhere')
    h.clock.advance(10 * 60_000)
    await h.reporter.tick()
    expect(h.statuses()).toHaveLength(1)
    const posted = h.fake.requests.filter((request) => request.method === 'POST' && request.url.includes('/statuses/'))
    expect(posted.at(-1)!.token).toBe('gitea-token-rotated-elsewhere')
    stored = await h.row()
    expect(stored.observedState).toBe('queued')
  })
})
