/**
 * Agent multi-repo authorization over the C2 REST surface + the github-hook
 * watch gate (issue #457, docs/designs/agent-multi-repo-authorization.md).
 * Covered:
 *
 *  - `POST /agents/:agentId/repos` resolves the repo through an org
 *    installation (canonical casing + the numeric id — never client-supplied),
 *    `GET` lists it, and each write appends an `agent_repo_change` audit row;
 *  - scratch workspaces can authorize covered repos despite having no implicit
 *    workspace repo; create denials still cover GitHub App unconfigured (409),
 *    uncovered or unknown repo (400), an implicit workspace repo itself (409),
 *    duplicate repoId even under a case-shifted name (409);
 *  - identity assertion (when `githubUserAuthz` is wired): the tier→need
 *    mapping (read/comment ⇒ read, write ⇒ write) and the 403 + code surface;
 *  - agent visibility: a restricted agent reads 404 on GET and POST (no
 *    oracle); viewer-role callers get 403 on writes;
 *  - `PATCH` upgrades a grant in place and rejects a downgrade; `DELETE`: 204
 *    then an empty list; a foreign or unknown row id reads 404;
 *  - github hooks may watch only workspace ∪ authorized repos: 409 before the
 *    grant, 200 after; the workspace repo needs no row; grandfathered rows
 *    keep working for non-binding edits but a repo CHANGE re-enters the gate.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type { Ack, AgentActivate, AgentDetach, AgentUpsert } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, TEST_API_KEY_PEPPER, type HttpApp } from '../fakes/build-http.js'
import { GithubService } from '../../src/github/service.js'
import { UserAuthzDeniedError } from '../../src/github/user-authz.js'
import {
  PgAgentRepoAuthorizationRepo,
  PgGithubInstallationRepo,
  PgGithubInstallStateStore,
  PgUserRepo
} from '../../src/persistence/index.js'
import type { HttpDeps } from '../../src/http/deps.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import type { DaemonLiveness } from '../../src/ports.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { systemClock } from '../../src/domain/clock.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const RELAY_URL = 'https://relay.test'
const DAEMON = 'd7d7d7d7-dddd-4ddd-8ddd-dddddddddddd'
const INSTALLATION = 1234567n
const INSTALLATION_ROW = '12345670-0000-4000-8000-000000000000'
const WORKSPACE_CAPS = {
  platforms: ['slack'],
  runtimes: ['claude'],
  acp: true,
  features: ['agent-move-v1', 'workspace-convert-v1', 'workspace-edit-v2']
}

/** GitHub's repo table as the stub serves it: lookups are case-insensitive and
 *  answer with the canonical casing + the numeric id (the rename-immune key). */
const REPOS: Record<string, { id: number; full_name: string }> = {
  'acme/infra': { id: 100, full_name: 'acme/infra' }, // the agents' workspace repo
  // A pre-R2a stored workspace name after a GitHub rename. The endpoint still
  // resolves to the same numeric repository and returns its canonical name.
  'acme/old-infra': { id: 100, full_name: 'acme/infra' },
  'acme/tools': { id: 111, full_name: 'acme/tools' },
  'acme/legacy': { id: 999, full_name: 'acme/legacy' } // grandfathered-hook repo
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

/** A GithubService over the real Pg repos with a URL-routing fetch stub —
 *  token mints + repo lookups answered from REPOS, no network. */
function stubbedGithub(): GithubService {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.includes('/access_tokens')) {
      return Response.json(
        { token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() },
        { status: 201 }
      )
    }
    const repoPath = /\/repos\/([^/]+\/[^/]+)$/.exec(url)
    if (repoPath) {
      const hit = REPOS[repoPath[1]!.toLowerCase()]
      if (!hit) return Response.json({ message: 'Not Found' }, { status: 404 })
      return Response.json(
        { ...hit, private: true, default_branch: hit.full_name === 'acme/tools' ? 'trunk' : 'main' },
        { status: 200 }
      )
    }
    throw new Error(`unexpected github call: ${url}`)
  }
  return new GithubService({
    cfg: { appId: 1, slug: 'agentconnect-test', jwtIssuer: '1', privateKey },
    clock: systemClock,
    installations: new PgGithubInstallationRepo(prisma),
    installState: new PgGithubInstallStateStore(prisma),
    repoAuths: new PgAgentRepoAuthorizationRepo(prisma),
    pepper: TEST_API_KEY_PEPPER,
    fetchImpl
  })
}

/** An app with the GitHub App wired (and the hook ingress, for the gate tests). */
function app(depsOverrides: Partial<HttpDeps> = {}): HttpApp {
  const a = buildHttpApp(prisma, { PUBLIC_RELAY_URL: RELAY_URL }, undefined, undefined, {
    github: stubbedGithub(),
    ...depsOverrides
  })
  opened.push(a)
  return a
}

class WorkspaceControlSpy {
  readonly detaches: AgentDetach[] = []
  readonly activations: AgentActivate[] = []

  constructor(
    private readonly detachAck: Ack = { ok: true },
    private readonly firstActivateAck: Ack = { ok: true },
    private readonly onDetach?: () => Promise<void>
  ) {}

  async agentDetach(_daemonId: string, value: AgentDetach): Promise<Ack> {
    this.detaches.push(value)
    await this.onDetach?.()
    return this.detachAck
  }

  async agentActivate(_daemonId: string, value: AgentActivate): Promise<Ack> {
    this.activations.push(value)
    return this.activations.length === 1 ? this.firstActivateAck : { ok: true }
  }
}

