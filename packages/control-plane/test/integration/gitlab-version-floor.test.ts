/**
 * The 18.11 instance version floor (gitlab-com-integration.md §24.2) end to end
 * over real Postgres: a below-floor instance is refused at the first
 * credentialed call with nothing provisioned, an at-floor one connects and
 * provisions normally, and an instance that downgrades under a live binding
 * converges on refusing NEW provisioning while everything already provisioned
 * is left exactly as it was.
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
  PgGitlabInstanceStateStore,
  PgGitlabOauthStateStore,
  PgGitlabProjectBindingRepo,
  PgGitlabProjectCredentialRepo,
  PgGitlabProjectCredentialSecretStore,
  PgGitlabWebhookSecretStore
} from '../../src/persistence/index.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { systemClock } from '../../src/domain/clock.js'
import { OrgId } from '../../src/domain/ids.js'
import { INSTANCE_VERSION_UNSUPPORTED_REASON } from '../../src/gitlab/version.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const PUBLIC_CP = 'https://api.example.test'
const INSTANCE = 'https://gitlab.example.test'
const PROJECT = 4455667n
/** A second project, so "new provisioning" can be asked for after a downgrade. */
const OTHER_PROJECT = 4455668n
const AT_FLOOR = '18.11.0-ee'
const BELOW_FLOOR = '18.10.9-ee'
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)

let running: HttpApp | undefined
let settleConvergence: (() => Promise<void>) | undefined
afterEach(async () => {
  await settleConvergence?.()
  settleConvergence = undefined
  await running?.close()
  running = undefined
})

