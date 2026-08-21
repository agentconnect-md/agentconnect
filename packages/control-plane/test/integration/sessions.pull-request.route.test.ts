// `GET /sessions/:id/pull-request` — the PR panel's read (webchat-side-panels.md §3.4, M5).
// Real Postgres rows behind the route, GitHub stubbed at the fetch seam: the 404 matrix (absence and
// authorization answer identically, with zero GitHub calls), the happy projection, and the degraded
// arm falling back to the subject's own Postgres facts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PullRequestViewService } from '../../src/github/pull-request-view.service.js'
import { SessionPullRequestLinkService } from '../../src/github/session-pull-request-link.service.js'
import { GitCredDeniedError, type GithubService } from '../../src/github/service.js'
import type { InstallationTokenService } from '../../src/github/installation-token.service.js'
import type { FetchLike } from '../../src/github/api.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { systemClock } from '../../src/domain/clock.js'
import { AUTO_MERGE_FEATURE, SANDBOX_KEEP_ALIVE_FEATURE } from '@agentconnect.md/protocol'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { ProtocolError } from '../../src/domain/errors.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd5d5d5d5-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a5a5a5a5-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INSTALLATION = 555n
const REPO_ID = 4242n
const REPO = 'acme/repo'
const PULL = 7

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

// The two GitHub seams the projection spends: token mints and GraphQL POSTs, both counted.
function githubStub(replies: Array<() => Response>) {
  const mint = vi.fn(async () => ({
    token: 'ghs_int_test',
    ttlSec: 3600,
    expiresAt: '2026-08-11T01:00:00Z',
    repoFullName: REPO,
    access: 'read' as const
  }))
  const calls: unknown[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const next = replies.shift()
    if (!next) throw new Error('unexpected extra GitHub call')
    return next()
  }
  const view = new PullRequestViewService(
    { mintPullRequestRead: mint } as unknown as InstallationTokenService,
    systemClock,
    fetch
  )
  return { view, mint, calls }
}

const graphqlOk = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const rateLimited = () =>
  new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' }
  })

function fullAnswer() {
  return {
    data: {
      repository: {
        pullRequest: {
          number: PULL,
          title: 'Ship the panel',
          bodyText: 'Ship the panel body',
          state: 'OPEN',
          isDraft: false,
          merged: false,
          additions: 120,
          deletions: 8,
          url: `https://github.com/${REPO}/pull/${PULL}`,
          baseRefName: 'main',
          headRefName: 'feat/panel',
          headRefOid: 'sha_HEAD',
          reviewDecision: 'APPROVED',
          latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'dana', __typename: 'User' } }] },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: { hasNextPage: false },
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          name: 'unit',
                          conclusion: 'SUCCESS',
                          status: 'COMPLETED',
                          startedAt: '2026-08-11T00:00:00Z',
                          completedAt: '2026-08-11T00:05:00Z',
                          detailsUrl: 'https://ci.example/unit'
                        }
                      ]
                    }
                  }
                }
              }
            ]
          },
          reviewThreads: {
            totalCount: 1,
            nodes: [
              {
                isResolved: false,
                isOutdated: false,
                path: 'src/app.ts',
                line: 12,
                comments: { nodes: [{ body: 'rename this', author: { login: 'dana' } }] }
              }
            ]
          }
        }
      }
    }
  }
}

function app(
  view?: PullRequestViewService,
  userId?: string,
  github?: GithubService,
  sessionPullRequestLink?: SessionPullRequestLinkService,
  control?: ControlSender
): HttpApp {
  const running = buildHttpApp(prisma, userId ? { DEFAULT_OWNER_ID: userId } : undefined, undefined, control, {
    ...(view ? { pullRequestView: view } : {}),
    ...(github ? { github } : {}),
    ...(sessionPullRequestLink ? { sessionPullRequestLink } : {})
  })
  opened.push(running)
  return running
}

// The clamp seam as the route sees it: capability answers and a write-purpose mint, no real GithubService.
function fakeGithub(deny?: 'SCOPE_DENIED' | 'LEASE_DENIED'): GithubService {
  return {
    canArmAutoMerge: async () => deny === undefined,
    mintAutoMergeForAgent: async () => {
      if (deny) throw new GitCredDeniedError(`denied by clamp: ${deny}`, deny, false)
      return {
        token: 'ghs_write',
        ttlSec: 3600,
        expiresAt: '2026-08-11T01:00:00Z',
        repoFullName: REPO,
        access: 'write' as const,
        installationId: INSTALLATION
      }
    }
  } as unknown as GithubService
}

