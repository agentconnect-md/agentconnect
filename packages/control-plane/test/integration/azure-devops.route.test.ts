// Azure DevOps on the Control Plane (azure-devops-integration.md §3-§6.1): connect, picker, first-use binding, removal, states, leases.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { trackedTestClock } from '../fakes/tracked-clock.js'
import {
  CLIENT_ID,
  DEPLOYMENT_CLIENT_ID,
  FakeAzureDevOps,
  IDENTITY_ID,
  INSTANCE_ID,
  ORGANIZATION,
  PROJECT_ID,
  REPOSITORY_ID,
  SECOND_REPOSITORY_ID,
  TENANT_ID,
  exampleRepository,
  type FakeAzureDevOpsOptions
} from '../fakes/azure-devops-api.js'
import { AzureDevOpsConnectionService } from '../../src/azure-devops/connection.service.js'
import { AzureDevOpsBindingService } from '../../src/azure-devops/binding.service.js'
import { AzureDevOpsGitcredService } from '../../src/azure-devops/gitcred.service.js'
import { AzureDevOpsTokenCache } from '../../src/azure-devops/token-cache.js'
import {
  PgAzureDevOpsConnectionRepo,
  PgAzureDevOpsConnectionSecretStore,
  PgAzureDevOpsRepositoryBindingRepo
} from '../../src/persistence/repositories/azure-devops.repo.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgAgentRepoAuthorizationRepo } from '../../src/persistence/repositories/agent-repo-auth.repo.js'
import { AzureDevOpsRepositoryClaimConflict } from '../../src/persistence/errors.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const GIT_REPO = 'https://dev.azure.com/example-org/Example%20Project/_git/Example%20Repo'
const ROUTING = { organization: ORGANIZATION, projectId: PROJECT_ID, repositoryId: REPOSITORY_ID }
const clock = trackedTestClock()
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)
const OWN_APP = { organization: ORGANIZATION, tenantId: TENANT_ID, clientId: CLIENT_ID, clientSecret: 'example-secret' }

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

function harness(opts: { fake?: FakeAzureDevOpsOptions; deploymentSecret?: string } = {}) {
  const fake = new FakeAzureDevOps(opts.fake)
  const connectionRepo = new PgAzureDevOpsConnectionRepo(prisma)
  const bindings = new PgAzureDevOpsRepositoryBindingRepo(prisma)
  const epochChanges: string[] = []
  const service = new AzureDevOpsConnectionService({
    connections: connectionRepo,
    secrets: new PgAzureDevOpsConnectionSecretStore(prisma, cipher),
    bindings,
    cipher,
    clock,
    api: fake.api,
    tokens: new AzureDevOpsTokenCache(() => clock.now()),
    ...(opts.deploymentSecret !== undefined
      ? { deploymentApplication: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: opts.deploymentSecret } }
      : {}),
    onCredentialEpochChanged: (_orgId, connection) => void epochChanges.push(connection.id)
  })
  const bindingService = new AzureDevOpsBindingService({
    connections: connectionRepo,
    bindings,
    service,
    api: fake.api
  })
  running = buildHttpApp(prisma, {}, undefined, undefined, {
    azureDevOps: { connections: service, bindings: bindingService }
  })
  const gitcred = new AzureDevOpsGitcredService({
    connections: connectionRepo,
    bindings,
    repoAuths: new PgAgentRepoAuthorizationRepo(prisma),
    service,
    api: fake.api,
    clock
  })
  const connect = async () => {
    const res = await running!.app.inject({ method: 'POST', url: `${ORG}/azure-devops/connections`, payload: OWN_APP })
    expect(res.statusCode).toBe(200)
    return res.json() as { id: string; credentialEpoch: string }
  }
  return { a: running, fake, service, bindings, connectionRepo, gitcred, epochChanges, connect }
}

async function createAgent(h: ReturnType<typeof harness>, gitRepo: string, access?: 'read' | 'write') {
  return h.a.app.inject({
    method: 'POST',
    url: `${ORG}/agents`,
    payload: {
      name: `ado-${randomUUID().slice(0, 8)}`,
      runtime: 'claude',
      workspace: { mode: 'git', gitRepo, ...(access ? { access } : {}) }
    }
  })
}

