/**
 * The console's `repo` scope on the workspace surface: a read or a git action may address one of
 * the agent's AUTHORIZED additional repositories instead of its primary workspace
 * (multi-repository-workspaces.md).
 *
 * Three claims live here. The CP forwards the scope only after checking the agent's own
 * authorization rows; a repository it does not authorize reads as an absent workspace, exactly
 * like an unknown path, so the query is no oracle; and a daemon too old to scope by repository is
 * refused with 409 rather than being asked and silently answering for the PRIMARY root.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  WORKSPACE_GIT_MESSAGE_FEATURE,
  WORKSPACE_GIT_REVIEW_FEATURE,
  WORKSPACE_GIT_WRITE_FEATURE,
  WORKSPACE_REPO_SCOPE_FEATURE,
  WORKSPACE_SESSION_READ_FEATURE
} from '@agentconnect.md/protocol'
import type {
  WorkspaceGitCommitReq,
  WorkspaceGitCommitResult,
  WorkspaceGitLog,
  WorkspaceGitLogReq,
  WorkspaceGitPullReq,
  WorkspaceGitPullResult,
  WorkspaceGitStatus,
  WorkspaceGitStatusReq,
  WorkspaceListPage,
  WorkspaceListReq
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd7d7d7d7-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a7a7a7a7-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AUTHORIZED = 'acme/infra'
const REPO_ID = '9007199254740993'
const ALL_FEATURES = [
  WORKSPACE_SESSION_READ_FEATURE,
  WORKSPACE_REPO_SCOPE_FEATURE,
  WORKSPACE_GIT_REVIEW_FEATURE,
  WORKSPACE_GIT_WRITE_FEATURE,
  WORKSPACE_GIT_MESSAGE_FEATURE
]
const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

/** Every seam the scope rides, recording the REQ the CP actually forwarded. */
class ScopeSpy {
  listCalls: WorkspaceListReq[] = []
  statusCalls: WorkspaceGitStatusReq[] = []
  logCalls: WorkspaceGitLogReq[] = []
  pullCalls: WorkspaceGitPullReq[] = []
  commitCalls: WorkspaceGitCommitReq[] = []

  async workspaceList(_daemonId: string, req: WorkspaceListReq): Promise<WorkspaceListPage> {
    this.listCalls.push(req)
    return { agentId: req.agentId, path: req.path, exists: true, entries: [] }
  }

  async workspaceGitStatus(_daemonId: string, req: WorkspaceGitStatusReq): Promise<WorkspaceGitStatus> {
    this.statusCalls.push(req)
    return { agentId: req.agentId, isRepo: true, clean: true, branch: 'trunk' }
  }

  async workspaceGitLog(_daemonId: string, req: WorkspaceGitLogReq): Promise<WorkspaceGitLog> {
    this.logCalls.push(req)
    return { agentId: req.agentId, isRepo: true, commits: [], truncated: false }
  }

  async workspaceGitPull(_daemonId: string, req: WorkspaceGitPullReq): Promise<WorkspaceGitPullResult> {
    this.pullCalls.push(req)
    return { agentId: req.agentId, isRepo: true, ok: true, detail: 'Already up to date.' }
  }

  async workspaceGitCommit(_daemonId: string, req: WorkspaceGitCommitReq): Promise<WorkspaceGitCommitResult> {
    this.commitCalls.push(req)
    return { agentId: req.agentId, isRepo: true, ok: true, sha: 'f'.repeat(40), detail: 'Committed.' }
  }
}

function app(control: ScopeSpy): HttpApp {
  const running = buildHttpApp(prisma, undefined, LIVE, control as unknown as ControlSender)
  opened.push(running)
  return running
}

/** A scratch agent on a repo-scope-capable daemon, holding one explicit repository grant. */
async function seedAuthorized(features: string[] = ALL_FEATURES): Promise<void> {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features }
  })
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  await prisma.agentRepoAuthorization.create({
    data: { agentId: AGENT, repoId: BigInt(REPO_ID), repoFullName: AUTHORIZED, access: 'write' }
  })
}

