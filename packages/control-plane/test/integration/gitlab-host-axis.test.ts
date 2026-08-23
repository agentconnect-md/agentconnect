/**
 * The GitLab host axis (gitlab-com-integration.md §24.1) end to end over real
 * Postgres: the axis unset composes exactly today's GitLab.com URLs, a
 * path-prefixed non-default-port instance keeps its prefix and port on every
 * surface (and its clone URL comes from the provider, never composed), and the
 * deployment document refuses a base-URL change while GitLab state exists.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { FakeGitlab } from '../fakes/gitlab-api.js'
import { GitlabOauthService } from '../../src/gitlab/oauth.service.js'
import { GitlabProvisioner } from '../../src/gitlab/provisioner.js'
import { GitlabAccountService } from '../../src/gitlab/account.service.js'
import {
  PgAgentRepo,
  PgCodeHostRepositoryRepo,
  PgGitlabAgentAccountRepo,
  PgGitlabConnectionRepo,
  PgGitlabConnectionSecretStore,
  PgGitlabOauthStateStore,
  PgGitlabProjectBindingRepo,
  PgGitlabProjectCredentialRepo,
  PgGitlabProjectCredentialSecretStore,
  PgGitlabWebhookSecretStore
} from '../../src/persistence/index.js'
import { PgDeploymentConfigStore } from '../../src/persistence/repositories/deployment-config.repo.js'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  GITLAB_BASE_URL_LOCKED_REASON,
  type DeploymentConfigValuesV1
} from '../../src/persistence/deployment-config.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { systemClock } from '../../src/domain/clock.js'
import { OrgId } from '../../src/domain/ids.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const PUBLIC_CP = 'https://api.example.test'
const PROJECT = 4455667n
/** A relative URL root on a non-default port — the shape prefix loss shows up in. */
const PREFIXED = 'https://gitlab.example.test:8443/gitlab'
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)

let running: HttpApp | undefined
let settleConvergence: (() => Promise<void>) | undefined
afterEach(async () => {
  // Route writes kick convergence fire-and-forget; a run outliving its test
  // re-creates the very rows the fence assertions below just removed.
  await settleConvergence?.()
  settleConvergence = undefined
  await running?.close()
  running = undefined
})

function app(baseUrl: string): HttpApp & { fake: FakeGitlab; settled: () => Promise<void> } {
  const fake = new FakeGitlab({ baseUrl })
  const bindings = new PgGitlabProjectBindingRepo(prisma)
  const oauth = new GitlabOauthService({
    cfg: { clientId: 'client-1', clientSecret: 'secret-1', baseUrl },
    connections: new PgGitlabConnectionRepo(prisma),
    secrets: new PgGitlabConnectionSecretStore(prisma, cipher),
    states: new PgGitlabOauthStateStore(prisma),
    cipher,
    clock: systemClock,
    publicCpUrl: PUBLIC_CP,
    webAppUrl: 'https://console.example.test',
    api: fake.api
  })
  const accounts = new GitlabAccountService({
    oauth,
    accounts: new PgGitlabAgentAccountRepo(prisma),
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
    accounts,
    webhookSecrets: new PgGitlabWebhookSecretStore(prisma, cipher),
    catalog: new PgCodeHostRepositoryRepo(prisma),
    clock: systemClock,
    publicRelayUrl: 'https://relay.example.test',
    desiredWebhookEvents: async () => null,
    syncWorkspacePaths: async (orgId, projectId, projectPath, cloneUrl) => {
      await new PgAgentRepo(prisma).refreshGitlabProjectPath(OrgId(orgId), projectId, projectPath, cloneUrl)
    },
    api: fake.api
  })
  const inFlight = new Set<Promise<void>>()
  const convergeProject = provisioner.convergeProject.bind(provisioner)
  provisioner.convergeProject = (orgId: string, projectId: bigint): Promise<void> => {
    const run = convergeProject(orgId, projectId)
    inFlight.add(run)
    return run.finally(() => inFlight.delete(run))
  }
  const settled = async (): Promise<void> => {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight])
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  settleConvergence = settled
  running = buildHttpApp(prisma, { PUBLIC_CP_URL: PUBLIC_CP }, undefined, undefined, {
    gitlab: { oauth, provisioner, accounts, api: fake.api }
  })
  return { ...running, fake, settled }
}

