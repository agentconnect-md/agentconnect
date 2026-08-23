/**
 * GitLab workspaces (gitlab-com-integration.md M4, CP half): agent create/edit
 * against a managed binding (§8.3 — the binding, never caller input, is the
 * authority), and the gitcred v2 GitLab grants served from the binding's
 * purpose-separated PATs under the workspace access clamp (§13.1/§17.1).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { FakeGitlab } from '../fakes/gitlab-api.js'
import { GitlabOauthService } from '../../src/gitlab/oauth.service.js'
import { GitlabProvisioner } from '../../src/gitlab/provisioner.js'
import { GitlabAccountService } from '../../src/gitlab/account.service.js'
import { gitlabAgentAccountUsername } from '../../src/gitlab/api.js'
import { GitlabGitcredService } from '../../src/gitlab/gitcred.service.js'
import { GitCredDeniedError } from '../../src/github/service.js'
import {
  PgAgentRepo,
  PgAgentRepoAuthorizationRepo,
  PgCodeHostRepositoryRepo,
  PgGitlabAgentAccountRepo,
  PgGitlabConnectionRepo,
  PgGitlabConnectionSecretStore,
  PgGitlabInstanceStateStore,
  PgGitlabOauthStateStore,
  PgGitlabProjectBindingRepo,
  PgGitlabProjectCredentialRepo,
  PgGitlabProjectCredentialSecretStore,
  PgGitlabWebhookSecretStore
} from '../../src/persistence/index.js'
import type { AgentRecord } from '../../src/persistence/ports.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { systemClock } from '../../src/domain/clock.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { OrgId } from '../../src/domain/ids.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const PROJECT = 4455667n
/** A second project under the SAME top-level group — the retarget's other half. */
const SECOND_PROJECT = 4455668n
const ROOT_GROUP = 900n
/** The agent whose own account (§7.2) backs every grant assertion below. */
const AGENT = '11111111-1111-4111-8111-111111111111'
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)

let running: HttpApp | undefined
let settleConvergence: (() => Promise<void>) | undefined
afterEach(async () => {
  // Own the routes' fire-and-forget convergence: a run outliving its test writes into the next one's swept database.
  await settleConvergence?.()
  settleConvergence = undefined
  await running?.close()
  running = undefined
})

async function harness(liveness?: DaemonLiveness) {
  // The second project answers with its own path, so a test holding both can tell
  // which one a grant or a credential resolved to.
  const fake = new FakeGitlab({ pathById: { [String(SECOND_PROJECT)]: 'example-group/example-second' } })
  const bindings = new PgGitlabProjectBindingRepo(prisma)
  const connections = new PgGitlabConnectionRepo(prisma)
  const oauth = new GitlabOauthService({
    cfg: { clientId: 'client-1', clientSecret: 'secret-1', baseUrl: fake.opts.baseUrl },
    connections,
    secrets: new PgGitlabConnectionSecretStore(prisma, cipher),
    states: new PgGitlabOauthStateStore(prisma),
    instanceState: new PgGitlabInstanceStateStore(prisma),
    cipher,
    clock: systemClock,
    publicCpUrl: 'https://api.example.test',
    api: fake.api
  })
  const accounts = new PgGitlabAgentAccountRepo(prisma)
  const accountService = new GitlabAccountService({
    oauth,
    accounts,
    credentials: new PgGitlabProjectCredentialRepo(prisma),
    credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, cipher),
    agents: new PgAgentRepo(prisma),
    cipher,
    clock: systemClock,
    api: fake.api
  })
  const provisioner = new GitlabProvisioner({
    oauth,
    bindings,
    accounts: accountService,
    webhookSecrets: new PgGitlabWebhookSecretStore(prisma, cipher),
    catalog: new PgCodeHostRepositoryRepo(prisma),
    instanceState: new PgGitlabInstanceStateStore(prisma),
    clock: systemClock,
    publicRelayUrl: 'https://relay.example.test',
    desiredWebhookEvents: async () => null,
    // Mirrors the container: the durable clone-URL convergence is AWAITED
    // inside the run, under the saga lease.
    syncWorkspacePaths: async (orgId, projectId, projectPath, cloneUrl) => {
      await new PgAgentRepo(prisma).refreshGitlabProjectPath(OrgId(orgId), projectId, projectPath, cloneUrl)
    },
    api: fake.api
  })
  // Route writes kick §10.2 convergence fire-and-forget, and the run re-writes every replicated project path from
  // what the provider answers with — so a test writing those paths itself has to outwait the run, not race it.
  const inFlightConvergence = new Set<Promise<void>>()
  const convergeProject = provisioner.convergeProject.bind(provisioner)
  provisioner.convergeProject = (orgId: string, projectId: bigint): Promise<void> => {
    const run = convergeProject(orgId, projectId)
    inFlightConvergence.add(run)
    return run.finally(() => inFlightConvergence.delete(run))
  }
  // A retarget converges two projects SEQUENTIALLY, so drain until nothing new is enqueued.
  const settled = async (): Promise<void> => {
    while (inFlightConvergence.size > 0) {
      await Promise.allSettled([...inFlightConvergence])
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  settleConvergence = settled
  running = buildHttpApp(prisma, { PUBLIC_CP_URL: 'https://api.example.test' }, liveness, undefined, {
    gitlab: { oauth, provisioner, accounts: accountService, api: fake.api }
  })
  const connection = await connections.upsertOnCallback({
    orgId: DEFAULT_ORG_ID,
    userId: DEFAULT_OWNER_ID,
    gitlabUserId: 4242n,
    gitlabUsername: 'example-admin',
    scopes: ['api'],
    accessExpiresAt: new Date(Date.now() + 3600_000),
    sealedPair: { accessToken: 'at-1', refreshToken: 'rt-1' },
    axisBaseUrl: 'https://gitlab.com'
  })
  const binding = await bindings.createWithClaim({
    orgId: DEFAULT_ORG_ID,
    projectId: PROJECT,
    projectPath: 'example-group/example-project',
    cloneUrl: 'https://gitlab.com/example-group/example-project.git',
    installerConnectionId: connection.id,
    axisBaseUrl: 'https://gitlab.com'
  })
  // The consuming agent exists BEFORE convergence, so the run gives it its own
  // account and project membership (§7.2) — the grants below resolve through it.
  await seedAgent(prisma, AGENT, { name: 'workspace-agent', gitlabProjectId: PROJECT })
  expect(await provisioner.provision(DEFAULT_ORG_ID, binding.id)).toEqual({ state: 'ready' })
  const account = (await accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
  return { fake, a: running, bindings, accounts, binding, account, provisioner, connection, settled }
}

function credService(bindings: PgGitlabProjectBindingRepo) {
  return new GitlabGitcredService({
    bindings,
    accounts: new PgGitlabAgentAccountRepo(prisma),
    credentials: new PgGitlabProjectCredentialRepo(prisma),
    credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, cipher),
    repoAuths: new PgAgentRepoAuthorizationRepo(prisma),
    clock: systemClock
  })
}

function gitlabAgent(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: AGENT,
    orgId: DEFAULT_ORG_ID,
    workspaceRepoId: PROJECT,
    workspace: { mode: 'gitlab', gitRepo: 'https://gitlab.com/example-group/example-project', gitAccess: 'write' },
    ...over
  } as AgentRecord
}