async function makeUser(sub: string): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@acme.dev`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, 'collaborator')
  return userId
}

// Merge-when-ready is served by the EDGE, so the fixture daemon advertises the feature the route gates on.
const EDGE_CAPABILITIES = {
  platforms: ['slack', 'telegram', 'discord'],
  runtimes: ['claude'],
  acp: true,
  features: [AUTO_MERGE_FEATURE]
}

/** The daemon's watcher as the route sees it: `automerge/set` flips a per-PR entry, `automerge/state`
 *  reads it back. In-memory here exactly as it is at the real edge — there is no row to fake. */
function fakeEdge(opts: { fail?: Error; placement?: 'sandbox' | 'daemon' } = {}) {
  const armed = new Map<string, { waitingOn?: string }>()
  const calls: Array<{ op: 'set' | 'state'; enabled?: boolean }> = []
  const state = (repoFullName: string, prNumber: number) => {
    const held = armed.get(`${repoFullName}#${prNumber}`)
    return {
      agentId: AGENT,
      repoFullName,
      prNumber,
      armed: held !== undefined,
      ...(held ? { placement: opts.placement ?? 'daemon', waitingOn: 'checks running: unit' } : {})
    }
  }
  const control = {
    autoMergeSet: async (
      _daemonId: string,
      _orgId: string,
      req: { repoFullName: string; prNumber: number; enabled: boolean }
    ) => {
      calls.push({ op: 'set', enabled: req.enabled })
      if (opts.fail) throw opts.fail
      const key = `${req.repoFullName}#${req.prNumber}`
      if (req.enabled) armed.set(key, {})
      else armed.delete(key)
      return state(req.repoFullName, req.prNumber)
    },
    autoMergeState: async (_daemonId: string, _orgId: string, req: { repoFullName: string; prNumber: number }) => {
      calls.push({ op: 'state' })
      if (opts.fail) throw opts.fail
      return state(req.repoFullName, req.prNumber)
    }
  }
  return { control: control as unknown as ControlSender, calls, armed }
}

async function seedAgentAndSession(opts: { visibility?: 'org' | 'private'; ownerIdentity?: string } = {}) {
  await seedDaemon(prisma, DAEMON, { capabilities: EDGE_CAPABILITIES })
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  return seedSessionMeta(prisma, randomUUID(), AGENT, { daemonId: DAEMON, ...opts })
}

// A PR-subject run bound to `sessionId`; overrides shape the legacy/degraded scenarios.
async function seedPullRequestRun(sessionId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const hookId = randomUUID()
  await prisma.hookDef.create({
    data: {
      id: hookId,
      orgId: DEFAULT_ORG_ID,
      agentId: AGENT,
      kind: 'webhook',
      name: `pr-hook-${hookId.slice(0, 8)}`,
      sessionMode: 'perDelivery',
      urlToken: `whk_${randomUUID().replaceAll('-', '')}`
    }
  })
  const run = await prisma.hookRun.create({
    data: {
      hookId,
      orgId: DEFAULT_ORG_ID,
      deliveryKey: `delivery-${randomUUID().slice(0, 8)}`,
      startedAt: new Date('2026-08-11T00:00:00Z'),
      agentId: AGENT,
      sessionId,
      subjectKind: 'pull_request',
      pullNumber: PULL,
      repoId: REPO_ID,
      repoFullName: REPO,
      sourceInstallationId: INSTALLATION,
      ...overrides
    }
  })
  return run.id
}

const NOT_FOUND = { error: 'Not Found', statusCode: 404, message: 'pull request not found' }