describe('connecting an own application (§3.2)', () => {
  it('verifies the identity, records the organization instance, and never echoes the secret', async () => {
    const h = harness()
    const created = await h.connect()
    expect(created).toMatchObject({
      organization: ORGANIZATION,
      organizationInstanceId: INSTANCE_ID,
      tenantId: TENANT_ID,
      identityId: IDENTITY_ID,
      identityName: 'Example Application',
      credentialSource: 'own',
      clientId: CLIENT_ID,
      state: 'connected',
      credentialEpoch: '1',
      boundRepositories: 0
    })
    expect(JSON.stringify(created)).not.toContain('example-secret')
    const listed = await h.a.app.inject({ method: 'GET', url: `${ORG}/azure-devops/connections` })
    expect(listed.json()).toMatchObject({ connections: [{ id: created.id }], deploymentApplication: false })
    // One connection per organization at the route (§3.2).
    const again = await h.a.app.inject({ method: 'POST', url: `${ORG}/azure-devops/connections`, payload: OWN_APP })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: 'connection_exists' })
  })

  it('refuses the deployment’s own application, an organization with no visible repository, and a wrong secret', async () => {
    const h = harness({ deploymentSecret: 'deployment-secret' })
    const deployment = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/azure-devops/connections`,
      payload: { ...OWN_APP, clientId: DEPLOYMENT_CLIENT_ID.toUpperCase() }
    })
    expect(deployment.statusCode).toBe(400)
    expect(deployment.json()).toMatchObject({ code: 'deployment_application' })
    h.fake.repositories = []
    const stakeholder = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/azure-devops/connections`,
      payload: OWN_APP
    })
    expect(stakeholder.statusCode).toBe(409)
    expect(stakeholder.json()).toMatchObject({ code: 'no_repository_access' })
    expect((stakeholder.json() as { message: string }).message).toContain('Basic access level')
    h.fake.repositories = [exampleRepository()]
    const wrong = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/azure-devops/connections`,
      payload: { ...OWN_APP, clientSecret: 'not-the-secret' }
    })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json()).toMatchObject({ code: 'secret_rejected' })
    expect(await prisma.azureDevOpsConnection.count()).toBe(0)
  })

  it('refuses an organization another AgentConnect organization connected, naming none', async () => {
    const h = harness()
    await h.connect()
    const other = await prisma.org.create({ data: { slug: 'second-example-org' } })
    const refused = await h.service.connectOwnApplication(other.id, OWN_APP).catch((e: unknown) => e)
    expect(refused).toMatchObject({ status: 409, code: 'AZURE_DEVOPS_ORGANIZATION_TAKEN' })
    expect((refused as Error).message).not.toContain(DEFAULT_ORG_ID)
  })

  it('replaces an own secret only for the same identity, advancing the epoch (§3.5)', async () => {
    const h = harness()
    const created = await h.connect()
    h.fake.secrets[CLIENT_ID] = 'rotated-secret'
    const replaced = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/azure-devops/connections/${created.id}/secret`,
      payload: { clientSecret: 'rotated-secret' }
    })
    expect(replaced.statusCode).toBe(200)
    expect(replaced.json()).toMatchObject({
      credentialEpoch: '2',
      identityId: IDENTITY_ID,
      clientId: CLIENT_ID,
      tenantId: TENANT_ID
    })
    expect(h.epochChanges).toEqual([created.id])
    h.fake.identityId = '00000000-0000-4000-8000-0000000000f9'
    h.fake.secrets[CLIENT_ID] = 'third-secret'
    const mismatch = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/azure-devops/connections/${created.id}/secret`,
      payload: { clientSecret: 'third-secret' }
    })
    expect(mismatch.statusCode).toBe(409)
    expect(mismatch.json()).toMatchObject({ code: 'identity_mismatch' })
    expect((await h.connectionRepo.getUnscoped(created.id))!.credentialEpoch).toBe(2n)
  })

  it('re-stamps a rotated deployment secret at boot and refuses a secret replacement for it', async () => {
    const h = harness({
      deploymentSecret: 'deployment-secret',
      fake: { secrets: { [DEPLOYMENT_CLIENT_ID]: 'deployment-secret' } }
    })
    const connection = await h.service.connectDeploymentApplication(DEFAULT_ORG_ID, {
      organization: ORGANIZATION,
      tenantId: TENANT_ID
    })
    expect(connection).toMatchObject({ credentialSource: 'deployment', clientId: null, credentialEpoch: 1n })
    expect(await h.service.reconcileDeploymentSecret()).toBe(0)
    const refused = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/azure-devops/connections/${connection.id}/secret`,
      payload: { clientSecret: 'x' }
    })
    expect(refused.json()).toMatchObject({ code: 'deployment_secret' })
    const rotated = new AzureDevOpsConnectionService({
      connections: h.connectionRepo,
      secrets: new PgAzureDevOpsConnectionSecretStore(prisma, cipher),
      bindings: h.bindings,
      cipher,
      clock,
      api: h.fake.api,
      tokens: new AzureDevOpsTokenCache(() => clock.now()),
      deploymentApplication: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: 'rotated-deployment-secret' }
    })
    expect(await rotated.reconcileDeploymentSecret()).toBe(1)
    expect((await h.connectionRepo.getUnscoped(connection.id))!.credentialEpoch).toBe(2n)
    expect(await rotated.reconcileDeploymentSecret()).toBe(0)
  })
})

