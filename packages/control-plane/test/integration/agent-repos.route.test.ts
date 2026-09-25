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
 *  - `materialize` (multi-repository-workspaces.md decision 13): `always` by
 *    default, chosen on POST, changed on PATCH with a config-revision bump and
 *    a re-projected spec; `decision` needs the agent's repository selector and
 *    daemons advertising `repo-selector-v1`, on rows and grants alike, and the
 *    selector cannot be cleared while anything uses it;
 *  - github hooks may watch only workspace ∪ authorized repos: 409 before the
 *    grant, 200 after; the workspace repo needs no row; grandfathered rows
 *    keep working for non-binding edits but a repo CHANGE re-enters the gate;
 *  - installation grants (decision 10): owner-only writes, the org's live claim, projection beside the rows, the hook gate.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import {
  DECISION_PROVIDER_PROFILES,
  REPO_SELECTOR_V1_FEATURE,
  type Ack,
  type AgentActivate,
  type AgentDetach,
  type AgentUpsert
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, TEST_API_KEY_PEPPER, type HttpApp } from '../fakes/build-http.js'
import { GithubService } from '../../src/github/service.js'
import { UserAuthzDeniedError } from '../../src/github/user-authz.js'
import {
  PgAgentInstallationAuthorizationRepo,
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
import { AgentId, OrgId } from '../../src/domain/ids.js'

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
    cfg: { appId: 1, slug: 'example-deployment', jwtIssuer: '1', privateKey },
    clock: systemClock,
    installations: new PgGithubInstallationRepo(prisma),
    installState: new PgGithubInstallStateStore(prisma),
    repoAuths: new PgAgentRepoAuthorizationRepo(prisma),
    installationAuths: new PgAgentInstallationAuthorizationRepo(prisma),
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

  it('PATCH raises an existing grant in place and lowers it again', async () => {
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

    const lowered = await patch(a, agentId, created.id, { access: 'comment' })
    expect(lowered.statusCode).toBe(200)
    expect(lowered.json()).toMatchObject({ id: created.id, repoFullName: 'acme/tools', access: 'comment' })
  })

  it('PATCH lowers write to read in place: persisted, audited, minted read, and nothing re-pushed', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const spy = new UpsertSpy()
    const a = replicatingApp(spy)
    const created = (await post(a, agentId, { repoFullName: 'acme/tools', access: 'write' })).json() as { id: string }
    const agent = async () => (await a.deps.repos.agent.get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    const mint = async () => a.deps.github!.mintForAgent(await agent(), [randomUUID()], ['contents'], 'acme/tools')
    // A write token already minted and cached must not be served once the row is lowered.
    expect((await mint()).access).toBe('write')
    const revision = (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).configRevision

    const lowered = await patch(a, agentId, created.id, { access: 'read' })

    expect(lowered.statusCode).toBe(200)
    expect(lowered.json()).toMatchObject({ id: created.id, access: 'read', materialize: 'always' })
    expect(await prisma.agentRepoAuthorization.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      access: 'read'
    })
    expect((await mint()).access).toBe('read')
    expect(await a.deps.github!.resolveAgentRepoAuthorization(await agent(), 111n, 'acme/tools')).toMatchObject({
      kind: 'additional',
      access: 'read'
    })
    // The tier is off the spec, as for a raise: no revision bump and no re-push.
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).configRevision).toBe(revision)
    expect(spy.upserts).toHaveLength(1)
    await vi.waitFor(async () => {
      const audits = await prisma.auditEvent.findMany({ where: { kind: 'agent_repo_change', agentId } })
      expect(audits.map((e) => e.details)).toContainEqual({
        repoAuthId: created.id,
        provider: 'github',
        repoFullName: 'acme/tools',
        previousAccess: 'write',
        access: 'read'
      })
    })
  })

  it('PATCH refuses to lower a row while an enabled review or Checks hook on the repository needs the tier', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const a = app()
    const created = (await post(a, agentId, { repoFullName: 'acme/tools', access: 'write' })).json() as { id: string }
    const hook = await prisma.hookDef.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        agentId,
        kind: 'github',
        name: 'tools-review',
        enabled: true,
        sessionMode: 'perThread',
        repoId: 111n,
        repoFullName: 'acme/tools',
        family: 'pull_request',
        events: ['pull_request:*'],
        reviewPolicy: 'full',
        targetPlatform: 'slack'
      }
    })
    const access = async () =>
      (await prisma.agentRepoAuthorization.findUniqueOrThrow({ where: { id: created.id } })).access

    for (const tier of ['comment', 'read']) {
      const refused = await patch(a, agentId, created.id, { access: tier, materialize: 'on-demand' })
      expect(refused.statusCode).toBe(409)
      expect(refused.json()).toMatchObject({
        code: 'AGENT_REPO_INTEGRATION_CONFLICT',
        message: expect.stringContaining('enabled GitHub integration')
      })
    }
    // A refused tier leaves the whole row untouched.
    expect(await prisma.agentRepoAuthorization.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      access: 'write',
      materialize: 'always'
    })

    // Checks need write as well; a comment review is served by the comment tier but not by read.
    await prisma.hookDef.update({ where: { id: hook.id }, data: { reviewPolicy: 'off', reportingMode: 'check' } })
    expect((await patch(a, agentId, created.id, { access: 'comment' })).statusCode).toBe(409)
    await prisma.hookDef.update({ where: { id: hook.id }, data: { reviewPolicy: 'comment', reportingMode: 'off' } })
    expect((await patch(a, agentId, created.id, { access: 'comment' })).statusCode).toBe(200)
    expect((await patch(a, agentId, created.id, { access: 'read' })).statusCode).toBe(409)
    expect(await access()).toBe('comment')

    // A disabled hook needs nothing.
    await prisma.hookDef.update({ where: { id: hook.id }, data: { enabled: false } })
    expect((await patch(a, agentId, created.id, { access: 'read' })).statusCode).toBe(200)
    expect(await access()).toBe('read')
  })

  it('materialize defaults to `always`, is chosen on POST, and rides the spec beside each entry', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const spy = new UpsertSpy()
    const a = replicatingApp(spy)

    const dflt = await post(a, agentId, { repoFullName: 'acme/tools' })
    expect(dflt.statusCode).toBe(200)
    expect(dflt.json()).toMatchObject({ repoFullName: 'acme/tools', access: 'read', materialize: 'always' })

    const onDemand = await post(a, agentId, {
      repoFullName: 'acme/legacy',
      access: 'comment',
      materialize: 'on-demand'
    })
    expect(onDemand.statusCode).toBe(200)
    expect(onDemand.json()).toMatchObject({ repoFullName: 'acme/legacy', access: 'comment', materialize: 'on-demand' })
    // The Prisma member is `on_demand`; its `@map` keeps the column on the wire spelling.
    const stored = await prisma.agentRepoAuthorization.findUniqueOrThrow({
      where: { id: (onDemand.json() as { id: string }).id }
    })
    expect(stored.materialize).toBe('on_demand')

    // A row written without the column — every grant the migration backfilled — lists as `always`.
    await prisma.agentRepoAuthorization.create({
      data: { agentId, provider: 'github', repoId: 555n, repoFullName: 'acme/extra', access: 'read' }
    })
    const rows = (await list(a, agentId)).json() as Array<{ repoFullName: string; materialize: string }>
    expect(rows.map((r) => [r.repoFullName, r.materialize])).toEqual([
      ['acme/tools', 'always'],
      ['acme/legacy', 'on-demand'],
      ['acme/extra', 'always']
    ])

    // The projection carries the choice beside each entry, in the projection's own order.
    expect(spy.upserts).toHaveLength(2)
    expect(spy.upserts[1]!.spec.workspace).toMatchObject({
      additionalRepos: [
        { repoFullName: 'acme/legacy', repoId: '999', provider: 'github', materialize: 'on-demand' },
        { repoFullName: 'acme/tools', repoId: '111', provider: 'github', materialize: 'always' }
      ]
    })

    await vi.waitFor(async () => {
      const audits = await prisma.auditEvent.findMany({ where: { kind: 'agent_repo_change', agentId } })
      expect(audits.map((e) => (e.details as { materialize: string }).materialize).sort()).toEqual([
        'always',
        'on-demand'
      ])
    })
  })

  it('PATCH materialize re-projects the spec at an advanced revision and audits; an access-only change does neither', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const spy = new UpsertSpy()
    const a = replicatingApp(spy)
    const revision = async () => (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).configRevision

    const created = (await post(a, agentId, { repoFullName: 'acme/tools', access: 'read' })).json() as { id: string }
    expect(spy.upserts).toHaveLength(1)
    const afterCreate = await revision()

    // Access alone: the tier is not on the spec, so no revision bump and no re-push.
    const accessOnly = await patch(a, agentId, created.id, { access: 'comment' })
    expect(accessOnly.statusCode).toBe(200)
    expect(accessOnly.json()).toMatchObject({ id: created.id, access: 'comment', materialize: 'always' })
    expect(await revision()).toBe(afterCreate)
    expect(spy.upserts).toHaveLength(1)

    // Materialize alone: projected content changed, so the revision advances in the same write.
    const materializeOnly = await patch(a, agentId, created.id, { materialize: 'on-demand' })
    expect(materializeOnly.statusCode).toBe(200)
    expect(materializeOnly.json()).toMatchObject({ id: created.id, access: 'comment', materialize: 'on-demand' })
    expect(await revision()).toBe(afterCreate + 1n)
    expect(spy.upserts).toHaveLength(2)
    expect(spy.upserts[1]!.spec.workspace).toMatchObject({
      additionalRepos: [{ repoFullName: 'acme/tools', repoId: '111', materialize: 'on-demand' }]
    })
    expect(BigInt(spy.upserts[1]!.spec.configRevision!)).toBeGreaterThan(BigInt(spy.upserts[0]!.spec.configRevision!))

    // The same value again is a no-op: no bump, no push.
    expect((await patch(a, agentId, created.id, { materialize: 'on-demand' })).statusCode).toBe(200)
    expect(await revision()).toBe(afterCreate + 1n)
    expect(spy.upserts).toHaveLength(2)

    // Both at once: the tier rises and the row returns to `always`.
    const both = await patch(a, agentId, created.id, { access: 'write', materialize: 'always' })
    expect(both.statusCode).toBe(200)
    expect(both.json()).toMatchObject({ id: created.id, access: 'write', materialize: 'always' })
    expect(await revision()).toBe(afterCreate + 2n)
    expect(spy.upserts).toHaveLength(3)
    expect(spy.upserts[2]!.spec.workspace).toMatchObject({
      additionalRepos: [{ repoFullName: 'acme/tools', materialize: 'always' }]
    })

    // An empty body has nothing to update.
    expect((await patch(a, agentId, created.id, {})).statusCode).toBe(400)

    await vi.waitFor(async () => {
      const audits = await prisma.auditEvent.findMany({ where: { kind: 'agent_repo_change', agentId } })
      const changes = audits
        .map((e) => e.details as { previousMaterialize?: string; materialize?: string; repoFullName: string })
        .filter((d) => d.previousMaterialize !== undefined)
        .sort((x, y) => x.previousMaterialize!.localeCompare(y.previousMaterialize!))
      expect(changes).toEqual([
        {
          repoAuthId: created.id,
          provider: 'github',
          repoFullName: 'acme/tools',
          previousMaterialize: 'always',
          materialize: 'on-demand'
        },
        {
          repoAuthId: created.id,
          provider: 'github',
          repoFullName: 'acme/tools',
          previousMaterialize: 'on-demand',
          materialize: 'always'
        }
      ])
    })
  })

  it('a denied tier leaves materialize untouched when both are sent', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const a = app({
      githubUserAuthz: {
        assertAccess: async (_u: string, _i: unknown, _o: string, _r: string, need: 'read' | 'write') => {
          if (need === 'write')
            throw new UserAuthzDeniedError('you do not have write access to acme/tools', 'USER_NO_ACCESS')
          return { permission: 'read', repoPrivate: true, canRead: true, canWrite: false, identityRequired: false }
        }
      } as never
    })

    const created = (await post(a, agentId, { repoFullName: 'acme/tools', access: 'read' })).json() as { id: string }
    const denied = await patch(a, agentId, created.id, { access: 'write', materialize: 'on-demand' })
    expect(denied.statusCode).toBe(403)
    expect(await prisma.agentRepoAuthorization.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      access: 'read',
      materialize: 'always'
    })
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