describe('GET /sessions/:id/pull-request', () => {
  it('projects the stubbed GitHub answer for a linked session, one GraphQL call, cached until refresh', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    const github = githubStub([graphqlOk(fullAnswer()), graphqlOk(fullAnswer())])
    const running = app(github.view)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      repoFullName: REPO,
      pullNumber: PULL,
      title: 'Ship the panel',
      body: 'Ship the panel body',
      state: 'open',
      isDraft: false,
      url: `https://github.com/${REPO}/pull/${PULL}`,
      headRef: 'feat/panel',
      baseRef: 'main',
      additions: 120,
      deletions: 8,
      reviewDecision: 'approved',
      checks: [
        {
          name: 'unit',
          state: 'success',
          detail: 'SUCCESS',
          startedAt: '2026-08-11T00:00:00Z',
          completedAt: '2026-08-11T00:05:00Z',
          url: 'https://ci.example/unit'
        }
      ],
      checksTruncated: false,
      reviews: [{ author: 'dana', state: 'approved', isBot: false }],
      threads: [{ location: 'src/app.ts:12', body: 'rename this', author: 'dana', isOutdated: false }],
      unresolvedCount: 1,
      threadsTruncated: false,
      // No live daemon in this fixture, so the edge could not be asked: unknown, not "not armed".
      autoMergeArmed: null,
      autoMergePlacement: null,
      autoMergeWaitingOn: null,
      autoMergeError: null,
      canArmAutoMerge: false,
      degraded: false,
      degradedReason: null,
      agentReview: null,
      linkedBy: 'run',
      linkBranch: null,
      linkScope: null,
      linkAmbiguous: false
    })
    expect(github.calls).toHaveLength(1)
    expect(github.mint).toHaveBeenCalledWith(INSTALLATION, REPO, REPO_ID)

    // Within the TTL the second read is free; `refresh=false` must not truthy-coerce into a force.
    const again = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${session}/pull-request?refresh=false`
    })
    expect(again.statusCode).toBe(200)
    expect(github.calls).toHaveLength(1)

    const forced = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${session}/pull-request?refresh=true`
    })
    expect(forced.statusCode).toBe(200)
    expect(github.calls).toHaveLength(2)
  })

  it('degrades to the subject’s own Postgres facts when GitHub is rate limited', async () => {
    const session = await seedAgentAndSession()
    const projectionId = randomUUID()
    const runId = await seedPullRequestRun(session, { isDraft: true, projectionId, reviewEvent: 'REQUEST_CHANGES' })
    // The broker's own association rows: the projection and its subject, which says the PR is CLOSED.
    const run = await prisma.hookRun.findUniqueOrThrow({ where: { id: runId } })
    await prisma.hookReviewProjection.create({
      data: {
        id: projectionId,
        hookId: run.hookId,
        orgId: DEFAULT_ORG_ID,
        agentId: AGENT,
        repoId: REPO_ID,
        repoFullName: REPO,
        headSha: 'head-sha',
        reportSha: 'report-sha',
        projectionEpoch: 1n,
        externalId: `ext-${projectionId}`,
        mode: 'check',
        gateMode: 'informational',
        desiredState: 'pending'
      }
    })
    await prisma.hookReviewSubject.create({
      data: { projectionId, pullNumber: PULL, headSha: 'head-sha', isOpen: false }
    })
    const github = githubStub([rateLimited])
    const running = app(github.view)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      repoFullName: REPO,
      pullNumber: PULL,
      url: `https://github.com/${REPO}/pull/${PULL}`,
      degraded: true,
      degradedReason: 'rate_limited',
      // Postgres facts, not fabrication: the subject says closed, the run says draft, counts unknown —
      // and the run's own recorded review is the one review state a degraded read can still show.
      state: 'closed',
      isDraft: true,
      agentReview: 'changes_requested',
      additions: null,
      deletions: null,
      checks: [],
      reviews: [],
      threads: []
    })
  })

  it('404s a session with no pull-request run — the tab-hiding case', async () => {
    const session = await seedAgentAndSession()
    // A foreign org's run bound to THIS session id pins the run lookup's own org fence.
    const foreignOrg = `org-fence-${randomUUID().slice(0, 8)}`
    await prisma.org.create({ data: { id: foreignOrg, slug: foreignOrg } })
    const foreignHook = randomUUID()
    await prisma.hookDef.create({
      data: {
        id: foreignHook,
        orgId: foreignOrg,
        kind: 'webhook',
        name: 'fence-hook',
        sessionMode: 'perDelivery',
        urlToken: `whk_${randomUUID().replaceAll('-', '')}`
      }
    })
    await prisma.hookRun.create({
      data: {
        hookId: foreignHook,
        orgId: foreignOrg,
        deliveryKey: 'delivery-f',
        startedAt: new Date(),
        sessionId: session,
        subjectKind: 'pull_request',
        pullNumber: PULL,
        repoId: REPO_ID,
        repoFullName: REPO,
        sourceInstallationId: INSTALLATION
      }
    })
    const github = githubStub([])
    const running = app(github.view)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual(NOT_FOUND)
    expect(github.calls).toHaveLength(0)
    expect(github.mint).not.toHaveBeenCalled()
  })

  it('404s identically when the deployment has no GitHub App configured', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    const running = app(undefined) // no pullRequestView dep, exactly like GITHUB_APP_* unset

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual(NOT_FOUND)
  })

  it('404s identically for a legacy run that predates repo/installation capture', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session, { sourceInstallationId: null })
    const github = githubStub([])
    const running = app(github.view)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual(NOT_FOUND)
    expect(github.calls).toHaveLength(0)
  })

  it('hides a foreign org’s session behind the same 404, spending no GitHub call', async () => {
    const foreignOrg = `org-foreign-${randomUUID().slice(0, 8)}`
    const foreignAgent = randomUUID()
    const foreignSession = randomUUID()
    await prisma.org.create({ data: { id: foreignOrg, slug: foreignOrg } })
    await prisma.agent.create({
      data: { id: foreignAgent, orgId: foreignOrg, name: 'foreign-bot', runtime: 'claude' }
    })
    await prisma.sessionMeta.create({
      data: {
        id: foreignSession,
        agentId: foreignAgent,
        orgId: foreignOrg,
        platform: 'slack',
        channel: '#general',
        phase: 'start',
        lastActivityAt: new Date()
      }
    })
    // A real linked run in ITS org — reachable only if the org fence leaks.
    const foreignHook = randomUUID()
    await prisma.hookDef.create({
      data: {
        id: foreignHook,
        orgId: foreignOrg,
        agentId: foreignAgent,
        kind: 'webhook',
        name: 'foreign-hook',
        sessionMode: 'perDelivery',
        urlToken: `whk_${randomUUID().replaceAll('-', '')}`
      }
    })
    await prisma.hookRun.create({
      data: {
        hookId: foreignHook,
        orgId: foreignOrg,
        deliveryKey: 'delivery-x',
        startedAt: new Date(),
        sessionId: foreignSession,
        subjectKind: 'pull_request',
        pullNumber: PULL,
        repoId: REPO_ID,
        repoFullName: REPO,
        sourceInstallationId: INSTALLATION
      }
    })
    const github = githubStub([])
    const running = app(github.view)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${foreignSession}/pull-request` })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual(NOT_FOUND)
    expect(github.calls).toHaveLength(0)
    expect(github.mint).not.toHaveBeenCalled()
  })

  it('hides another member’s private session behind the same 404 — and answers its owner', async () => {
    const mine = await makeUser(`pr-mine-${randomUUID()}`)
    const theirs = await makeUser(`pr-theirs-${randomUUID()}`)
    const session = await seedAgentAndSession({ visibility: 'private', ownerIdentity: `user:${theirs}` })
    await seedPullRequestRun(session)
    const github = githubStub([graphqlOk(fullAnswer())])

    const denied = await app(github.view, mine).app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${session}/pull-request`
    })
    expect(denied.statusCode).toBe(404)
    expect(denied.json()).toEqual(NOT_FOUND)
    expect(github.calls).toHaveLength(0)
    expect(github.mint).not.toHaveBeenCalled()

    const owner = await app(github.view, theirs).app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${session}/pull-request`
    })
    expect(owner.statusCode).toBe(200)
    expect(owner.json()).toMatchObject({ pullNumber: PULL, degraded: false })
    expect(github.calls).toHaveLength(1)
  })

  it('404s an unknown session id with the identical body', async () => {
    const github = githubStub([])
    const running = app(github.view)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${randomUUID()}/pull-request` })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual(NOT_FOUND)
    expect(github.calls).toHaveLength(0)
  })
})

