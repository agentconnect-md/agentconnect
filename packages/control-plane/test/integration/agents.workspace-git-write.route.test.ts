/**
 * The console's git writes (`POST …/workspace/gitstage | gitunstage | gitcommit |
 * gitpush | gitmessage`) stay daemon-local: the CP authorizes the writer, the agent, the
 * session worktree and the daemon's capability, forwards, and persists nothing — no diff,
 * no commit content, no drafted message. Every degraded git answer is data; only a
 * refused caller, a refused payload or an unreachable daemon carries a status.
 *
 * The denial matrix runs over ALL FIVE routes, because a gate that guards four of them is
 * a gate the fifth does not have.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  MAX_WORKSPACE_COMMIT_MESSAGE,
  MAX_WORKSPACE_STAGE_PATHS,
  WORKSPACE_GIT_MESSAGE_FEATURE,
  WORKSPACE_GIT_WRITE_FEATURE,
  WORKSPACE_SESSION_READ_FEATURE
} from '@agentconnect.md/protocol'
import type {
  WorkspaceGitCommitReq,
  WorkspaceGitCommitResult,
  WorkspaceGitMessageReq,
  WorkspaceGitMessageResult,
  WorkspaceGitPushReq,
  WorkspaceGitPushResult,
  WorkspaceGitStageReq,
  WorkspaceGitStatus
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
const DAEMON = 'd3d3d3d3-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a3a3a3a3-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WRITE_FEATURES = [WORKSPACE_SESSION_READ_FEATURE, WORKSPACE_GIT_WRITE_FEATURE, WORKSPACE_GIT_MESSAGE_FEATURE]
const CAPABILITIES = { platforms: ['slack'], runtimes: ['claude'], acp: true, features: WRITE_FEATURES }
const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

/** The five write seams under test, recording every forwarded REQ. */
class GitWriteSpy {
  stageCalls: Array<{ daemonId: string; req: WorkspaceGitStageReq }> = []
  unstageCalls: Array<{ daemonId: string; req: WorkspaceGitStageReq }> = []
  commitCalls: Array<{ daemonId: string; req: WorkspaceGitCommitReq }> = []
  pushCalls: Array<{ daemonId: string; req: WorkspaceGitPushReq }> = []
  messageCalls: Array<{ daemonId: string; req: WorkspaceGitMessageReq }> = []
  /** Set to make the next write fail the way a daemon `error` frame would. */
  failure: Error | null = null

  /** Every forwarded REQ across all five seams — what "zero daemon calls" is measured on. */
  get all(): unknown[] {
    return [...this.stageCalls, ...this.unstageCalls, ...this.commitCalls, ...this.pushCalls, ...this.messageCalls]
  }

  private throwIfArmed(): void {
    if (this.failure) throw this.failure
  }

  async workspaceGitStage(daemonId: string, req: WorkspaceGitStageReq): Promise<WorkspaceGitStatus> {
    this.stageCalls.push({ daemonId, req })
    this.throwIfArmed()
    return {
      agentId: req.agentId,
      isRepo: true,
      clean: false,
      branch: 'work',
      files: [{ path: 'src/app.ts', index: 'M', workingDir: ' ', additions: 4, deletions: 1 }]
    }
  }

  async workspaceGitUnstage(daemonId: string, req: WorkspaceGitStageReq): Promise<WorkspaceGitStatus> {
    this.unstageCalls.push({ daemonId, req })
    this.throwIfArmed()
    return {
      agentId: req.agentId,
      isRepo: true,
      clean: false,
      branch: 'work',
      files: [{ path: 'src/app.ts', index: ' ', workingDir: 'M' }]
    }
  }

  async workspaceGitCommit(daemonId: string, req: WorkspaceGitCommitReq): Promise<WorkspaceGitCommitResult> {
    this.commitCalls.push({ daemonId, req })
    this.throwIfArmed()
    return {
      agentId: req.agentId,
      isRepo: true,
      ok: true,
      sha: 'c0ffee1234567890abcdef1234567890abcdef12',
      detail: 'Committed 1 file.'
    }
  }

