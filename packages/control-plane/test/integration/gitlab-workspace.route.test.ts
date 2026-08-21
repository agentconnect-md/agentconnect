/**
 * GitLab workspaces (gitlab-com-integration.md M4, CP half): agent create/edit
 * against a managed binding (§8.3 — the binding, never caller input, is the
 * authority), and the gitcred v2 GitLab grants served from the binding's
 * purpose-separated PATs under the workspace access clamp (§13.1/§17.1).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { FakeGitlab } from '../fakes/gitlab-api.js'
import { GitlabOauthService } from '../../src/gitlab/oauth.service.js'
import { GitlabProvisioner } from '../../src/gitlab/provisioner.js'
import { GitlabGitcredService } from '../../src/gitlab/gitcred.service.js'
import { GitCredDeniedError } from '../../src/github/service.js'
import {
  PgCodeHostRepositoryRepo,
  PgGitlabConnectionRepo,
  PgGitlabConnectionSecretStore,
  PgGitlabOauthStateStore,
  PgGitlabProjectBindingRepo,
  PgGitlabProjectCredentialRepo,
  PgGitlabProjectCredentialSecretStore,
  PgGitlabWebhookSecretStore
} from '../../src/persistence/index.js'
import type { AgentRecord } from '../../src/persistence/ports.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { systemClock } from '../../src/domain/clock.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const PROJECT = 4455667n
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function harness() {
  const fake = new FakeGitlab()
  const bindings = new PgGitlabProjectBindingRepo(prisma)
  const connections = new PgGitlabConnectionRepo(prisma)
  const oauth = new GitlabOauthService({
    cfg: { clientId: 'client-1', clientSecret: 'secret-1' },
    connections,
    secrets: new PgGitlabConnectionSecretStore(prisma, cipher),
    states: new PgGitlabOauthStateStore(prisma),
    cipher,
    clock: systemClock,
    publicCpUrl: 'https://api.example.test',
    fetchImpl: fake.fetch()
  })
  const provisioner = new GitlabProvisioner({
    oauth,
    bindings,
    credentials: new PgGitlabProjectCredentialRepo(prisma),
    credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, cipher),
    webhookSecrets: new PgGitlabWebhookSecretStore(prisma, cipher),
    catalog: new PgCodeHostRepositoryRepo(prisma),
    cipher,
    clock: systemClock,
    publicRelayUrl: 'https://relay.example.test',
    desiredWebhookEvents: async () => null,
    fetchImpl: fake.fetch()
  })
  running = buildHttpApp(prisma, { PUBLIC_CP_URL: 'https://api.example.test' }, undefined, undefined, {
    gitlab: { oauth, provisioner, fetchImpl: fake.fetch() }
  })
  const connection = await connections.upsertOnCallback({
    orgId: DEFAULT_ORG_ID,
    userId: DEFAULT_OWNER_ID,
    gitlabUserId: 4242n,
    gitlabUsername: 'example-admin',
    scopes: ['api'],
    accessExpiresAt: new Date(Date.now() + 3600_000),
    sealedPair: { accessToken: 'at-1', refreshToken: 'rt-1' }
  })
  const binding = await bindings.createWithClaim({
    orgId: DEFAULT_ORG_ID,
    projectId: PROJECT,
    projectPath: 'example-group/example-project',
    installerConnectionId: connection.id
  })
  expect(await provisioner.provision(DEFAULT_ORG_ID, binding.id)).toEqual({ state: 'ready' })
  return { fake, a: running, bindings, binding }
}

function credService(bindings: PgGitlabProjectBindingRepo) {
  return new GitlabGitcredService({
    bindings,
    credentials: new PgGitlabProjectCredentialRepo(prisma),
    credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, cipher),
    clock: systemClock
  })
}

function gitlabAgent(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
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
      gitRepo: 'https://gitlab.com/example-group/example-project',
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
})

describe('gitcred v2 GitLab grants (§13.1/§17.1)', () => {
  it('serves the read or git_write PAT under the workspace access clamp, with the v2 echo', async () => {
    const h = await harness()
    const service = credService(h.bindings)
    const creds = new PgGitlabProjectCredentialRepo(prisma)
    const store = new PgGitlabProjectCredentialSecretStore(prisma, cipher)

    const write = await service.grantForAgent(gitlabAgent())
    const gitWriteCred = (await creds.get(h.binding.id, 'git_write'))!
    expect(write.token).toBe(await store.get(DEFAULT_ORG_ID, gitWriteCred.id))
    expect(write.access).toBe('write')
    expect(write.provider).toBe('gitlab')
    expect(write.externalRepoId).toBe(PROJECT.toString())
    expect(write.username).toBe(`agentconnect-p${PROJECT}`)
    expect(write.repoFullName).toBe('example-group/example-project')
    expect(write.credentialEpoch).toBe((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.credentialEpoch.toString())
    expect(write.ttlSec).toBeGreaterThan(0)
    expect(write.ttlSec).toBeLessThanOrEqual(3600)

    const read = await service.grantForAgent(
      gitlabAgent({
        workspace: { mode: 'gitlab', gitRepo: 'https://gitlab.com/example-group/example-project', gitAccess: 'read' }
      } as Partial<AgentRecord>)
    )
    const readCred = (await creds.get(h.binding.id, 'read'))!
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

  it('refuses an expired underlying PAT instead of serving a dead token', async () => {
    const h = await harness()
    const service = credService(h.bindings)
    await prisma.gitlabProjectCredential.updateMany({
      where: { bindingId: h.binding.id },
      data: { providerExpiresAt: new Date(Date.now() - 1000) }
    })
    await expect(service.grantForAgent(gitlabAgent())).rejects.toThrowError(GitCredDeniedError)
  })
})