describe('the picker and workspaces (§5)', () => {
  it('lists what the identity sees and marks what is bound', async () => {
    const h = harness({
      fake: {
        repositories: [
          exampleRepository(),
          exampleRepository({ id: SECOND_REPOSITORY_ID, name: 'Retired Repo', isDisabled: true })
        ]
      }
    })
    const connection = await h.connect()
    const picked = async () =>
      (
        await h.a.app.inject({ method: 'GET', url: `${ORG}/azure-devops/connections/${connection.id}/repositories` })
      ).json() as { repositories: Array<Record<string, unknown>> }
    expect((await picked()).repositories).toEqual([
      {
        repositoryId: REPOSITORY_ID,
        projectId: PROJECT_ID,
        path: 'example-org/Example Project/Example Repo',
        cloneUrl: GIT_REPO,
        defaultBranch: 'main',
        repoId: null,
        bindingId: null
      }
    ])
    expect((await createAgent(h, GIT_REPO)).statusCode).toBe(201)
    const [row] = (await picked()).repositories
    expect(row).toMatchObject({ repoId: expect.stringMatching(/^[1-9]\d*$/), bindingId: expect.any(String) })
  })

  it('binds on first use, writes the connection and projects the routing (§4, §7)', async () => {
    const h = harness()
    const connection = await h.connect()
    const created = await createAgent(h, GIT_REPO, 'write')
    expect(created.statusCode).toBe(201)
    const dto = created.json() as { id: string; workspace: { gitRepo: string; credential: { repoId: string } } }
    expect(dto.workspace.gitRepo).toBe(GIT_REPO)
    expect(dto.workspace.credential).toMatchObject({
      provider: 'azure-devops',
      access: 'write',
      connectionId: connection.id,
      azureDevOps: ROUTING
    })
    const repoId = BigInt(dto.workspace.credential.repoId)
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: dto.id } })).toMatchObject({
      gitCredentialProvider: 'azure-devops',
      workspaceRepoId: repoId,
      workspaceConnectionId: connection.id
    })
    expect(await prisma.azureDevOpsRepositoryIdentity.findUniqueOrThrow({ where: { id: repoId } })).toMatchObject({
      repositoryId: REPOSITORY_ID,
      projectId: PROJECT_ID,
      organizationInstanceId: INSTANCE_ID
    })
    expect(
      await prisma.codeHostRepositoryClaim.findUniqueOrThrow({
        where: { provider_externalId: { provider: 'azure-devops', externalId: repoId } }
      })
    ).toMatchObject({ orgId: DEFAULT_ORG_ID })
    expect(
      await prisma.codeHostRepository.findFirstOrThrow({ where: { provider: 'azure-devops', externalId: repoId } })
    ).toMatchObject({ displayPath: 'example-org/Example Project/Example Repo', cloneUrl: GIT_REPO })
    const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(dto.id)))!
    const spec = await h.a.deps.agentSpecs.assemble(agent)
    expect(spec.workspace).toMatchObject({
      mode: 'git',
      credential: {
        provider: 'azure-devops',
        repoId: repoId.toString(),
        connectionId: connection.id,
        azureDevOps: ROUTING
      }
    })
    // Another accepted form of the same repository — project GUID, other casing — reuses the one identity.
    const again = await createAgent(h, `https://dev.azure.com/example-org/${PROJECT_ID}/_git/example%20repo`)
    expect(again.statusCode).toBe(201)
    expect((again.json() as { workspace: { credential: { repoId: string } } }).workspace.credential.repoId).toBe(
      repoId.toString()
    )
    expect(await prisma.azureDevOpsRepositoryBinding.count()).toBe(1)
    const resolved = await h.a.app.inject({
      method: 'GET',
      url: `${ORG}/git/resolve?gitRepo=${encodeURIComponent(GIT_REPO)}`
    })
    expect(resolved.json()).toMatchObject({ provider: 'azure-devops', access: 'write', defaultBranch: 'main' })
  })

  it('refuses an invisible repository and a write without Contribute; an unconnected organization stays anonymous', async () => {
    const h = harness({ fake: { repositories: [exampleRepository({ contribute: false })] } })
    await h.connect()
    const hidden = await createAgent(h, 'https://dev.azure.com/example-org/Example%20Project/_git/Hidden%20Repo')
    expect(hidden.statusCode).toBe(409)
    expect((hidden.json() as { message: string }).message).toContain('grant the application access to this repository')
    const write = await createAgent(h, GIT_REPO, 'write')
    expect(write.statusCode).toBe(409)
    expect((write.json() as { message: string }).message).toContain('Contribute')
    expect(await prisma.azureDevOpsRepositoryBinding.count()).toBe(0)
    // An unstated tier takes what the identity holds.
    const unstated = await createAgent(h, GIT_REPO)
    expect(unstated.statusCode).toBe(201)
    expect((unstated.json() as { workspace: { credential: { access: string } } }).workspace.credential.access).toBe(
      'read'
    )
    const foreign = await h.a.app.inject({
      method: 'GET',
      url: `${ORG}/git/resolve?gitRepo=${encodeURIComponent('https://dev.azure.com/other-org/Project/_git/Repo')}`
    })
    expect(foreign.json()).toMatchObject({ provider: 'anonymous', access: 'read', host: 'azure-devops' })
    const foreignWrite = await createAgent(h, 'https://dev.azure.com/other-org/Project/_git/Repo', 'write')
    expect(foreignWrite.statusCode).toBe(409)
  })
})

