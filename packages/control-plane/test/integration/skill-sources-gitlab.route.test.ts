/**
 * GitLab skill sources (source-cache.md §11, CP3.2): admission records a managed
 * private project's numeric id as the credential and a public one as anonymous, the
 * preview scans through the GitLab API, and enabling a private source is the agent's
 * read-only grant on that project — a §7.2 consumer the gitcred broker serves.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { FakeGitlab } from '../fakes/gitlab-api.js'
import { GitlabOauthService } from '../../src/gitlab/oauth.service.js'
import { GitlabProvisioner } from '../../src/gitlab/provisioner.js'
import { GitlabAccountService } from '../../src/gitlab/account.service.js'
import { GitlabGitcredService } from '../../src/gitlab/gitcred.service.js'
import { GitCredDeniedError } from '../../src/github/service.js'
import { resolveAgentSkillEntries, resolveGitlabSkillSourceProjects } from '../../src/orchestrator/skillSource.js'
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
  PgGitlabWebhookSecretStore,
  PgSkillSourceRepo
} from '../../src/persistence/index.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { trackedTestClock } from '../fakes/tracked-clock.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const PROJECT = 4455667n
const ROOT_GROUP = 900n
const PRIVATE_URL = 'https://gitlab.com/example-group/example-project'
/** A second managed project under the SAME top-level group, so both share the agent's account. */
const SECOND_PROJECT = 4455668n
const SECOND_URL = 'https://gitlab.com/example-group/example-second'
const PUBLIC_URL = 'https://gitlab.com/example-group/public-kit'
const clock = trackedTestClock()
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)

let running: HttpApp | undefined
let settleConvergence: (() => Promise<void>) | undefined
afterEach(async () => {
  await settleConvergence?.()
  settleConvergence = undefined
  await running?.close()
  running = undefined
})

async function harness() {
  const fake = new FakeGitlab({
    pathById: { [String(SECOND_PROJECT)]: 'example-group/example-second' },
    publicPaths: { 'example-group/public-kit': 77 },
    repositories: {
      'example-group/public-kit': { files: ['skills/review/SKILL.md'], tags: ['v1'] },
      [String(PROJECT)]: { files: ['skills/lint/SKILL.md', 'skills/deploy/SKILL.md'] }
    }
  })
  const bindings = new PgGitlabProjectBindingRepo(prisma)
  const connections = new PgGitlabConnectionRepo(prisma)
  const oauth = new GitlabOauthService({
    cfg: { clientId: 'client-1', clientSecret: 'secret-1', baseUrl: fake.opts.baseUrl },
    connections,
    secrets: new PgGitlabConnectionSecretStore(prisma, cipher),
    states: new PgGitlabOauthStateStore(prisma),
    instanceState: new PgGitlabInstanceStateStore(prisma),
    cipher,
    clock,
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
    instanceState: new PgGitlabInstanceStateStore(prisma),
    cipher,
    clock,
    api: fake.api
  })
  const provisioner = new GitlabProvisioner({
    oauth,
    bindings,
    accounts: accountService,
    webhookSecrets: new PgGitlabWebhookSecretStore(prisma, cipher),
    catalog: new PgCodeHostRepositoryRepo(prisma),
    instanceState: new PgGitlabInstanceStateStore(prisma),
    clock,
    publicRelayUrl: 'https://relay.example.test',
    desiredWebhookEvents: async () => null,
    api: fake.api
  })
  // Route writes converge fire-and-forget; own every run so none outlives its test.
  const inFlight = new Set<Promise<void>>()
  const convergeProject = provisioner.convergeProject.bind(provisioner)
  provisioner.convergeProject = (orgId: string, projectId: bigint): Promise<void> => {
    const run = convergeProject(orgId, projectId)
    inFlight.add(run)
    return run.finally(() => inFlight.delete(run))
  }
  const settled = async (): Promise<void> => {
    // The agents route resolves the changed projects before it converges, so yield until nothing is pending.
    for (let idle = 0; idle < 5;) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      if (inFlight.size === 0) idle++
      else await Promise.allSettled([...inFlight])
    }
  }
  settleConvergence = settled
  running = buildHttpApp(prisma, { PUBLIC_CP_URL: 'https://api.example.test' }, undefined, undefined, {
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
    axisBaseUrl: fake.opts.baseUrl
  })
  const binding = await bindings.createWithClaim({
    orgId: DEFAULT_ORG_ID,
    projectId: PROJECT,
    projectPath: 'example-group/example-project',
    cloneUrl: `${fake.opts.baseUrl}/example-group/example-project.git`,
    installerConnectionId: connection.id,
    axisBaseUrl: fake.opts.baseUrl
  })
  expect(await provisioner.provision(DEFAULT_ORG_ID, binding.id)).toEqual({ state: 'ready' })
  const second = await bindings.createWithClaim({
    orgId: DEFAULT_ORG_ID,
    projectId: SECOND_PROJECT,
    projectPath: 'example-group/example-second',
    cloneUrl: `${fake.opts.baseUrl}/example-group/example-second.git`,
    installerConnectionId: connection.id,
    axisBaseUrl: fake.opts.baseUrl
  })
  expect(await provisioner.provision(DEFAULT_ORG_ID, second.id)).toEqual({ state: 'ready' })
  const gitcred = new GitlabGitcredService({
    bindings,
    accounts,
    credentials: new PgGitlabProjectCredentialRepo(prisma),
    credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, cipher),
    repoAuths: new PgAgentRepoAuthorizationRepo(prisma),
    skillSourceProjects: (agent) => resolveGitlabSkillSourceProjects(agent, new PgSkillSourceRepo(prisma)),
    clock,
    baseUrl: fake.opts.baseUrl
  })
  return { fake, a: running, accounts, gitcred, settled }
}