// Merge-when-ready (§7, rebuilt): the CP RELAYS an arm to the edge and stores nothing. GitHub's own
// `enablePullRequestAutoMerge` is gone from this path — it refuses every PR that is not BLOCKED, which
// is what made the box unarmable on any repository without required checks.
describe('POST /sessions/:id/pull-request/auto-merge', () => {
  const post = (running: HttpApp, sessionId: string, enabled = true) =>
    running.app.inject({
      method: 'POST',
      url: `${ORG}/sessions/${sessionId}/pull-request/auto-merge`,
      payload: { enabled }
    })

  it('arms at the edge, spends NO GitHub call, and the read projects the watcher back', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    const github = githubStub([graphqlOk(fullAnswer())])
    const edge = fakeEdge({ placement: 'sandbox' })
    const running = app(github.view, undefined, fakeGithub(), undefined, edge.control)

    const res = await post(running, session)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ armed: true, placement: 'sandbox', waitingOn: 'checks running: unit', error: null })
    // The arm is a relay, not a mutation: nothing was asked of GitHub.
    expect(github.calls).toHaveLength(0)
    expect(edge.calls).toEqual([{ op: 'set', enabled: true }])

    // And the panel's read carries the edge's own verdict, which GitHub auto-merge never gave.
    const read = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })
    expect(read.json()).toMatchObject({
      canArmAutoMerge: true,
      autoMergeArmed: true,
      autoMergePlacement: 'sandbox',
      autoMergeWaitingOn: 'checks running: unit',
      autoMergeError: null
    })
  })

  it('disarms, and the next read reports an unarmed box', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    const github = githubStub([graphqlOk(fullAnswer())])
    const edge = fakeEdge()
    const running = app(github.view, undefined, fakeGithub(), undefined, edge.control)

    await post(running, session)
    const off = await post(running, session, false)
    expect(off.json()).toMatchObject({ armed: false, placement: null })

    const read = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })
    expect(read.json()).toMatchObject({ autoMergeArmed: false, autoMergePlacement: null })
  })

  it('refuses a read-tier agent with 403 before reaching the edge — the disabled-control contract', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    const github = githubStub([graphqlOk(fullAnswer())])
    const edge = fakeEdge()
    const running = app(github.view, undefined, fakeGithub('SCOPE_DENIED'), undefined, edge.control)

    const res = await post(running, session)
    expect(res.statusCode).toBe(403)
    expect(edge.calls).toHaveLength(0)

    // And the read-side flag agrees, so the console never offered the control in the first place.
    const read = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })
    expect(read.json()).toMatchObject({ canArmAutoMerge: false })
  })

  it('409s a daemon that does not serve the frame, naming the upgrade rather than 503-ing', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const session = await seedSessionMeta(prisma, randomUUID(), AGENT, { daemonId: DAEMON })
    await seedPullRequestRun(session)
    const edge = fakeEdge()
    const running = app(githubStub([]).view, undefined, fakeGithub(), undefined, edge.control)

    const res = await post(running, session)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('DAEMON_FEATURE_MISSING')
    expect(edge.calls).toHaveLength(0)
  })

  it('relays a runtime image with no watcher as 409 with its machine code', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    const edge = fakeEdge({
      fail: new ProtocolError('BAD_PAYLOAD', 'automerge/set failed: this runtime image ships no watcher', {
        details: { reason: 'unsupported-image' }
      })
    })
    const running = app(githubStub([]).view, undefined, fakeGithub(), undefined, edge.control)

    const res = await post(running, session)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('AUTO_MERGE_UNSUPPORTED_IMAGE')
  })

  it('relays a sleeping sandbox and an already-mergeable pull request as their own 409 codes', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    for (const [reason, code] of [
      ['sandbox-asleep', 'AUTO_MERGE_SANDBOX_ASLEEP'],
      ['already-mergeable', 'AUTO_MERGE_ALREADY_MERGEABLE']
    ] as const) {
      const edge = fakeEdge({
        fail: new ProtocolError('BAD_PAYLOAD', `automerge/set failed: ${reason}`, { details: { reason } })
      })
      const running = app(githubStub([]).view, undefined, fakeGithub(), undefined, edge.control)
      const res = await post(running, session)
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe(code)
    }
  })

  it('reads back autoMergeArmed:null when the edge cannot be asked — unknown, not "off"', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    const github = githubStub([graphqlOk(fullAnswer())])
    const edge = fakeEdge({ fail: new Error('connection closed') })
    const running = app(github.view, undefined, fakeGithub(), undefined, edge.control)

    const read = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })
    expect(read.statusCode).toBe(200) // a lost toggle state must not fail the whole panel read
    expect(read.json()).toMatchObject({ autoMergeArmed: null, autoMergeWaitingOn: null })
  })

  it('403s a run whose owning agent is gone — the arm rides the agent authorization, which no longer exists', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session, { agentId: null })
    const edge = fakeEdge()
    const running = app(githubStub([]).view, undefined, fakeGithub(), undefined, edge.control)

    const res = await post(running, session)
    expect(res.statusCode).toBe(403)
    expect(edge.calls).toHaveLength(0)
  })

  it('404s a session with no linked run, with the GET route\u2019s exact body', async () => {
    const edge = fakeEdge()
    const running = app(githubStub([]).view, undefined, fakeGithub(), undefined, edge.control)
    const bare = await seedAgentAndSession()

    const res = await post(running, bare)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual(NOT_FOUND)
    expect(edge.calls).toHaveLength(0)
  })

  it('hides another member\u2019s private session behind the same 404, spending nothing', async () => {
    const edge = fakeEdge()
    const running = app(githubStub([]).view, undefined, fakeGithub(), undefined, edge.control)
    const owner = await makeUser(`owner-${randomUUID().slice(0, 8)}`)
    const priv = await seedAgentAndSession({ visibility: 'private', ownerIdentity: `user:${owner}` })
    await seedPullRequestRun(priv)

    const res = await post(running, priv)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual(NOT_FOUND)
    expect(edge.calls).toHaveLength(0)
  })
})

