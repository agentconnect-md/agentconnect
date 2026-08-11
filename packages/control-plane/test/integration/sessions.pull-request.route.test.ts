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
import { GitCredDeniedError, type GithubService } from '../../src/github/service.js'
import type { InstallationTokenService } from '../../src/github/installation-token.service.js'
import type { FetchLike } from '../../src/github/api.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { systemClock } from '../../src/domain/clock.js'

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
          state: 'OPEN',
          isDraft: false,
          merged: false,
          additions: 120,
          deletions: 8,
          url: `https://github.com/${REPO}/pull/${PULL}`,
          baseRefName: 'main',
          headRefName: 'feat/panel',
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

function app(view?: PullRequestViewService, userId?: string, github?: GithubService): HttpApp {
  const running = buildHttpApp(prisma, userId ? { DEFAULT_OWNER_ID: userId } : undefined, undefined, undefined, {
    ...(view ? { pullRequestView: view } : {}),
    ...(github ? { github } : {})
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

async function seedAgentAndSession(opts: { visibility?: 'org' | 'private'; ownerIdentity?: string } = {}) {
  await seedDaemon(prisma, DAEMON)
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
      autoMergeArmed: false,
      canArmAutoMerge: false,
      degraded: false,
      degradedReason: null,
      agentReview: null
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

// The M6 write (§7): auto-merge armed under the owning agent's clamp, refusals as data-bearing statuses.
describe('POST /sessions/:id/pull-request/auto-merge', () => {
  const nodeAnswer = (armed: boolean) =>
    graphqlOk({
      data: { repository: { pullRequest: { id: 'PR_node1', autoMergeRequest: armed ? { enabledAt: 'now' } : null } } }
    })
  const post = (running: HttpApp, sessionId: string, enabled = true) =>
    running.app.inject({
      method: 'POST',
      url: `${ORG}/sessions/${sessionId}/pull-request/auto-merge`,
      payload: { enabled }
    })

  it('arms auto-merge end to end and reports canArmAutoMerge on the read', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    const github = githubStub([
      nodeAnswer(false),
      graphqlOk({ data: { enablePullRequestAutoMerge: { clientMutationId: null } } }),
      graphqlOk(fullAnswer())
    ])
    const running = app(github.view, undefined, fakeGithub())

    const res = await post(running, session)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ armed: true })
    expect((github.calls[1] as { body: { query: string } }).body.query).toContain('enablePullRequestAutoMerge')

    // The write-capable caller reads canArmAutoMerge: true — the flag behind the panel's enabled control.
    const read = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })
    expect(read.json()).toMatchObject({ canArmAutoMerge: true })
  })

  it('refuses a read-tier agent with 403 before any GitHub call — the disabled-control contract', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    const github = githubStub([graphqlOk(fullAnswer())])
    const running = app(github.view, undefined, fakeGithub('SCOPE_DENIED'))

    const res = await post(running, session)
    expect(res.statusCode).toBe(403)
    expect(github.calls).toHaveLength(0)

    // And the read-side flag agrees, so the console never offered the control in the first place.
    const read = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${session}/pull-request` })
    expect(read.json()).toMatchObject({ canArmAutoMerge: false })
  })

  it('relays GitHub declining the state change as 409, not a 5xx', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session)
    const github = githubStub([
      nodeAnswer(false),
      graphqlOk({ data: null, errors: [{ type: 'UNPROCESSABLE', message: 'Pull request is in clean status' }] })
    ])
    const running = app(github.view, undefined, fakeGithub())

    const res = await post(running, session)
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toContain('clean status')
  })

  it('403s a run whose owning agent is gone — the write rides the agent authorization, which no longer exists', async () => {
    const session = await seedAgentAndSession()
    await seedPullRequestRun(session, { agentId: null })
    const github = githubStub([])
    const running = app(github.view, undefined, fakeGithub())

    const res = await post(running, session)
    expect(res.statusCode).toBe(403)
    expect(github.calls).toHaveLength(0)
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

  it('hides another member\u2019s private session behind the same 404, spending nothing', async () => {
    const github = githubStub([])
    const running = app(github.view, undefined, fakeGithub())
    const owner = await makeUser(`owner-${randomUUID().slice(0, 8)}`)
    const priv = await seedAgentAndSession({ visibility: 'private', ownerIdentity: `user:${owner}` })
    await seedPullRequestRun(priv)

    const res = await post(running, priv)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual(NOT_FOUND)
    expect(github.calls).toHaveLength(0)
  })
})