describe('agent installation grants REST (agent-multi-repo-authorization.md decision 10)', () => {
  const grants = (agentId: string) => `${ORG}/agents/${agentId}/installations`
  const grantInstallation = (a: HttpApp, agentId: string, payload: Record<string, unknown>) =>
    a.app.inject({ method: 'POST', url: grants(agentId), payload })
  const listGrants = (a: HttpApp, agentId: string) => a.app.inject({ method: 'GET', url: grants(agentId) })
  const CLAIMED = Number(INSTALLATION)

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

  it('an owner grants a claimed installation: defaults, listing, audit, and a projection beside the rows', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const spy = new UpsertSpy()
    const a = replicatingApp(spy)
    const before = (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).configRevision

    const created = await grantInstallation(a, agentId, { installationId: CLAIMED })

    expect(created.statusCode).toBe(200)
    const dto = created.json() as { id: string }
    expect(dto).toMatchObject({
      provider: 'github',
      installationId: CLAIMED,
      accountLogin: 'acme',
      access: 'read',
      materialize: 'on-demand'
    })
    expect((await listGrants(a, agentId)).json()).toEqual([dto])
    expect(await prisma.agentInstallationAuthorization.findUniqueOrThrow({ where: { id: dto.id } })).toMatchObject({
      agentId,
      installationId: INSTALLATION,
      materialize: 'on_demand'
    })
    // Replicated at the advanced revision, beside the repository rows and never as one.
    expect(spy.upserts).toHaveLength(1)
    expect(spy.upserts[0]!.spec.workspace).toMatchObject({
      additionalRepos: [],
      additionalInstallations: [{ provider: 'github', accountLogin: 'acme', access: 'read', materialize: 'on-demand' }]
    })
    expect(BigInt(spy.upserts[0]!.spec.configRevision!)).toBe(before + 1n)
    expect(await prisma.agentRepoAuthorization.count()).toBe(0)
    await vi.waitFor(async () => {
      const audits = await prisma.auditEvent.findMany({ where: { kind: 'agent_repo_change', agentId } })
      expect(audits.map((e) => e.details)).toEqual([
        expect.objectContaining({
          installationAuthId: dto.id,
          installationId: INSTALLATION.toString(),
          accountLogin: 'acme',
          access: 'read',
          materialize: 'on-demand'
        })
      ])
    })
  })

  it('only an organization owner writes a grant; a collaborator reads it, and a hidden agent stays 404', async () => {
    const collaborator = await makeUser('grants-collaborator', 'collaborator')
    const viewer = await makeUser('grants-viewer', 'viewer')
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    const hidden = await workspaceAgent({ visibility: 'restricted', sharedWith: [viewer] })
    await seedInstallation()
    const { id } = (await grantInstallation(app(), agentId, { installationId: CLAIMED })).json() as { id: string }

    const asCollaborator = buildHttpApp(
      prisma,
      { PUBLIC_RELAY_URL: RELAY_URL, DEFAULT_OWNER_ID: collaborator },
      undefined,
      undefined,
      { github: stubbedGithub() }
    )
    opened.push(asCollaborator)
    expect((await listGrants(asCollaborator, agentId)).json()).toMatchObject([{ id, accountLogin: 'acme' }])
    const writes = [
      await grantInstallation(asCollaborator, agentId, { installationId: CLAIMED, access: 'write' }),
      await asCollaborator.app.inject({
        method: 'PATCH',
        url: `${grants(agentId)}/${id}`,
        payload: { access: 'write' }
      }),
      await asCollaborator.app.inject({ method: 'DELETE', url: `${grants(agentId)}/${id}` })
    ]
    for (const denied of writes) {
      // The refusal names the role rather than hiding the resource.
      expect(denied.statusCode).toBe(403)
      expect(denied.json()).toMatchObject({ message: 'only an organization owner can do this' })
    }
    // Not viewable ⇒ 404 before the role is judged (no oracle).
    expect((await listGrants(asCollaborator, hidden)).statusCode).toBe(404)
    expect((await grantInstallation(asCollaborator, hidden, { installationId: CLAIMED })).statusCode).toBe(404)

    const asViewer = buildHttpApp(prisma, { DEFAULT_OWNER_ID: viewer })
    opened.push(asViewer)
    expect((await listGrants(asViewer, hidden)).statusCode).toBe(200)
    expect((await grantInstallation(asViewer, hidden, { installationId: CLAIMED })).statusCode).toBe(403)
    expect(await prisma.agentInstallationAuthorization.findMany({ select: { id: true, access: true } })).toEqual([
      { id, access: 'read' }
    ])
  })

  it('refuses `always`, an unclaimed or revoked installation, a suspended one, and a duplicate', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const foreignOrg = `org-${randomUUID().slice(0, 8)}`
    await prisma.org.create({ data: { id: foreignOrg, slug: foreignOrg } })
    const installation = (orgId: string, installationId: bigint, accountLogin: string, over = {}) =>
      prisma.githubInstallation.create({
        data: { orgId, installationId, accountLogin, accountType: 'Organization', repositorySelection: 'all', ...over }
      })
    await installation(foreignOrg, 7654321n, 'example-co')
    await installation(DEFAULT_ORG_ID, 2345678n, 'example-gone', { revokedAt: new Date() })
    await installation(DEFAULT_ORG_ID, 3456789n, 'example-paused', { suspendedAt: new Date() })
    const a = app()

    const always = await grantInstallation(a, agentId, { installationId: CLAIMED, materialize: 'always' })
    expect(always.statusCode).toBe(400)
    expect(always.json()).toMatchObject({ message: 'request does not match schema' })
    // Another organization's claim, a revoked row and an unknown id all read alike.
    for (const installationId of [7654321, 2345678, 1111111]) {
      const refused = await grantInstallation(a, agentId, { installationId })
      expect(refused.statusCode).toBe(400)
      expect(refused.json()).toMatchObject({ message: "not one of this organization's GitHub App installations" })
    }
    const suspended = await grantInstallation(a, agentId, { installationId: 3456789 })
    expect(suspended.statusCode).toBe(409)
    expect(suspended.json()).toMatchObject({ message: 'the example-paused installation is suspended on GitHub' })

    expect((await grantInstallation(a, agentId, { installationId: CLAIMED })).statusCode).toBe(200)
    const duplicate = await grantInstallation(a, agentId, { installationId: CLAIMED, access: 'write' })
    expect(duplicate.statusCode).toBe(409)
    expect(await prisma.agentInstallationAuthorization.count()).toBe(1)
  })

  it('the table itself refuses a non-github provider and `always`', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, {})
    const base = { agentId, installationId: INSTALLATION, accountLogin: 'acme', access: 'read' as const }

    await expect(
      prisma.agentInstallationAuthorization.create({ data: { ...base, materialize: 'always' } })
    ).rejects.toThrow()
    await expect(
      prisma.agentInstallationAuthorization.create({ data: { ...base, provider: 'gitlab' } })
    ).rejects.toThrow()
    await expect(prisma.agentInstallationAuthorization.create({ data: base })).resolves.toMatchObject({
      provider: 'github',
      materialize: 'on_demand'
    })
  })

  it('PATCH raises the tier and re-projects; it refuses `always`, `decision` without a selector and an empty body', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const spy = new UpsertSpy()
    const a = replicatingApp(spy)
    const { id } = (await grantInstallation(a, agentId, { installationId: CLAIMED, access: 'comment' })).json() as {
      id: string
    }
    const patchGrant = (payload: Record<string, unknown>, grantId = id) =>
      a.app.inject({ method: 'PATCH', url: `${grants(agentId)}/${grantId}`, payload })

    const raised = await patchGrant({ access: 'write' })
    expect(raised.statusCode).toBe(200)
    expect(raised.json()).toMatchObject({ access: 'write', materialize: 'on-demand' })
    expect(spy.upserts).toHaveLength(2)
    expect(spy.upserts[1]!.spec.workspace).toMatchObject({ additionalInstallations: [{ access: 'write' }] })
    expect(BigInt(spy.upserts[1]!.spec.configRevision!)).toBeGreaterThan(BigInt(spy.upserts[0]!.spec.configRevision!))

    expect((await patchGrant({ materialize: 'decision' })).statusCode).toBe(409)
    expect((await patchGrant({ materialize: 'always' })).statusCode).toBe(400)
    expect((await patchGrant({})).statusCode).toBe(400)
    expect((await patchGrant({ access: 'write' }, randomUUID())).statusCode).toBe(404)
    // An unchanged value is a no-op: nothing is audited or pushed.
    expect((await patchGrant({ access: 'write', materialize: 'on-demand' })).statusCode).toBe(200)
    expect(spy.upserts).toHaveLength(2)
    expect(await prisma.agentInstallationAuthorization.findUniqueOrThrow({ where: { id } })).toMatchObject({
      access: 'write'
    })
    await vi.waitFor(async () => {
      const audits = await prisma.auditEvent.findMany({ where: { kind: 'agent_repo_change', agentId } })
      expect(audits.map((e) => e.details)).toContainEqual(
        expect.objectContaining({ installationAuthId: id, previousAccess: 'comment', access: 'write' })
      )
      expect(audits).toHaveLength(2)
    })
  })

  it('PATCH lowers a grant in place: persisted, re-projected at the lower tier, and audited', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    await seedInstallation()
    const spy = new UpsertSpy()
    const a = replicatingApp(spy)
    const { id } = (await grantInstallation(a, agentId, { installationId: CLAIMED, access: 'write' })).json() as {
      id: string
    }

    const lowered = await a.app.inject({
      method: 'PATCH',
      url: `${grants(agentId)}/${id}`,
      payload: { access: 'read' }
    })

    expect(lowered.statusCode).toBe(200)
    expect(lowered.json()).toMatchObject({ id, access: 'read', materialize: 'on-demand' })
    expect(await prisma.agentInstallationAuthorization.findUniqueOrThrow({ where: { id } })).toMatchObject({
      access: 'read'
    })
    // The tier rides the spec, so the lower one replicates at an advanced revision.
    expect(spy.upserts).toHaveLength(2)
    expect(spy.upserts[1]!.spec.workspace).toMatchObject({
      additionalInstallations: [{ accountLogin: 'acme', access: 'read' }]
    })
    expect(BigInt(spy.upserts[1]!.spec.configRevision!)).toBeGreaterThan(BigInt(spy.upserts[0]!.spec.configRevision!))
    await vi.waitFor(async () => {
      const audits = await prisma.auditEvent.findMany({ where: { kind: 'agent_repo_change', agentId } })
      expect(audits.map((e) => e.details)).toContainEqual(
        expect.objectContaining({ installationAuthId: id, previousAccess: 'write', access: 'read' })
      )
    })
  })

  it('PATCH refuses to lower a grant while a hook needs it on a repository only the grant covers', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await seedInstallation()
    const spy = new UpsertSpy()
    const a = replicatingApp(spy)
    const { id } = (await grantInstallation(a, agentId, { installationId: CLAIMED, access: 'write' })).json() as {
      id: string
    }
    const patchGrant = (payload: Record<string, unknown>) =>
      a.app.inject({ method: 'PATCH', url: `${grants(agentId)}/${id}`, payload })
    const reviewHook = (name: string, repoId: bigint, repoFullName: string) =>
      prisma.hookDef.create({
        data: {
          orgId: DEFAULT_ORG_ID,
          agentId,
          kind: 'github',
          name,
          enabled: true,
          sessionMode: 'perThread',
          repoId,
          repoFullName,
          family: 'pull_request',
          events: ['pull_request:*'],
          reviewPolicy: 'full',
          targetPlatform: 'slack'
        }
      })
    // Another account's repository is not the grant's to serve.
    await reviewHook('elsewhere-review', 222n, 'other-org/elsewhere')
    expect((await patchGrant({ access: 'comment' })).statusCode).toBe(200)
    expect((await patchGrant({ access: 'write' })).statusCode).toBe(200)

    const hook = await reviewHook('tools-review', 111n, 'ACME/tools')
    const refused = await patchGrant({ access: 'read', materialize: 'on-demand' })

    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({
      code: 'AGENT_REPO_INTEGRATION_CONFLICT',
      message: expect.stringContaining('this installation grant covers')
    })
    expect(await prisma.agentInstallationAuthorization.findUniqueOrThrow({ where: { id } })).toMatchObject({
      access: 'write'
    })
    const pushed = spy.upserts.length

    // A repository row of its own keeps its tier, so the grant no longer serves that hook.
    expect((await post(a, agentId, { repoFullName: 'acme/tools', access: 'write' })).statusCode).toBe(200)
    expect((await patchGrant({ access: 'read' })).statusCode).toBe(200)
    expect(spy.upserts.length).toBeGreaterThan(pushed + 1)
    expect(spy.upserts.at(-1)!.spec.workspace).toMatchObject({ additionalInstallations: [{ access: 'read' }] })
    // The row itself now carries the hook's need.
    const row = (await prisma.agentRepoAuthorization.findFirstOrThrow({ where: { agentId, repoId: 111n } })).id
    expect((await patch(a, agentId, row, { access: 'read' })).statusCode).toBe(409)
    await prisma.hookDef.delete({ where: { id: hook.id } })
    expect((await patch(a, agentId, row, { access: 'read' })).statusCode).toBe(200)
  })

  it('DELETE revokes and re-projects; another agent’s or an unknown grant reads 404', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = await workspaceAgent()
    const otherAgent = await workspaceAgent()
    await seedInstallation()
    const spy = new UpsertSpy()
    const a = replicatingApp(spy)
    const { id } = (await grantInstallation(a, agentId, { installationId: CLAIMED })).json() as { id: string }

    expect((await a.app.inject({ method: 'DELETE', url: `${grants(otherAgent)}/${id}` })).statusCode).toBe(404)
    expect((await a.app.inject({ method: 'DELETE', url: `${grants(agentId)}/${randomUUID()}` })).statusCode).toBe(404)
    expect((await a.app.inject({ method: 'DELETE', url: `${grants(agentId)}/${id}` })).statusCode).toBe(204)

    expect((await listGrants(a, agentId)).json()).toEqual([])
    expect(spy.upserts.at(-1)!.spec.workspace).toMatchObject({ additionalInstallations: [] })
    await vi.waitFor(async () => {
      const audits = await prisma.auditEvent.findMany({ where: { kind: 'agent_repo_change', agentId } })
      expect(audits.map((e) => e.message).sort()).toEqual([
        'installation acme authorization revoked',
        'installation acme authorized (read, on-demand)'
      ])
    })
  })

  it('a hook may watch a repository its installation grant covers, but Checks need the repository itself', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await seedInstallation()
    await seedRelay()
    const a = app()
    const hook = {
      agentId,
      kind: 'github',
      name: 'gh-hook',
      repoFullName: 'acme/tools',
      family: 'issues',
      events: ['issues:opened']
    }

    expect((await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: hook })).statusCode).toBe(409)
    expect((await grantInstallation(a, agentId, { installationId: CLAIMED, access: 'write' })).statusCode).toBe(200)
    expect((await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: hook })).statusCode).toBe(200)
    // A repository the installation does not cover is still not watchable.
    const uncovered = await a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: { ...hook, name: 'gh-uncovered', repoFullName: 'acme/unknown' }
    })
    expect(uncovered.statusCode).toBe(400)

    const checks = await a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: {
        ...hook,
        name: 'gh-checks',
        family: 'pull_request',
        events: ['pull_request:*'],
        reportingMode: 'check'
      }
    })
    expect(checks.statusCode).toBe(409)
    expect(checks.json()).toMatchObject({
      message: expect.stringContaining('an installation grant does not carry them')
    })
  })
})