async function create(h: Awaited<ReturnType<typeof harness>>, payload: Record<string, unknown>) {
  return h.a.app.inject({ method: 'POST', url: `${ORG}/skill-sources`, payload })
}

describe('GitLab skill-source admission (CP3.2)', () => {
  it('records a managed private project by numeric id and converges its catalog row', async () => {
    const h = await harness()
    const res = await create(h, { name: 'kit', source: `${PRIVATE_URL}.git`, subDir: 'skills' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      source: PRIVATE_URL,
      githubRepoId: null,
      ref: 'main',
      subDir: 'skills',
      private: false,
      credential: { provider: 'gitlab', repoId: String(PROJECT) }
    })
    const catalog = await new PgCodeHostRepositoryRepo(prisma).byExternalId(DEFAULT_ORG_ID, 'gitlab', PROJECT)
    expect(catalog).toMatchObject({ displayPath: 'example-group/example-project' })
    // The projected entry carries the GitLab credential the daemon acquires through.
    const entries = await resolveAgentSkillEntries(
      { orgId: OrgId(DEFAULT_ORG_ID), skills: ['kit/*'] },
      new PgSkillSourceRepo(prisma)
    )
    expect(entries).toEqual([
      {
        name: 'kit',
        source: PRIVATE_URL,
        ref: 'main',
        subDir: 'skills',
        skills: [],
        credential: { provider: 'gitlab', projectId: String(PROJECT) }
      }
    ])
  })

  it('admits a public project anonymously', async () => {
    const h = await harness()
    const res = await create(h, { name: 'pub', source: `${PUBLIC_URL}.git` })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ source: PUBLIC_URL, githubRepoId: null, credential: null, private: false })
  })

  it('refuses what cannot be acquired', async () => {
    const h = await harness()
    const refused = async (payload: Record<string, unknown>) => {
      const res = await create(h, { name: 'x', ...payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      return res.json().message as string
    }
    expect(await refused({ source: 'https://gitlab.com/example-group/unmanaged' })).toMatch(/managed project/)
    expect(await refused({ source: `${PUBLIC_URL}/-/tree/main/skills` })).toMatch(/ref and subdirectory separately/)
    expect(await refused({ source: PRIVATE_URL, githubRepoId: '42' })).toMatch(/only to a GitHub source/)
    expect(await refused({ source: 'https://git.example.test/team/skills' })).toMatch(/GitLab instance/)
    expect(await refused({ source: 'https://git.example.test/team/skills', githubRepoId: '42' })).toMatch(
      /GitLab instance/
    )
  })

  it('re-resolves on edit: a source moved to a public project drops its credential', async () => {
    const h = await harness()
    const id = (await create(h, { name: 'kit', source: PRIVATE_URL })).json().id as string
    const res = await h.a.app.inject({
      method: 'PATCH',
      url: `${ORG}/skill-sources/${id}`,
      payload: { source: PUBLIC_URL }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ source: PUBLIC_URL, credential: null })
  })
})