describe('workspace reads scoped to an additional repository', () => {
  it('forwards an authorized repo, and forwards none when the caller names none', async () => {
    await seedAuthorized()
    const control = new ScopeSpy()
    const running = app(control)

    const scoped = await running.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/files?repo=${encodeURIComponent(AUTHORIZED)}`
    })
    expect(scoped.statusCode).toBe(200)
    expect(control.listCalls).toEqual([{ agentId: AGENT, repo: AUTHORIZED, path: '', limit: 200 }])

    // The primary read is unchanged: no `repo` on the wire at all.
    const primary = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/workspace/files` })
    expect(primary.statusCode).toBe(200)
    expect(control.listCalls[1]).toEqual({ agentId: AGENT, path: '', limit: 200 })
  })

  it('accepts the grant’s name in any case, forwarding what the caller wrote', async () => {
    await seedAuthorized()
    const control = new ScopeSpy()
    const res = await app(control).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/files?repo=ACME%2FInfra`
    })
    expect(res.statusCode).toBe(200)
    expect(control.listCalls[0]?.repo).toBe('ACME/Infra')
  })

  it('reads an unauthorized repository as an absent workspace, before any daemon I/O', async () => {
    await seedAuthorized()
    const control = new ScopeSpy()
    const running = app(control)

    for (const path of ['files', 'gitstatus', 'gitlog']) {
      const res = await running.app.inject({
        method: 'GET',
        url: `${ORG}/agents/${AGENT}/workspace/${path}?repo=acme%2Fnot-granted`
      })
      // The same 404 an unknown path gets — never a 403 that would confirm the repository exists.
      expect(res.statusCode).toBe(404)
      expect(res.json().message).toBe('workspace not found')
    }
    expect([...control.listCalls, ...control.statusCalls, ...control.logCalls]).toEqual([])
  })

  it('scopes the git reads and the pull to the named repository', async () => {
    await seedAuthorized()
    const control = new ScopeSpy()
    const running = app(control)

    const status = await running.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/gitstatus?repo=${encodeURIComponent(AUTHORIZED)}`
    })
    expect(status.statusCode).toBe(200)
    expect(control.statusCalls).toEqual([{ agentId: AGENT, repo: AUTHORIZED }])
    // The body names the SCOPED repository, not the agent's own workspace address.
    expect(status.json()).toMatchObject({ repo: AUTHORIZED, agentDir: null, branch: 'trunk' })

    const pull = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/gitpull?repo=${encodeURIComponent(AUTHORIZED)}`
    })
    expect(pull.statusCode).toBe(200)
    expect(control.pullCalls).toEqual([{ agentId: AGENT, repo: AUTHORIZED }])
  })

  it('scopes a git write, and refuses an unauthorized one on the write chain too', async () => {
    await seedAuthorized()
    const control = new ScopeSpy()
    const running = app(control)

    const ok = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/gitcommit?repo=${encodeURIComponent(AUTHORIZED)}`,
      payload: { message: 'chore: from the console' }
    })
    expect(ok.statusCode).toBe(200)
    expect(control.commitCalls).toEqual([{ agentId: AGENT, repo: AUTHORIZED, message: 'chore: from the console' }])

    const denied = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/gitcommit?repo=acme%2Fnot-granted`,
      payload: { message: 'chore: elsewhere' }
    })
    expect(denied.statusCode).toBe(404)
    expect(control.commitCalls).toHaveLength(1)
  })
})

describe('version skew on the repo scope', () => {
  it('refuses a scoped request to a daemon that would answer for the primary root', async () => {
    // Everything BUT the repo scope: an older daemon ignores the field and reads the primary.
    await seedAuthorized(ALL_FEATURES.filter((feature) => feature !== WORKSPACE_REPO_SCOPE_FEATURE))
    const control = new ScopeSpy()
    const running = app(control)

    for (const url of [
      `${ORG}/agents/${AGENT}/workspace/files?repo=${encodeURIComponent(AUTHORIZED)}`,
      `${ORG}/agents/${AGENT}/workspace/gitstatus?repo=${encodeURIComponent(AUTHORIZED)}`
    ]) {
      const res = await running.app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('DAEMON_FEATURE_MISSING')
    }

    const pull = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/gitpull?repo=${encodeURIComponent(AUTHORIZED)}`
    })
    expect(pull.statusCode).toBe(409)
    expect([...control.listCalls, ...control.statusCalls, ...control.pullCalls]).toEqual([])

    // The unscoped reads are untouched by the missing marker — the primary still serves.
    const primary = await running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/workspace/files` })
    expect(primary.statusCode).toBe(200)
  })
})