function app(version: string): HttpApp & {
  fake: FakeGitlab
  provisioner: GitlabProvisioner
  settled: () => Promise<void>
} {
  const fake = new FakeGitlab({
    baseUrl: INSTANCE,
    version,
    pathById: {
      [PROJECT.toString()]: 'example-group/example-project',
      [OTHER_PROJECT.toString()]: 'example-group/other'
    }
  })
  const instanceState = new PgGitlabInstanceStateStore(prisma)
  const bindings = new PgGitlabProjectBindingRepo(prisma)
  const oauth = new GitlabOauthService({
    cfg: { clientId: 'client-1', clientSecret: 'secret-1', baseUrl: INSTANCE },
    connections: new PgGitlabConnectionRepo(prisma),
    secrets: new PgGitlabConnectionSecretStore(prisma, cipher),
    states: new PgGitlabOauthStateStore(prisma),
    instanceState,
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
    instanceState,
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
  return { ...running, fake, provisioner, settled }
}

/** The OAuth three-hop, returning the final console redirect it landed on. */
async function connect(a: HttpApp): Promise<string> {
  const started = await a.app.inject({
    method: 'POST',
    url: `${ORG}/gitlab/oauth/start`,
    payload: { returnPath: '/settings/integrations' }
  })
  expect(started.statusCode).toBe(200)
  const state = new URL((started.json() as { url: string }).url).searchParams.get('state')!
  const begun = await a.app.inject({ method: 'GET', url: `/api/v1/gitlab/oauth/begin?state=${state}` })
  const cookie = (begun.headers['set-cookie'] as string).split(';')[0]!
  const done = await a.app.inject({
    method: 'GET',
    url: `/api/v1/gitlab/oauth/callback?state=${state}&code=code-1`,
    headers: { cookie }
  })
  return done.headers.location as string
}

interface BindResult {
  binding: { id: string; state: string; stateReason: string | null }
  /** The workspace agent create, which runs the inline pre-activation ensure. */
  agentStatus: number
  agentMessage: string
}

/** Bind a project and put an agent's workspace on it — what provisions accounts. */
async function bind(a: HttpApp, connectionId: string, projectId: bigint, agentName: string): Promise<BindResult> {
  await seedAgent(prisma, randomUUID(), { name: `gl-${randomUUID().slice(0, 6)}`, gitlabProjectId: projectId })
  const bound = await a.app.inject({
    method: 'POST',
    url: `${ORG}/gitlab/projects`,
    payload: { connectionId, projectId: projectId.toString() }
  })
  expect(bound.statusCode).toBe(200)
  const created = await a.app.inject({
    method: 'POST',
    url: `${ORG}/agents`,
    payload: {
      name: agentName,
      runtime: 'claude',
      workspace: { mode: 'gitlab', projectId: projectId.toString(), gitAccess: 'write' }
    }
  })
  return {
    binding: bound.json() as BindResult['binding'],
    agentStatus: created.statusCode,
    agentMessage: (created.json() as { message?: string }).message ?? ''
  }
}

describe('the GitLab version floor (§24.2)', () => {
  it('refuses the connection of a below-floor instance before anything is provisioned', async () => {
    const a = app(BELOW_FLOOR)
    const landed = await connect(a)

    expect(landed).toBe(
      `https://console.example.test/settings/integrations?gitlab=${INSTANCE_VERSION_UNSUPPORTED_REASON}`
    )
    // No connection row, so nothing downstream has an administration identity.
    expect(await prisma.gitlabConnection.count({ where: { orgId: DEFAULT_ORG_ID } })).toBe(0)
    // The floor was read on the FIRST credentialed call: the token exchange and
    // the version read are all the instance ever saw.
    expect(a.fake.requests.map((r) => r.url)).toEqual([`${INSTANCE}/oauth/token`, `${INSTANCE}/api/v4/version`])
    expect(a.fake.serviceAccounts).toEqual([])
    expect(a.fake.webhooks.size).toBe(0)
    // The observation is recorded even though the connection was refused.
    expect(await prisma.gitlabInstanceState.findUnique({ where: { baseUrl: INSTANCE } })).toMatchObject({
      version: BELOW_FLOOR,
      enterprise: true
    })
  })

  it('connects and provisions normally at exactly the floor', async () => {
    const a = app(AT_FLOOR)
    expect(await connect(a)).toBe('https://console.example.test/settings/integrations?gitlab=connected')
    const connection = await prisma.gitlabConnection.findFirstOrThrow({ where: { orgId: DEFAULT_ORG_ID } })

    const { binding, agentStatus } = await bind(a, connection.id, PROJECT, 'floor-bot')
    await a.settled()
    expect(binding.state).toBe('ready')
    expect(agentStatus).toBe(201)
    expect(a.fake.serviceAccounts.length).toBeGreaterThan(0)
    expect(await prisma.gitlabInstanceState.findUnique({ where: { baseUrl: INSTANCE } })).toMatchObject({
      version: AT_FLOOR,
      enterprise: true
    })

    // The non-secret instance facts reach the console through the connection DTO.
    const listed = await a.app.inject({ method: 'GET', url: `${ORG}/gitlab/connections` })
    expect(
      (listed.json() as { connections: { instanceUrl: string; instanceVersion: string }[] }).connections[0]
    ).toMatchObject({ instanceUrl: INSTANCE, instanceVersion: AT_FLOOR })
  })

  it('refuses new provisioning after a downgrade while existing state keeps serving', async () => {
    const a = app(AT_FLOOR)
    await connect(a)
    const connection = await prisma.gitlabConnection.findFirstOrThrow({ where: { orgId: DEFAULT_ORG_ID } })
    const { binding } = await bind(a, connection.id, PROJECT, 'downgrade-bot')
    await a.settled()
    expect(binding.state).toBe('ready')
    // Accounts are keyed on (org, agent, root group), so the organization's set
    // is what must survive the downgrade untouched.
    const accounts = () =>
      prisma.gitlabAgentAccount.findMany({ where: { orgId: DEFAULT_ORG_ID }, orderBy: { id: 'asc' } })
    const credentials = () =>
      prisma.gitlabProjectCredential.findMany({ where: { account: { orgId: DEFAULT_ORG_ID } }, orderBy: { id: 'asc' } })
    const accountsBefore = await accounts()
    const credentialsBefore = await credentials()
    expect(accountsBefore.length).toBeGreaterThan(0)
    expect(credentialsBefore.length).toBeGreaterThan(0)
    const accountsAtProvider = [...a.fake.serviceAccounts]

    // The instance is downgraded under the live binding.
    a.fake.version = BELOW_FLOOR

    // The reconciliation pass refreshes the recorded version and then refuses.
    await a.provisioner.convergeProject(DEFAULT_ORG_ID, PROJECT, { followUp: false, attempts: 0 })
    await a.settled()
    expect(await prisma.gitlabInstanceState.findUnique({ where: { baseUrl: INSTANCE } })).toMatchObject({
      version: BELOW_FLOOR
    })
    expect(await prisma.gitlabProjectBinding.findUniqueOrThrow({ where: { id: binding.id } })).toMatchObject({
      state: 'admin_degraded',
      stateReason: INSTANCE_VERSION_UNSUPPORTED_REASON
    })

    // Existing identities and credentials are untouched: the floor gates
    // provisioning, not runtime, so live sessions keep working (§19.1).
    expect(await accounts()).toEqual(accountsBefore)
    expect(await credentials()).toEqual(credentialsBefore)
    expect(a.fake.serviceAccounts).toEqual(accountsAtProvider)
    expect(a.fake.deletedServiceAccounts).toEqual([])

    // And NEW provisioning is refused: a second project binds degraded with the
    // named reason, the workspace agent that would need an identity on it is
    // refused too, and no identity was created for either at the provider.
    const second = await bind(a, connection.id, OTHER_PROJECT, 'second-bot')
    await a.settled()
    expect(second.binding).toMatchObject({
      state: 'admin_degraded',
      stateReason: INSTANCE_VERSION_UNSUPPORTED_REASON
    })
    expect(second.agentStatus).toBe(409)
    expect(second.agentMessage).toContain(INSTANCE_VERSION_UNSUPPORTED_REASON)
    expect(a.fake.serviceAccounts).toEqual(accountsAtProvider)
  })
})
