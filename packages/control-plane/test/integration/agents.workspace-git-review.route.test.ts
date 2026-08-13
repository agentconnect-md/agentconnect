/**
 * The git review reads (`GET …/workspace/gitdiff`, `GET …/workspace/gitlog`) stay
 * daemon-local: the CP authorizes the agent, the session worktree and the daemon's
 * capability, proxies the outcome, and persists nothing. Every degraded answer the
 * daemon can give is data; only a rejection carries a status the console can act on.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { WORKSPACE_GIT_REVIEW_FEATURE, WORKSPACE_SESSION_READ_FEATURE } from '@agentconnect.md/protocol'
import type {
  WorkspaceGitDiffReq,
  WorkspaceGitDiffResult,
  WorkspaceGitLog,
  WorkspaceGitLogReq,
  WorkspaceGitStatus,
  WorkspaceGitStatusReq
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { NoConnection } from '../../src/orchestrator/outbound.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { ProtocolError } from '../../src/domain/errors.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a2a2a2a2-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REVIEW_CAPABILITIES = {
  platforms: ['slack'],
  runtimes: ['claude'],
  acp: true,
  features: [WORKSPACE_SESSION_READ_FEATURE, WORKSPACE_GIT_REVIEW_FEATURE]
}
const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

/** The three read seams under test, recording every forwarded REQ. */
class GitReviewSpy {
  diffCalls: Array<{ daemonId: string; req: WorkspaceGitDiffReq }> = []
  logCalls: Array<{ daemonId: string; req: WorkspaceGitLogReq }> = []
  statusCalls: Array<{ daemonId: string; req: WorkspaceGitStatusReq }> = []
  /** Set to make the next diff read fail the way a daemon `error` frame would. */
  diffFailure: Error | null = null

  async workspaceGitDiff(daemonId: string, req: WorkspaceGitDiffReq): Promise<WorkspaceGitDiffResult> {
    this.diffCalls.push({ daemonId, req })
    if (this.diffFailure) throw this.diffFailure
    return {
      agentId: req.agentId,
      path: req.path,
      isRepo: true,
      exists: true,
      diff: req.staged ? '@@ -1 +1 @@\n-staged\n+index\n' : '@@ -1 +1 @@\n-a\n+b\n',
      truncated: false
    }
  }

  async workspaceGitLog(daemonId: string, req: WorkspaceGitLogReq): Promise<WorkspaceGitLog> {
    this.logCalls.push({ daemonId, req })
    return {
      agentId: req.agentId,
      isRepo: true,
      commits: [
        {
          sha: 'a3f9c21deadbeefdeadbeefdeadbeefdeadbeef00',
          shortSha: 'a3f9c21',
          subject: 'Pin deploy image',
          author: 'Ada',
          committedAt: '2026-07-02T07:00:00Z',
          pushed: false
        }
      ],
      truncated: true,
      tracking: 'origin/main',
      // The session worktree sits on its own branch, so the daemon lists `<base>..HEAD` and says so.
      base: 'origin/main'
    }
  }

  async workspaceGitStatus(daemonId: string, req: WorkspaceGitStatusReq): Promise<WorkspaceGitStatus> {
    this.statusCalls.push({ daemonId, req })
    return {
      agentId: req.agentId,
      isRepo: true,
      clean: false,
      branch: 'work',
      files: [
        { path: 'src/app.ts', index: 'M', workingDir: ' ', additions: 128, deletions: 12 },
        { path: 'new.bin', index: '?', workingDir: '?' }
      ]
    }
  }
}