/** Connect, bind the project, and put an agent's workspace on it — the flow that
 *  touches the OAuth endpoints, the API surface, and the persisted clone URL. */
async function install(a: HttpApp & { fake: FakeGitlab }): Promise<{ authorizeUrl: string; agentId: string }> {
  const started = await a.app.inject({
    method: 'POST',
    url: `${ORG}/gitlab/oauth/start`,
    payload: { returnPath: '/settings/integrations' }
  })
  expect(started.statusCode).toBe(200)
  const state = new URL((started.json() as { url: string }).url).searchParams.get('state')!

  const begun = await a.app.inject({ method: 'GET', url: `/api/v1/gitlab/oauth/begin?state=${state}` })
  expect(begun.statusCode).toBe(302)
  const authorizeUrl = begun.headers.location as string
  const cookie = (begun.headers['set-cookie'] as string).split(';')[0]!

  const done = await a.app.inject({
    method: 'GET',
    url: `/api/v1/gitlab/oauth/callback?state=${state}&code=code-1`,
    headers: { cookie }
  })
  expect(done.headers.location).toBe('https://console.example.test/settings/integrations?gitlab=connected')
  const connection = await prisma.gitlabConnection.findFirstOrThrow({ where: { orgId: DEFAULT_ORG_ID } })

  await seedAgent(prisma, randomUUID(), { name: `gl-${randomUUID().slice(0, 6)}`, gitlabProjectId: PROJECT })
  const bound = await a.app.inject({
    method: 'POST',
    url: `${ORG}/gitlab/projects`,
    payload: { connectionId: connection.id, projectId: PROJECT.toString() }
  })
  expect(bound.statusCode).toBe(200)

  const created = await a.app.inject({
    method: 'POST',
    url: `${ORG}/agents`,
    payload: {
      name: 'axis-bot',
      runtime: 'claude',
      workspace: { mode: 'gitlab', projectId: PROJECT.toString(), gitAccess: 'write' }
    }
  })
  expect(created.statusCode).toBe(201)
  return { authorizeUrl, agentId: (created.json() as { id: string }).id }
}

describe('the GitLab host axis (§24.1)', () => {
  it('composes exactly today’s GitLab.com URLs when the axis is unset', async () => {
    const a = app('https://gitlab.com')
    const { authorizeUrl } = await install(a)

    expect(authorizeUrl.startsWith('https://gitlab.com/oauth/authorize?')).toBe(true)
    const urls = a.fake.requests.map((r) => r.url)
    expect(urls.length).toBeGreaterThan(5)
    // Byte-identical to the pinned-host build: OAuth at the root, REST under /api/v4.
    for (const url of urls) {
      expect(url.startsWith('https://gitlab.com/api/v4/') || url.startsWith('https://gitlab.com/oauth/')).toBe(true)
    }
    expect(urls).toContain('https://gitlab.com/oauth/token')
    expect(urls).toContain('https://gitlab.com/api/v4/user')
    expect(urls).toContain(`https://gitlab.com/api/v4/projects/${PROJECT}`)
  })

  it('keeps the prefix and the port on every surface of a self-managed instance', async () => {
    const a = app(PREFIXED)
    const { authorizeUrl, agentId } = await install(a)

    expect(authorizeUrl.startsWith(`${PREFIXED}/oauth/authorize?`)).toBe(true)
    const urls = a.fake.requests.map((r) => r.url)
    for (const url of urls) {
      expect(url.startsWith(`${PREFIXED}/api/v4/`) || url.startsWith(`${PREFIXED}/oauth/`)).toBe(true)
    }
    expect(urls).toContain(`${PREFIXED}/oauth/token`)
    expect(urls).toContain(`${PREFIXED}/api/v4/user`)
    expect(urls).toContain(`${PREFIXED}/api/v4/projects/${PROJECT}`)
    // The paged administration reads compose through the same base.
    expect(urls).toContain(`${PREFIXED}/api/v4/groups/900/service_accounts?per_page=100&page=1`)
    // Nothing addressed the instance root instead of the prefix — the exact
    // failure `new URL(absolutePath, base)` would have produced.
    expect(urls.some((url) => url.startsWith('https://gitlab.example.test:8443/api/v4/'))).toBe(false)

    // Clone URLs are the provider's own answer, so they follow the instance.
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
    expect(agent.gitRepo).toBe(`${PREFIXED}/example-group/example-project.git`)
    const catalog = await prisma.codeHostRepository.findFirstOrThrow({
      where: { orgId: DEFAULT_ORG_ID, provider: 'gitlab', externalId: PROJECT }
    })
    expect(catalog.cloneUrl).toBe(`${PREFIXED}/example-group/example-project.git`)
  })
})