  async workspaceGitPush(daemonId: string, req: WorkspaceGitPushReq): Promise<WorkspaceGitPushResult> {
    this.pushCalls.push({ daemonId, req })
    this.throwIfArmed()
    return { agentId: req.agentId, isRepo: true, ok: true, detail: 'Pushed 1 commit.', ahead: 0 }
  }

  async workspaceGitMessage(daemonId: string, req: WorkspaceGitMessageReq): Promise<WorkspaceGitMessageResult> {
    this.messageCalls.push({ daemonId, req })
    this.throwIfArmed()
    return { agentId: req.agentId, ok: true, message: 'feat(dock): stage files from the git panel' }
  }
}

function app(control: GitWriteSpy, userId?: string): HttpApp {
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

/** A write-capable daemon holding one github-mode agent. */
async function seedWriteAgent(features: string[] = WRITE_FEATURES): Promise<void> {
  await seedDaemon(prisma, DAEMON, { capabilities: { ...CAPABILITIES, features } })
  await seedAgent(prisma, AGENT, { daemonId: DAEMON, gitRepo: 'https://github.com/acme/repo' })
}

/** An isolated, org-visible session of AGENT — the worktree the dock writes to. */
async function seedIsolatedSession(agentId = AGENT): Promise<string> {
  const id = randomUUID()
  await seedSessionMeta(prisma, id, agentId, { daemonId: DAEMON })
  await prisma.sessionMeta.update({ where: { id }, data: { workspaceIsolation: 'session' } })
  return id
}

/** One write route, addressable with or without a session scope. */
interface WriteRoute {
  name: string
  path: string
  payload?: unknown
}
const STAGE: WriteRoute = { name: 'gitstage', path: 'gitstage', payload: { paths: ['src/app.ts'] } }
const UNSTAGE: WriteRoute = { name: 'gitunstage', path: 'gitunstage', payload: { paths: ['src/app.ts'] } }
const COMMIT: WriteRoute = { name: 'gitcommit', path: 'gitcommit', payload: { message: 'fix: typo' } }
const PUSH: WriteRoute = { name: 'gitpush', path: 'gitpush' }
const MESSAGE: WriteRoute = { name: 'gitmessage', path: 'gitmessage' }
const ROUTES: WriteRoute[] = [STAGE, UNSTAGE, COMMIT, PUSH, MESSAGE]

function url(route: WriteRoute, sessionId?: string, agentId = AGENT): string {
  const scope = sessionId ? `?sessionId=${sessionId}` : ''
  return `${ORG}/agents/${agentId}/workspace/${route.path}${scope}`
}

function post(running: HttpApp, route: WriteRoute, sessionId?: string, agentId = AGENT) {
  return running.app.inject({
    method: 'POST',
    url: url(route, sessionId, agentId),
    ...(route.payload ? { payload: route.payload } : {})
  })
}

describe('POST /agents/:id/workspace/git{stage,unstage,commit,push,message} — authorization', () => {
  it('rejects a viewer-role member on every route, before any daemon I/O', async () => {
    await seedWriteAgent()
    const viewer = await makeUser(`gw-viewer-${randomUUID()}`, 'viewer')
    const control = new GitWriteSpy()
    const running = app(control, viewer)

    for (const route of ROUTES) {
      const res = await post(running, route)
      expect(res.statusCode, route.name).toBe(403)
      expect(res.json(), route.name).toMatchObject({ message: 'viewers are read-only' })
    }
    expect(control.all).toHaveLength(0)
  })

  it('reads a restricted agent and a foreign org’s agent as absent on every route', async () => {
    const other = await makeUser(`gw-other-${randomUUID()}`, 'collaborator')
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABILITIES })
    await seedAgent(prisma, AGENT, { daemonId: DAEMON, visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] })
    const foreignOrg = `org-foreign-${randomUUID().slice(0, 8)}`
    const foreignAgent = randomUUID()
    await prisma.org.create({ data: { id: foreignOrg, slug: foreignOrg } })
    await prisma.agent.create({
      data: { id: foreignAgent, orgId: foreignOrg, name: 'foreign-bot', runtime: 'claude', daemonId: DAEMON }
    })
    const control = new GitWriteSpy()
    const outsider = app(control, other)
    const insider = app(control)

    for (const route of ROUTES) {
      const restricted = await post(outsider, route)
      expect(restricted.statusCode, route.name).toBe(404)
      expect(restricted.json(), route.name).toMatchObject({ message: 'agent not found' })

      const crossOrg = await post(insider, route, undefined, foreignAgent)
      expect(crossOrg.statusCode, route.name).toBe(404)
      expect(crossOrg.json(), route.name).toMatchObject({ message: 'agent not found' })
    }
    expect(control.all).toHaveLength(0)
  })

  it('refuses every worktree the session gate does not authorize, on every route', async () => {
    await seedWriteAgent()
    const otherAgent = randomUUID()
    await seedAgent(prisma, otherAgent, { daemonId: DAEMON })
    const foreign = await seedIsolatedSession(otherAgent) // isolated, but not this agent's
    const shared = randomUUID()
    const purged = randomUUID()
    await seedSessionMeta(prisma, shared, AGENT, { daemonId: DAEMON })
    await seedSessionMeta(prisma, purged, AGENT, { daemonId: DAEMON })
    await prisma.sessionMeta.update({ where: { id: shared }, data: { workspaceIsolation: 'shared' } })
    await prisma.sessionMeta.update({
      where: { id: purged },
      data: { workspaceIsolation: 'session', contentPurgedAt: new Date(), contentPurgedReason: 'retention' }
    })
    const control = new GitWriteSpy()
    const running = app(control)

    for (const route of ROUTES) {
      for (const sessionId of [shared, purged, foreign, randomUUID()]) {
        const res = await post(running, route, sessionId)
        expect(res.statusCode, `${route.name} ${sessionId}`).toBe(404)
        expect(res.json(), route.name).toMatchObject({ message: 'workspace not found' })
      }
    }
    expect(control.all).toHaveLength(0)
  })

  it('hides another member’s private session behind the same 404, and lets its owner write', async () => {
    await seedWriteAgent()
    const mine = await makeUser(`gw-mine-${randomUUID()}`, 'collaborator')
    const theirs = await makeUser(`gw-theirs-${randomUUID()}`, 'collaborator')
    const session = randomUUID()
    await seedSessionMeta(prisma, session, AGENT, {
      daemonId: DAEMON,
      visibility: 'private',
      ownerIdentity: `user:${theirs}`
    })
    await prisma.sessionMeta.update({ where: { id: session }, data: { workspaceIsolation: 'session' } })
    const control = new GitWriteSpy()
    const intruder = app(control, mine)
    const owner = app(control, theirs)

    for (const route of ROUTES) {
      const denied = await post(intruder, route, session)
      expect(denied.statusCode, route.name).toBe(404)
    }
    expect(control.all).toHaveLength(0)

    for (const route of ROUTES) {
      const allowed = await post(owner, route, session)
      expect(allowed.statusCode, route.name).toBe(200)
    }
    expect(control.all).toHaveLength(ROUTES.length)
  })

  it('answers an unplaced agent 503 on every route, without touching the wire', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABILITIES })
    await seedAgent(prisma, AGENT) // no daemonId
    const control = new GitWriteSpy()
    const running = app(control)

    for (const route of ROUTES) {
      const res = await post(running, route)
      expect(res.statusCode, route.name).toBe(503)
      expect(res.json(), route.name).toMatchObject({ message: 'agent has no live daemon' })
    }
    expect(control.all).toHaveLength(0)
  })

  it('refuses a daemon without the write feature, rather than sending a frame it would drop', async () => {
    await seedWriteAgent([WORKSPACE_SESSION_READ_FEATURE, WORKSPACE_GIT_MESSAGE_FEATURE])
    const control = new GitWriteSpy()
    const running = app(control)

    for (const route of ROUTES.filter((r) => r.name !== 'gitmessage')) {
      const res = await post(running, route)
      expect(res.statusCode, route.name).toBe(409)
      expect(res.json(), route.name).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    }
    expect(control.all).toHaveLength(0)

    // The wand rides its OWN feature, so a daemon that can draft but not write still drafts.
    const drafted = await post(running, MESSAGE)
    expect(drafted.statusCode).toBe(200)
    expect(control.messageCalls).toHaveLength(1)
  })

  it('refuses the wand alone on a daemon that writes but cannot draft', async () => {
    await seedWriteAgent([WORKSPACE_SESSION_READ_FEATURE, WORKSPACE_GIT_WRITE_FEATURE])
    const control = new GitWriteSpy()
    const running = app(control)

    const drafted = await post(running, MESSAGE)
    expect(drafted.statusCode).toBe(409)
    expect(drafted.json()).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    expect(control.messageCalls).toHaveLength(0)

    const staged = await post(running, STAGE)
    expect(staged.statusCode).toBe(200)
  })

  it('refuses a session-scoped write on a daemon that cannot resolve worktrees', async () => {
    await seedWriteAgent([WORKSPACE_GIT_WRITE_FEATURE, WORKSPACE_GIT_MESSAGE_FEATURE])
    const session = await seedIsolatedSession()
    const control = new GitWriteSpy()
    const running = app(control)

    for (const route of ROUTES) {
      const scoped = await post(running, route, session)
      expect(scoped.statusCode, route.name).toBe(409)
      expect(scoped.json(), route.name).toMatchObject({
        message: 'this agent version does not support session worktree browsing'
      })
    }
    expect(control.all).toHaveLength(0)

    // The primary checkout needs no worktree resolution, so it must not pay that gate.
    const primary = await post(running, STAGE)
    expect(primary.statusCode).toBe(200)
  })
})