function app(control: GitReviewSpy, userId?: string): HttpApp {
  const running = buildHttpApp(
    prisma,
    userId ? { DEFAULT_OWNER_ID: userId } : undefined,
    LIVE,
    control as unknown as ControlSender
  )
  opened.push(running)
  return running
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@acme.dev`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

/** A review-capable daemon holding one github-mode agent. */
async function seedReviewAgent(features: string[] = REVIEW_CAPABILITIES.features): Promise<void> {
  await seedDaemon(prisma, DAEMON, { capabilities: { ...REVIEW_CAPABILITIES, features } })
  await seedAgent(prisma, AGENT, { daemonId: DAEMON, gitRepo: 'https://github.com/acme/repo' })
}

/** An isolated, org-visible session of AGENT — the worktree the dock reads. */
async function seedIsolatedSession(agentId = AGENT): Promise<string> {
  const id = randomUUID()
  await seedSessionMeta(prisma, id, agentId, { daemonId: DAEMON })
  await prisma.sessionMeta.update({ where: { id }, data: { workspaceIsolation: 'session' } })
  return id
}

describe('GET /agents/:id/workspace/gitdiff', () => {
  it('proxies an authorized session worktree and forwards the resolved diff scope', async () => {
    await seedReviewAgent()
    const session = await seedIsolatedSession()
    const control = new GitReviewSpy()
    const running = app(control)

    const unstaged = await running.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitdiff?sessionId=${session}&path=src/app.ts`
    })
    expect(unstaged.statusCode).toBe(200)
    expect(unstaged.json()).toEqual({
      path: 'src/app.ts',
      isRepo: true,
      exists: true,
      diff: '@@ -1 +1 @@\n-a\n+b\n',
      binary: false,
      truncated: false
    })

    const staged = await running.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitdiff?sessionId=${session}&path=src/app.ts&scope=staged`
    })
    expect(staged.statusCode).toBe(200)
    expect(control.diffCalls).toEqual([
      { daemonId: DAEMON, req: { agentId: AGENT, sessionId: session, path: 'src/app.ts', staged: false } },
      { daemonId: DAEMON, req: { agentId: AGENT, sessionId: session, path: 'src/app.ts', staged: true } }
    ])

    // The scope is a closed vocabulary, so a querystring boolean cannot flip the
    // side by accident — an unknown value is refused before any daemon I/O.
    const bogus = await running.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitdiff?path=src/app.ts&scope=cached`
    })
    expect(bogus.statusCode).toBe(400)
    expect(control.diffCalls).toHaveLength(2)
  })

  it('reads the primary checkout when no session is named, with no session gates in the way', async () => {
    // No WORKSPACE_SESSION_READ_FEATURE: an unscoped read must not pay that gate.
    await seedReviewAgent([WORKSPACE_GIT_REVIEW_FEATURE])
    const control = new GitReviewSpy()

    const res = await app(control).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitdiff?path=README.md`
    })
    expect(res.statusCode).toBe(200)
    expect(control.diffCalls).toEqual([{ daemonId: DAEMON, req: { agentId: AGENT, path: 'README.md', staged: false } }])
  })

  it('refuses every worktree the session gate does not authorize, before any daemon I/O', async () => {
    await seedReviewAgent()
    const otherAgent = randomUUID()
    await seedAgent(prisma, otherAgent, { daemonId: DAEMON })
    const shared = randomUUID()
    const purged = randomUUID()
    const foreign = await seedIsolatedSession(otherAgent) // isolated, but not this agent's
    await seedSessionMeta(prisma, shared, AGENT, { daemonId: DAEMON })
    await seedSessionMeta(prisma, purged, AGENT, { daemonId: DAEMON })
    await prisma.sessionMeta.update({ where: { id: shared }, data: { workspaceIsolation: 'shared' } })
    await prisma.sessionMeta.update({
      where: { id: purged },
      data: { workspaceIsolation: 'session', contentPurgedAt: new Date(), contentPurgedReason: 'retention' }
    })
    const control = new GitReviewSpy()
    const running = app(control)

    for (const sessionId of [shared, purged, foreign, randomUUID()]) {
      const res = await running.app.inject({
        method: 'GET',
        url: `${ORG}/agents/${AGENT}/workspace/gitdiff?sessionId=${sessionId}&path=src/app.ts`
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ message: 'workspace not found' })
    }
    expect(control.diffCalls).toHaveLength(0)
  })

  it('hides another member’s private session behind the same 404', async () => {
    await seedReviewAgent()
    const mine = await makeUser(`gd-mine-${randomUUID()}`, 'collaborator')
    const theirs = await makeUser(`gd-theirs-${randomUUID()}`, 'collaborator')
    const session = randomUUID()
    await seedSessionMeta(prisma, session, AGENT, {
      daemonId: DAEMON,
      visibility: 'private',
      ownerIdentity: `user:${theirs}`
    })
    await prisma.sessionMeta.update({ where: { id: session }, data: { workspaceIsolation: 'session' } })
    const control = new GitReviewSpy()

    const denied = await app(control, mine).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitdiff?sessionId=${session}&path=src/app.ts`
    })
    expect(denied.statusCode).toBe(404)
    expect(control.diffCalls).toHaveLength(0)

    const owner = await app(control, theirs).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitdiff?sessionId=${session}&path=src/app.ts`
    })
    expect(owner.statusCode).toBe(200)
    expect(control.diffCalls).toHaveLength(1)
  })

  it('reads a restricted agent and a foreign org’s agent as absent', async () => {
    const other = await makeUser(`gd-other-${randomUUID()}`, 'collaborator')
    await seedDaemon(prisma, DAEMON, { capabilities: REVIEW_CAPABILITIES })
    await seedAgent(prisma, AGENT, {
      daemonId: DAEMON,
      visibility: 'restricted',
      sharedWith: [DEFAULT_OWNER_ID]
    })
    const foreignOrg = `org-foreign-${randomUUID().slice(0, 8)}`
    const foreignAgent = randomUUID()
    await prisma.org.create({ data: { id: foreignOrg, slug: foreignOrg } })
    await prisma.agent.create({
      data: { id: foreignAgent, orgId: foreignOrg, name: 'foreign-bot', runtime: 'claude', daemonId: null }
    })
    const control = new GitReviewSpy()

    const restricted = await app(control, other).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitdiff?path=README.md`
    })
    expect(restricted.statusCode).toBe(404)
    expect(restricted.json()).toMatchObject({ message: 'agent not found' })

    const crossOrg = await app(control).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${foreignAgent}/workspace/gitdiff?path=README.md`
    })
    expect(crossOrg.statusCode).toBe(404)
    expect(control.diffCalls).toHaveLength(0)
  })

  it('answers an unplaced agent 503 without touching the wire', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: REVIEW_CAPABILITIES })
    await seedAgent(prisma, AGENT) // no daemonId
    const control = new GitReviewSpy()

    const res = await app(control).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitdiff?path=README.md`
    })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ message: 'agent has no live daemon' })
    expect(control.diffCalls).toHaveLength(0)
  })

  it('refuses a daemon that does not advertise git review, rather than sending a frame it would drop', async () => {
    await seedReviewAgent([WORKSPACE_SESSION_READ_FEATURE])
    const control = new GitReviewSpy()

    const res = await app(control).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitdiff?path=README.md`
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    expect(control.diffCalls).toHaveLength(0)
  })

  it('refuses a session-scoped read on a daemon that cannot resolve worktrees', async () => {
    await seedReviewAgent([WORKSPACE_GIT_REVIEW_FEATURE])
    const session = await seedIsolatedSession()
    const control = new GitReviewSpy()

    const res = await app(control).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitdiff?sessionId=${session}&path=src/app.ts`
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ message: 'this agent version does not support session worktree browsing' })
    expect(control.diffCalls).toHaveLength(0)
  })

  it('maps a daemon rejection to the status and code its reason names', async () => {
    await seedReviewAgent()
    const control = new GitReviewSpy()
    const running = app(control)
    const read = () => running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/workspace/gitdiff?path=src` })

    control.diffFailure = new ProtocolError(
      'BAD_PAYLOAD',
      'workspace/gitdiff failed: path escapes the workspace root',
      {
        details: { reason: 'path-escape' }
      }
    )
    const escaped = await read()
    expect(escaped.statusCode).toBe(400)
    expect(escaped.json()).toMatchObject({ code: 'WORKSPACE_PATH_ESCAPE' })

    control.diffFailure = new ProtocolError('BAD_PAYLOAD', 'workspace/gitdiff failed: unknown agent "a2"', {
      details: { reason: 'unknown-agent' }
    })
    const unknown = await read()
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toMatchObject({ message: 'workspace not found', code: 'WORKSPACE_UNKNOWN_AGENT' })

    // An older daemon names no reason, so the read keeps the honest "may be offline"
    // 503 instead of the CP inventing a status from a prose message.
    control.diffFailure = new ProtocolError('BAD_PAYLOAD', 'workspace/gitdiff failed')
    expect((await read()).statusCode).toBe(503)

    control.diffFailure = new NoConnection(DAEMON)
    const offline = await read()
    expect(offline.statusCode).toBe(503)
    expect(offline.json()).toMatchObject({ message: 'owning daemon is offline' })
  })
})

describe('GET /agents/:id/workspace/gitlog', () => {
  it('proxies the log with the default limit and refuses one past the wire cap', async () => {
    await seedReviewAgent()
    const session = await seedIsolatedSession()
    const control = new GitReviewSpy()
    const running = app(control)

    const res = await running.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitlog?sessionId=${session}`
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      isRepo: true,
      commits: [
        {
          sha: 'a3f9c21deadbeefdeadbeefdeadbeefdeadbeef00',
          shortSha: 'a3f9c21',
          subject: 'Pin deploy image',
          author: 'Ada',
          committedAt: '2026-07-02T07:00:00Z',
          pushed: false
        }
      ],
      truncated: true,
      tracking: 'origin/main',
      base: 'origin/main'
    })

    const capped = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/workspace/gitlog?limit=51` })
    expect(capped.statusCode).toBe(400)
    const explicit = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/workspace/gitlog?limit=5` })
    expect(explicit.statusCode).toBe(200)
    expect(control.logCalls.map((c) => c.req)).toEqual([
      { agentId: AGENT, sessionId: session, limit: 20 },
      { agentId: AGENT, limit: 5 }
    ])
  })

  it('carries the same agent, session and capability gates as the diff read', async () => {
    await seedReviewAgent([WORKSPACE_SESSION_READ_FEATURE])
    const shared = randomUUID()
    await seedSessionMeta(prisma, shared, AGENT, { daemonId: DAEMON })
    await prisma.sessionMeta.update({ where: { id: shared }, data: { workspaceIsolation: 'shared' } })
    const control = new GitReviewSpy()
    const running = app(control)

    const sharedWorktree = await running.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitlog?sessionId=${shared}`
    })
    expect(sharedWorktree.statusCode).toBe(404)

    const uncapable = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/workspace/gitlog` })
    expect(uncapable.statusCode).toBe(409)
    expect(uncapable.json()).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    expect(control.logCalls).toHaveLength(0)
  })
})

describe('GET /agents/:id/workspace/gitstatus', () => {
  it('projects per-file additions/deletions and nulls them where the daemon reports none', async () => {
    await seedReviewAgent()
    const control = new GitReviewSpy()

    const res = await app(control).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitstatus`
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { files: unknown[] }).files).toEqual([
      { path: 'src/app.ts', index: 'M', workingDir: ' ', additions: 128, deletions: 12 },
      { path: 'new.bin', index: '?', workingDir: '?', additions: null, deletions: null }
    ])
  })

  it('stays readable on a daemon without the git review feature (the counts are optional, not gated)', async () => {
    await seedReviewAgent([WORKSPACE_SESSION_READ_FEATURE])
    const session = await seedIsolatedSession()
    const control = new GitReviewSpy()

    const res = await app(control).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitstatus?sessionId=${session}`
    })
    expect(res.statusCode).toBe(200)
    expect(control.statusCalls).toHaveLength(1)
  })
})