describe('additional-repository grants and removal (§5)', () => {
  it('grants by GUID through a connection, projects the routing, and removes only once unreferenced', async () => {
    const h = harness({
      fake: {
        repositories: [
          exampleRepository(),
          exampleRepository({ id: SECOND_REPOSITORY_ID, name: 'Second Repo', contribute: false })
        ]
      }
    })
    const connection = await h.connect()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const grant = (repositoryId: string, access: string) =>
      h.a.app.inject({
        method: 'POST',
        url: `${ORG}/agents/${agentId}/repos`,
        payload: { provider: 'azure-devops', connectionId: connection.id, repositoryId, access }
      })
    const refused = await grant(SECOND_REPOSITORY_ID, 'write')
    expect(refused.statusCode).toBe(409)
    expect((refused.json() as { message: string }).message).toContain('Contribute')
    const granted = await grant(REPOSITORY_ID, 'read')
    expect(granted.statusCode).toBe(200)
    expect(granted.json()).toMatchObject({
      provider: 'azure-devops',
      repoFullName: 'example-org/Example Project/Example Repo',
      access: 'read',
      connectionId: connection.id
    })
    const grantId = (granted.json() as { id: string }).id
    const repoId = (granted.json() as { repoId: string }).repoId
    const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    const spec = await h.a.deps.agentSpecs.assemble(agent)
    expect(spec.workspace?.additionalRepos).toEqual([
      {
        provider: 'azure-devops',
        repoId,
        repoFullName: 'example-org/Example Project/Example Repo',
        materialize: 'always',
        azureDevOps: ROUTING
      }
    ])
    // Raising to write checks Contribute again.
    const raised = await h.a.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}/repos/${grantId}`,
      payload: { access: 'write' }
    })
    expect(raised.statusCode).toBe(200)
    expect(raised.json()).toMatchObject({ access: 'write' })

    const [binding] = await h.bindings.listForOrg(DEFAULT_ORG_ID)
    const inUse = await h.a.app.inject({ method: 'DELETE', url: `${ORG}/azure-devops/repositories/${binding!.id}` })
    expect(inUse.statusCode).toBe(409)
    expect(inUse.json()).toMatchObject({ code: 'repository_in_use' })
    expect((inUse.json() as { message: string }).message).toContain('an additional repository of agent')
    const disconnect = await h.a.app.inject({
      method: 'DELETE',
      url: `${ORG}/azure-devops/connections/${connection.id}`
    })
    expect(disconnect.statusCode).toBe(409)
    expect(
      (await h.a.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}/repos/${grantId}` })).statusCode
    ).toBeLessThan(300)
    const removed = await h.a.app.inject({ method: 'DELETE', url: `${ORG}/azure-devops/repositories/${binding!.id}` })
    expect(removed.statusCode).toBe(204)
    // The claim is released, the identity stays allocated for good (§4).
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'azure-devops' } })).toBe(0)
    expect(await prisma.azureDevOpsRepositoryIdentity.count({ where: { id: BigInt(repoId) } })).toBe(1)
    const gone = await h.a.app.inject({ method: 'DELETE', url: `${ORG}/azure-devops/connections/${connection.id}` })
    expect(gone.statusCode).toBe(204)
    expect(await prisma.azureDevOpsConnection.count()).toBe(0)
  })

  it('keeps one organization per repository through the deployment-global claim', async () => {
    const h = harness()
    const connection = await h.connect()
    expect((await createAgent(h, GIT_REPO)).statusCode).toBe(201)
    const other = await prisma.org.create({ data: { slug: 'second-example-org' } })
    const foreign = await h.connectionRepo.create({
      orgId: other.id,
      tenantId: TENANT_ID,
      credentialSource: 'own',
      clientId: CLIENT_ID,
      identity: {
        organization: 'second-org',
        organizationInstanceId: '00000000-0000-4000-8000-0000000000e2',
        identityId: IDENTITY_ID,
        identityName: null,
        verifiedAt: new Date()
      },
      sealedSecret: 'sealed'
    })
    const facts = {
      repositoryId: REPOSITORY_ID,
      projectId: PROJECT_ID,
      organizationInstanceId: INSTANCE_ID,
      repoPath: 'example-org/Example Project/Example Repo',
      cloneUrl: GIT_REPO,
      defaultBranch: 'main'
    }
    await expect(h.bindings.bind({ orgId: other.id, connectionId: foreign.id, facts })).rejects.toBeInstanceOf(
      AzureDevOpsRepositoryClaimConflict
    )
    // The holder rebinding is a refresh, not a second binding.
    const rebound = await h.bindings.bind({ orgId: DEFAULT_ORG_ID, connectionId: connection.id, facts })
    expect(rebound.created).toBe(false)
  })

  it('lets an organization deletion cascade through referenced bindings and release their claims', async () => {
    const h = harness()
    const other = await prisma.org.create({ data: { slug: 'second-example-org' } })
    const connection = await h.connectionRepo.create({
      orgId: other.id,
      tenantId: TENANT_ID,
      credentialSource: 'own',
      clientId: CLIENT_ID,
      identity: {
        organization: ORGANIZATION,
        organizationInstanceId: INSTANCE_ID,
        identityId: IDENTITY_ID,
        identityName: null,
        verifiedAt: new Date()
      },
      sealedSecret: 'sealed'
    })
    const { binding } = await h.bindings.bind({
      orgId: other.id,
      connectionId: connection.id,
      facts: {
        repositoryId: REPOSITORY_ID,
        projectId: PROJECT_ID,
        organizationInstanceId: INSTANCE_ID,
        repoPath: 'example-org/Example Project/Example Repo',
        cloneUrl: GIT_REPO,
        defaultBranch: null
      }
    })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { orgId: other.id, gitRepo: GIT_REPO })
    await prisma.agent.update({
      where: { id: agentId },
      data: {
        gitCredentialProvider: 'azure-devops',
        workspaceRepoId: binding.repoId,
        workspaceConnectionId: connection.id
      }
    })
    // The composite key refuses a binding a workspace still names, outside the route's own check too.
    await expect(prisma.azureDevOpsRepositoryBinding.delete({ where: { id: binding.id } })).rejects.toThrow()
    await prisma.org.delete({ where: { id: other.id } })
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'azure-devops' } })).toBe(0)
    expect(await prisma.azureDevOpsRepositoryIdentity.count()).toBe(1)
  })
})