describe('POST /agents/:id/workspace/gitstage | gitunstage', () => {
  it('forwards the selection and answers with the FRESH status, config folded in', async () => {
    await seedWriteAgent()
    const session = await seedIsolatedSession()
    const control = new GitWriteSpy()
    const running = app(control)

    const staged = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/gitstage?sessionId=${session}`,
      payload: { paths: ['src/app.ts', 'docs/README.md'] }
    })
    expect(staged.statusCode).toBe(200)
    expect(staged.json()).toMatchObject({
      isRepo: true,
      clean: false,
      repo: 'https://github.com/acme/repo',
      branch: 'work',
      files: [{ path: 'src/app.ts', index: 'M', workingDir: ' ', additions: 4, deletions: 1 }]
    })
    expect(control.stageCalls).toEqual([
      { daemonId: DAEMON, req: { agentId: AGENT, sessionId: session, paths: ['src/app.ts', 'docs/README.md'] } }
    ])

    const unstaged = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/gitunstage`,
      payload: { paths: ['src/app.ts'] }
    })
    expect(unstaged.statusCode).toBe(200)
    expect((unstaged.json() as { files: unknown[] }).files).toEqual([
      { path: 'src/app.ts', index: ' ', workingDir: 'M', additions: null, deletions: null }
    ])
    // No sessionId on the wire for a primary-checkout write — an absent scope is absent.
    expect(control.unstageCalls).toEqual([{ daemonId: DAEMON, req: { agentId: AGENT, paths: ['src/app.ts'] } }])
  })

  it('accepts an empty selection as data and refuses a selection past the wire caps', async () => {
    await seedWriteAgent()
    const control = new GitWriteSpy()
    const running = app(control)

    const empty = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/gitstage`,
      payload: { paths: [] }
    })
    expect(empty.statusCode).toBe(200)

    const tooMany = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/gitstage`,
      payload: { paths: Array.from({ length: MAX_WORKSPACE_STAGE_PATHS + 1 }, (_, i) => `f${i}.ts`) }
    })
    expect(tooMany.statusCode).toBe(400)

    // Inside the count cap, past the byte cap: refused here rather than on the daemon.
    const tooWide = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/gitstage`,
      payload: { paths: Array.from({ length: 16 }, (_, i) => String(i).padStart(4096, 'q')) }
    })
    expect(tooWide.statusCode).toBe(400)

    const unknownField = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/gitstage`,
      payload: { paths: ['a.ts'], force: true }
    })
    expect(unknownField.statusCode).toBe(400)

    expect(control.stageCalls).toHaveLength(1) // only the empty selection reached the daemon
  })
})