// The sandbox keep-alive: an open page renewing a lease the DAEMON decides on. The CP relays and
// stores nothing, so every assertion here is about what it forwards and how it maps a refusal.
describe('POST /sessions/:id/sandbox-keep-alive', () => {
  const KEEP_ALIVE_CAPABILITIES = { ...EDGE_CAPABILITIES, features: [SANDBOX_KEEP_ALIVE_FEATURE] }
  const post = (running: HttpApp, sessionId: string) =>
    running.app.inject({ method: 'POST', url: `${ORG}/sessions/${sessionId}/sandbox-keep-alive`, payload: {} })

  function fakeKeepAlive(answer: Record<string, unknown> | Error) {
    const calls: Array<{ agentId: string; sessionId?: string }> = []
    const control = {
      sandboxKeepAlive: async (_d: string, _o: string, req: { agentId: string; sessionId?: string }) => {
        calls.push(req)
        if (answer instanceof Error) throw answer
        return { agentId: req.agentId, ...answer }
      }
    }
    return { control: control as unknown as ControlSender, calls }
  }

  it('relays the daemon’s hold, naming the session whose worktree decides it', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: KEEP_ALIVE_CAPABILITIES })
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const session = await seedSessionMeta(prisma, randomUUID(), AGENT, { daemonId: DAEMON })
    const edge = fakeKeepAlive({
      held: true,
      reasons: ['uncommitted-files', 'auto-merge-armed'],
      ttlMs: 180_000,
      placement: 'sandbox'
    })
    const running = app(githubStub([]).view, undefined, undefined, undefined, edge.control)

    const res = await post(running, session)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      held: true,
      reasons: ['uncommitted-files', 'auto-merge-armed'],
      ttlMs: 180_000,
      placement: 'sandbox',
      asleep: false
    })
    expect(edge.calls).toEqual([{ agentId: AGENT, sessionId: session }])
  })

  it('passes an unheld answer through unchanged — a clean tree is not an error', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: KEEP_ALIVE_CAPABILITIES })
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const session = await seedSessionMeta(prisma, randomUUID(), AGENT, { daemonId: DAEMON })
    const edge = fakeKeepAlive({ held: false, reasons: [], placement: 'sandbox', asleep: true })
    const running = app(githubStub([]).view, undefined, undefined, undefined, edge.control)

    expect((await post(running, session)).json()).toEqual({
      held: false,
      reasons: [],
      ttlMs: null,
      placement: 'sandbox',
      asleep: true
    })
  })

  it('409s a daemon too old to hold a lease, without asking it', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const session = await seedSessionMeta(prisma, randomUUID(), AGENT, { daemonId: DAEMON })
    const edge = fakeKeepAlive({ held: true, reasons: ['uncommitted-files'] })
    const running = app(githubStub([]).view, undefined, undefined, undefined, edge.control)

    const res = await post(running, session)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('DAEMON_FEATURE_MISSING')
    expect(edge.calls).toHaveLength(0)
  })

  it('503s an offline daemon — the page simply stops holding', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: KEEP_ALIVE_CAPABILITIES })
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const session = await seedSessionMeta(prisma, randomUUID(), AGENT, { daemonId: DAEMON })
    const edge = fakeKeepAlive(new Error('connection closed'))
    const running = app(githubStub([]).view, undefined, undefined, undefined, edge.control)

    expect((await post(running, session)).statusCode).toBe(503)
  })

  it('hides another member’s private session behind a 404, spending nothing', async () => {
    const edge = fakeKeepAlive({ held: true, reasons: ['uncommitted-files'] })
    const running = app(githubStub([]).view, undefined, undefined, undefined, edge.control)
    const owner = await makeUser(`owner-${randomUUID().slice(0, 8)}`)
    const priv = await seedAgentAndSession({ visibility: 'private', ownerIdentity: `user:${owner}` })

    const res = await post(running, priv)
    expect(res.statusCode).toBe(404)
    expect(edge.calls).toHaveLength(0)
  })
})