/** Records the `agent/upsert` pushes the grant routes make. */
class UpsertSpy {
  readonly upserts: AgentUpsert[] = []
  async agentUpsert(_daemonId: string, u: AgentUpsert): Promise<void> {
    this.upserts.push(u)
  }
}

function replicatingApp(control: UpsertSpy): HttpApp {
  const a = buildHttpApp(prisma, { PUBLIC_RELAY_URL: RELAY_URL }, undefined, control as unknown as ControlSender, {
    github: stubbedGithub()
  })
  opened.push(a)
  return a
}

function workspaceApp(control: WorkspaceControlSpy): HttpApp {
  const liveness: DaemonLiveness = {
    get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
  }
  const a = buildHttpApp(prisma, { PUBLIC_RELAY_URL: RELAY_URL }, liveness, control as unknown as ControlSender, {
    github: stubbedGithub()
  })
  opened.push(a)
  return a
}

async function seedInstallation(over: Record<string, unknown> = {}): Promise<void> {
  await prisma.githubInstallation.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      installationId: INSTALLATION,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      ...over
    }
  })
}

/** A placed github-APP-mode agent on acme/infra — the grant channel the repos
 *  routes require (installation provenance set at create). */
async function workspaceAgent(
  opts: { visibility?: 'org' | 'restricted'; sharedWith?: string[] } = {}
): Promise<string> {
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, {
    daemonId: DAEMON,
    gitRepo: 'https://github.com/acme/infra',
    installationId: INSTALLATION_ROW,
    ...opts
  })
  return agentId
}

async function manualWorkspaceAgent(): Promise<string> {
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, gitRepo: 'https://github.com/acme/infra' })
  return agentId
}

const post = (a: HttpApp, agentId: string, payload: Record<string, unknown>) =>
  a.app.inject({ method: 'POST', url: `${ORG}/agents/${agentId}/repos`, payload })
const patch = (a: HttpApp, agentId: string, repoAuthId: string, payload: Record<string, unknown>) =>
  a.app.inject({ method: 'PATCH', url: `${ORG}/agents/${agentId}/repos/${repoAuthId}`, payload })
const list = (a: HttpApp, agentId: string) => a.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}/repos` })

/** Provision a user + add them to the default org with a role; returns their id. */
async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@acme.dev`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