describe('POST /agents/:id/workspace/gitcommit', () => {
  it('forwards the message and projects the new commit', async () => {
    await seedWriteAgent()
    const control = new GitWriteSpy()

    const res = await app(control).app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/gitcommit`,
      payload: { message: 'feat(dock): stage from the git panel\n\nWith a body.' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      isRepo: true,
      ok: true,
      sha: 'c0ffee1234567890abcdef1234567890abcdef12',
      detail: 'Committed 1 file.',
      reason: null
    })
    expect(control.commitCalls[0]?.req.message).toBe('feat(dock): stage from the git panel\n\nWith a body.')
  })

  it('keeps a daemon refusal as a 200 carrying its machine reason', async () => {
    await seedWriteAgent()
    const control = new GitWriteSpy()
    control.workspaceGitCommit = async (daemonId, req) => {
      control.commitCalls.push({ daemonId, req })
      return {
        agentId: req.agentId,
        isRepo: true,
        ok: false,
        detail: 'No commit identity is registered for this daemon.',
        reason: 'no-identity'
      }
    }

    const res = await app(control).app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/gitcommit`,
      payload: { message: 'fix: typo' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: false, sha: null, reason: 'no-identity' })
  })

  it('refuses a missing or over-cap message before any daemon I/O', async () => {
    await seedWriteAgent()
    const control = new GitWriteSpy()
    const running = app(control)

    for (const payload of [{}, { message: '' }, { message: 'x'.repeat(MAX_WORKSPACE_COMMIT_MESSAGE + 1) }]) {
      const res = await running.app.inject({
        method: 'POST',
        url: `${ORG}/agents/${AGENT}/workspace/gitcommit`,
        payload
      })
      expect(res.statusCode).toBe(400)
    }
    expect(control.commitCalls).toHaveLength(0)
  })
})