// The direct merge (§3.4): the same identity and the same clamped write grant as auto-merge, but the
// mutation is mergePullRequest — one press merges now rather than arming GitHub to merge later.
describe('POST /sessions/:id/pull-request/merge', () => {
  const mergeNode = (merged: boolean) =>
    graphqlOk({
      data: { repository: { pullRequest: { id: 'PR_node1', state: merged ? 'MERGED' : 'OPEN', merged } } }
    })
  const post = (running: HttpApp, sessionId: string) =>
    running.app.inject({ method: 'POST', url: `${ORG}/sessions/${sessionId}/pull-request/merge` })

  it('merges end to end under the owning agent\u2019s clamp, pinning the head the operator saw', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    const github = githubStub([
      graphqlOk(fullAnswer()), // the projection read, carrying headRefOid
      mergeNode(false),
      graphqlOk({ data: { mergePullRequest: { clientMutationId: null } } })
    ])
    const running = app(github.view, undefined, fakeGithub())

    const res = await post(running, session)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ merged: true })
    const mutation = github.calls[2] as { body: { query: string; variables: Record<string, unknown> } }
    expect(mutation.body.query).toContain('mergePullRequest')
    expect(mutation.body.query).toContain('expectedHeadOid')
    expect(mutation.body.variables).toMatchObject({ expectedHeadOid: 'sha_HEAD' })
  })

  it('refuses a read-tier agent with 403 before any GitHub call', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    const github = githubStub([graphqlOk(fullAnswer())])
    const running = app(github.view, undefined, fakeGithub('SCOPE_DENIED'))

    const res = await post(running, session)
    expect(res.statusCode).toBe(403)
    expect(github.calls).toHaveLength(0)
  })

  it('relays GitHub declining the merge as 409, not a 5xx', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    const github = githubStub([
      graphqlOk(fullAnswer()),
      mergeNode(false),
      graphqlOk({ data: null, errors: [{ type: 'UNPROCESSABLE', message: 'Pull request is not mergeable' }] })
    ])
    const running = app(github.view, undefined, fakeGithub())

    const res = await post(running, session)
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toContain('not mergeable')
  })

  it('409s when the projection carries no head oid — nothing is merged on an unverifiable head', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    const degraded = fullAnswer() as { data: { repository: { pullRequest: Record<string, unknown> } } }
    degraded.data.repository.pullRequest.headRefOid = null
    const github = githubStub([graphqlOk(degraded)])
    const running = app(github.view, undefined, fakeGithub())

    const res = await post(running, session)
    expect(res.statusCode).toBe(409)
    expect(github.calls).toHaveLength(1) // the projection read only — no mutation issued
  })

  it('404s a session with no linked run, with the GET route\u2019s exact body', async () => {
    const github = githubStub([])
    const running = app(github.view, undefined, fakeGithub())
    const bare = await seedAgentAndSession()

    const res = await post(running, bare)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual(NOT_FOUND)
    expect(github.calls).toHaveLength(0)
  })
})