describe('agent repo authorizations REST — grant, list, revoke, gates', () => {
  it('canonicalizes an App-backed workspace to the repository authorized by GitHub', async () => {
    await seedInstallation()
    const a = app()

    // Provenance is derived from the ADDRESS alone (§6) — the caller reports none.
    // The stale name and the shifted casing both resolve through the covering
    // installation, so the persisted address is GitHub's canonical one.
    const created = await a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'canonical-workspace',
        runtime: 'claude',
        workspace: { mode: 'git', gitRepo: 'https://github.com/ACME/Old-Infra', access: 'read' }
      }
    })

    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      workspace: {
        mode: 'git',
        gitRepo: 'https://github.com/acme/infra',
        credential: { provider: 'github', access: 'read' }
      },
      workspaceRepoId: '100'
    })
    expect(await prisma.agent.findFirstOrThrow({ where: { name: 'canonical-workspace' } })).toMatchObject({
      gitRepo: 'https://github.com/acme/infra',
      workspaceMode: 'git',
      gitCredentialProvider: 'github'
    })
  })

  it('PATCH upgrades an App-backed workspace from read to write after checking the caller', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await prisma.agent.update({ where: { id: agentId }, data: { workspaceRepoId: 100n, gitAccess: 'read' } })
    await seedInstallation()
    const needs: string[] = []
    const a = app({
      githubUserAuthz: {
        assertAccess: async (
          _userId: string,
          _installation: unknown,
          _owner: string,
          _repo: string,
          need: 'read' | 'write'
        ) => {
          needs.push(need)
          return { permission: 'write', repoPrivate: true, canRead: true, canWrite: true, identityRequired: false }
        }
      } as never
    })

    const upgraded = await a.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { gitAccess: 'write' }
    })

    expect(upgraded.statusCode).toBe(200)
    expect(upgraded.json()).toMatchObject({
      workspace: { mode: 'git', credential: { provider: 'github', access: 'write' } }
    })
    expect(needs).toEqual(['write'])
    expect(await prisma.agent.findUnique({ where: { id: agentId } })).toMatchObject({ gitAccess: 'write' })
  })

  it('PATCH keeps an App-backed workspace read-only when the caller lacks write access', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await prisma.agent.update({ where: { id: agentId }, data: { workspaceRepoId: 100n, gitAccess: 'read' } })
    await seedInstallation()
    const a = app({
      githubUserAuthz: {
        assertAccess: async () => {
          throw new UserAuthzDeniedError('you do not have write access to acme/infra', 'USER_NO_ACCESS')
        }
      } as never
    })

    const denied = await a.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { gitAccess: 'write' }
    })

    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ code: 'USER_NO_ACCESS' })
    expect(await prisma.agent.findUnique({ where: { id: agentId } })).toMatchObject({ gitAccess: 'read' })
  })

  it('POST authorizes a repo (canonical casing + numeric id), GET lists it, audit row appended', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const a = app()

    // Casing is normalized to GitHub's canonical full name.
    const res = await post(a, agentId, { repoFullName: 'ACME/Tools', access: 'comment' })
    expect(res.statusCode).toBe(200)
    const dto = res.json() as { id: string; repoId: string; repoFullName: string; access: string }
    expect(dto).toMatchObject({ repoId: '111', repoFullName: 'acme/tools', access: 'comment' })

    // The numeric match key is losslessly exposed and lands on the row as BigInt.
    const row = await prisma.agentRepoAuthorization.findUniqueOrThrow({ where: { id: dto.id } })
    expect(row.repoId).toBe(111n)
    expect(row.agentId).toBe(agentId)
    const agentDto = (await a.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).json() as {
      workspaceRepoId: string | null
    }
    expect(agentDto.workspaceRepoId).toBe('100')

    // Omitted access defaults to the least tier.
    const dflt = await post(a, agentId, { repoFullName: 'acme/legacy' })
    expect((dflt.json() as { access: string }).access).toBe('read')

    const rows = (await list(a, agentId)).json() as Array<{ repoId: string; repoFullName: string; access: string }>
    expect(rows.map((r) => r.repoFullName)).toEqual(['acme/tools', 'acme/legacy'])
    expect(rows.map((r) => r.repoId)).toEqual(['111', '999'])

    await vi.waitFor(async () => {
      const audits = await prisma.auditEvent.findMany({ where: { kind: 'agent_repo_change' } })
      expect(audits.length).toBeGreaterThanOrEqual(2)
      expect(audits.every((e) => e.agentId === agentId)).toBe(true)
      // Fire-and-forget appends — assert membership, not insertion order.
      expect(audits.map((e) => (e.details as { repoFullName: string }).repoFullName).sort()).toEqual([
        'acme/legacy',
        'acme/tools'
      ])
    })
  })

  it('a grant and its revoke re-project workspace.additionalRepos at an advanced config revision', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const spy = new UpsertSpy()
    const a = replicatingApp(spy)

    const created = await post(a, agentId, { repoFullName: 'acme/tools', access: 'read' })
    expect(created.statusCode).toBe(200)
    expect(spy.upserts).toHaveLength(1)
    expect(spy.upserts[0]!.spec.workspace).toMatchObject({
      additionalRepos: [{ repoFullName: 'acme/tools', repoId: '111' }]
    })

    const repoAuthId = (created.json() as { id: string }).id
    const revoked = await a.app.inject({
      method: 'DELETE',
      url: `${ORG}/agents/${agentId}/repos/${repoAuthId}`
    })
    expect(revoked.statusCode).toBe(204)
    expect(spy.upserts).toHaveLength(2)
    expect(spy.upserts[1]!.spec.workspace).toMatchObject({ additionalRepos: [] })
    // Equal revision + changed content is refused daemon-side, so the row writes
    // must advance the revision in the same transaction.
    expect(BigInt(spy.upserts[1]!.spec.configRevision!)).toBeGreaterThan(BigInt(spy.upserts[0]!.spec.configRevision!))
  })

  it('POST lets a scratch workspace authorize covered repositories', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await seedInstallation()
    const a = app()

    const created = await post(a, agentId, { repoFullName: 'ACME/Tools', access: 'write' })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({ repoId: '111', repoFullName: 'acme/tools', access: 'write' })
    expect((await list(a, agentId)).json()).toMatchObject([
      { repoId: '111', repoFullName: 'acme/tools', access: 'write' }
    ])

    const agentDto = (await a.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).json() as {
      workspaceRepoId: string | null
    }
    expect(agentDto.workspaceRepoId).toBeNull()
  })

  it('converts a scratch workspace to its authorized repo and removes the redundant grant', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: WORKSPACE_CAPS })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await seedInstallation()
    const control = new WorkspaceControlSpy()
    const a = workspaceApp(control)

    expect((await post(a, agentId, { repoFullName: 'acme/tools', access: 'write' })).statusCode).toBe(200)
    const converted = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: 'acme/tools', access: 'write' }
    })

    expect(converted.statusCode).toBe(200)
    expect(converted.json()).toMatchObject({
      workspace: {
        mode: 'git',
        worktree: true,
        gitBranch: 'trunk',
        credential: { provider: 'github', access: 'write' }
      },
      workspaceRepoId: '111'
    })
    expect(control.detaches).toMatchObject([{ agentId }])
    expect(control.activations).toMatchObject([
      {
        agentId,
        reconcileWorkspace: true,
        // The spy stands in for WsControlSender, so this is the assembled spec — the
        // per-peer dual encoding (§8) happens inside the real sender.
        spec: { workspace: { mode: 'git', branch: 'trunk', credential: { provider: 'github' } } }
      }
    ])
    expect(await prisma.agentRepoAuthorization.count({ where: { agentId } })).toBe(0)
    expect(await prisma.agent.findUnique({ where: { id: agentId } })).toMatchObject({
      workspaceMode: 'git',
      gitCredentialProvider: 'github',
      workspaceIsolation: 'session',
      gitBranch: 'trunk',
      workspaceRepoId: 111n
    })
  })

  it('converts a scratch workspace one-step, without any prior explicit grant', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: WORKSPACE_CAPS })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await seedInstallation()
    const control = new WorkspaceControlSpy()
    const a = workspaceApp(control)

    const converted = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: 'ACME/Tools', access: 'write' }
    })

    expect(converted.statusCode).toBe(200)
    expect(converted.json()).toMatchObject({
      workspace: { mode: 'git', gitBranch: 'trunk', credential: { provider: 'github', access: 'write' } },
      workspaceRepoId: '111'
    })
    expect(control.detaches).toMatchObject([{ agentId }])
    expect(control.activations).toMatchObject([{ agentId, reconcileWorkspace: true }])
    expect(await prisma.agentRepoAuthorization.count({ where: { agentId } })).toBe(0)
    expect(await prisma.agent.findUnique({ where: { id: agentId } })).toMatchObject({
      workspaceMode: 'git',
      gitCredentialProvider: 'github',
      workspaceRepoId: 111n
    })
  })

  it('converts to write over a read-tier grant and still removes the redundant grant', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: WORKSPACE_CAPS })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await seedInstallation()
    const a = workspaceApp(new WorkspaceControlSpy())

    // The grant tier is no longer a conversion ceiling — the caller's own GitHub
    // permission (identity assertion, when configured) gates the requested access.
    expect((await post(a, agentId, { repoFullName: 'acme/tools', access: 'read' })).statusCode).toBe(200)
    const converted = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: 'acme/tools', access: 'write' }
    })

    expect(converted.statusCode).toBe(200)
    expect(converted.json()).toMatchObject({
      workspace: { mode: 'git', credential: { provider: 'github', access: 'write' } }
    })
    expect(await prisma.agentRepoAuthorization.count({ where: { agentId } })).toBe(0)
  })

  it('edits an existing GitHub workspace access without an empty-workspace check or clone', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: WORKSPACE_CAPS })
    const agentId = await workspaceAgent()
    await prisma.agent.update({ where: { id: agentId }, data: { workspaceRepoId: 100n, gitAccess: 'write' } })
    await seedInstallation()
    const control = new WorkspaceControlSpy()
    const a = workspaceApp(control)

    const edited = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', worktree: false, gitRepo: 'acme/infra', access: 'read' }
    })

    expect(edited.statusCode).toBe(200)
    expect(edited.json()).toMatchObject({
      workspace: { mode: 'git', worktree: false, credential: { provider: 'github', access: 'read' } }
    })
    expect(control.detaches).toHaveLength(1)
    expect(control.detaches[0]?.requireEmptyWorkspace).toBeUndefined()
    expect(control.activations).toHaveLength(1)
    expect(control.activations[0]).toMatchObject({
      reconcileWorkspace: true,
      spec: { workspace: { isolation: 'shared' } }
    })
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toMatchObject({
      gitAccess: 'read',
      workspaceIsolation: 'shared'
    })
  })

  it('switches repository, branch, and working directory, then converts GitHub back to scratch', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: WORKSPACE_CAPS })
    const agentId = await workspaceAgent()
    await prisma.agent.update({ where: { id: agentId }, data: { workspaceRepoId: 100n, gitAccess: 'write' } })
    await seedInstallation()
    const control = new WorkspaceControlSpy()
    const a = workspaceApp(control)

    const switched = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: {
        mode: 'git',
        gitRepo: 'acme/tools',
        gitBranch: 'feature/workspace-edit',
        agentDir: 'services/api',
        access: 'write'
      }
    })

    expect(switched.statusCode).toBe(200)
    expect(switched.json()).toMatchObject({
      workspace: {
        mode: 'git',
        gitBranch: 'feature/workspace-edit',
        agentDir: 'services/api',
        credential: { provider: 'github', access: 'write' }
      },
      workspaceRepoId: '111'
    })

    const scratch = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'scratch' }
    })

    expect(scratch.statusCode).toBe(200)
    expect(scratch.json()).toMatchObject({ workspace: { mode: 'scratch' }, workspaceRepoId: null })
    expect(control.activations).toHaveLength(2)
    expect(control.activations.every((activation) => activation.reconcileWorkspace === true)).toBe(true)
  })

  it('binds an existing anonymous GitHub workspace to the App without widening its effective read access', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: WORKSPACE_CAPS })
    const agentId = await manualWorkspaceAgent()
    await seedInstallation()
    const control = new WorkspaceControlSpy()
    const a = workspaceApp(control)

    const edited = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: 'acme/infra', access: 'read' }
    })

    expect(edited.statusCode).toBe(200)
    expect(edited.json()).toMatchObject({
      workspace: { mode: 'git', credential: { provider: 'github', access: 'read' } },
      workspaceRepoId: '100'
    })
    expect(control.detaches[0]?.requireEmptyWorkspace).toBeUndefined()
    expect(control.activations[0]?.reconcileWorkspace).toBe(true)
  })

  it('rejects any edit that removes write authority required by a GitHub integration', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: WORKSPACE_CAPS })
    const agentId = await workspaceAgent()
    await prisma.agent.update({ where: { id: agentId }, data: { workspaceRepoId: 100n, gitAccess: 'write' } })
    await seedInstallation()
    await prisma.hookDef.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        agentId,
        kind: 'github',
        name: 'review-integration',
        enabled: true,
        sessionMode: 'perThread',
        repoId: 100n,
        repoFullName: 'acme/infra',
        events: ['pull_request:*'],
        reviewPolicy: 'full',
        targetPlatform: 'slack'
      }
    })
    const control = new WorkspaceControlSpy()
    const a = workspaceApp(control)

    const rejected = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: 'acme/infra', access: 'read' }
    })

    expect(rejected.statusCode).toBe(409)
    expect(rejected.json()).toMatchObject({ message: expect.stringContaining('enabled GitHub integration') })
    const scratch = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'scratch' }
    })
    expect(scratch.statusCode).toBe(409)
    expect(scratch.json()).toMatchObject({ message: expect.stringContaining('enabled GitHub integration') })
    expect(control.detaches).toEqual([])
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toMatchObject({ gitAccess: 'write' })
  })

  it('conversion denies a caller the identity-assertion gate refuses', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, {}) // unplaced — the gate fires before any daemon traffic
    await seedInstallation()
    const a = app({
      githubUserAuthz: {
        assertAccess: async () => {
          throw new UserAuthzDeniedError('you do not have write access to acme/tools on GitHub', 'USER_NO_ACCESS')
        }
      } as never
    })

    const denied = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: 'acme/tools', access: 'write' }
    })

    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ code: 'USER_NO_ACCESS' })
    expect(await prisma.agent.findUnique({ where: { id: agentId } })).toMatchObject({ workspaceMode: 'scratch' })
  })

  it('preserves existing grants when the daemon rejects workspace replacement', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: WORKSPACE_CAPS })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await seedInstallation()
    const control = new WorkspaceControlSpy({ ok: true }, { ok: false, reason: 'workspace preparation failed' })
    const a = workspaceApp(control)

    expect((await post(a, agentId, { repoFullName: 'acme/legacy', access: 'read' })).statusCode).toBe(200)
    const rejected = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: 'acme/tools', access: 'read' }
    })

    expect(rejected.statusCode).toBe(503)
    expect(rejected.json()).toMatchObject({ message: expect.stringContaining('workspace edit rejected') })
    expect(await prisma.agent.findUnique({ where: { id: agentId } })).toMatchObject({ workspaceMode: 'scratch' })
    expect(await prisma.agentRepoAuthorization.count({ where: { agentId } })).toBe(1)
  })

  it('a concurrent grant revocation no longer blocks conversion', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: WORKSPACE_CAPS })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await seedInstallation()
    const control = new WorkspaceControlSpy({ ok: true }, { ok: true }, async () => {
      await prisma.agentRepoAuthorization.deleteMany({ where: { agentId } })
    })
    const a = workspaceApp(control)

    expect((await post(a, agentId, { repoFullName: 'acme/tools', access: 'write' })).statusCode).toBe(200)
    const converted = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: 'acme/tools', access: 'write' }
    })

    expect(converted.statusCode).toBe(200)
    expect(await prisma.agent.findUnique({ where: { id: agentId } })).toMatchObject({
      workspaceMode: 'git',
      gitCredentialProvider: 'github',
      workspaceRepoId: 111n
    })
    expect(control.activations).toMatchObject([{ agentId, reconcileWorkspace: true }])
  })

  it('POST 409s without the GitHub App and 400s an uncovered repo', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()

    // (a) GitHub App not configured on the deployment.
    const bare = buildHttpApp(prisma)
    opened.push(bare)
    const noApp = await post(bare, agentId, { repoFullName: 'acme/tools' })
    expect(noApp.statusCode).toBe(409)
    expect((noApp.json() as { message: string }).message).toMatch(/GitHub App is not configured/)

    const a = app()

    // (b) no installation covers the owner at all.
    expect((await post(a, agentId, { repoFullName: 'acme/tools' })).statusCode).toBe(400)

    // (c) the covering installation is suspended.
    await seedInstallation({ suspendedAt: new Date() })
    expect((await post(a, agentId, { repoFullName: 'acme/tools' })).statusCode).toBe(400)
    await prisma.githubInstallation.deleteMany()

    // (d) installation live but the repo reads 404 (out of grant / gone).
    await seedInstallation()
    expect((await post(a, agentId, { repoFullName: 'acme/gone' })).statusCode).toBe(400)

    expect(await prisma.agentRepoAuthorization.count()).toBe(0) // nothing persisted anywhere
  })

  it('replaces the workspace with a repository no installation covers, read-only', async () => {
    // Agent creation has always accepted this anonymous checkout, so the editor
    // must too — otherwise a public-repo agent cannot even move to another branch.
    await seedDaemon(prisma, DAEMON, { capabilities: WORKSPACE_CAPS })
    const agentId = await workspaceAgent()
    await prisma.agent.update({ where: { id: agentId }, data: { workspaceRepoId: 100n, gitAccess: 'write' } })
    await seedInstallation()
    const control = new WorkspaceControlSpy()
    const a = workspaceApp(control)

    const replaced = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: 'github/docs', gitBranch: 'main', access: 'read' }
    })

    expect(replaced.statusCode).toBe(200)
    expect(replaced.json()).toMatchObject({
      workspace: { mode: 'git', gitRepo: 'https://github.com/github/docs', gitBranch: 'main' },
      workspaceRepoId: null
    })
    // Anonymous git: no credential on the DTO, and no `gitCredential` on the spec.
    expect((replaced.json() as { workspace: Record<string, unknown> }).workspace).not.toHaveProperty('credential')
    expect(control.activations[0]?.spec.workspace).not.toHaveProperty('credential')
    // `gitAccess` is meaningful only where a credential provider is set (§4), so the
    // anonymous outcome is stated by the provider column, not by that tier.
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toMatchObject({
      gitRepo: 'https://github.com/github/docs',
      gitCredentialProvider: null,
      installationId: null,
      workspaceRepoId: null
    })

    // Push still requires an installation — an anonymous clone cannot push.
    const write = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: 'github/docs', access: 'write' }
    })
    expect(write.statusCode).toBe(409)
    expect(write.json()).toMatchObject({ message: expect.stringContaining('requires a GitHub App installation') })
  })

  it('keeps the ungranted-repository conflict, and needs no App for the anonymous arm', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: WORKSPACE_CAPS })
    const agentId = await workspaceAgent()
    await seedInstallation()
    const control = new WorkspaceControlSpy()
    const a = workspaceApp(control)

    // An installation token reads any PUBLIC repo, so a miss under a covered owner
    // means private-and-ungranted: the answer is to grant it, not to degrade to an
    // anonymous clone that cannot work.
    const ungranted = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: 'acme/gone', access: 'read' }
    })
    expect(ungranted.statusCode).toBe(409)
    expect(ungranted.json()).toMatchObject({ message: expect.stringContaining('is not granted') })

    // The App is required to BIND an installation, not to accept a workspace —
    // creation already takes a credential-free one with no App configured.
    const bare = buildHttpApp(
      prisma,
      { PUBLIC_RELAY_URL: RELAY_URL },
      { get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined) },
      new WorkspaceControlSpy() as unknown as ControlSender
    )
    opened.push(bare)
    const noApp = await bare.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: 'github/docs', gitBranch: 'master', access: 'read' }
    })
    expect(noApp.statusCode).toBe(200)
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toMatchObject({
      gitRepo: 'https://github.com/github/docs',
      gitCredentialProvider: null,
      installationId: null
    })
  })

  it('takes the highest access tier the target carries when none is stated', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: WORKSPACE_CAPS })
    const agentId = await workspaceAgent()
    await seedInstallation()
    const a = workspaceApp(new WorkspaceControlSpy())

    // Credentials are minted for an App-backed repo, so the unstated tier is write.
    const granted = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: 'acme/tools' }
    })
    expect(granted.statusCode).toBe(200)
    expect(granted.json()).toMatchObject({ workspace: { credential: { provider: 'github', access: 'write' } } })

    // An anonymous checkout has nothing to push with, so it stays read.
    const anonymous = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: 'github/docs', gitBranch: 'master' }
    })
    expect(anonymous.statusCode).toBe(200)
    expect(anonymous.json()).toMatchObject({ workspace: { mode: 'git' } })
    expect((anonymous.json() as { workspace: Record<string, unknown> }).workspace).not.toHaveProperty('credential')
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toMatchObject({
      gitRepo: 'https://github.com/github/docs',
      gitCredentialProvider: null,
      installationId: null
    })
  })

  it('POST 409s the workspace repo and a duplicate grant (rename-immune numeric id, case-shifted name)', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const a = app()

    // The workspace repo is implicit — never a grant row.
    const ws = await post(a, agentId, { repoFullName: 'ACME/Infra' })
    expect(ws.statusCode).toBe(409)
    expect((ws.json() as { message: string }).message).toMatch(/workspace repository/)

    expect((await post(a, agentId, { repoFullName: 'acme/tools' })).statusCode).toBe(200)
    // Same numeric id under a different casing — one row per (agent, repo).
    const dup = await post(a, agentId, { repoFullName: 'Acme/TOOLS' })
    expect(dup.statusCode).toBe(409)
    expect((dup.json() as { message: string }).message).toMatch(/already authorized/)
    expect(await prisma.agentRepoAuthorization.count()).toBe(1)

    // A DIFFERENT agent may hold its own grant on the same repo.
    const other = await workspaceAgent()
    expect((await post(a, other, { repoFullName: 'acme/tools' })).statusCode).toBe(200)
  })

  it('POST does not read a same-numbered GitLab project as a duplicate GitHub repository', async () => {
    // The hosts number their repositories independently and the unique key permits
    // both, so the duplicate preflight has to qualify by provider (§8.1). Before it
    // did, holding GitLab project 111 blocked authorizing GitHub repository 111.
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const a = app()
    await prisma.agentRepoAuthorization.create({
      data: {
        agentId,
        provider: 'gitlab',
        repoId: 111n,
        repoFullName: 'example-group/example-project',
        access: 'read'
      }
    })

    expect((await post(a, agentId, { repoFullName: 'acme/tools' })).statusCode).toBe(200)
    expect(
      await prisma.agentRepoAuthorization.findMany({
        where: { agentId, repoId: 111n },
        orderBy: { provider: 'asc' },
        select: { provider: true, repoFullName: true }
      })
    ).toEqual([
      { provider: 'github', repoFullName: 'acme/tools' },
      { provider: 'gitlab', repoFullName: 'example-group/example-project' }
    ])
  })

  it('lets a manual GitHub workspace explicitly authorize only its own repo', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await manualWorkspaceAgent()
    await seedInstallation()
    const a = app()

    const workspace = await post(a, agentId, { repoFullName: 'acme/infra', access: 'write' })
    expect(workspace.statusCode).toBe(200)
    expect(workspace.json()).toMatchObject({ repoId: '100', repoFullName: 'acme/infra', access: 'write' })

    const additional = await post(a, agentId, { repoFullName: 'acme/tools', access: 'write' })
    expect(additional.statusCode).toBe(409)
    expect((additional.json() as { message: string }).message).toMatch(/only its workspace repository/)
  })

  it('PATCH upgrades an existing grant in place and rejects a downgrade', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const a = app()

    const created = (await post(a, agentId, { repoFullName: 'acme/tools', access: 'read' })).json() as {
      id: string
    }
    const upgraded = await patch(a, agentId, created.id, { access: 'write' })
    expect(upgraded.statusCode).toBe(200)
    expect(upgraded.json()).toMatchObject({ id: created.id, repoFullName: 'acme/tools', access: 'write' })

    const downgrade = await patch(a, agentId, created.id, { access: 'comment' })
    expect(downgrade.statusCode).toBe(409)
    expect((downgrade.json() as { message: string }).message).toMatch(/revoke and reauthorize/)
  })

  it('identity assertion (when wired): read/comment tiers need read, write needs write; denial reads 403 + code', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const needs: string[] = []
    // A gate that grants read but denies write — the USER_NO_ACCESS surface.
    const githubUserAuthz = {
      assertAccess: async (_u: string, _i: unknown, owner: string, repo: string, need: 'read' | 'write') => {
        needs.push(need)
        if (need === 'write') {
          throw new UserAuthzDeniedError(`you do not have write access to ${owner}/${repo} on GitHub`, 'USER_NO_ACCESS')
        }
        return { permission: 'read', repoPrivate: true, canRead: true, canWrite: false, identityRequired: false }
      }
    }
    const a = app({ githubUserAuthz: githubUserAuthz as never })

    expect((await post(a, agentId, { repoFullName: 'acme/tools', access: 'comment' })).statusCode).toBe(200)
    const denied = await post(a, agentId, { repoFullName: 'acme/legacy', access: 'write' })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ code: 'USER_NO_ACCESS' })
    expect(needs).toEqual(['read', 'write']) // comment ⇒ read; write ⇒ write
    expect(await prisma.agentRepoAuthorization.count()).toBe(1) // the denial persisted nothing
  })

  it('a restricted agent reads 404 on GET and POST (no oracle); viewer-role callers get 403 on writes', async () => {
    const other = await makeUser('repos-other', 'collaborator')
    const viewer = await makeUser('repos-viewer', 'viewer')
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent({ visibility: 'restricted', sharedWith: [viewer] })

    // Not viewable ⇒ 404 before any GitHub work (same shape as an unknown agent).
    const asOther = buildHttpApp(prisma, { DEFAULT_OWNER_ID: other })
    opened.push(asOther)
    expect((await list(asOther, agentId)).statusCode).toBe(404)
    expect((await post(asOther, agentId, { repoFullName: 'acme/tools' })).statusCode).toBe(404)

    // Viewable but read-only role ⇒ writes 403, reads pass.
    const asViewer = buildHttpApp(prisma, { DEFAULT_OWNER_ID: viewer })
    opened.push(asViewer)
    expect((await list(asViewer, agentId)).statusCode).toBe(200)
    expect((await post(asViewer, agentId, { repoFullName: 'acme/tools' })).statusCode).toBe(403)
    const del = await asViewer.app.inject({
      method: 'DELETE',
      url: `${ORG}/agents/${agentId}/repos/${randomUUID()}`
    })
    expect(del.statusCode).toBe(403)
  })

  it('DELETE durably tombstones affected Checks before revoking; a foreign or unknown row id reads 404', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    const otherAgent = await workspaceAgent()
    await seedInstallation()
    const a = app()
    const { id } = (await post(a, agentId, { repoFullName: 'acme/tools' })).json() as { id: string }
    const projectionId = randomUUID()
    await prisma.hookReviewProjection.create({
      data: {
        id: projectionId,
        externalId: projectionId,
        hookId: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        agentId,
        repoId: 111n,
        repoFullName: 'acme/tools',
        headSha: 'a'.repeat(40),
        reportSha: 'a'.repeat(40),
        projectionEpoch: 1n,
        generation: 4n,
        mode: 'check',
        gateMode: 'informational',
        desiredState: 'success',
        observedState: 'success'
      }
    })

    // The row hangs off ONE agent — another agent's path can't address it.
    const foreign = await a.app.inject({ method: 'DELETE', url: `${ORG}/agents/${otherAgent}/repos/${id}` })
    expect(foreign.statusCode).toBe(404)
    const unknown = await a.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}/repos/${randomUUID()}` })
    expect(unknown.statusCode).toBe(404)

    const del = await a.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}/repos/${id}` })
    expect(del.statusCode).toBe(204)
    expect((await list(a, agentId)).json()).toEqual([])
    expect(await prisma.agentRepoAuthorization.count()).toBe(0)
    expect(await prisma.hookReviewProjection.findUniqueOrThrow({ where: { id: projectionId } })).toMatchObject({
      generation: 5n,
      desiredState: 'failure',
      observedState: null,
      tombstonedAt: expect.any(Date),
      nextAttemptAt: expect.any(Date)
    })
  })

  it('DELETE repairs and removes a legacy workspace duplicate without tombstoning its Checks', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, {
      daemonId: DAEMON,
      gitRepo: 'https://github.com/acme/old-infra',
      installationId: INSTALLATION_ROW
    })
    await seedInstallation()
    const duplicate = await prisma.agentRepoAuthorization.create({
      data: { agentId, repoId: 100n, repoFullName: 'acme/infra', access: 'write' }
    })
    const projectionId = randomUUID()
    await prisma.hookReviewProjection.create({
      data: {
        id: projectionId,
        externalId: projectionId,
        hookId: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        agentId,
        repoId: 100n,
        repoFullName: 'acme/infra',
        headSha: 'b'.repeat(40),
        reportSha: 'b'.repeat(40),
        projectionEpoch: 1n,
        generation: 4n,
        mode: 'check',
        gateMode: 'informational',
        desiredState: 'success',
        observedState: 'success'
      }
    })
    const a = app()

    const del = await a.app.inject({
      method: 'DELETE',
      url: `${ORG}/agents/${agentId}/repos/${duplicate.id}`
    })
    expect(del.statusCode).toBe(204)
    expect(await prisma.agentRepoAuthorization.findUnique({ where: { id: duplicate.id } })).toBeNull()
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toMatchObject({ workspaceRepoId: 100n })
    expect(await prisma.hookReviewProjection.findUniqueOrThrow({ where: { id: projectionId } })).toMatchObject({
      generation: 4n,
      desiredState: 'success',
      observedState: 'success',
      tombstonedAt: null
    })
  })

  describe('github hook watch gate (multi-repo decision 6)', () => {
    /** A live relay row so the hook-create ingress gate passes. */
    async function seedRelay(): Promise<void> {
      await prisma.relay.create({
        data: {
          id: randomUUID(),
          name: `relay-${randomUUID().slice(0, 8)}`,
          daemonUrl: 'wss://relay-0',
          lastSeenAt: new Date()
        }
      })
    }

    const hookBody = (agentId: string, over: Record<string, unknown> = {}) => ({
      agentId,
      kind: 'github',
      name: 'gh-hook',
      repoFullName: 'acme/tools',
      family: 'issues',
      events: ['issues:opened'],
      ...over
    })

    it('hook create on a non-workspace repo 409s until the repo is authorized; the workspace repo needs no row', async () => {
      await seedDaemon(prisma, DAEMON)
      const agentId = await workspaceAgent()
      await seedInstallation()
      await seedRelay()
      const a = app()

      const denied = await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: hookBody(agentId) })
      expect(denied.statusCode).toBe(409)
      expect((denied.json() as { message: string }).message).toMatch(/not authorized for this agent/)
      expect(await prisma.hookDef.count()).toBe(0)

      // Authorize the repo on the agent, then the same create passes.
      expect((await post(a, agentId, { repoFullName: 'acme/tools', access: 'comment' })).statusCode).toBe(200)
      expect((await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: hookBody(agentId) })).statusCode).toBe(
        200
      )

      // The workspace repo is admitted by the workspace arm — no grant row.
      const ws = await a.app.inject({
        method: 'POST',
        url: `${ORG}/hooks`,
        payload: hookBody(agentId, { name: 'ws-hook', repoFullName: 'ACME/Infra' })
      })
      expect(ws.statusCode).toBe(200)
    })

    it('a scratch workspace may watch an explicitly authorized repo', async () => {
      await seedDaemon(prisma, DAEMON)
      const agentId = randomUUID()
      await seedAgent(prisma, agentId, { daemonId: DAEMON })
      await seedInstallation()
      await seedRelay()
      const a = app()

      const denied = await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: hookBody(agentId) })
      expect(denied.statusCode).toBe(409)

      expect((await post(a, agentId, { repoFullName: 'acme/tools', access: 'comment' })).statusCode).toBe(200)
      expect((await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: hookBody(agentId) })).statusCode).toBe(
        200
      )
    })

    it('hook create recognizes a renamed legacy workspace by numeric repo id', async () => {
      await seedDaemon(prisma, DAEMON)
      const agentId = randomUUID()
      await seedAgent(prisma, agentId, {
        daemonId: DAEMON,
        gitRepo: 'https://github.com/acme/old-infra',
        installationId: INSTALLATION_ROW
      })
      await seedInstallation()
      await seedRelay()
      const a = app()

      const created = await a.app.inject({
        method: 'POST',
        url: `${ORG}/hooks`,
        payload: hookBody(agentId, { repoFullName: 'acme/infra' })
      })
      expect(created.statusCode).toBe(200)
      expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toMatchObject({ workspaceRepoId: 100n })
      expect(await prisma.agentRepoAuthorization.count({ where: { agentId, repoId: 100n } })).toBe(0)
    })

    it('grandfathered hooks: non-binding edits keep working; a repo change re-enters the gate', async () => {
      await seedDaemon(prisma, DAEMON)
      const agentId = await workspaceAgent()
      await seedInstallation()
      const a = app()

      // A pre-#457 row watching a repo that has no authorization row.
      const hookId = randomUUID()
      await prisma.hookDef.create({
        data: {
          id: hookId,
          orgId: DEFAULT_ORG_ID,
          agentId,
          kind: 'github',
          name: 'legacy',
          sessionMode: 'perThread',
          repoId: 999n,
          repoFullName: 'acme/legacy',
          events: ['issues:opened'],
          targetPlatform: 'slack'
        }
      })

      // Events/label tweaks that KEEP the (agent, repo) binding must not brick it.
      const edit = await a.app.inject({
        method: 'PUT',
        url: `${ORG}/hooks/${hookId}`,
        payload: hookBody(agentId, { name: 'legacy', repoFullName: 'acme/legacy', events: ['pull_request:*'] })
      })
      expect(edit.statusCode).toBe(200)
      expect(edit.json()).toMatchObject({ repoFullName: 'acme/legacy', events: ['pull_request:*'] })

      // Re-targeting onto another unauthorized repo IS a binding change ⇒ gate.
      const retarget = await a.app.inject({
        method: 'PUT',
        url: `${ORG}/hooks/${hookId}`,
        payload: hookBody(agentId, { name: 'legacy' }) // repoFullName: acme/tools
      })
      expect(retarget.statusCode).toBe(409)
      expect((retarget.json() as { message: string }).message).toMatch(/not authorized for this agent/)
    })
  })
})