describe('GitLab skill-source preview (CP3.2)', () => {
  it('scans a public project anonymously and a private one through its binding', async () => {
    const h = await harness()
    const pub = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources/preview`,
      payload: { source: PUBLIC_URL }
    })
    expect(pub.statusCode).toBe(200)
    expect(pub.json()).toEqual({
      branches: ['main'],
      tags: ['v1'],
      skills: [{ name: 'review', dirPath: 'skills/review' }]
    })
    const priv = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources/preview`,
      payload: { source: PRIVATE_URL }
    })
    expect(priv.statusCode).toBe(200)
    expect(priv.json().skills).toEqual([
      { name: 'lint', dirPath: 'skills/lint' },
      { name: 'deploy', dirPath: 'skills/deploy' }
    ])
    const unmanaged = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources/preview`,
      payload: { source: 'https://gitlab.com/example-group/unmanaged' }
    })
    expect(unmanaged.statusCode).toBe(400)
  })

  it("lists a stored private source's skills, honoring its filter", async () => {
    const h = await harness()
    const id = (await create(h, { name: 'kit', source: PRIVATE_URL, skills: ['deploy'] })).json().id as string
    const res = await h.a.app.inject({ method: 'GET', url: `${ORG}/skill-sources/${id}/skills` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ resolvable: true, skills: [{ name: 'deploy', dirPath: 'skills/deploy' }] })
  })
})

describe('GitLab skill-source read grant (CP3.2)', () => {
  it('enabling a private source makes the agent a Reporter consumer the broker serves read-only', async () => {
    const h = await harness()
    expect((await create(h, { name: 'kit', source: PRIVATE_URL })).statusCode).toBe(201)
    const made = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'skill-reader', runtime: 'claude', skills: ['kit/*'] }
    })
    expect(made.statusCode).toBe(201)
    const agentId = made.json().id as string
    await h.settled()

    const account = await h.accounts.byAgentRoot(DEFAULT_ORG_ID, agentId, ROOT_GROUP)
    expect(account?.serviceAccountUserId).not.toBeNull()
    expect(h.fake.members.get(Number(account!.serviceAccountUserId))).toBe(20)

    const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    const grant = await h.gitcred.grantForAgent(agent, PROJECT)
    expect(grant).toMatchObject({ access: 'read', provider: 'gitlab', externalRepoId: String(PROJECT) })
    // A skill source never earns more than read, whatever the ask.
    expect((await h.gitcred.grantForAgent(agent, PROJECT, 'write')).access).toBe('read')

    // Unselecting the source withdraws the grant and the membership.
    const off = await h.a.app.inject({ method: 'PATCH', url: `${ORG}/agents/${agentId}`, payload: { skills: [] } })
    expect(off.statusCode).toBe(200)
    await h.settled()
    const unselected = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    await expect(h.gitcred.grantForAgent(unselected, PROJECT)).rejects.toBeInstanceOf(GitCredDeniedError)
    expect(h.fake.members.has(Number(account!.serviceAccountUserId))).toBe(false)
  })

  it('moving between private sources in one group keeps the shared account (destination converges first)', async () => {
    const h = await harness()
    expect((await create(h, { name: 'first', source: PRIVATE_URL })).statusCode).toBe(201)
    expect((await create(h, { name: 'second', source: SECOND_URL })).statusCode).toBe(201)
    const made = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'skill-mover', runtime: 'claude', skills: ['first/*'] }
    })
    expect(made.statusCode).toBe(201)
    const agentId = made.json().id as string
    await h.settled()
    const before = await h.accounts.byAgentRoot(DEFAULT_ORG_ID, agentId, ROOT_GROUP)
    expect(before?.serviceAccountUserId).not.toBeNull()

    const moved = await h.a.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { skills: ['second/*'] }
    })
    expect(moved.statusCode).toBe(200)
    await h.settled()
    const after = await h.accounts.byAgentRoot(DEFAULT_ORG_ID, agentId, ROOT_GROUP)
    expect(after?.id).toBe(before!.id)
    expect(h.fake.deletedServiceAccounts).not.toContain(Number(before!.serviceAccountUserId))
    const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    expect(await h.gitcred.grantForAgent(agent, SECOND_PROJECT)).toMatchObject({ access: 'read' })
    await expect(h.gitcred.grantForAgent(agent, PROJECT)).rejects.toBeInstanceOf(GitCredDeniedError)
  })

  it('a public source grants nothing', async () => {
    const h = await harness()
    expect((await create(h, { name: 'pub', source: PUBLIC_URL })).statusCode).toBe(201)
    const made = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'public-reader', runtime: 'claude', skills: ['pub/*'] }
    })
    expect(made.statusCode).toBe(201)
    await h.settled()
    const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(made.json().id as string)))!
    await expect(h.gitcred.grantForAgent(agent, PROJECT)).rejects.toBeInstanceOf(GitCredDeniedError)
  })
})