// §12.6's SECOND identity source: the pull request this session worktree's own head branch has, for a
// session no pull-request run owns — the case a PR the agent opened mid-conversation always lands in.
describe('GET /sessions/:id/pull-request — the head-branch link', () => {
  const BRANCH = 'dev/jane/panel'

  // The link service as the route sees it: a scripted daemon branch read plus the `pulls` REST list.
  function linkStub(opts: { branch?: string | null; pulls?: unknown[]; latestSessionId?: string | null } = {}) {
    const calls: string[] = []
    const fetch: FetchLike = async (url) => {
      calls.push(String(url))
      return new Response(JSON.stringify(opts.pulls ?? [{ number: PULL, state: 'open', head: { ref: BRANCH } }]), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const links = new SessionPullRequestLinkService({
      clock: systemClock,
      github: {
        resolveWorkspaceRepo: async () => ({ repoId: REPO_ID, repoFullName: REPO, installationId: INSTALLATION })
      } as unknown as GithubService,
      tokens: { mintPullRequestRead: async () => ({ token: 'ghs_link' }) } as unknown as InstallationTokenService,
      readSessionBranch: async (_agent, _session, scope) => {
        calls.push(`branch:${scope}`)
        return opts.branch === undefined ? BRANCH : opts.branch
      },
      // Real repo read by default, so the shared arm's "is this the session using the checkout now"
      // question is answered by Postgres exactly as it is in production.
      latestSessionIdOfAgent: async (agent) =>
        opts.latestSessionId !== undefined
          ? opts.latestSessionId
          : new PgSessionRepo(prisma).latestSessionIdForAgent(agent.orgId, agent.id),
      fetchImpl: fetch
    })
    return { links, calls }
  }

  // Only a session-isolated worktree HAS a branch of its own — the same gate the console applies.
  async function seedSessionWorktree(): Promise<string> {
    const session = await seedAgentAndSession()
    await prisma.sessionMeta.update({ where: { id: session }, data: { workspaceIsolation: 'session' } })
    return session
  }

  it('links the pull request the branch has, and says which source named it', async () => {
    const session = await seedSessionWorktree()
    const github = githubStub([graphqlOk(fullAnswer())])
    const link = linkStub()
    const running = app(github.view, undefined, undefined, link.links)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      repoFullName: REPO,
      pullNumber: PULL,
      degraded: false,
      linkedBy: 'head-branch',
      linkBranch: BRANCH,
      linkScope: 'session',
      linkAmbiguous: false
    })
    // One REST list for identity, then the same single GraphQL projection a run-linked PR spends.
    expect(link.calls.filter((call) => call.startsWith('https'))).toHaveLength(1)
    expect(link.calls.at(-1)).toContain(`head=${encodeURIComponent(`acme:${BRANCH}`)}`)
    expect(github.calls).toHaveLength(1)
  })

  it('reports the ambiguity when the branch has more than one open pull request', async () => {
    const session = await seedSessionWorktree()
    const github = githubStub([graphqlOk(fullAnswer())])
    const link = linkStub({
      pulls: [
        { number: 9, state: 'open', head: { ref: BRANCH } },
        { number: PULL, state: 'open', head: { ref: BRANCH } }
      ]
    })
    const running = app(github.view, undefined, undefined, link.links)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })

    expect(res.json()).toMatchObject({ pullNumber: PULL, linkAmbiguous: true, linkBranch: BRANCH })
  })

  it('links a SHARED-workspace session through the agent’s primary checkout, and says which', async () => {
    // Every session on a shared-workspace agent works in that one checkout — the same one the Files
    // and Git tabs show them — so the pull request on its branch is this session's to see, labelled.
    const session = await seedAgentAndSession()
    await prisma.sessionMeta.update({ where: { id: session }, data: { workspaceIsolation: 'shared' } })
    const github = githubStub([graphqlOk(fullAnswer())])
    const link = linkStub()
    const running = app(github.view, undefined, undefined, link.links)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ pullNumber: PULL, linkedBy: 'head-branch', linkScope: 'shared' })
    // The branch was read from the PRIMARY checkout, not from a session worktree that does not exist.
    expect(link.calls[0]).toBe('branch:shared')
  })

  it('404s an OLDER shared-workspace session — the tree moved on and its branch is gone', async () => {
    // Real Postgres ordering decides "the session using it now": the newer row wins, so the older
    // session is not handed the newer one's pull request, checks and threads.
    const older = await seedAgentAndSession()
    await prisma.sessionMeta.update({
      where: { id: older },
      data: { workspaceIsolation: 'shared', lastActivityAt: new Date('2026-08-01T00:00:00Z') }
    })
    await seedSessionMeta(prisma, randomUUID(), AGENT, {
      daemonId: DAEMON,
      lastActivityAt: new Date('2026-08-20T00:00:00Z')
    })
    const github = githubStub([])
    const link = linkStub()
    const running = app(github.view, undefined, undefined, link.links)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${older}/pull-request` })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual(NOT_FOUND)
    // Refused before the daemon read, so a stale session costs nothing at all.
    expect(link.calls).toHaveLength(0)
    expect(github.calls).toHaveLength(0)
  })

  it('still 404s when the branch has no pull request — the panel keeps its create action', async () => {
    const session = await seedSessionWorktree()
    const github = githubStub([])
    const link = linkStub({ pulls: [] })
    const running = app(github.view, undefined, undefined, link.links)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual(NOT_FOUND)
    expect(github.calls).toHaveLength(0)
  })

  it('prefers the owning run and never asks the branch — the run carries review facts a branch cannot', async () => {
    const session = await seedSessionWorktree()
    await seedPullRequestRun(session)
    const github = githubStub([graphqlOk(fullAnswer())])
    const link = linkStub()
    const running = app(github.view, undefined, undefined, link.links)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })

    expect(res.json()).toMatchObject({ linkedBy: 'run', linkBranch: null, linkScope: null })
    expect(link.calls).toHaveLength(0)
  })

  it('arms merge-when-ready on a branch-linked session, under that session’s own agent', async () => {
    const session = await seedSessionWorktree()
    const github = githubStub([])
    const link = linkStub()
    const edge = fakeEdge()
    const running = app(github.view, undefined, fakeGithub(), link.links, edge.control)

    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/sessions/${session}/pull-request/auto-merge`,
      payload: { enabled: true }
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ armed: true })
    // The branch arm reaches the edge too, and asks GitHub for nothing.
    expect(edge.calls).toEqual([{ op: 'set', enabled: true }])
    expect(github.calls).toHaveLength(0)
  })
})