describe('POST /agents/:id/workspace/gitpush', () => {
  it('projects a successful push and keeps a rejection as data with its reason', async () => {
    await seedWriteAgent()
    const control = new GitWriteSpy()
    const running = app(control)

    const pushed = await running.app.inject({ method: 'POST', url: `${ORG}/agents/${AGENT}/workspace/gitpush` })
    expect(pushed.statusCode).toBe(200)
    expect(pushed.json()).toEqual({ isRepo: true, ok: true, detail: 'Pushed 1 commit.', ahead: 0, reason: null })
    expect(control.pushCalls).toEqual([{ daemonId: DAEMON, req: { agentId: AGENT } }])

    // The console posts `{}` at a bodyless route (as it does for the pull); an empty
    // object must not read as an unexpected payload.
    for (const path of ['gitpush', 'gitmessage']) {
      const withEmptyBody = await running.app.inject({
        method: 'POST',
        url: `${ORG}/agents/${AGENT}/workspace/${path}`,
        payload: {}
      })
      expect(withEmptyBody.statusCode, path).toBe(200)
    }

    control.workspaceGitPush = async (daemonId, req) => {
      control.pushCalls.push({ daemonId, req })
      return {
        agentId: req.agentId,
        isRepo: true,
        ok: false,
        detail: 'Rejected — the remote has commits this branch does not. Pull, then push.',
        ahead: 3,
        reason: 'diverged'
      }
    }
    const diverged = await running.app.inject({ method: 'POST', url: `${ORG}/agents/${AGENT}/workspace/gitpush` })
    expect(diverged.statusCode).toBe(200)
    expect(diverged.json()).toMatchObject({ ok: false, ahead: 3, reason: 'diverged' })
  })
})

