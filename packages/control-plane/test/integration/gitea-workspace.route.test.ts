/**
 * Gitea workspaces and credentials (gitea-integration.md §5, §9, §11): agent create against a
 * managed binding (the binding, never caller input, is the authority), the spec host carriage,
 * additional-repository grants as a local clamp, and the gitcred v2 grants served from the one bot
 * token — including the epoch a replacement advances.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { buildGiteaSeam, type GiteaSeam } from '../fakes/gitea-seam.js'
import { GiteaGitcredService } from '../../src/gitea/gitcred.service.js'
import { GitCredDeniedError } from '../../src/github/service.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgAgentRepoAuthorizationRepo } from '../../src/persistence/repositories/agent-repo-auth.repo.js'
import { PgGiteaConnectionSecretStore } from '../../src/persistence/repositories/gitea.repo.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { trackedTestClock } from '../fakes/tracked-clock.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const REPO = 556677n
const SECOND = 556678n
const BASE = 'https://gitea.example.test/gitea'
// Real-time clock whose pending timers die with the test — see fakes/tracked-clock.ts.
const clock = trackedTestClock()
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)

let running: HttpApp | undefined
let seam: GiteaSeam | undefined
afterEach(async () => {
  await seam?.settled()
  await running?.close()
  running = undefined
  seam = undefined
})

async function harness() {
  const built = buildGiteaSeam(prisma, cipher, clock, {
    fake: {
      baseUrl: BASE,
      repositories: [
        { id: Number(REPO), full_name: 'example-org/example-repo', admin: true },
        { id: Number(SECOND), full_name: 'example-org/second-repo', admin: true },
        { id: 556690, full_name: 'example-org/public-unbound', admin: false, private: false },
        { id: 556691, full_name: 'example-org/private-unbound', admin: false, private: true }
      ]
    }
  })
  seam = built
  running = buildHttpApp(prisma, { PUBLIC_RELAY_URL: 'https://relay.example.test' }, undefined, undefined, {
    gitea: built.httpDeps
  })
  built.broadcast.current = (hook) => running!.deps.hooks.broadcast(hook)
  const connection = await built.connections.connect(DEFAULT_ORG_ID, built.fake.token)
  const bind = async (repoId: bigint, path: string) => {
    const binding = await built.bindings.createWithClaim({
      orgId: DEFAULT_ORG_ID,
      connectionId: connection.id,
      repoId,
      repoPath: path,
      cloneUrl: `${BASE}/${path}.git`,
      axisBaseUrl: BASE
    })
    expect(await built.provisioner.provision(DEFAULT_ORG_ID, binding.id)).toEqual({ state: 'ready', reason: null })
    return binding
  }
  const binding = await bind(REPO, 'example-org/example-repo')
  const daemonId = randomUUID()
  await seedDaemon(prisma, daemonId, {
    capabilities: { platforms: [], runtimes: ['claude'], acp: true, features: ['gitea-v1', 'workspace-git-v1'] }
  })
  return { a: running, seam: built, fake: built.fake, connection, binding, bind, daemonId }
}

function gitcred(h: Awaited<ReturnType<typeof harness>>): GiteaGitcredService {
  return new GiteaGitcredService({
    connections: h.seam.connectionRepo,
    secrets: new PgGiteaConnectionSecretStore(prisma, cipher),
    bindings: h.seam.bindings,
    repoAuths: new PgAgentRepoAuthorizationRepo(prisma),
    clock,
    baseUrl: BASE
  })
}

describe('gitea workspaces (§5) — the binding vouches', () => {
  it('derives a managed workspace from the address on the deployment instance and projects the host', async () => {
    const h = await harness()
    const created = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'gitea-bot',
        runtime: 'claude',
        // Addressed by URL under the instance prefix; the binding is what the server derives from it.
        workspace: { mode: 'git', gitRepo: `${BASE}/example-org/example-repo`, access: 'write' }
      }
    })
    expect(created.statusCode).toBe(201)
    const dto = created.json() as { id: string; workspace: { gitRepo: string; credential?: unknown } }
    expect(dto.workspace.credential).toEqual({ provider: 'gitea', access: 'write', repoId: REPO.toString() })
    // The clone URL is the catalog row's — the provider's own answer, never the caller's address.
    expect(dto.workspace.gitRepo).toBe(`${BASE}/example-org/example-repo.git`)
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: dto.id } })
    expect(row).toMatchObject({ gitCredentialProvider: 'gitea', workspaceRepoId: REPO, gitAccess: 'write' })
    const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(dto.id)))!
    const spec = await h.a.deps.agentSpecs.assemble(agent)
    expect(spec.giteaHost).toBe(BASE)
    expect(spec.gitlabHost).toBeUndefined()
    expect(spec.workspace).toMatchObject({ mode: 'git', credential: { provider: 'gitea', repoId: REPO.toString() } })

    // The resolve preview agrees with the write path.
    const resolved = await h.a.app.inject({
      method: 'GET',
      url: `${ORG}/git/resolve?gitRepo=${encodeURIComponent(`${BASE}/example-org/example-repo`)}`
    })
    expect(resolved.json()).toMatchObject({ provider: 'gitea', access: 'write', defaultBranch: 'main' })
  })

  it('an unbound address is anonymous when public and refused when private or asked for write', async () => {
    const h = await harness()
    const anonymous = await h.a.app.inject({
      method: 'GET',
      url: `${ORG}/git/resolve?gitRepo=${encodeURIComponent(`${BASE}/example-org/public-unbound`)}`
    })
    expect(anonymous.json()).toMatchObject({ provider: 'anonymous', access: 'read', host: 'gitea' })
    const hidden = await h.a.app.inject({
      method: 'GET',
      url: `${ORG}/git/resolve?gitRepo=${encodeURIComponent(`${BASE}/example-org/private-unbound`)}`
    })
    expect(hidden.statusCode).toBe(409)
    const write = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'gitea-write',
        runtime: 'claude',
        workspace: { mode: 'git', gitRepo: `${BASE}/example-org/public-unbound`, access: 'write' }
      }
    })
    expect(write.statusCode).toBe(409)
    expect((write.json() as { message: string }).message).toContain('a repository the connected bot administers')
    // Nothing the bot does not administer was bound along the way (§6).
    expect(await prisma.giteaRepositoryBinding.count({ where: { repoId: 556690n } })).toBe(0)
  })

  it('refuses a workspace on a binding mid-removal', async () => {
    const h = await harness()
    await h.seam.bindings.update(DEFAULT_ORG_ID, h.binding.id, { state: 'cleanup_pending' })
    const res = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'gitea-late',
        runtime: 'claude',
        workspace: { mode: 'git', gitRepo: `${BASE}/example-org/example-repo` }
      }
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toContain('being removed')
  })
})

describe('gitea additional-repository grants (§5)', () => {
  it('grants a managed repository by numeric id, raises the tier locally, and refuses an unbound one', async () => {
    const h = await harness()
    await h.bind(SECOND, 'example-org/second-repo')
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, {
      daemonId: h.daemonId,
      giteaRepoId: REPO,
      gitRepo: `${BASE}/example-org/example-repo.git`
    })
    const granted = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${agentId}/repos`,
      payload: { provider: 'gitea', repoId: SECOND.toString(), access: 'comment' }
    })
    expect(granted.statusCode).toBe(200)
    expect(granted.json()).toMatchObject({
      provider: 'gitea',
      repoId: SECOND.toString(),
      repoFullName: 'example-org/second-repo',
      access: 'comment'
    })
    const id = (granted.json() as { id: string }).id
    // The tier is a clamp, never a provider role: nothing was written at Gitea.
    h.fake.requests.length = 0
    const raised = await h.a.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}/repos/${id}`,
      payload: { access: 'write' }
    })
    expect(raised.statusCode).toBe(200)
    expect(raised.json()).toMatchObject({ access: 'write' })
    expect(h.fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0)
    const workspace = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${agentId}/repos`,
      payload: { provider: 'gitea', repoId: REPO.toString() }
    })
    expect(workspace.statusCode).toBe(409)
    // A repository the bot does not administer cannot be bound on first use (§4.4, §6).
    const unbound = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${agentId}/repos`,
      payload: { provider: 'gitea', repoId: '556690' }
    })
    expect(unbound.statusCode).toBe(403)
    expect((unbound.json() as { message: string }).message).toContain('must hold admin')
  })
})

describe('gitcred v2 gitea grants (§4.2, §9)', () => {
  it('serves the bot token under the workspace clamp, echoing provider, id, host and epoch', async () => {
    const h = await harness()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: h.daemonId, giteaRepoId: REPO, gitAccess: 'write' })
    const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    const service = gitcred(h)
    const grant = await service.grantForAgent(agent)
    expect(grant).toMatchObject({
      username: 'example-bot',
      token: h.fake.token,
      repoFullName: 'example-org/example-repo',
      access: 'write',
      provider: 'gitea',
      externalRepoId: REPO.toString(),
      credentialEpoch: '1',
      host: BASE
    })
    expect(grant.ttlSec).toBe(3600)
    // The §17.1 floor narrows the clamp; a foreign repository is neither workspace nor grant.
    expect((await service.grantForAgent(agent, REPO, 'read')).access).toBe('read')
    await expect(service.grantForAgent(agent, SECOND)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    // A replacement advances the epoch every later grant carries (§4.3).
    h.fake.token = 'gitea-token-2'
    await h.seam.connections.replaceToken(DEFAULT_ORG_ID, h.connection.id, 'gitea-token-2')
    expect(await service.grantForAgent(agent)).toMatchObject({ token: 'gitea-token-2', credentialEpoch: '2' })
  })

  it('serves the hook-reply and effect purposes from the same token on action-time leases, clamped', async () => {
    const h = await harness()
    await h.bind(SECOND, 'example-org/second-repo')
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: h.daemonId, giteaRepoId: REPO, gitAccess: 'read' })
    const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    const service = gitcred(h)
    const reply = await service.grantForHookReply(DEFAULT_ORG_ID, REPO)
    expect(reply).toMatchObject({ token: h.fake.token, access: 'read', ttlSec: 900, provider: 'gitea' })
    // A read workspace earns comment-level effects; a hook alone does too; nothing else is authorized.
    expect((await service.grantForBrokerEffect(agent, REPO, false)).access).toBe('comment')
    expect((await service.grantForBrokerEffect(agent, SECOND, true)).access).toBe('comment')
    await expect(service.grantForBrokerEffect(agent, SECOND, false)).rejects.toBeInstanceOf(GitCredDeniedError)
  })

  it('denies while the token is rejected and once the binding enters cleanup', async () => {
    const h = await harness()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: h.daemonId, giteaRepoId: REPO })
    const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    const service = gitcred(h)
    await h.seam.connections.onAuthRejected(DEFAULT_ORG_ID, h.connection.id)
    await expect(service.grantForAgent(agent)).rejects.toMatchObject({ code: 'LEASE_DENIED', retryable: true })
    await h.seam.bindings.update(DEFAULT_ORG_ID, h.binding.id, { state: 'cleanup_pending' })
    await expect(service.grantForAgent(agent)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
  })
})