function document(baseUrl: string | null): DeploymentConfigValuesV1 {
  return { ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1, gitlab: { clientId: 'client-1', baseUrl } }
}

describe('the base URL is immutable while GitLab state exists (§24.1)', () => {
  it('refuses a retarget while a binding exists and allows it after a full disconnect', async () => {
    const store = new PgDeploymentConfigStore(prisma, cipher)
    const first = await store.replace({
      expectedRevision: 0,
      values: document(PREFIXED),
      secrets: { 'gitlab.clientSecret': 'secret-1' }
    })
    expect(first.values.gitlab?.baseUrl).toBe(PREFIXED)

    const a = app(PREFIXED)
    await install(a)
    // Every row the fence reads must be settled before the removals below.
    await a.settled()
    const retarget = { values: document('https://other.example.test'), secrets: { 'gitlab.clientSecret': 'secret-2' } }

    await expect(store.replace({ expectedRevision: first.revision, ...retarget })).rejects.toMatchObject({
      code: GITLAB_BASE_URL_LOCKED_REASON
    })
    // Unsetting the axis is the same change: the effective base becomes GitLab.com.
    await expect(
      store.replace({
        expectedRevision: first.revision,
        values: document(null),
        secrets: { 'gitlab.clientSecret': 'secret-2' }
      })
    ).rejects.toMatchObject({ code: GITLAB_BASE_URL_LOCKED_REASON })
    // A write that leaves the base alone is unaffected by the fence.
    const same = await store.replace({ expectedRevision: first.revision, values: document(PREFIXED) })
    expect(same.revision).toBe(first.revision + 1)

    // The binding is gone but its deployment-global claim still owes external
    // cleanup, which is exactly a reason the axis stays put.
    await prisma.gitlabProjectBinding.deleteMany({})
    await expect(store.replace({ expectedRevision: same.revision, ...retarget })).rejects.toMatchObject({
      code: GITLAB_BASE_URL_LOCKED_REASON
    })

    await prisma.codeHostRepositoryClaim.deleteMany({})
    await prisma.gitlabAgentAccount.deleteMany({})
    // The connection row survives a disconnect as credential-free history, so it
    // must not hold the axis — only a live one does.
    await expect(store.replace({ expectedRevision: same.revision, ...retarget })).rejects.toMatchObject({
      code: GITLAB_BASE_URL_LOCKED_REASON
    })
    const connection = await prisma.gitlabConnection.findFirstOrThrow({ where: { orgId: DEFAULT_ORG_ID } })
    expect(await new PgGitlabConnectionRepo(prisma).disconnect(DEFAULT_ORG_ID, connection.id)).toBe(true)

    const moved = await store.replace({ expectedRevision: same.revision, ...retarget })
    expect(moved.values.gitlab?.baseUrl).toBe('https://other.example.test')
  })

  it('requires the client secret again, because a new instance is a new application', async () => {
    const store = new PgDeploymentConfigStore(prisma, cipher)
    const first = await store.replace({
      expectedRevision: 0,
      values: document(null),
      secrets: { 'gitlab.clientSecret': 'secret-1' }
    })
    await expect(store.replace({ expectedRevision: first.revision, values: document(PREFIXED) })).rejects.toMatchObject(
      { code: 'DEPLOYMENT_CONFIG_SECRET_REFRESH_REQUIRED' }
    )
  })

  it('refuses a base URL the axis cannot normalize', async () => {
    const store = new PgDeploymentConfigStore(prisma, cipher)
    await expect(
      store.replace({
        expectedRevision: 0,
        values: document('http://gitlab.example.test'),
        secrets: { 'gitlab.clientSecret': 'secret-1' }
      })
    ).rejects.toThrow(/https/)
  })
})