describe('choosing repositories by decision (multi-repository-workspaces.md decisions 13–18)', () => {
  const SELECTOR = DECISION_PROVIDER_PROFILES.flatMap((provider) =>
    provider.models
      .filter((model) => model.questionTypes.includes('choice'))
      .map((model) => ({ providerId: provider.id, model: model.id }))
  )[0]!
  const SELECTOR_CAPS = { ...WORKSPACE_CAPS, features: [...WORKSPACE_CAPS.features, REPO_SELECTOR_V1_FEATURE] }
  const CLAIMED = Number(INSTALLATION)
  const grants = (agentId: string) => `${ORG}/agents/${agentId}/installations`
  const grantInstallation = (a: HttpApp, agentId: string, payload: Record<string, unknown>) =>
    a.app.inject({ method: 'POST', url: grants(agentId), payload })
  const patchGrant = (a: HttpApp, agentId: string, id: string, payload: Record<string, unknown>) =>
    a.app.inject({ method: 'PATCH', url: `${grants(agentId)}/${id}`, payload })
  const patchAgent = (a: HttpApp, agentId: string, payload: Record<string, unknown>) =>
    a.app.inject({ method: 'PATCH', url: `${ORG}/agents/${agentId}`, payload })
  const setSelector = (agentId: string) =>
    prisma.agent.update({
      where: { id: agentId },
      data: { repositorySelectorProviderId: SELECTOR.providerId, repositorySelectorModel: SELECTOR.model }
    })
  const upgradeDaemon = (daemonId = DAEMON) =>
    prisma.daemon.update({ where: { id: daemonId }, data: { capabilities: SELECTOR_CAPS } })
  const refusal = (res: { statusCode: number; json(): unknown }) => ({
    statusCode: res.statusCode,
    code: (res.json() as { code?: string }).code
  })

  it('a repository row needs the selector, then a daemon that runs it, on POST and PATCH', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: WORKSPACE_CAPS })
    const agentId = await workspaceAgent()
    await seedInstallation()
    const spy = new UpsertSpy()
    const a = replicatingApp(spy)

    const noSelector = await post(a, agentId, { repoFullName: 'acme/tools', materialize: 'decision' })
    expect(refusal(noSelector)).toEqual({ statusCode: 409, code: 'REPOSITORY_SELECTOR_MISSING' })
    expect((noSelector.json() as { message: string }).message).toMatch(/repositorySelector/)
    await setSelector(agentId)
    const oldDaemon = await post(a, agentId, { repoFullName: 'acme/tools', materialize: 'decision' })
    expect(refusal(oldDaemon)).toEqual({ statusCode: 409, code: 'DAEMON_FEATURE_MISSING' })
    expect(await prisma.agentRepoAuthorization.count()).toBe(0)

    const created = (await post(a, agentId, { repoFullName: 'acme/tools', materialize: 'on-demand' })).json() as {
      id: string
    }
    // Refused before the tier is considered: neither field moves.
    expect(refusal(await patch(a, agentId, created.id, { access: 'write', materialize: 'decision' }))).toEqual({
      statusCode: 409,
      code: 'DAEMON_FEATURE_MISSING'
    })
    expect(await prisma.agentRepoAuthorization.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      access: 'read',
      materialize: 'on_demand'
    })

    await upgradeDaemon()
    const moved = await patch(a, agentId, created.id, { materialize: 'decision' })
    expect(moved.statusCode, moved.body).toBe(200)
    expect(moved.json()).toMatchObject({ materialize: 'decision' })
    expect(spy.upserts.at(-1)!.spec.workspace).toMatchObject({
      additionalRepos: [expect.objectContaining({ repoFullName: 'acme/tools', materialize: 'decision' })]
    })
    await prisma.agentRepoAuthorization.deleteMany()
    const direct = await post(a, agentId, { repoFullName: 'acme/tools', materialize: 'decision' })
    expect(direct.statusCode, direct.body).toBe(200)
    expect(await prisma.agentRepoAuthorization.findFirstOrThrow()).toMatchObject({ materialize: 'decision' })
  })

  it('an installation grant needs the same preconditions on POST and PATCH', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: WORKSPACE_CAPS })
    const agentId = await workspaceAgent()
    await seedInstallation()
    const spy = new UpsertSpy()
    const a = replicatingApp(spy)

    expect(refusal(await grantInstallation(a, agentId, { installationId: CLAIMED, materialize: 'decision' }))).toEqual({
      statusCode: 409,
      code: 'REPOSITORY_SELECTOR_MISSING'
    })
    await setSelector(agentId)
    expect(refusal(await grantInstallation(a, agentId, { installationId: CLAIMED, materialize: 'decision' }))).toEqual({
      statusCode: 409,
      code: 'DAEMON_FEATURE_MISSING'
    })
    expect(await prisma.agentInstallationAuthorization.count()).toBe(0)

    const { id } = (await grantInstallation(a, agentId, { installationId: CLAIMED })).json() as { id: string }
    expect(refusal(await patchGrant(a, agentId, id, { materialize: 'decision' }))).toEqual({
      statusCode: 409,
      code: 'DAEMON_FEATURE_MISSING'
    })
    await upgradeDaemon()
    const moved = await patchGrant(a, agentId, id, { materialize: 'decision' })
    expect(moved.statusCode, moved.body).toBe(200)
    expect(moved.json()).toMatchObject({ materialize: 'decision' })
    expect(spy.upserts.at(-1)!.spec.workspace).toMatchObject({
      additionalInstallations: [{ provider: 'github', accountLogin: 'acme', access: 'read', materialize: 'decision' }]
    })
    expect((await patchGrant(a, agentId, id, { materialize: 'always' })).statusCode).toBe(400)

    await prisma.agentInstallationAuthorization.deleteMany()
    const direct = await grantInstallation(a, agentId, { installationId: CLAIMED, materialize: 'decision' })
    expect(direct.statusCode, direct.body).toBe(200)
    expect(await prisma.agentInstallationAuthorization.findFirstOrThrow()).toMatchObject({ materialize: 'decision' })
  })

  it('a group agent needs every ready member to run the selector', async () => {
    const [memberA, memberB] = [randomUUID(), randomUUID()]
    await seedDaemon(prisma, memberA, { capabilities: SELECTOR_CAPS })
    await seedDaemon(prisma, memberB, { capabilities: WORKSPACE_CAPS })
    const setId = randomUUID()
    await prisma.memberSet.create({ data: { id: setId, orgId: DEFAULT_ORG_ID, name: 'lab' } })
    await prisma.memberSetMember.createMany({ data: [memberA, memberB].map((daemonId) => ({ setId, daemonId })) })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, {
      setId,
      gitRepo: 'https://github.com/acme/infra',
      installationId: INSTALLATION_ROW
    })
    await setSelector(agentId)
    await seedInstallation()
    const ready = new Set<string>([memberA, memberB])
    const liveness: DaemonLiveness = {
      get: (id) => (ready.has(id) ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
    }
    const a = buildHttpApp(prisma, { PUBLIC_RELAY_URL: RELAY_URL }, liveness, undefined, { github: stubbedGithub() })
    opened.push(a)

    expect(refusal(await post(a, agentId, { repoFullName: 'acme/tools', materialize: 'decision' }))).toEqual({
      statusCode: 409,
      code: 'DAEMON_FEATURE_MISSING'
    })
    // A member that is not ready now does not hold the choice back.
    ready.delete(memberB)
    const accepted = await post(a, agentId, { repoFullName: 'acme/tools', materialize: 'decision' })
    expect(accepted.statusCode, accepted.body).toBe(200)
    ready.clear()
    expect(refusal(await grantInstallation(a, agentId, { installationId: CLAIMED, materialize: 'decision' }))).toEqual({
      statusCode: 409,
      code: 'DAEMON_FEATURE_MISSING'
    })
  })

  it('the selector cannot be cleared while a row or a grant is marked by decision', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: SELECTOR_CAPS })
    const agentId = await workspaceAgent()
    await setSelector(agentId)
    await seedInstallation()
    const a = app()
    const row = (await post(a, agentId, { repoFullName: 'acme/tools', materialize: 'decision' })).json() as {
      id: string
    }

    const inUse = await patchAgent(a, agentId, { repositorySelector: null })
    expect(inUse.statusCode).toBe(409)
    expect((inUse.json() as { message: string }).message).toMatch(/repository selector is in use/)
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).toMatchObject({
      repositorySelectorProviderId: SELECTOR.providerId
    })

    expect((await patch(a, agentId, row.id, { materialize: 'on-demand' })).statusCode).toBe(200)
    const { id } = (
      await grantInstallation(a, agentId, { installationId: CLAIMED, materialize: 'decision' })
    ).json() as {
      id: string
    }
    expect((await patchAgent(a, agentId, { repositorySelector: null })).statusCode).toBe(409)
    expect((await patchGrant(a, agentId, id, { materialize: 'on-demand' })).statusCode).toBe(200)

    const cleared = await patchAgent(a, agentId, { repositorySelector: null })
    expect(cleared.statusCode, cleared.body).toBe(200)
    expect(cleared.json()).toMatchObject({ repositorySelector: null })
  })
})