describe('binding states (§3.5, §5)', () => {
  it('degrades every binding on a rejected secret or a removed identity, and recovers on the next success', async () => {
    const h = harness()
    const connection = await h.connect()
    expect((await createAgent(h, GIT_REPO)).statusCode).toBe(201)
    const pick = () =>
      h.a.app.inject({ method: 'GET', url: `${ORG}/azure-devops/connections/${connection.id}/repositories` })
    const states = async () => {
      const [binding] = await h.bindings.listForOrg(DEFAULT_ORG_ID)
      const row = await h.connectionRepo.getUnscoped(connection.id)
      return { binding: [binding!.state, binding!.stateReason], connection: [row!.state, row!.stateReason] }
    }

    h.fake.revoked = 'TF400813'
    const revoked = await pick()
    expect(revoked.statusCode).toBe(409)
    expect(revoked.json()).toMatchObject({ code: 'access_revoked' })
    expect(await states()).toEqual({
      binding: ['runtime_degraded', 'access_revoked'],
      connection: ['degraded', 'access_revoked']
    })
    h.fake.revoked = undefined
    expect((await pick()).statusCode).toBe(200)
    expect(await states()).toEqual({ binding: ['ready', null], connection: ['connected', null] })

    // The secret was rotated in Entra: the cached token fails, and the one retry cannot mint another.
    h.fake.secrets[CLIENT_ID] = 'rotated-elsewhere'
    h.fake.staleTokenOnce = true
    const rejected = await pick()
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json()).toMatchObject({ code: 'secret_rejected' })
    expect(await states()).toEqual({
      binding: ['runtime_degraded', 'secret_rejected'],
      connection: ['degraded', 'secret_rejected']
    })
    const replaced = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/azure-devops/connections/${connection.id}/secret`,
      payload: { clientSecret: 'rotated-elsewhere' }
    })
    expect(replaced.statusCode).toBe(200)
    expect(await states()).toEqual({ binding: ['ready', null], connection: ['connected', null] })
  })

  it('marks a repository that left the list unavailable, refuses its lease, and recovers when it returns', async () => {
    const h = harness()
    const connection = await h.connect()
    const created = await createAgent(h, GIT_REPO, 'write')
    const agentId = (created.json() as { id: string }).id
    const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    const lease = await h.gitcred.grantForAgent(agent)
    expect(lease).toMatchObject({
      username: 'Example Application',
      access: 'write',
      provider: 'azure-devops',
      repoFullName: 'example-org/Example Project/Example Repo',
      credentialEpoch: '1'
    })
    expect(lease.token).toMatch(/^example-token-/)
    expect(lease.ttlSec).toBeLessThanOrEqual(3599 - 300)
    await expect(h.gitcred.grantForAgent(agent, 999n)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })

    h.fake.repositories = []
    expect(
      (await h.a.app.inject({ method: 'GET', url: `${ORG}/azure-devops/connections/${connection.id}/repositories` }))
        .statusCode
    ).toBe(200)
    const [gone] = await h.bindings.listForOrg(DEFAULT_ORG_ID)
    expect([gone!.state, gone!.stateReason]).toEqual(['runtime_degraded', 'repository_unavailable'])
    await expect(h.gitcred.grantForAgent(agent)).rejects.toMatchObject({ code: 'LEASE_DENIED' })
    h.fake.repositories = [exampleRepository()]
    await h.a.app.inject({ method: 'GET', url: `${ORG}/azure-devops/connections/${connection.id}/repositories` })
    expect((await h.gitcred.grantForAgent(agent)).access).toBe('write')
  })
})