describe('POST /agents/:id/workspace/gitmessage', () => {
  it('proxies the drafted message without storing it, and keeps a decline as data', async () => {
    await seedWriteAgent()
    const session = await seedIsolatedSession()
    const control = new GitWriteSpy()
    const running = app(control)

    const drafted = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/gitmessage?sessionId=${session}`
    })
    expect(drafted.statusCode).toBe(200)
    expect(drafted.json()).toEqual({
      ok: true,
      message: 'feat(dock): stage files from the git panel',
      detail: null
    })
    expect(control.messageCalls).toEqual([{ daemonId: DAEMON, req: { agentId: AGENT, sessionId: session } }])
    // Body-locality: the draft is proxied, never persisted against the session or agent.
    const stored = await prisma.sessionMeta.findUnique({ where: { id: session } })
    expect(JSON.stringify(stored)).not.toContain('stage files from the git panel')

    control.workspaceGitMessage = async (daemonId, req) => {
      control.messageCalls.push({ daemonId, req })
      return { agentId: req.agentId, ok: false, detail: 'Nothing is staged, so there is nothing to describe.' }
    }
    const declined = await running.app.inject({ method: 'POST', url: `${ORG}/agents/${AGENT}/workspace/gitmessage` })
    expect(declined.statusCode).toBe(200)
    expect(declined.json()).toEqual({
      ok: false,
      message: null,
      detail: 'Nothing is staged, so there is nothing to describe.'
    })
  })
})

describe('workspace git write failure mapping', () => {
  it('keeps a mutation’s own status whatever the daemon names, with the reason as a code', async () => {
    await seedWriteAgent()
    const control = new GitWriteSpy()
    const running = app(control)
    const stage = () =>
      running.app.inject({
        method: 'POST',
        url: `${ORG}/agents/${AGENT}/workspace/gitstage`,
        payload: { paths: ['src/app.ts'] }
      })

    // The agent is working in its workspace: a write that was not performed is 409,
    // never the 404 the read path would give an unknown worktree.
    control.failure = new ProtocolError(
      'CONFLICT',
      'workspace/gitstage failed: the agent is working in this workspace; retry when it is idle',
      { details: { reason: 'stale' } }
    )
    const busy = await stage()
    expect(busy.statusCode).toBe(409)
    expect(busy.json()).toMatchObject({ code: 'WORKSPACE_STALE' })

    // An unknown agent is a refused PAYLOAD on a write, so it stays 400 — the write
    // route must not report a mutation as a resource that is absent.
    control.failure = new ProtocolError('BAD_PAYLOAD', 'workspace/gitstage failed: unknown agent "a3"', {
      details: { reason: 'unknown-agent' }
    })
    const unknown = await stage()
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json()).toMatchObject({ code: 'WORKSPACE_UNKNOWN_AGENT' })

    // An older daemon names no reason: still the mutation's 400, just with no code.
    control.failure = new ProtocolError('BAD_PAYLOAD', 'workspace/gitstage failed')
    const reasonless = await stage()
    expect(reasonless.statusCode).toBe(400)
    expect(reasonless.json()).not.toHaveProperty('code')

    // An INTERNAL frame is a daemon-side failure the console cannot act on: 503.
    control.failure = new ProtocolError('INTERNAL', 'workspace/gitstage failed')
    expect((await stage()).statusCode).toBe(503)

    control.failure = new NoConnection(DAEMON)
    const offline = await stage()
    expect(offline.statusCode).toBe(503)
    expect(offline.json()).toMatchObject({ message: 'owning daemon is offline' })
  })

  it('maps the same daemon rejection identically on the commit, push and draft routes', async () => {
    await seedWriteAgent()
    const control = new GitWriteSpy()
    const running = app(control)
    control.failure = new ProtocolError('CONFLICT', 'the agent is working in this workspace', {
      details: { reason: 'stale' }
    })

    for (const route of [COMMIT, PUSH, MESSAGE]) {
      const res = await post(running, route)
      expect(res.statusCode, route.name).toBe(409)
      expect(res.json(), route.name).toMatchObject({ code: 'WORKSPACE_STALE' })
    }
  })
})