describe('gitlab workspaces — agent create/edit (§8.3)', () => {
  it('creates an agent on a managed binding: the binding is the clone-URL authority', async () => {
    const h = await harness()
    const res = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'gitlab-bot',
        runtime: 'claude',
        workspace: { mode: 'gitlab', projectId: PROJECT.toString(), gitAccess: 'write' }
      }
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json() as { id: string; workspace: Record<string, unknown>; workspaceRepoId: string | null }
    expect(dto.workspace).toMatchObject({
      mode: 'gitlab',
      worktree: true,
      gitRepo: 'https://gitlab.com/example-group/example-project.git',
      projectId: PROJECT.toString(),
      gitAccess: 'write'
    })
    expect(dto.workspaceRepoId).toBe(PROJECT.toString())

    const row = await prisma.agent.findUniqueOrThrow({ where: { id: dto.id } })
    expect(row.workspaceMode).toBe('gitlab')
    expect(row.workspaceRepoId).toBe(PROJECT)
  })

  it('refuses an unbound project and a deployment without the gitlab seam', async () => {
    const h = await harness()
    const unbound = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'g1', runtime: 'claude', workspace: { mode: 'gitlab', projectId: '999' } }
    })
    expect(unbound.statusCode).toBe(409)

    await running?.close()
    running = buildHttpApp(prisma, { PUBLIC_CP_URL: 'https://api.example.test' })
    const disabled = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'g2', runtime: 'claude', workspace: { mode: 'gitlab', projectId: PROJECT.toString() } }
    })
    expect(disabled.statusCode).toBe(409)
  })

  it('refuses a DIRECT placement on a daemon that has not advertised gitlab-com-v1 (§17.3)', async () => {
    const h = await harness()
    const OLD_DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
    const NEW_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
    await seedDaemon(prisma, OLD_DAEMON)
    await seedDaemon(prisma, NEW_DAEMON, {
      capabilities: { platforms: [], runtimes: ['claude'], acp: true, features: ['gitlab-com-v1'] }
    })
    const payload = (daemonId: string) => ({
      name: `gl-${daemonId.slice(0, 4)}`,
      runtime: 'claude',
      daemonId,
      workspace: { mode: 'gitlab', projectId: PROJECT.toString() }
    })
    expect(
      (await h.a.app.inject({ method: 'POST', url: `${ORG}/agents`, payload: payload(OLD_DAEMON) })).statusCode
    ).toBe(409)
    expect(
      (await h.a.app.inject({ method: 'POST', url: `${ORG}/agents`, payload: payload(NEW_DAEMON) })).statusCode
    ).toBe(201)
  })

  it('creation inherits the binding default branch when the caller names none', async () => {
    const h = await harness()
    await prisma.gitlabProjectBinding.update({ where: { id: h.binding.id }, data: { defaultBranch: 'develop' } })
    const res = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'gl-branch', runtime: 'claude', workspace: { mode: 'gitlab', projectId: PROJECT.toString() } }
    })
    expect(res.statusCode).toBe(201)
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: (res.json() as { id: string }).id } })
    expect(row.gitBranch).toBe('develop')
  })

  it('a workspace edit toward gitlab refuses a serving daemon without the feature (§17.3)', async () => {
    const DAEMON = 'd3d3d3d3-dddd-4ddd-8ddd-dddddddddddd'
    const h = await harness({
      get: (id: string) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
    })
    await seedDaemon(prisma, DAEMON, {
      capabilities: { platforms: [], runtimes: ['claude'], acp: true, features: ['workspace-edit-v2'] }
    })
    const created = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'placed-bot', runtime: 'claude', daemonId: DAEMON }
    })
    expect(created.statusCode).toBe(201)
    const agentId = (created.json() as { id: string }).id
    const res = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'gitlab', projectId: PROJECT.toString() }
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toContain('does not support GitLab workspaces')
  })

  it('a workspace write converges the new agent’s own account, and leaving retires it (§7.2)', async () => {
    const h = await harness()
    const created = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'gl-joiner', runtime: 'claude', workspace: { mode: 'gitlab', projectId: PROJECT.toString() } }
    })
    expect(created.statusCode).toBe(201)
    const agentId = (created.json() as { id: string }).id

    // Creating the workspace made this agent a consumer, so the kick gives it
    // its own account, project membership, and PATs — no repair needed.
    await vi.waitFor(
      async () => {
        const account = await h.accounts.byAgentRoot(DEFAULT_ORG_ID, agentId, ROOT_GROUP)
        expect(account?.state).toBe('ready')
        expect(h.fake.members.get(Number(account!.serviceAccountUserId))).toBe(30)
        expect(await new PgGitlabProjectCredentialRepo(prisma).listForAccount(account!.id)).toHaveLength(3)
      },
      { timeout: 20_000 }
    )
    const joined = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, agentId, ROOT_GROUP))!

    // Moving the workspace off the project takes the authorization with it.
    const moved = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'scratch' }
    })
    expect(moved.statusCode).toBe(200)
    await vi.waitFor(
      async () => {
        expect(await h.accounts.byAgentRoot(DEFAULT_ORG_ID, agentId, ROOT_GROUP)).toBeNull()
        expect(h.fake.removedMembers).toContain(Number(joined.serviceAccountUserId))
      },
      { timeout: 20_000 }
    )
    // Drain the fire-and-forget kicks so no background run still holds the lease.
    await vi.waitFor(
      async () => expect((await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).state).not.toBe('busy'),
      { timeout: 20_000 }
    )
  })

  it('a binding path refresh converges affected agent clone URLs with a revision bump', async () => {
    const h = await harness()
    const created = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'gl-rename', runtime: 'claude', workspace: { mode: 'gitlab', projectId: PROJECT.toString() } }
    })
    expect(created.statusCode).toBe(201)
    const agentId = (created.json() as { id: string }).id
    // Outwait the create's kick: the rename below is a provider-side fact this fake never learns, so a run landing
    // after it would legitimately converge the clone URL back to the path the provider still answers with.
    await h.settled()
    const before = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
    const agents = new PgAgentRepo(prisma)
    const renamed = { path: 'example-group/renamed-project', clone: 'https://gitlab.com/example-group/renamed.git' }
    const refreshed = await agents.refreshGitlabProjectPath(OrgId(DEFAULT_ORG_ID), PROJECT, renamed.path, renamed.clone)
    // Every gitlab-workspace agent on the project drifts, the harness's included.
    expect(refreshed).toContain(agentId)
    const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
    expect(after.gitRepo).toBe(renamed.clone)
    expect(after.configRevision).toBe(before.configRevision + 1n)
    // Idempotent: an unchanged path touches nothing.
    expect(await agents.refreshGitlabProjectPath(OrgId(DEFAULT_ORG_ID), PROJECT, renamed.path, renamed.clone)).toEqual(
      []
    )
  })

  it('the SAGA converges renamed clone URLs durably, inside the leased run (round 3)', async () => {
    const h = await harness()
    const created = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'gl-saga-rename',
        runtime: 'claude',
        workspace: { mode: 'gitlab', projectId: PROJECT.toString() }
      }
    })
    expect(created.statusCode).toBe(201)
    const agentId = (created.json() as { id: string }).id
    // Provider-side rename: the next provisioning run re-reads the path by
    // numeric id and must land the agent update before the run completes.
    h.fake.opts.path = 'example-group/project-renamed'
    // The create kicked its own §7.2 convergence; converge the way production
    // does, which outwaits that peer's lease instead of racing it.
    await h.provisioner.convergeProject(DEFAULT_ORG_ID, PROJECT)
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.state).toBe('ready')
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
    expect(row.gitRepo).toBe('https://gitlab.com/example-group/project-renamed.git')
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.projectPath).toBe('example-group/project-renamed')
  })

  it('retargets an existing agent onto the binding through the workspace edit route', async () => {
    const h = await harness()
    const created = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'scratch-bot', runtime: 'claude' }
    })
    expect(created.statusCode).toBe(201)
    const agentId = (created.json() as { id: string }).id
    const res = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'gitlab', projectId: PROJECT.toString(), gitAccess: 'read' }
    })
    expect(res.statusCode).toBe(200)
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
    expect(row.workspaceMode).toBe('gitlab')
    expect(row.workspaceRepoId).toBe(PROJECT)
    expect(row.gitBranch).toBe('main')
    expect(row.gitAccess).toBe('read')
  })

  it('provisions the agent’s account inline, before the workspace edit activates (§7.2)', async () => {
    const h = await harness()
    // The live-testing shape: a project picked and provisioned moments ago, so
    // it has no consumers and therefore no accounts at all.
    const fresh = await h.bindings.createWithClaim({
      orgId: DEFAULT_ORG_ID,
      projectId: SECOND_PROJECT,
      projectPath: 'example-group/example-second',
      cloneUrl: 'https://gitlab.com/example-group/example-second.git',
      installerConnectionId: h.connection.id,
      axisBaseUrl: 'https://gitlab.com'
    })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, fresh.id)).toEqual({ state: 'ready' })
    expect(await h.accounts.listForBinding(fresh.id)).toHaveLength(0)

    const created = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'gl-picker', runtime: 'claude' }
    })
    expect(created.statusCode).toBe(201)
    const agentId = (created.json() as { id: string }).id

    const res = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'gitlab', projectId: SECOND_PROJECT.toString(), gitAccess: 'write' }
    })
    expect(res.statusCode).toBe(200)

    // Asserted with NO polling on purpose: the identity has to exist by the time
    // the response is written, because activation runs inside this request and
    // mints its credentials from it.
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, agentId, ROOT_GROUP))!
    expect(account.state).toBe('ready')
    expect((await h.accounts.membershipsForBinding(fresh.id)).map((m) => m.accountId)).toEqual([account.id])
    expect(h.fake.members.get(Number(account.serviceAccountUserId))).toBe(30)
    expect(await new PgGitlabProjectCredentialRepo(prisma).listForAccount(account.id)).toHaveLength(3)

    // …and the grant the daemon asks for while preparing the workspace resolves.
    const grant = await credService(h.bindings).grantForAgent(
      gitlabAgent({ id: agentId, workspaceRepoId: SECOND_PROJECT } as Partial<AgentRecord>)
    )
    expect(grant.username).toBe(account.username)
    expect(grant.access).toBe('write')
  })

  it('refuses the workspace edit with the account’s own repair reason, writing nothing', async () => {
    const h = await harness()
    const fresh = await h.bindings.createWithClaim({
      orgId: DEFAULT_ORG_ID,
      projectId: SECOND_PROJECT,
      projectPath: 'example-group/example-second',
      cloneUrl: 'https://gitlab.com/example-group/example-second.git',
      installerConnectionId: h.connection.id,
      axisBaseUrl: 'https://gitlab.com'
    })
    await h.provisioner.provision(DEFAULT_ORG_ID, fresh.id)
    const created = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'gl-refused', runtime: 'claude' }
    })
    const agentId = (created.json() as { id: string }).id

    // The top-level group is out of service-account slots (§7.2).
    h.fake.opts.refuseServiceAccountQuota = true
    const res = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'gitlab', projectId: SECOND_PROJECT.toString() }
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toContain('no service-account slots left')
    // The workspace was never written, so the agent is untouched.
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).workspaceMode).toBe('scratch')
    expect(await h.accounts.membershipsForBinding(fresh.id)).toHaveLength(0)
  })

  it('a retarget within one top-level group keeps the agent’s account alive (§7.2)', async () => {
    const h = await harness()
    // A second managed project under the SAME root, so both share one account.
    const second = await h.bindings.createWithClaim({
      orgId: DEFAULT_ORG_ID,
      projectId: SECOND_PROJECT,
      projectPath: 'example-group/example-second',
      cloneUrl: 'https://gitlab.com/example-group/example-second.git',
      installerConnectionId: h.connection.id,
      axisBaseUrl: 'https://gitlab.com'
    })
    const before = h.account
    expect(before.serviceAccountUserId).not.toBeNull()

    const moved = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${AGENT}/workspace`,
      payload: { mode: 'gitlab', projectId: SECOND_PROJECT.toString() }
    })
    expect(moved.statusCode).toBe(200)

    // The route converges the DESTINATION first, so the account is bound there
    // before the source unbind can find its root empty and retire it.
    await vi.waitFor(
      async () => {
        expect((await h.accounts.membershipsForBinding(second.id)).map((m) => m.accountId)).toEqual([before.id])
        expect(await h.accounts.membershipsForBinding(h.binding.id)).toHaveLength(0)
      },
      { timeout: 30_000 }
    )
    // The identity survived the move: same row, same GitLab user, same PATs.
    const after = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(after.id).toBe(before.id)
    expect(after.serviceAccountUserId).toBe(before.serviceAccountUserId)
    expect(after.generation).toBe(before.generation)
    expect(h.fake.deletedServiceAccounts).toEqual([])
    expect([...h.fake.tokens.values()].every((token) => !token.revoked)).toBe(true)
    expect(await new PgGitlabProjectCredentialRepo(prisma).listForAccount(after.id)).toHaveLength(3)
  })
})

describe('gitcred v2 GitLab grants (§13.1/§17.1)', () => {
  it('serves the read or git_write PAT under the workspace access clamp, with the v2 echo', async () => {
    const h = await harness()
    const service = credService(h.bindings)
    const creds = new PgGitlabProjectCredentialRepo(prisma)
    const store = new PgGitlabProjectCredentialSecretStore(prisma, cipher)

    const write = await service.grantForAgent(gitlabAgent())
    const gitWriteCred = (await creds.get(h.account.id, 'git_write'))!
    expect(write.token).toBe(await store.get(DEFAULT_ORG_ID, gitWriteCred.id))
    expect(write.access).toBe('write')
    expect(write.provider).toBe('gitlab')
    expect(write.externalRepoId).toBe(PROJECT.toString())
    expect(write.username).toBe(gitlabAgentAccountUsername(AGENT, 'workspace-agent', ROOT_GROUP))
    expect(write.repoFullName).toBe('example-group/example-project')
    expect(write.credentialEpoch).toBe((await h.accounts.get(h.account.id))!.credentialEpoch.toString())
    expect(write.ttlSec).toBeGreaterThan(0)
    expect(write.ttlSec).toBeLessThanOrEqual(3600)

    const read = await service.grantForAgent(
      gitlabAgent({
        workspace: { mode: 'gitlab', gitRepo: 'https://gitlab.com/example-group/example-project', gitAccess: 'read' }
      } as Partial<AgentRecord>)
    )
    const readCred = (await creds.get(h.account.id, 'read'))!
    expect(read.token).toBe(await store.get(DEFAULT_ORG_ID, readCred.id))
    expect(read.access).toBe('read')

    // §17.1: requestedAccess narrows a write clamp to the read PAT (the CLI
    // wrapper's ask) — and can never widen a read clamp.
    const narrowed = await service.grantForAgent(gitlabAgent(), undefined, 'read')
    expect(narrowed.access).toBe('read')
    expect(narrowed.token).toBe(await store.get(DEFAULT_ORG_ID, readCred.id))
    const readAgent = gitlabAgent({
      workspace: { mode: 'gitlab', gitRepo: 'https://gitlab.com/example-group/example-project', gitAccess: 'read' }
    } as Partial<AgentRecord>)
    expect((await service.grantForAgent(readAgent, undefined, 'write')).access).toBe('read')
  })

  it('denies a foreign project, a non-gitlab workspace, and a binding entering cleanup', async () => {
    const h = await harness()
    const service = credService(h.bindings)
    await expect(service.grantForAgent(gitlabAgent(), 999n)).rejects.toThrowError(GitCredDeniedError)
    await expect(
      service.grantForAgent(gitlabAgent({ workspace: { mode: 'scratch' } } as Partial<AgentRecord>))
    ).rejects.toThrowError(GitCredDeniedError)
    await prisma.gitlabProjectBinding.update({ where: { id: h.binding.id }, data: { state: 'cleanup_pending' } })
    await expect(service.grantForAgent(gitlabAgent())).rejects.toThrowError(GitCredDeniedError)
  })

  it('runtime_degraded stops NEW authority (§19.3); admin_degraded keeps serving', async () => {
    const h = await harness()
    const service = credService(h.bindings)
    await prisma.gitlabProjectBinding.update({ where: { id: h.binding.id }, data: { state: 'admin_degraded' } })
    expect((await service.grantForAgent(gitlabAgent())).provider).toBe('gitlab')
    await prisma.gitlabProjectBinding.update({ where: { id: h.binding.id }, data: { state: 'runtime_degraded' } })
    const denial = await service.grantForAgent(gitlabAgent()).catch((e: GitCredDeniedError) => e)
    expect(denial).toBeInstanceOf(GitCredDeniedError)
    expect((denial as GitCredDeniedError).code).toBe('LEASE_DENIED')
    expect((denial as GitCredDeniedError).retryable).toBe(true)
  })

  it('refuses an expired underlying PAT instead of serving a dead token', async () => {
    const h = await harness()
    const service = credService(h.bindings)
    await prisma.gitlabProjectCredential.updateMany({
      where: { accountId: h.account.id },
      data: { providerExpiresAt: new Date(Date.now() - 1000) }
    })
    await expect(service.grantForAgent(gitlabAgent())).rejects.toThrowError(GitCredDeniedError)
  })

  it('grantForHookReply serves the effect PAT on a short action-time lease (§14.1)', async () => {
    const h = await harness()
    const service = credService(h.bindings)
    const creds = new PgGitlabProjectCredentialRepo(prisma)
    const store = new PgGitlabProjectCredentialSecretStore(prisma, cipher)

    const grant = await service.grantForHookReply(DEFAULT_ORG_ID, AGENT, PROJECT)

    const effect = (await creds.get(h.account.id, 'effect'))!
    expect(grant.token).toBe(await store.get(DEFAULT_ORG_ID, effect.id))
    // Never a workspace PAT: the reply carries api effect scope, not contents.
    expect(grant.token).not.toBe(await store.get(DEFAULT_ORG_ID, (await creds.get(h.account.id, 'read'))!.id))
    expect(grant.token).not.toBe(await store.get(DEFAULT_ORG_ID, (await creds.get(h.account.id, 'git_write'))!.id))
    expect(grant.access).toBe('read')
    expect(grant.provider).toBe('gitlab')
    expect(grant.username).toBe(gitlabAgentAccountUsername(AGENT, 'workspace-agent', ROOT_GROUP))
    expect(grant.externalRepoId).toBe(PROJECT.toString())
    expect(grant.repoFullName).toBe('example-group/example-project')
    // Action-time, not the hourly workspace lease.
    expect(grant.ttlSec).toBeGreaterThan(0)
    expect(grant.ttlSec).toBeLessThanOrEqual(900)

    await prisma.gitlabProjectBinding.update({ where: { id: h.binding.id }, data: { state: 'runtime_degraded' } })
    await expect(service.grantForHookReply(DEFAULT_ORG_ID, AGENT, PROJECT)).rejects.toThrowError(GitCredDeniedError)
  })

  it('grantForBrokerEffect clamps the same effect PAT by the workspace authorization (§14.2)', async () => {
    const h = await harness()
    const service = credService(h.bindings)
    const creds = new PgGitlabProjectCredentialRepo(prisma)
    const store = new PgGitlabProjectCredentialSecretStore(prisma, cipher)
    const effectToken = await store.get(DEFAULT_ORG_ID, (await creds.get(h.account.id, 'effect'))!.id)

    // A write workspace earns full effect authority on the same action-time lease as the poster.
    const write = await service.grantForBrokerEffect(gitlabAgent(), PROJECT, false)
    expect(write.access).toBe('write')
    expect(write.token).toBe(effectToken)
    expect(write.provider).toBe('gitlab')
    expect(write.externalRepoId).toBe(PROJECT.toString())
    expect(write.ttlSec).toBeGreaterThan(0)
    expect(write.ttlSec).toBeLessThanOrEqual(900)

    // A read workspace gets the SAME PAT under a comment-level clamp the broker enforces per operation.
    const readAgent = gitlabAgent({
      workspace: { mode: 'gitlab', gitRepo: 'https://gitlab.com/example-group/example-project', gitAccess: 'read' }
    } as Partial<AgentRecord>)
    const read = await service.grantForBrokerEffect(readAgent, PROJECT, false)
    expect(read.access).toBe('comment')
    expect(read.token).toBe(effectToken)

    // An agent whose workspace is not this project is admitted only by an enabled hook, at comment level.
    const unbound = gitlabAgent({ workspace: { mode: 'scratch' } } as Partial<AgentRecord>)
    expect((await service.grantForBrokerEffect(unbound, PROJECT, true)).access).toBe('comment')

    // Neither authorization ⇒ terminal refusal, and a write workspace on ANOTHER project is not one.
    const denial = await service.grantForBrokerEffect(unbound, PROJECT, false).catch((e: GitCredDeniedError) => e)
    expect(denial).toBeInstanceOf(GitCredDeniedError)
    expect((denial as GitCredDeniedError).code).toBe('SCOPE_DENIED')
    expect((denial as GitCredDeniedError).retryable).toBe(false)
    await expect(service.grantForBrokerEffect(gitlabAgent(), 999n, false)).rejects.toThrowError(GitCredDeniedError)

    // §19.3: runtime drift refuses a NEW effect lease exactly as it refuses a workspace one.
    await prisma.gitlabProjectBinding.update({ where: { id: h.binding.id }, data: { state: 'runtime_degraded' } })
    const degraded = await service
      .grantForBrokerEffect(gitlabAgent(), PROJECT, false)
      .catch((e: GitCredDeniedError) => e)
    expect((degraded as GitCredDeniedError).code).toBe('LEASE_DENIED')
    expect((degraded as GitCredDeniedError).retryable).toBe(true)
  })
})

describe('additional GitLab project authorizations (§8.3/§13.1)', () => {
  /** A second managed binding under the same top-level group, with no consumer yet. */
  async function secondBinding(h: Awaited<ReturnType<typeof harness>>) {
    const fresh = await h.bindings.createWithClaim({
      orgId: DEFAULT_ORG_ID,
      projectId: SECOND_PROJECT,
      projectPath: 'example-group/example-second',
      cloneUrl: 'https://gitlab.com/example-group/example-second.git',
      installerConnectionId: h.connection.id,
      axisBaseUrl: 'https://gitlab.com'
    })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, fresh.id)).toEqual({ state: 'ready' })
    expect(await h.accounts.listForBinding(fresh.id)).toHaveLength(0)
    return fresh
  }

  const authorize = (payload: Record<string, unknown>) => ({
    method: 'POST' as const,
    url: `${ORG}/agents/${AGENT}/repos`,
    payload
  })

  const grants = () => running!.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/repos` }).then((r) => r.json())

  it('authorizes a project, provisioning the agent’s account and membership inline (§7.2)', async () => {
    const h = await harness()
    const fresh = await secondBinding(h)

    const res = await h.a.app.inject(authorize({ provider: 'gitlab', projectId: SECOND_PROJECT.toString() }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      provider: 'gitlab',
      repoId: SECOND_PROJECT.toString(),
      repoFullName: 'example-group/example-second',
      access: 'read'
    })

    // Asserted with NO polling: the account is the write's own precondition, so it
    // exists by the time the response is written — the grant row and the membership
    // become visible to convergence together.
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect((await h.accounts.membershipsForBinding(fresh.id)).map((m) => m.accountId)).toEqual([account.id])
    // read ⇒ Reporter, the same clamp a read workspace derives (§13.1).
    expect(h.fake.members.get(Number(account.serviceAccountUserId))).toBe(20)

    // The catalog converged on the project too (§8.1).
    expect(
      await prisma.codeHostRepository.findUnique({
        where: {
          orgId_provider_externalId: { orgId: DEFAULT_ORG_ID, provider: 'gitlab', externalId: SECOND_PROJECT }
        }
      })
    ).toMatchObject({ displayPath: 'example-group/example-second' })

    expect(await grants()).toMatchObject([{ provider: 'gitlab', repoId: SECOND_PROJECT.toString() }])
  })

  it('serves a read credential for the authorized project, not the workspace one (§13.1)', async () => {
    const h = await harness()
    await secondBinding(h)
    const created = await h.a.app.inject(authorize({ provider: 'gitlab', projectId: SECOND_PROJECT.toString() }))
    expect(created.statusCode).toBe(200)
    const service = credService(h.bindings)
    const creds = new PgGitlabProjectCredentialRepo(prisma)
    const store = new PgGitlabProjectCredentialSecretStore(prisma, cipher)

    const grant = await service.grantForAgent(gitlabAgent(), SECOND_PROJECT)
    expect(grant.provider).toBe('gitlab')
    expect(grant.externalRepoId).toBe(SECOND_PROJECT.toString())
    expect(grant.repoFullName).toBe('example-group/example-second')
    // The grant's own tier is the ceiling — a write WORKSPACE does not widen it.
    expect(grant.access).toBe('read')
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(grant.token).toBe(await store.get(DEFAULT_ORG_ID, (await creds.get(account.id, 'read'))!.id))

    // The workspace ask still resolves to the workspace project.
    expect((await service.grantForAgent(gitlabAgent())).externalRepoId).toBe(PROJECT.toString())
    // A project that is neither remains a denial, never a fallback onto the workspace.
    await expect(service.grantForAgent(gitlabAgent(), 999n)).rejects.toThrowError(GitCredDeniedError)
  })

  it('commits the path the provider answers with inside the lease, not the pre-lease capture', async () => {
    // A rename between the binding read and the write is exactly when a captured
    // path becomes the losing side. The grant is what the daemon maps a NAMED
    // project back to its numeric id with, so persisting the stale one would
    // replicate a path the checkout can never be found under.
    const h = await harness()
    const fresh = await secondBinding(h)
    expect(fresh.projectPath).toBe('example-group/example-second')

    // The project is renamed at GitLab; no convergence has run since.
    h.fake.opts.pathById = { [String(SECOND_PROJECT)]: 'example-group/renamed-second' }

    const res = await h.a.app.inject(authorize({ provider: 'gitlab', projectId: SECOND_PROJECT.toString() }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ repoFullName: 'example-group/renamed-second' })
    expect(await grants()).toMatchObject([{ repoFullName: 'example-group/renamed-second' }])

    // The same read converged the durable replicas, so nothing disagrees.
    expect((await h.bindings.get(DEFAULT_ORG_ID, fresh.id))?.projectPath).toBe('example-group/renamed-second')
    expect(
      await prisma.codeHostRepository.findUnique({
        where: {
          orgId_provider_externalId: { orgId: DEFAULT_ORG_ID, provider: 'gitlab', externalId: SECOND_PROJECT }
        }
      })
    ).toMatchObject({ displayPath: 'example-group/renamed-second' })
  })

  it('raises the account’s project role when the tier is raised', async () => {
    const h = await harness()
    const fresh = await secondBinding(h)
    const created = await h.a.app.inject(authorize({ provider: 'gitlab', projectId: SECOND_PROJECT.toString() }))
    expect(created.statusCode).toBe(200)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(h.fake.members.get(Number(account.serviceAccountUserId))).toBe(20)

    const raised = await h.a.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${AGENT}/repos/${(created.json() as { id: string }).id}`,
      payload: { access: 'write' }
    })
    expect(raised.statusCode).toBe(200)
    expect(raised.json()).toMatchObject({ provider: 'gitlab', access: 'write' })
    // write ⇒ Developer, the push role.
    expect(h.fake.members.get(Number(account.serviceAccountUserId))).toBe(30)
    expect(await h.accounts.membershipsForBinding(fresh.id)).toHaveLength(1)

    const service = credService(h.bindings)
    expect((await service.grantForAgent(gitlabAgent(), SECOND_PROJECT)).access).toBe('write')
  })

  it('drops the consumer when the authorization is revoked', async () => {
    const h = await harness()
    const fresh = await secondBinding(h)
    const created = await h.a.app.inject(authorize({ provider: 'gitlab', projectId: SECOND_PROJECT.toString() }))
    expect(created.statusCode).toBe(200)
    expect(await h.accounts.membershipsForBinding(fresh.id)).toHaveLength(1)

    const removed = await h.a.app.inject({
      method: 'DELETE',
      url: `${ORG}/agents/${AGENT}/repos/${(created.json() as { id: string }).id}`
    })
    expect(removed.statusCode).toBe(204)
    expect(await grants()).toEqual([])
    // Membership detach is the converge kick's, so it settles just after the reply.
    await vi.waitFor(async () => expect(await h.accounts.membershipsForBinding(fresh.id)).toHaveLength(0), {
      timeout: 20_000
    })
    // The workspace project keeps the account alive in this root.
    expect((await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))?.state).toBe('ready')

    const service = credService(h.bindings)
    await expect(service.grantForAgent(gitlabAgent(), SECOND_PROJECT)).rejects.toThrowError(GitCredDeniedError)
  })

  it('refuses an unmanaged project, the workspace project, and a duplicate', async () => {
    const h = await harness()
    await secondBinding(h)

    const unmanaged = await h.a.app.inject(authorize({ provider: 'gitlab', projectId: '999' }))
    expect(unmanaged.statusCode).toBe(409)
    expect((unmanaged.json() as { message: string }).message).toContain('not a managed GitLab project')

    const workspace = await h.a.app.inject(authorize({ provider: 'gitlab', projectId: PROJECT.toString() }))
    expect(workspace.statusCode).toBe(409)
    expect((workspace.json() as { message: string }).message).toContain('workspace project')

    const first = await h.a.app.inject(authorize({ provider: 'gitlab', projectId: SECOND_PROJECT.toString() }))
    expect(first.statusCode).toBe(200)
    const again = await h.a.app.inject(authorize({ provider: 'gitlab', projectId: SECOND_PROJECT.toString() }))
    expect(again.statusCode).toBe(409)
    expect((again.json() as { message: string }).message).toContain('already authorized')
  })

  it('carries a project rename into the grant path and the replicated spec', async () => {
    // The daemon maps a NAMED gitlab project back to its numeric id through this
    // path in the replicated spec. A rename that refreshed only the binding and
    // the workspace would orphan the new path, and an ask under the old one is
    // answered with the binding's new path and then rejected by the echo check.
    const h = await harness()
    await secondBinding(h)
    const created = await h.a.app.inject(authorize({ provider: 'gitlab', projectId: SECOND_PROJECT.toString() }))
    expect(created.statusCode).toBe(200)
    // Same as the workspace half: outwait the authorization's kick, which re-writes the grant path from the provider.
    await h.settled()
    const before = await prisma.agent.findUniqueOrThrow({ where: { id: AGENT } })

    const agents = new PgAgentRepo(prisma)
    const refreshed = await agents.refreshGitlabProjectPath(
      OrgId(DEFAULT_ORG_ID),
      SECOND_PROJECT,
      'example-group/renamed-second'
    )

    // The grant's owner joins the rename's configuration-ordering domain, so the
    // spec push replicates the new path.
    expect(refreshed).toContain(AGENT)
    expect(await grants()).toMatchObject([{ repoFullName: 'example-group/renamed-second' }])
    const after = await prisma.agent.findUniqueOrThrow({ where: { id: AGENT } })
    expect(after.configRevision).toBe(before.configRevision + 1n)
    // The workspace project is a different project: its own path is untouched.
    expect(after.gitRepo).toBe('https://gitlab.com/example-group/example-project.git')
    // Idempotent, exactly as the workspace half is.
    expect(
      await agents.refreshGitlabProjectPath(OrgId(DEFAULT_ORG_ID), SECOND_PROJECT, 'example-group/renamed-second')
    ).toEqual([])
  })

  it('bumps one revision when a rename moves an agent’s workspace AND its grant', async () => {
    // The same agent may hold the workspace on one project and a grant on it too
    // only transiently, but a rename touching both halves must still advance the
    // revision once: two bumps for one rename would be a spec the daemon refuses.
    const h = await harness()
    await prisma.agentRepoAuthorization.create({
      data: {
        agentId: AGENT,
        provider: 'gitlab',
        repoId: PROJECT,
        repoFullName: 'example-group/example-project',
        access: 'read'
      }
    })
    const before = await prisma.agent.findUniqueOrThrow({ where: { id: AGENT } })
    const agents = new PgAgentRepo(prisma)

    const clone = 'https://gitlab.com/example-group/renamed-project.git'
    expect(
      await agents.refreshGitlabProjectPath(OrgId(DEFAULT_ORG_ID), PROJECT, 'example-group/renamed-project', clone)
    ).toEqual([AGENT])
    const after = await prisma.agent.findUniqueOrThrow({ where: { id: AGENT } })
    expect(after.configRevision).toBe(before.configRevision + 1n)
    expect(after.gitRepo).toBe(clone)
    expect(await grants()).toMatchObject([{ repoFullName: 'example-group/renamed-project' }])
  })

  it('undoes the account a refused authorization speculatively created (§7.2)', async () => {
    const h = await harness()
    // Nothing else makes the agent a consumer once its workspace account is gone,
    // so this write is the only thing that would — and its PATs come back out of
    // policy, failing the ensure with real provider state already behind it.
    const fresh = await secondBinding(h)
    await prisma.agent.update({
      where: { id: AGENT },
      data: { workspaceMode: 'scratch', workspaceRepoId: null, gitRepo: null }
    })
    await prisma.gitlabAccountMembership.deleteMany({})
    await prisma.gitlabAgentAccount.deleteMany({})
    h.fake.opts.patExpiryOverride = null

    const res = await h.a.app.inject(authorize({ provider: 'gitlab', projectId: SECOND_PROJECT.toString() }))
    expect(res.statusCode).toBe(409)
    expect(await grants()).toEqual([])
    expect(await h.accounts.listForAgent(DEFAULT_ORG_ID, AGENT)).toHaveLength(0)
    expect(await h.accounts.membershipsForBinding(fresh.id)).toHaveLength(0)
  })
})
