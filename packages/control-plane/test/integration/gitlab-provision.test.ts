/**
 * Provisioning saga + external cleanup (gitlab-com-integration.md §10.2, §7.2,
 * §7.3, §11.1, §19.4) against real Postgres and the stateful fake gitlab.com
 * edge: per-agent service-account convergence, membership as authorization,
 * purpose-separated PATs with policy validation, the managed webhook, the
 * lifecycle-generation fence, retirement, and claim-preserving disconnect.
 */
import { describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent } from '../fixtures/seed.js'
import { FakeGitlab, type FakeGitlabOptions } from '../fakes/gitlab-api.js'
import { GitlabOauthService } from '../../src/gitlab/oauth.service.js'
import { GitlabProvisioner } from '../../src/gitlab/provisioner.js'
import { GitlabApiClient, gitlabAgentAccountUsername, type GitlabWebhookEvents } from '../../src/gitlab/api.js'
import { GitlabAccountService, gitlabAccountUnavailableMessage } from '../../src/gitlab/account.service.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import {
  PgGitlabAgentAccountRepo,
  PgGitlabConnectionRepo,
  PgGitlabConnectionSecretStore,
  PgGitlabInstanceStateStore,
  PgGitlabOauthStateStore,
  PgGitlabProjectBindingRepo,
  PgGitlabProjectCredentialRepo,
  PgGitlabProjectCredentialSecretStore,
  PgGitlabWebhookSecretStore
} from '../../src/persistence/repositories/gitlab.repo.js'
import { PgCodeHostRepositoryRepo } from '../../src/persistence/repositories/code-host-repository.repo.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { systemClock } from '../../src/domain/clock.js'

const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)
const PROJECT = 4455667n
/** A second project under the SAME top-level group — the retarget's other half. */
const SECOND_PROJECT = 4455668n
const ROOT_GROUP = 900n
const AGENT = '11111111-1111-4111-8111-111111111111'
const SIBLING = '22222222-2222-4222-8222-222222222222'
const EVENTS: GitlabWebhookEvents = {
  push_events: true,
  issues_events: true,
  merge_requests_events: true,
  note_events: false
}

/** The account this agent must hold in the project's top-level group (§7.2). */
function usernameOf(agentId: string, agentName = 'review-agent'): string {
  return gitlabAgentAccountUsername(agentId, agentName, ROOT_GROUP)
}

/** Stand-in for the rendered agent-icon PNG the account wears (§7.2). */
const AVATAR_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function harness(
  options: FakeGitlabOptions = {},
  webhookEvents: GitlabWebhookEvents | null = null,
  agents: Array<{ id: string; name?: string; gitAccess?: 'read' | 'write' }> = [{ id: AGENT, name: 'review-agent' }]
) {
  const fake = new FakeGitlab(options)
  const avatarRenders: string[] = []
  /** What an operator reads: every account-service warning, with its reason. */
  const warnings: { obj: Record<string, unknown>; msg: string }[] = []
  const connections = new PgGitlabConnectionRepo(prisma)
  const bindings = new PgGitlabProjectBindingRepo(prisma)
  const accounts = new PgGitlabAgentAccountRepo(prisma)
  const credentials = new PgGitlabProjectCredentialRepo(prisma)
  const credentialSecrets = new PgGitlabProjectCredentialSecretStore(prisma, cipher)
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
  const accountService = new GitlabAccountService({
    oauth,
    accounts,
    credentials,
    credentialSecrets,
    agents: new PgAgentRepo(prisma),
    instanceState: new PgGitlabInstanceStateStore(prisma),
    cipher,
    clock: systemClock,
    avatarPng: async (agent) => {
      avatarRenders.push(agent.id)
      return AVATAR_PNG
    },
    log: { warn: (obj, msg) => warnings.push({ obj: obj as Record<string, unknown>, msg }) },
    api: fake.api
  })
  const buildProvisioner = (): GitlabProvisioner =>
    new GitlabProvisioner({
      oauth,
      bindings,
      accounts: accountService,
      webhookSecrets: new PgGitlabWebhookSecretStore(prisma, cipher),
      catalog: new PgCodeHostRepositoryRepo(prisma),
      instanceState: new PgGitlabInstanceStateStore(prisma),
      clock: systemClock,
      publicRelayUrl: 'https://relay.example.test',
      desiredWebhookEvents: async () => webhookEvents,
      api: fake.api
    })
  const provisioner = buildProvisioner()
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
    installerConnectionId: connection.id,
    axisBaseUrl: 'https://gitlab.com'
  })
  for (const agent of agents) {
    await seedAgent(prisma, agent.id, {
      name: agent.name ?? `agent-${agent.id.slice(0, 4)}`,
      gitlabProjectId: PROJECT,
      ...(agent.gitAccess ? { gitAccess: agent.gitAccess } : {})
    })
  }
  return {
    fake,
    avatarRenders,
    warnings,
    bindings,
    accounts,
    credentials,
    credentialSecrets,
    oauth,
    accountService,
    provisioner,
    /** A second instance over the same rows — what survives a restart is only
     *  what the database holds, never this process's timers. */
    restarted: buildProvisioner,
    binding,
    connection,
    connections
  }
}

/** The pre-M8 machine username this agent's account would have carried. */
function legacyUsername(): string {
  return `agentconnect-a${AGENT.replace(/-/g, '')}-g${ROOT_GROUP}`
}

/** The account row alone — no provider twin, as first provisioning leaves it. */
async function seedAccountRow(h: Awaited<ReturnType<typeof harness>>, username: string) {
  await h.accounts.ensure({
    orgId: DEFAULT_ORG_ID,
    agentId: AGENT,
    rootGroupId: ROOT_GROUP,
    username,
    administeringConnectionId: h.connection.id,
    axisBaseUrl: 'https://gitlab.com'
  })
  return (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
}

/** A row that already records its provider account, under `username`. */
async function seedLegacyAccount(
  h: Awaited<ReturnType<typeof harness>>,
  username: string,
  name = 'review-agent'
): Promise<void> {
  const seeded = await seedAccountRow(h, username)
  await h.accounts.update(seeded.id, { serviceAccountUserId: 7000n })
  h.fake.serviceAccounts = [{ id: 7000, username, name }]
}

describe('GitlabProvisioner (§10.2) — per-agent identity', () => {
  it('converges to ready: one account per agent, member at the derived role, three sealed PATs', async () => {
    const h = await harness()
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.state).toBe('ready')

    const [account] = await h.accounts.listForBinding(h.binding.id)
    expect(account).toMatchObject({ agentId: AGENT, username: usernameOf(AGENT), state: 'ready', lifecycle: 'active' })
    // The username reads as the agent and is creation-time; so is the display name.
    expect(h.fake.serviceAccounts).toEqual([
      { id: Number(account!.serviceAccountUserId), username: usernameOf(AGENT), name: 'review-agent' }
    ])
    // Developer for a write workspace, never higher (§7.2).
    expect(h.fake.members.get(Number(account!.serviceAccountUserId))).toBe(30)
    expect(account!.credentialEpoch).toBe(4n)

    const rows = await h.credentials.listForAccount(account!.id)
    expect(rows.map((row) => row.purpose).sort()).toEqual(['effect', 'git_write', 'read'])
    for (const row of rows) {
      expect(await h.credentialSecrets.get(DEFAULT_ORG_ID, row.id)).toMatch(/^glpat-/)
      // §7.3: explicit finite expiry, ~90 days out.
      const days = (row.providerExpiresAt.getTime() - Date.now()) / 86_400_000
      expect(days).toBeGreaterThan(88)
      expect(days).toBeLessThan(91)
    }

    // Idempotent: a second run reuses everything and mints nothing new.
    const tokenCount = h.fake.tokens.size
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(h.fake.tokens.size).toBe(tokenCount)
    expect(h.fake.serviceAccounts).toHaveLength(1)
  })

  it('gives two agents on one project two independent accounts and credential sets', async () => {
    const h = await harness({}, null, [
      { id: AGENT, name: 'reviewer' },
      { id: SIBLING, name: 'builder' }
    ])
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const accounts = await h.accounts.listForBinding(h.binding.id)
    expect(accounts.map((a) => a.username).sort()).toEqual(
      [usernameOf(AGENT, 'reviewer'), usernameOf(SIBLING, 'builder')].sort()
    )
    expect(new Set(accounts.map((a) => a.serviceAccountUserId)).size).toBe(2)
    expect(h.fake.serviceAccounts.map((a) => a.name).sort()).toEqual(['builder', 'reviewer'])
    // Six PATs: three purposes per account, none shared.
    expect(h.fake.tokens.size).toBe(6)
    for (const account of accounts) expect(await h.credentials.listForAccount(account.id)).toHaveLength(3)
  })

  it('derives the membership role from the workspace gitAccess clamp', async () => {
    const h = await harness({}, null, [{ id: AGENT, name: 'reader', gitAccess: 'read' }])
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const [account] = await h.accounts.listForBinding(h.binding.id)
    // A read-only workspace needs no push, so Reporter is the derived role.
    expect(h.fake.members.get(Number(account!.serviceAccountUserId))).toBe(20)
    const memberships = await h.accounts.membershipsForBinding(h.binding.id)
    expect(memberships).toEqual([
      { accountId: account!.id, accountGeneration: 1n, bindingId: h.binding.id, accessLevel: 20 }
    ])
  })

  it('narrows the provider role when the workspace clamp narrows', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(h.fake.members.get(Number(account.serviceAccountUserId))).toBe(30)

    // write → read: the clamp is the role, so the membership must come DOWN.
    await prisma.agent.update({ where: { id: AGENT }, data: { gitAccess: 'read' } })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(h.fake.members.get(Number(account.serviceAccountUserId))).toBe(20)
    expect((await h.accounts.membershipsForBinding(h.binding.id))[0]!.accessLevel).toBe(20)
  })

  it('translates the root group’s account quota refusal (§7.2)', async () => {
    const h = await harness({ refuseServiceAccountQuota: true })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'service_account_quota'
    })
    const [account] = await h.accounts.listForAgent(DEFAULT_ORG_ID, AGENT)
    expect(account).toMatchObject({ state: 'admin_degraded', stateReason: 'service_account_quota' })
    // No membership was claimed, so nothing the account cannot back is authorized.
    expect(await h.accounts.membershipsForBinding(h.binding.id)).toHaveLength(0)

    h.fake.opts.refuseServiceAccountQuota = false
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
  })

  it('reports the human prerequisite when service-account creation is forbidden, and repairs later', async () => {
    const h = await harness({ refuseServiceAccountCreate: true })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'service_account_creation_forbidden'
    })
    h.fake.opts.refuseServiceAccountCreate = false
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
  })

  it('an admin-only instance lands the account in its own authority state, and Repair clears it (§24.3)', async () => {
    const h = await harness({ adminOnly: true })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'service_account_creation_forbidden'
    })
    const [account] = await h.accounts.listForAgent(DEFAULT_ORG_ID, AGENT)
    // Its OWN state, never admin_degraded: authority is what is missing, and an
    // account that already exists elsewhere must keep serving through it.
    expect(account).toMatchObject({
      state: 'service_account_creation_forbidden',
      stateReason: 'service_account_creation_forbidden'
    })
    // A settled verdict owes nothing: no sweep re-attempts it until a human acts.
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.convergeOwedAt).toBeNull()

    // The operator grants the authority; the ordinary Repair path re-attempts.
    h.fake.opts.adminOnly = false
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(await h.accounts.get(account!.id)).toMatchObject({ state: 'ready', stateReason: null })
  })

  it('the inline pre-activation ensure refuses an admin-only instance without retrying it (§24.3)', async () => {
    const h = await harness({ adminOnly: true })
    const committed: string[] = []
    const outcome = await h.provisioner.provisionAgentAccount(
      DEFAULT_ORG_ID,
      PROJECT,
      { agentId: AGENT, accessLevel: 30 },
      async () => {
        committed.push('commit')
        return 'ok'
      }
    )
    expect(outcome).toEqual({ ok: false, reason: 'service_account_creation_forbidden', retryable: false })
    // The write never happened, and the budget loop never spun: exactly one
    // create was attempted, because authority cannot resolve itself.
    expect(committed).toHaveLength(0)
    const creates = h.fake.requests.filter((r) => r.method === 'POST' && /\/service_accounts$/.test(r.url))
    expect(creates).toHaveLength(1)
    expect(await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP)).toMatchObject({
      state: 'service_account_creation_forbidden'
    })
  })

  it('names the instance token-lifetime cap when the create is rejected for it (§24.3)', async () => {
    const h = await harness({ refusePatLifetime: true })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'pat_lifetime_exceeds_instance_maximum'
    })
    const [account] = await h.accounts.listForAgent(DEFAULT_ORG_ID, AGENT)
    expect(account).toMatchObject({
      state: 'admin_degraded',
      stateReason: 'pat_lifetime_exceeds_instance_maximum'
    })
    expect(gitlabAccountUnavailableMessage(account!.stateReason!)).toContain('maximum access-token lifetime')
  })

  it('accepts an expiry the instance clamped below the request and records the granted one (§24.3)', async () => {
    const h = await harness({ patLifetimeCapDays: 30 })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    const read = (await h.credentials.get(account.id, 'read'))!
    // The 90-day request was answered with 30 days, and the ROW carries what the
    // instance granted — nothing was revoked and nothing failed closed.
    expect(read.providerExpiresAt.getTime()).toBeLessThan(Date.now() + 31 * 86_400_000)
    expect(read.providerExpiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000)
    expect(h.fake.tokens.get(Number(read.externalTokenId))!.revoked).toBe(false)
  })

  it('revokes an expiry LATER than requested and fails closed (§7.3)', async () => {
    const h = await harness({ patExpiryOverride: '2099-01-01' })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'out_of_policy_token'
    })
    expect([...h.fake.tokens.values()].every((token) => token.revoked)).toBe(true)
    expect(await prisma.gitlabProjectCredential.count()).toBe(0)
  })

  it('revokes an out-of-policy token and fails closed (§7.3)', async () => {
    const h = await harness({ patExpiryOverride: null })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'out_of_policy_token'
    })
    // The returned token was revoked by id, and nothing was sealed.
    expect([...h.fake.tokens.values()].every((token) => token.revoked)).toBe(true)
    expect(await prisma.gitlabProjectCredential.count()).toBe(0)
  })

  it('refuses a personal namespace (§5)', async () => {
    const h = await harness({ namespaceKind: 'user' })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'personal_namespace_unsupported'
    })
  })

  it('syncs the display name after an agent rename, and a refused rename stays cosmetic', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    await prisma.agent.update({ where: { id: AGENT }, data: { displayName: 'Release Robot' } })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(h.fake.serviceAccounts[0]).toMatchObject({ username: usernameOf(AGENT), name: 'Release-Robot' })

    h.fake.opts.refuseServiceAccountRename = true
    await prisma.agent.update({ where: { id: AGENT }, data: { displayName: 'Refused Name' } })
    // The account and its credentials matter; the label does not.
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(h.fake.serviceAccounts[0]).toMatchObject({ name: 'Release-Robot' })
  })

  it('installs, keys, and tests the managed webhook when hooks want events (§11.1)', async () => {
    const h = await harness({}, EVENTS)
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const binding = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!
    expect(binding.webhookId).not.toBeNull()
    const hook = h.fake.webhooks.get(Number(binding.webhookId))!
    expect(hook.url).toBe('https://relay.example.test/webhooks/gitlab')
    expect(hook.token.startsWith('whsec_')).toBe(true)
    expect(hook.events.issues_events).toBe(true)
    expect(hook.tested).toBe(1)
    expect(await new PgGitlabWebhookSecretStore(prisma, cipher).get(DEFAULT_ORG_ID, h.binding.id)).toBe(hook.token)
  })

  it('an agent that loses its authorization loses the membership and its emptied account retires (§7.2)', async () => {
    const h = await harness({}, null, [
      { id: AGENT, name: 'reviewer' },
      { id: SIBLING, name: 'builder' }
    ])
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const sibling = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, SIBLING, ROOT_GROUP))!
    const siblingUserId = Number(sibling.serviceAccountUserId)
    // The sibling's workspace moves off the project: it stops being a consumer.
    await prisma.agent.update({ where: { id: SIBLING }, data: { workspaceMode: 'scratch', workspaceRepoId: null } })

    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(h.fake.removedMembers).toEqual([siblingUserId])
    // Nothing bound in its root any more, so the account retired outright.
    expect(await h.accounts.byAgentRoot(DEFAULT_ORG_ID, SIBLING, ROOT_GROUP)).toBeNull()
    expect(h.fake.deletedServiceAccounts).toEqual([siblingUserId])
    expect([...h.fake.tokens.values()].filter((t) => t.user_id === siblingUserId).every((t) => t.revoked)).toBe(true)
    // The surviving agent is untouched.
    const kept = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(kept.state).toBe('ready')
    expect([...h.fake.tokens.values()].filter((t) => t.user_id === Number(kept.serviceAccountUserId))).toHaveLength(3)
    expect(
      [...h.fake.tokens.values()]
        .filter((t) => t.user_id === Number(kept.serviceAccountUserId))
        .every((t) => !t.revoked)
    ).toBe(true)
  })

  it('a failed write gives back the role it raised, keeping what survives it', async () => {
    // A read-only workspace earns Reporter. An enabled hook would earn
    // Developer, so its pre-write provisioning raises the membership — and if
    // that write then fails, the raise must not outlive it.
    const h = await harness({}, null, [{ id: AGENT, name: 'reader', gitAccess: 'read' }])
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(h.fake.members.get(Number(account.serviceAccountUserId))).toBe(20)

    await expect(
      h.provisioner.provisionAgentAccount(DEFAULT_ORG_ID, PROJECT, { agentId: AGENT, accessLevel: 30 }, async () => {
        throw new Error('the hook write failed')
      })
    ).rejects.toThrow('the hook write failed')

    // The workspace's own authorization survives, at its own role — not the
    // hook's — and the account is untouched.
    expect(h.fake.members.get(Number(account.serviceAccountUserId))).toBe(20)
    expect((await h.accounts.membershipsForBinding(h.binding.id))[0]).toMatchObject({
      accountId: account.id,
      accessLevel: 20
    })
    expect(await h.accounts.get(account.id)).not.toBeNull()
    expect(h.fake.deletedServiceAccounts).toEqual([])
  })

  it('a transient convergence failure never revokes an existing membership', async () => {
    const h = await harness({}, null, [
      { id: AGENT, name: 'reviewer' },
      { id: SIBLING, name: 'builder' }
    ])
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const sibling = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, SIBLING, ROOT_GROUP))!
    // A live peer holds the sibling's account lease, so its converge cannot run.
    expect(await h.accounts.claimLease(sibling.id, 'peer', new Date(Date.now() + 300_000), new Date())).toBe(true)

    const outcome = await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    // Retryable: a contended account lease resolves itself, so a writer comes back.
    expect(outcome).toEqual({ state: 'admin_degraded', reason: 'account_busy', retryable: true })
    // Authorization did not change, so the membership, the account, and its PATs stay.
    expect((await h.accounts.membershipsForBinding(h.binding.id)).map((m) => m.accountId).sort()).toEqual(
      [sibling.id, (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!.id].sort()
    )
    expect(await h.accounts.get(sibling.id)).not.toBeNull()
    expect(h.fake.removedMembers).toEqual([])
    expect(h.fake.deletedServiceAccounts).toEqual([])
    expect([...h.fake.tokens.values()].every((token) => !token.revoked)).toBe(true)
  })

  it('a retarget under one root converges the loser once the peer releases the account fence', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!

    // The agent's workspace moves to a second project in the SAME top-level
    // group, so both projects converge against its one account (§7.2).
    const second = await h.bindings.createWithClaim({
      orgId: DEFAULT_ORG_ID,
      projectId: SECOND_PROJECT,
      projectPath: 'example-group/example-second',
      installerConnectionId: h.connection.id,
      axisBaseUrl: 'https://gitlab.com'
    })
    await prisma.agent.update({ where: { id: AGENT }, data: { workspaceRepoId: SECOND_PROJECT } })

    // The project being left owns the account fence first: the new project's
    // run must lose, wait, and come back rather than leave the agent unbound.
    expect(await h.accounts.claimLease(account.id, 'old-project-run', new Date(Date.now() + 300_000), new Date())).toBe(
      true
    )
    const converging = h.provisioner.convergeProject(DEFAULT_ORG_ID, SECOND_PROJECT)
    // Losing the fence leaves the binding exactly as it was — a race is not a
    // verdict — so the peer's grip is what this waits on, not a degraded state.
    await vi.waitFor(() => expect(h.fake.requests.some((r) => r.url.includes('service_accounts'))).toBe(true), {
      timeout: 20_000
    })
    expect((await h.bindings.get(DEFAULT_ORG_ID, second.id))!.stateReason).toBeNull()
    await h.accounts.releaseLease(account.id, 'old-project-run')

    await converging
    expect((await h.bindings.get(DEFAULT_ORG_ID, second.id))!.state).toBe('ready')
    expect((await h.accounts.membershipsForBinding(second.id)).map((m) => m.accountId)).toEqual([account.id])
  })

  it('a retirement in flight is finished, never revived, and its credentials go with it', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    const before = (await h.credentials.get(account.id, 'read'))!
    await h.accounts.detachMembershipForRemoval(account.id, h.binding.id)
    // The detach that empties the account IS the active→retiring CAS, so the
    // row is a durable work item before any provider call runs (§7.2).
    expect(await h.accounts.get(account.id)).toMatchObject({ lifecycle: 'retiring' })

    // A consumer arriving now waits: reviving the row would keep credentials
    // whose account the retirement is tearing down.
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'account_retiring',
      retryable: true
    })

    // The sweep finishes the retirement; the row and its credentials go together.
    await h.accountService.sweepPendingRetirements(0)
    expect(await h.accounts.get(account.id)).toBeNull()
    expect(await prisma.gitlabProjectCredentialSecret.count({ where: { credentialId: before.id } })).toBe(0)

    // Only then does the next converge provision a genuinely fresh identity.
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const fresh = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(fresh.id).not.toBe(account.id)
    expect((await h.credentials.get(fresh.id, 'read'))!.externalTokenId).not.toBe(before.externalTokenId)
  })

  it('the lifecycle-generation fence decides a bind racing a retirement (§7.2)', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!

    // Retirement cannot begin while a membership is held.
    expect(await h.accounts.beginRetirement(account.id)).toBe(false)
    await h.accounts.detachMembership(account.id, h.binding.id)
    expect(await h.accounts.beginRetirement(account.id)).toBe(true)

    // A bind holding the pre-retirement generation loses the fence outright.
    expect(
      await h.accounts.attachMembership({
        accountId: account.id,
        generation: account.generation,
        bindingId: h.binding.id,
        accessLevel: 30
      })
    ).toBe(false)

    // The loser waits out the retirement rather than reviving the row: once the
    // sweep has finished it, the next converge provisions a fresh account.
    await h.accountService.sweepPendingRetirements(0)
    expect(await h.accounts.get(account.id)).toBeNull()
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const fresh = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(fresh.id).not.toBe(account.id)
    expect((await h.accounts.membershipsForBinding(h.binding.id)).map((m) => m.accountId)).toEqual([fresh.id])
  })

  it('deleting an agent retires every account it earned (§19.4)', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    await prisma.agent.delete({ where: { id: AGENT } })

    await h.accountService.retireAgentAccounts(DEFAULT_ORG_ID, AGENT)
    expect(await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP)).toBeNull()
    expect(h.fake.removedMembers).toEqual([Number(account.serviceAccountUserId)])
    expect(h.fake.deletedServiceAccounts).toEqual([Number(account.serviceAccountUserId)])
    expect([...h.fake.tokens.values()].every((token) => token.revoked)).toBe(true)
  })

  it('an agent retirement that cannot finish externally stays cleanup_pending', async () => {
    const h = await harness({ failTokenRevoke: true })
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    await prisma.agent.delete({ where: { id: AGENT } })
    await h.accountService.retireAgentAccounts(DEFAULT_ORG_ID, AGENT)
    const [account] = await h.accounts.listForAgent(DEFAULT_ORG_ID, AGENT)
    expect(account).toMatchObject({ state: 'cleanup_pending', lifecycle: 'retiring' })
  })

  it('records an accepted-but-unobserved deletion as pending, then the sweep closes it (§19.4)', async () => {
    // GitLab deletes a user asynchronously: the DELETE is accepted and the
    // account is still listed for a while afterwards.
    const h = await harness({ deferServiceAccountDeletion: true })
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    await prisma.agent.delete({ where: { id: AGENT } })
    await h.accountService.retireAgentAccounts(DEFAULT_ORG_ID, AGENT)

    // In flight, not failed — and never mislabelled as an unreachable GitLab.
    expect(await h.accounts.get(account.id)).toMatchObject({
      lifecycle: 'retiring',
      state: 'cleanup_pending',
      stateReason: 'deletion_pending'
    })
    expect(h.fake.deletedServiceAccounts).toEqual([Number(account.serviceAccountUserId)])

    // A sweep before the deletion lands leaves the row exactly as it is.
    await h.accountService.sweepPendingRetirements(0)
    expect((await h.accounts.get(account.id))?.stateReason).toBe('deletion_pending')

    // Once GitLab has actually removed the user, absence is the positive
    // evidence the retirement was waiting for.
    h.fake.settleServiceAccountDeletions()
    await h.accountService.sweepPendingRetirements(0)
    expect(await h.accounts.get(account.id)).toBeNull()
  })

  it('the sweep leaves rows alone until they have been quiet, and reserves gitlab_unreachable', async () => {
    const h = await harness({ deferServiceAccountDeletion: true })
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    await prisma.agent.delete({ where: { id: AGENT } })
    await h.accountService.retireAgentAccounts(DEFAULT_ORG_ID, AGENT)
    h.fake.settleServiceAccountDeletions()

    // A row written moments ago is not swept: the quiet window keeps the sweep
    // from racing the run that recorded it.
    await h.accountService.sweepPendingRetirements(60_000)
    expect(await h.accounts.get(account.id)).not.toBeNull()

    // A real transport failure — fetch itself throwing — is the ONLY thing that
    // may be reported as an unreachable GitLab.
    const offline = new GitlabAccountService({
      oauth: h.oauth,
      accounts: h.accounts,
      credentials: h.credentials,
      credentialSecrets: h.credentialSecrets,
      agents: new PgAgentRepo(prisma),
      instanceState: new PgGitlabInstanceStateStore(prisma),
      cipher,
      clock: systemClock,
      api: new GitlabApiClient(h.fake.opts.baseUrl, async () => {
        throw new Error('connect ECONNREFUSED')
      })
    })
    await offline.sweepPendingRetirements(0)
    expect((await h.accounts.get(account.id))?.stateReason).toBe('gitlab_unreachable')

    // …and the next healthy sweep still finishes the retirement.
    await h.accountService.sweepPendingRetirements(0)
    expect(await h.accounts.get(account.id)).toBeNull()
  })

  it('a project removal blocked by a pending deletion finishes once the account is gone', async () => {
    const h = await harness({ deferServiceAccountDeletion: true }, EVENTS)
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!

    // The removal cannot prove the account is gone yet, so it keeps the claim.
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      removed: false,
      reason: 'deletion_pending'
    })
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.stateReason).toBe('deletion_pending')
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitlab' } })).toBe(1)

    // Deletion lands, the sweep observes it, and the removal completes.
    h.fake.settleServiceAccountDeletions()
    await h.accountService.sweepPendingRetirements(0)
    expect(await h.accounts.get(account.id)).toBeNull()
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({ removed: true })
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitlab' } })).toBe(0)
  })

  it('never revives an account whose deletion GitLab already accepted', async () => {
    const h = await harness({ deferServiceAccountDeletion: true })
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const doomed = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    // The agent stops consuming the project, so its account retires; GitLab
    // accepts the deletion but has not carried it out yet.
    await prisma.agent.update({ where: { id: AGENT }, data: { workspaceMode: 'scratch', workspaceRepoId: null } })
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect((await h.accounts.get(doomed.id))?.stateReason).toBe('deletion_pending')

    // A consumer arriving before the deletion lands must NOT adopt that user:
    // its PATs would die with it, on a row the sweep no longer watches.
    await prisma.agent.update({
      where: { id: AGENT },
      data: {
        workspaceMode: 'gitlab',
        workspaceRepoId: PROJECT,
        gitRepo: 'https://gitlab.com/example-group/example-project'
      }
    })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'account_retiring',
      retryable: true
    })
    expect(await h.accounts.get(doomed.id)).toMatchObject({
      lifecycle: 'retiring',
      serviceAccountUserId: doomed.serviceAccountUserId
    })
    expect(await h.accounts.membershipsForBinding(h.binding.id)).toHaveLength(0)

    // Once the deletion lands the sweep clears the row, and the next attempt
    // provisions a genuinely fresh account.
    h.fake.settleServiceAccountDeletions()
    await h.accountService.sweepPendingRetirements(0)
    expect(await h.accounts.get(doomed.id)).toBeNull()
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const fresh = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(fresh.id).not.toBe(doomed.id)
    expect(fresh.state).toBe('ready')
    expect(await h.credentials.listForAccount(fresh.id)).toHaveLength(3)
  })

  it('records the removal’s obligation with the detach, before any provider write', async () => {
    const h = await harness({ deferServiceAccountDeletion: true }, EVENTS)
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!

    // Detaching the last membership IS the moment the removal takes on the
    // retirement: the same transaction performs the active→retiring CAS and
    // records the obligation, so a crash right here still leaves a work item.
    await h.accounts.detachMembershipForRemoval(account.id, h.binding.id)
    const row = await prisma.gitlabAgentAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(row.retiringForBindingId).toBe(h.binding.id)
    expect(row.lifecycle).toBe('retiring')

    // Crash simulated: nothing else ran after that transaction. Both worklists
    // still select the row, so the retirement resumes rather than stranding.
    expect((await h.accounts.listUnfinishedRetirements(new Date(Date.now() + 1_000), 50)).map((a) => a.id)).toEqual([
      account.id
    ])
    expect((await h.accounts.listRetiringForBinding(h.binding.id)).map((a) => a.id)).toEqual([account.id])

    // A removal retried after that crash cannot release the claim…
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      removed: false,
      reason: 'deletion_pending'
    })
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitlab' } })).toBe(1)

    // …until the deletion lands and the sweep discharges the obligation.
    h.fake.settleServiceAccountDeletions()
    await h.accountService.sweepPendingRetirements(0)
    expect(await h.accounts.get(account.id)).toBeNull()
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({ removed: true })
  })

  it('a bind racing the removal detach never leaves a retiring account holding a membership', async () => {
    // The bind is for a DIFFERENT project in the same root, so it is a genuine
    // "someone still needs this account" against "this account is being freed".
    // Both take the account row lock, so they serialize: either the bind commits
    // first and the detach sees its membership, or the detach retires first and
    // the bind loses the generation fence. The state this rules out is a
    // `retiring` row holding a membership — nothing could use the account then,
    // and nothing could retire it either.
    for (let round = 0; round < 8; round++) {
      const h = await harness()
      await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
      const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
      const second = await h.bindings.createWithClaim({
        orgId: DEFAULT_ORG_ID,
        projectId: SECOND_PROJECT,
        projectPath: 'example-group/example-second',
        installerConnectionId: h.connection.id,
        axisBaseUrl: 'https://gitlab.com'
      })

      const [, bound] = await Promise.all([
        h.accounts.detachMembershipForRemoval(account.id, h.binding.id),
        h.accounts.attachMembership({
          accountId: account.id,
          generation: account.generation,
          bindingId: second.id,
          accessLevel: 30
        })
      ])

      const after = await prisma.gitlabAgentAccount.findUniqueOrThrow({ where: { id: account.id } })
      const memberships = await h.accounts.countMemberships(account.id)
      // The invariant, whichever order won.
      expect(after.lifecycle === 'retiring' && memberships > 0).toBe(false)
      if (after.lifecycle === 'retiring') {
        expect(bound).toBe(false)
        expect(after.retiringForBindingId).toBe(h.binding.id)
      } else {
        expect(bound).toBe(true)
        expect(memberships).toBe(1)
        expect(after.retiringForBindingId).toBeNull()
      }
      await prisma.gitlabAgentAccount.deleteMany({})
      await prisma.gitlabProjectBinding.deleteMany({})
      await prisma.codeHostRepositoryClaim.deleteMany({})
      await prisma.agent.deleteMany({ where: { id: AGENT } })
    }
  })

  it('a removal waits for EVERY emptied account, not just the first to disappear', async () => {
    // Two agents on one project means two bot accounts; the removal detaches
    // both memberships up front, so nothing but the recorded obligation still
    // links the second retirement to the removal that caused it.
    const h = await harness({ deferServiceAccountDeletion: true }, EVENTS, [
      { id: AGENT, name: 'reviewer' },
      { id: SIBLING, name: 'builder' }
    ])
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const first = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    const second = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, SIBLING, ROOT_GROUP))!

    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      removed: false,
      reason: 'deletion_pending'
    })
    expect(await h.accounts.membershipsForBinding(h.binding.id)).toHaveLength(0)

    // Only the FIRST account's deletion lands. Its retirement completing must
    // not let the removal release the claim while the second is still listed.
    h.fake.serviceAccounts = h.fake.serviceAccounts.filter(
      (candidate) => candidate.id !== Number(first.serviceAccountUserId)
    )
    await h.accountService.sweepPendingRetirements(0)
    expect(await h.accounts.get(first.id)).toBeNull()
    expect(await h.accounts.get(second.id)).not.toBeNull()

    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      removed: false,
      reason: 'deletion_pending'
    })
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitlab' } })).toBe(1)
    expect(await prisma.gitlabProjectBinding.count()).toBe(1)

    // The second lands too: now every obligation is discharged and the claim goes.
    h.fake.settleServiceAccountDeletions()
    await h.accountService.sweepPendingRetirements(0)
    expect(await h.accounts.get(second.id)).toBeNull()
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({ removed: true })
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitlab' } })).toBe(0)
  })

  it('disconnect retires webhook, memberships, tokens, and accounts, then releases the claim (§19.4)', async () => {
    const h = await harness({}, EVENTS)
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({ removed: true })
    expect(await prisma.gitlabProjectBinding.count()).toBe(0)
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitlab' } })).toBe(0)
    expect(await prisma.gitlabAgentAccount.count()).toBe(0)
    expect(h.fake.webhooks.size).toBe(0)
    expect([...h.fake.tokens.values()].every((token) => token.revoked)).toBe(true)
    expect(h.fake.deletedServiceAccounts).toHaveLength(1)
  })

  it('incomplete cleanup keeps cleanup_pending and RETAINS the claim (§19.4)', async () => {
    const h = await harness({ failTokenRevoke: true })
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect((await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).removed).toBe(false)
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.state).toBe('cleanup_pending')
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitlab' } })).toBe(1)
  })

  it('provision loses to a concurrent cleanup: no provider write after the fence flips (§10.2)', async () => {
    const h = await harness()
    await h.bindings.beginCleanup(DEFAULT_ORG_ID, h.binding.id, PROJECT, new Date())
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'busy',
      reason: 'provisioning_or_cleanup_in_progress'
    })
    expect(h.fake.serviceAccounts).toHaveLength(0)
    expect(h.fake.tokens.size).toBe(0)
  })

  it('the lease is exclusive, run-owned, and mutually exclusive with cleanup', async () => {
    const h = await harness()
    const now = new Date()
    const until = new Date(Date.now() + 600_000)
    // Acquired by A: a live foreign acquire (B) refuses; same-owner re-acquire holds.
    expect(await h.bindings.markProviderMutationStarted(DEFAULT_ORG_ID, h.binding.id, PROJECT, 'A', until, now)).toBe(
      true
    )
    expect(await h.bindings.markProviderMutationStarted(DEFAULT_ORG_ID, h.binding.id, PROJECT, 'B', until, now)).toBe(
      false
    )
    expect(await h.bindings.markProviderMutationStarted(DEFAULT_ORG_ID, h.binding.id, PROJECT, 'A', until, now)).toBe(
      true
    )
    // Cleanup must wait while the lease is live; a foreign release does nothing.
    expect(await h.bindings.beginCleanup(DEFAULT_ORG_ID, h.binding.id, PROJECT, now)).toBe(false)
    await h.bindings.endProviderMutation(DEFAULT_ORG_ID, h.binding.id, PROJECT, 'B')
    expect(await h.bindings.renewProviderLease(DEFAULT_ORG_ID, h.binding.id, PROJECT, 'A', until)).toBe(true)
    // Only the owner's release frees it; then cleanup wins and late checks refuse.
    await h.bindings.endProviderMutation(DEFAULT_ORG_ID, h.binding.id, PROJECT, 'A')
    expect(await h.bindings.beginCleanup(DEFAULT_ORG_ID, h.binding.id, PROJECT, now)).toBe(true)
    expect(await h.bindings.renewProviderLease(DEFAULT_ORG_ID, h.binding.id, PROJECT, 'A', until)).toBe(false)
    expect(await h.bindings.markProviderMutationStarted(DEFAULT_ORG_ID, h.binding.id, PROJECT, 'A', until, now)).toBe(
      false
    )
  })

  it('the account mutation lease is exclusive and reclaimable after expiry (§7.2)', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    const now = new Date()
    const until = new Date(Date.now() + 300_000)
    expect(await h.accounts.claimLease(account.id, 'A', until, now)).toBe(true)
    expect(await h.accounts.claimLease(account.id, 'B', until, now)).toBe(false)
    expect(await h.accounts.renewLease(account.id, 'B', until)).toBe(false)
    expect(await h.accounts.renewLease(account.id, 'A', until)).toBe(true)
    // An expired lease is claimable again (crash recovery); only the owner releases.
    await h.accounts.claimLease(account.id, 'A', new Date(Date.now() - 1_000), now)
    expect(await h.accounts.claimLease(account.id, 'C', until, now)).toBe(true)
    await h.accounts.releaseLease(account.id, 'A')
    expect(await h.accounts.claimLease(account.id, 'D', until, now)).toBe(false)
  })

  it('concurrent convergences of one project join instead of racing, and settle ready', async () => {
    const h = await harness()
    // Four callers at once — a repair, a hook write, and two background kicks.
    await Promise.all([
      h.provisioner.convergeProject(DEFAULT_ORG_ID, PROJECT),
      h.provisioner.convergeProject(DEFAULT_ORG_ID, PROJECT),
      h.provisioner.convergeProject(DEFAULT_ORG_ID, PROJECT),
      h.provisioner.convergeProject(DEFAULT_ORG_ID, PROJECT)
    ])
    const binding = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!
    expect(binding).toMatchObject({ state: 'ready', stateReason: null })
    // One account and one set of PATs: the joined callers did not each provision.
    expect(h.fake.serviceAccounts).toHaveLength(1)
    expect(h.fake.tokens.size).toBe(3)
  })

  it('a bot repair across two projects sharing one account settles both clean', async () => {
    const h = await harness()
    const second = await h.bindings.createWithClaim({
      orgId: DEFAULT_ORG_ID,
      projectId: SECOND_PROJECT,
      projectPath: 'example-group/example-second',
      installerConnectionId: h.connection.id,
      axisBaseUrl: 'https://gitlab.com'
    })
    // One agent consuming both projects in the same root: both convergences want
    // the SAME account mutation lease, which is what a bot-level repair triggers.
    await prisma.hookDef.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        agentId: AGENT,
        kind: 'gitlab',
        name: 'second-hook',
        sessionMode: 'perThread',
        repoId: SECOND_PROJECT,
        events: ['issues:*']
      }
    })

    await Promise.all([
      h.provisioner.convergeProject(DEFAULT_ORG_ID, PROJECT),
      h.provisioner.convergeProject(DEFAULT_ORG_ID, SECOND_PROJECT)
    ])

    // Neither binding settled degraded on account of the other holding the lease.
    expect(await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)).toMatchObject({ state: 'ready', stateReason: null })
    expect(await h.bindings.get(DEFAULT_ORG_ID, second.id)).toMatchObject({ state: 'ready', stateReason: null })
    // One account, bound to both.
    const accounts = await h.accounts.listForAgent(DEFAULT_ORG_ID, AGENT)
    expect(accounts).toHaveLength(1)
    expect(await h.accounts.countMemberships(accounts[0]!.id)).toBe(2)
  })

  it('exhausted contention leaves the binding alone and re-drives itself', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    // A peer holds the account lease for longer than this pass will wait.
    expect(await h.accounts.claimLease(account.id, 'peer', new Date(Date.now() + 300_000), new Date())).toBe(true)

    await h.provisioner.convergeProject(DEFAULT_ORG_ID, PROJECT, { attempts: 0, followUp: false })

    // A lost fence is not a verdict: the binding keeps the state it had, so the
    // console never shows "setup incomplete" because two repairs overlapped.
    expect(await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)).toMatchObject({ state: 'ready', stateReason: null })

    // Once the peer is done, the next pass converges normally — no user action.
    await h.accounts.releaseLease(account.id, 'peer')
    await h.provisioner.convergeProject(DEFAULT_ORG_ID, PROJECT, { attempts: 0, followUp: false })
    expect(await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)).toMatchObject({ state: 'ready', stateReason: null })
  })

  it('a contended pass owes a follow-up, and the console keeps watching until it lands', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(h.provisioner.hasPendingWork(DEFAULT_ORG_ID)).toBe(false)

    // A peer holds the account lease, so a single pass — a create, a takeover,
    // a repair — cannot converge and must leave the binding alone.
    expect(await h.accounts.claimLease(account.id, 'peer', new Date(Date.now() + 300_000), new Date())).toBe(true)
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toMatchObject({ retryable: true })
    expect(await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)).toMatchObject({ state: 'ready', stateReason: null })

    // The work is owed and visible: the console is told to keep watching rather
    // than reading a settled database one refresh too early.
    expect(h.provisioner.hasPendingWork(DEFAULT_ORG_ID)).toBe(true)
    expect(h.provisioner.hasPendingWork('another-org')).toBe(false)
  })

  it('a takeover that loses the account fence still gets converged later', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    // A bot-wide takeover launches one transfer per project, so projects sharing
    // an account contend exactly as repairs do.
    expect(await h.accounts.claimLease(account.id, 'peer', new Date(Date.now() + 300_000), new Date())).toBe(true)

    const taker = await h.connections.upsertOnCallback({
      orgId: DEFAULT_ORG_ID,
      userId: DEFAULT_OWNER_ID,
      gitlabUserId: 7007n,
      gitlabUsername: 'example-taker',
      scopes: ['api'],
      accessExpiresAt: new Date(Date.now() + 3600_000),
      sealedPair: { accessToken: 'at-taker', refreshToken: 'rt-taker' },
      axisBaseUrl: 'https://gitlab.com'
    })
    h.fake.members.set(7007, 50)
    expect(await h.provisioner.transfer(DEFAULT_ORG_ID, h.binding.id, { id: taker.id, gitlabUserId: 7007n })).toEqual({
      outcome: 'transferred'
    })

    // The binding is not falsely degraded, and the convergence it never got is owed.
    expect(await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)).toMatchObject({ state: 'ready', stateReason: null })
    expect(h.provisioner.hasPendingWork(DEFAULT_ORG_ID)).toBe(true)
  })

  it('records the contended obligation durably, and a sweep re-drives it after a restart', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.convergeOwedAt).toBeNull()

    // A peer holds the account lease, so this pass writes no binding state.
    expect(await h.accounts.claimLease(account.id, 'peer', new Date(Date.now() + 300_000), new Date())).toBe(true)
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)

    // The obligation is on the row, not only in this process's timer — which is
    // what a restart would otherwise erase along with the console's signal.
    const owed = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!
    expect(owed.convergeOwedAt).not.toBeNull()
    expect(owed).toMatchObject({ state: 'ready', stateReason: null })
    expect((await h.bindings.listConvergeOwed(new Date(Date.now() + 1_000), 50)).map((b) => b.id)).toEqual([
      h.binding.id
    ])

    // A fresh provisioner — the restart — rediscovers and discharges it.
    await h.accounts.releaseLease(account.id, 'peer')
    await h.restarted().sweepOwedConvergences(0)
    const settled = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!
    expect(settled.convergeOwedAt).toBeNull()
    expect(settled).toMatchObject({ state: 'ready', stateReason: null })
    expect(await h.bindings.listConvergeOwed(new Date(Date.now() + 1_000), 50)).toHaveLength(0)
  })

  it('a route write waits out a background convergence instead of refusing it', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)

    // A background convergence holds the binding lease. The pre-activation
    // ensure a route write runs must outlast that rather than 409 on a race
    // with a perfectly healthy convergence.
    const held = 'background-converge'
    expect(
      await h.bindings.markProviderMutationStarted(
        DEFAULT_ORG_ID,
        h.binding.id,
        PROJECT,
        held,
        new Date(Date.now() + 600_000),
        new Date()
      )
    ).toBe(true)
    setTimeout(() => {
      void h.bindings.endProviderMutation(DEFAULT_ORG_ID, h.binding.id, PROJECT, held)
    }, 5_000)

    const committed = await h.provisioner.provisionAgentAccount(
      DEFAULT_ORG_ID,
      PROJECT,
      { agentId: AGENT, accessLevel: 30 },
      async () => 'written'
    )
    expect(committed).toEqual({ ok: true, result: 'written' })
    expect((await h.accounts.membershipsForBinding(h.binding.id)).map((m) => m.accessLevel)).toEqual([30])
  }, 30_000)

  it('reports a still-contended route write as transient, never as a degraded binding', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    // Held for longer than any request should wait.
    expect(
      await h.bindings.markProviderMutationStarted(
        DEFAULT_ORG_ID,
        h.binding.id,
        PROJECT,
        'stuck',
        new Date(Date.now() + 600_000),
        new Date()
      )
    ).toBe(true)

    const refused = await h.provisioner.provisionAgentAccount(
      DEFAULT_ORG_ID,
      PROJECT,
      { agentId: AGENT, accessLevel: 30 },
      async () => 'written'
    )
    expect(refused).toMatchObject({ ok: false, retryable: true, reason: 'provisioning_or_cleanup_in_progress' })
    // Transient wording, and the binding is untouched — a race is not a verdict.
    expect(gitlabAccountUnavailableMessage('provisioning_or_cleanup_in_progress')).toContain('try again')
    expect(await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)).toMatchObject({ state: 'ready', stateReason: null })
  }, 30_000)

  it('a settled degrade discharges the obligation instead of sweeping forever', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(await h.accounts.claimLease(account.id, 'peer', new Date(Date.now() + 300_000), new Date())).toBe(true)
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.convergeOwedAt).not.toBeNull()

    // The administering connection goes away: the next pass is a verdict asking
    // for human repair, not something a sweep should keep repeating.
    await h.bindings.update(DEFAULT_ORG_ID, h.binding.id, { installerConnectionId: null })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'no_admin_connection'
    })
    const settled = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!
    expect(settled.convergeOwedAt).toBeNull()
    expect(await h.bindings.listConvergeOwed(new Date(Date.now() + 1_000), 50)).toHaveLength(0)
  })

  it('a binding entering cleanup owes no more convergence', async () => {
    const h = await harness({ failTokenRevoke: true })
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(await h.accounts.claimLease(account.id, 'peer', new Date(Date.now() + 300_000), new Date())).toBe(true)
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.convergeOwedAt).not.toBeNull()
    await h.accounts.releaseLease(account.id, 'peer')

    // Taking the claim for cleanup discharges the obligation in the SAME
    // transaction: past that point convergence can never acquire the claim, so
    // an obligation surviving the flip is one nothing could satisfy.
    expect(await h.bindings.beginCleanup(DEFAULT_ORG_ID, h.binding.id, PROJECT, new Date())).toBe(true)
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.convergeOwedAt).toBeNull()
    expect(await h.bindings.listConvergeOwed(new Date(Date.now() + 1_000), 50)).toHaveLength(0)

    expect((await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).removed).toBe(false)
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.state).toBe('cleanup_pending')
    expect(await h.bindings.listConvergeOwed(new Date(Date.now() + 1_000), 50)).toHaveLength(0)

    // The inverse order too: a repair that loses to cleanup must not arm an
    // obligation afterwards, or the console would report converging forever.
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.convergeOwedAt).toBeNull()
    await h.bindings.markConvergeOwed(DEFAULT_ORG_ID, h.binding.id, new Date())
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.convergeOwedAt).toBeNull()
  })

  it('two concurrent provisions: exactly one runs, the other observes busy', async () => {
    const h = await harness()
    const [a, b] = await Promise.all([
      h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id),
      h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    ])
    expect([a.state, b.state].sort()).toEqual(['busy', 'ready'])
    // Exactly one set of provider resources was created.
    expect(h.fake.serviceAccounts).toHaveLength(1)
    expect(h.fake.tokens.size).toBe(3)
  })

  it('disconnect during a held lease is refused, then succeeds after release', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const until = new Date(Date.now() + 600_000)
    expect(
      await h.bindings.markProviderMutationStarted(DEFAULT_ORG_ID, h.binding.id, PROJECT, 'live', until, new Date())
    ).toBe(true)
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      removed: false,
      reason: 'provisioning_in_progress'
    })
    await h.bindings.endProviderMutation(DEFAULT_ORG_ID, h.binding.id, PROJECT, 'live')
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({ removed: true })
  })

  it('an unrecorded marked token (crash after create) is revoked before re-minting (§10.2)', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    const before = (await h.credentials.get(account.id, 'read'))!
    // Simulate the crash: the provider token exists but our record is gone.
    await prisma.gitlabProjectCredential.delete({ where: { id: before.id } })
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(h.fake.tokens.get(Number(before.externalTokenId))!.revoked).toBe(true)
    const after = (await h.credentials.get(account.id, 'read'))!
    expect(after.externalTokenId).not.toBe(before.externalTokenId)
    expect(h.fake.tokens.get(Number(after.externalTokenId))!.revoked).toBe(false)
  })

  it('reuses the account its own row already records, never duplicating it', async () => {
    const h = await harness()
    await seedLegacyAccount(h, usernameOf(AGENT), 'stale-label')
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(h.fake.serviceAccounts).toHaveLength(1)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(account.serviceAccountUserId).toBe(7000n)
    expect(h.fake.serviceAccounts[0]).toMatchObject({ id: 7000, name: 'review-agent' })
  })
})

describe('GitlabAccountService account naming (§7.2)', () => {
  it('names the account after the agent, twelve hex of its id, and the root in base 36', async () => {
    const h = await harness({}, null, [{ id: AGENT, name: 'GitLab Pilot' }])
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(account.username).toBe(`gitlab-pilot-${AGENT.replace(/-/g, '').slice(0, 12)}-${ROOT_GROUP.toString(36)}`)
    expect(h.fake.serviceAccounts).toEqual([
      { id: Number(account.serviceAccountUserId), username: account.username, name: 'GitLab-Pilot' }
    ])
  })

  it('renames an account whose username predates the readable scheme, and records it', async () => {
    const h = await harness()
    await seedLegacyAccount(h, legacyUsername())

    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(h.fake.serviceAccounts).toEqual([{ id: 7000, username: usernameOf(AGENT), name: 'review-agent' }])
    expect(await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP)).toMatchObject({
      serviceAccountUserId: 7000n,
      username: usernameOf(AGENT)
    })
  })

  it('leaves the username alone once it carries the scheme, agent renames included', async () => {
    const h = await harness()
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    await prisma.agent.update({ where: { id: AGENT }, data: { displayName: 'Release Robot' } })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    // The display name follows the rename; the username is creation-time (§7.2).
    expect(h.fake.serviceAccounts[0]).toMatchObject({ username: usernameOf(AGENT), name: 'Release-Robot' })
    expect(h.fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1)
  })

  it('a refused username convergence is cosmetic and never degrades credentials', async () => {
    const h = await harness({ refuseServiceAccountUsernameChange: true })
    const legacy = legacyUsername()
    await seedLegacyAccount(h, legacy)

    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(h.fake.serviceAccounts[0]).toMatchObject({ id: 7000, username: legacy })
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(account).toMatchObject({ username: legacy, state: 'ready' })
    expect(await h.credentials.listForAccount(account.id)).toHaveLength(3)
  })
})

describe('GitlabAccountService create recovery (§7.2)', () => {
  it('recovers an ambiguous create through the window recorded before it', async () => {
    const h = await harness({ ambiguousServiceAccountCreate: true })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(h.fake.serviceAccounts).toHaveLength(1)
    expect(await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP)).toMatchObject({
      serviceAccountUserId: BigInt(h.fake.serviceAccounts[0]!.id),
      createAttempt: null,
      state: 'ready'
    })
  })

  it('recovers the account a crash left behind, from the window recorded before the create', async () => {
    const h = await harness()
    // Exactly what a process that died between GitLab creating the account and
    // the row committing its numeric id leaves behind.
    const crashed = await seedAccountRow(h, usernameOf(AGENT))
    expect(crashed.serviceAccountUserId).toBeNull()
    await h.accounts.openCreateAttempt({
      accountId: crashed.id,
      attemptId: 'attempt-1',
      openedAt: new Date(),
      knownServiceAccountUserIds: []
    })
    h.fake.serviceAccounts = [{ id: 7000, username: usernameOf(AGENT), name: 'review-agent' }]

    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP)).toMatchObject({
      serviceAccountUserId: 7000n,
      createAttempt: null,
      state: 'ready'
    })
    // Recovered, not duplicated: no second account burns a slot in the root.
    expect(h.fake.serviceAccounts).toHaveLength(1)
  })

  it('commits the resolved id and closes the window before anything cosmetic', async () => {
    const h = await harness()
    // The crash state again, but under a username the scheme will want to
    // converge — so the run resolves, commits, and only then PATCHes.
    const legacy = legacyUsername()
    const crashed = await seedAccountRow(h, legacy)
    await h.accounts.openCreateAttempt({
      accountId: crashed.id,
      attemptId: 'attempt-1',
      openedAt: new Date(),
      knownServiceAccountUserIds: []
    })
    h.fake.serviceAccounts = [{ id: 7000, username: legacy, name: 'review-agent' }]
    // A process that exits at this instant must still own its account, so the
    // row has to carry the durable id and no window ALREADY.
    let atPatch: Awaited<ReturnType<typeof h.accounts.byAgentRoot>> = null
    h.fake.opts.onServiceAccountPatch = async () => {
      atPatch = await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP)
    }

    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(atPatch).toMatchObject({ serviceAccountUserId: 7000n, createAttempt: null })
    expect(await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP)).toMatchObject({
      serviceAccountUserId: 7000n,
      username: usernameOf(AGENT),
      createAttempt: null
    })
  })

  it('refuses a username a pre-existing account holds, and adopts nothing', async () => {
    const h = await harness()
    h.fake.serviceAccounts = [{ id: 7000, username: usernameOf(AGENT), name: 'somebody-else' }]
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'username_taken'
    })
    const [account] = await h.accounts.listForAgent(DEFAULT_ORG_ID, AGENT)
    expect(account).toMatchObject({ serviceAccountUserId: null, stateReason: 'username_taken' })
    // The foreign account is untouched and was issued nothing.
    expect(h.fake.serviceAccounts).toEqual([{ id: 7000, username: usernameOf(AGENT), name: 'somebody-else' }])
    expect(h.fake.tokens.size).toBe(0)
    expect(await h.accounts.membershipsForBinding(h.binding.id)).toHaveLength(0)
    expect(gitlabAccountUnavailableMessage('username_taken')).toContain('already holds the bot username')
  })

  it('will not claim through a window that already knew the account', async () => {
    const h = await harness()
    const row = await seedAccountRow(h, usernameOf(AGENT))
    await h.accounts.openCreateAttempt({
      accountId: row.id,
      attemptId: 'attempt-1',
      openedAt: new Date(),
      // The account was already there when the window opened, so it is not ours.
      knownServiceAccountUserIds: [7000n]
    })
    h.fake.serviceAccounts = [{ id: 7000, username: usernameOf(AGENT), name: 'somebody-else' }]

    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'username_taken'
    })
    expect(await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP)).toMatchObject({
      serviceAccountUserId: null
    })
  })

  it('resolves only through this root’s own service-account listing, never a user search', async () => {
    const h = await harness()
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const lookups = h.fake.requests.filter((r) => r.method === 'GET' && r.url.includes('/service_accounts'))
    expect(lookups.length).toBeGreaterThan(0)
    for (const lookup of lookups) expect(lookup.url).toContain(`/api/v4/groups/${ROOT_GROUP}/service_accounts`)
    expect(h.fake.requests.some((r) => /\/api\/v4\/users(\?|\/|$)/.test(r.url))).toBe(false)
  })
})

describe('GitlabAccountService listing pagination (§7.2)', () => {
  /** A root already holding this many other service accounts — Premium puts no
   *  bound on the quantity (§5), so a first page is not the whole set. */
  const others = (count: number, from = 6000) =>
    Array.from({ length: count }, (_, i) => ({ id: from + i, username: `other-${from + i}`, name: `other ${i}` }))

  const accountListings = (h: Awaited<ReturnType<typeof harness>>) =>
    h.fake.requests.filter((r) => r.method === 'GET' && /\/service_accounts\?/.test(r.url))

  /** A peer takes the account the way it legitimately can: the run's lease has
   *  expired, so the CAS lets the next worker claim it. */
  const stealLease = async (h: Awaited<ReturnType<typeof harness>>) => {
    const row = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    const later = new Date(Date.now() + 600_000)
    expect(await h.accounts.claimLease(row.id, 'peer', later, later)).toBe(true)
  }

  it('claims the account an ambiguous create landed past the first page', async () => {
    const h = await harness({ ambiguousServiceAccountCreate: true })
    h.fake.serviceAccounts = others(120)

    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const created = h.fake.serviceAccounts.find((a) => a.username === usernameOf(AGENT))!
    // It landed at index 120, so only an exhausted listing ever sees it.
    expect(h.fake.serviceAccounts.indexOf(created)).toBeGreaterThan(99)
    expect(await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP)).toMatchObject({
      serviceAccountUserId: BigInt(created.id),
      createAttempt: null,
      state: 'ready'
    })
    // One account, not a second one created because the first looked absent.
    expect(h.fake.serviceAccounts.filter((a) => a.username === usernameOf(AGENT))).toHaveLength(1)
    expect(accountListings(h).some((r) => r.url.includes('page=2'))).toBe(true)
  })

  it('re-proves the account fence after the read, so a peer that took it mid-listing wins', async () => {
    const h = await harness()
    h.fake.serviceAccounts = others(120)
    // A peer claims the account the moment our exhaustive read reaches page 2 —
    // the shape a lease that expires under a slow multi-page listing produces.
    h.fake.opts.onListPage = async (resource, page) => {
      if (resource !== 'service_accounts' || page !== 2) return
      await stealLease(h)
    }

    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'account_lease_lost'
    })
    // Nothing the stale listing decided was written at the provider.
    expect(h.fake.serviceAccounts).toHaveLength(120)
    expect(h.fake.tokens.size).toBe(0)
    expect(await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP)).toMatchObject({
      serviceAccountUserId: null,
      createAttempt: null
    })
  })

  it('sees a foreign account holding the username on a later page, and refuses it', async () => {
    const h = await harness()
    const foreign = { id: 7000, username: usernameOf(AGENT), name: 'somebody-else' }
    h.fake.serviceAccounts = [...others(100), foreign]

    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'username_taken'
    })
    const [account] = await h.accounts.listForAgent(DEFAULT_ORG_ID, AGENT)
    expect(account).toMatchObject({ serviceAccountUserId: null, stateReason: 'username_taken' })
    // Nothing was created behind its back, and the foreign account is untouched.
    expect(h.fake.serviceAccounts).toHaveLength(101)
    expect(h.fake.serviceAccounts.at(-1)).toEqual(foreign)
    expect(h.fake.tokens.size).toBe(0)
  })

  it('re-proves the fence after the token listing, so a stolen lease revokes nothing', async () => {
    const h = await harness()
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    const read = (await h.credentials.get(account.id, 'read'))!
    // The crash shape again: the PAT is live at the provider, our record is gone,
    // so the next mint would sweep it as a stray.
    await prisma.gitlabProjectCredential.delete({ where: { id: read.id } })
    h.fake.opts.onListPage = async (resource) => {
      if (resource !== 'personal_access_tokens') return
      await stealLease(h)
    }

    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'account_lease_lost'
    })
    // The revokes the stale listing decided never reached the provider.
    expect(h.fake.tokens.get(Number(read.externalTokenId))!.revoked).toBe(false)
  })

  it('sweeps a stray PAT that a long revocation history pushed past the first page', async () => {
    const h = await harness()
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    const userId = Number(account.serviceAccountUserId)
    // Re-lay the account's tokens behind a hundred revoked ones, so the live
    // PATs answer on page 2 — what years of rotation leave on a real account.
    const live = [...h.fake.tokens.entries()]
    h.fake.tokens.clear()
    for (let i = 0; i < 100; i++) {
      const stale = {
        name: `spent-${i}`,
        scopes: ['read_api'],
        expires_at: '2027-01-01',
        revoked: true,
        user_id: userId
      }
      h.fake.tokens.set(9000 + i, stale)
    }
    for (const [id, grant] of live) h.fake.tokens.set(id, grant)
    // The crash shape: the provider token exists but our record of it is gone,
    // so the next mint must find it as a stray and revoke it before re-minting.
    const read = (await h.credentials.get(account.id, 'read'))!
    await prisma.gitlabProjectCredential.delete({ where: { id: read.id } })

    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const listings = h.fake.requests.filter((r) => r.method === 'GET' && /personal_access_tokens\?/.test(r.url))
    expect(listings.some((r) => r.url.includes('page=2'))).toBe(true)
    // A first-page-only read would have left this token live with no plaintext.
    expect(h.fake.tokens.get(Number(read.externalTokenId))!.revoked).toBe(true)
  })
})

describe('GitlabAccountService avatar sync (§7.2)', () => {
  it('dresses the account in the agent icon on provisioning, through its OWN api token', async () => {
    const h = await harness()
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(h.avatarRenders).toEqual([AGENT])
    expect(h.fake.avatarUploads).toHaveLength(1)
    expect(h.fake.avatarUploads[0]!.bytes).toBe(AVATAR_PNG.byteLength)
    // §7.3: the account's own effect PAT wore it — never the installer's OAuth bearer.
    const effect = (await h.credentials.get(account.id, 'effect'))!
    expect(h.fake.avatarUploads[0]!.token).toBe(await h.credentialSecrets.get(DEFAULT_ORG_ID, effect.id))
    expect(account.avatarFingerprint).toBe('runtime:claude')

    // Converged, not re-sent: an unchanged icon uploads nothing.
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(h.fake.avatarUploads).toHaveLength(1)
  })

  it('re-uploads when the agent icon changes, and only then', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(h.fake.avatarUploads).toHaveLength(1)

    await prisma.agent.update({
      where: { id: AGENT },
      data: { icon: { kind: 'glyph', glyph: 'bot', color: '#123456' } }
    })
    await h.accountService.syncAgentAvatars(DEFAULT_ORG_ID, AGENT)
    expect(h.fake.avatarUploads).toHaveLength(2)
    expect(await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP)).toMatchObject({
      avatarFingerprint: 'glyph:bot:#123456'
    })

    await h.accountService.syncAgentAvatars(DEFAULT_ORG_ID, AGENT)
    expect(h.fake.avatarUploads).toHaveLength(2)
  })

  it('an avatar endpoint the provider does not offer is a cosmetic skip', async () => {
    const h = await harness({ avatarEndpointUnsupported: true })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(h.fake.avatarUploads).toHaveLength(0)
    // Nothing recorded, so a provider that later gains the endpoint converges.
    expect(account).toMatchObject({ state: 'ready', avatarFingerprint: null })
    expect(await h.credentials.listForAccount(account.id)).toHaveLength(3)
    expect(h.fake.members.get(Number(account.serviceAccountUserId))).toBe(30)
  })

  it('a refused avatar upload is cosmetic and never degrades credentials', async () => {
    const h = await harness({ refuseAvatarUpload: true })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(account).toMatchObject({ state: 'ready', stateReason: null, avatarFingerprint: null })
    expect(await h.credentials.listForAccount(account.id)).toHaveLength(3)
  })
})

describe('GitlabAccountService rotation (§7.4)', () => {
  it('rotates near-expiry credentials create-before-revoke; far ones untouched', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    const before = (await h.credentials.get(account.id, 'read'))!
    const sealedBefore = await h.credentialSecrets.get(DEFAULT_ORG_ID, before.id)
    await prisma.gitlabProjectCredential.update({
      where: { id: before.id },
      data: { providerExpiresAt: new Date(Date.now() + 3 * 86_400_000) }
    })
    await h.accountService.rotateDueCredentials(14 * 86_400_000)

    const after = (await h.credentials.get(account.id, 'read'))!
    expect(after.generation).toBe(before.generation + 1n)
    expect(after.externalTokenId).not.toBe(before.externalTokenId)
    expect(await h.credentialSecrets.get(DEFAULT_ORG_ID, after.id)).not.toBe(sealedBefore)
    // Create-before-revoke: the OLD provider token is revoked, the new one is not.
    expect(h.fake.tokens.get(Number(before.externalTokenId))!.revoked).toBe(true)
    expect(h.fake.tokens.get(Number(after.externalTokenId))!.revoked).toBe(false)
    expect((await h.credentials.get(account.id, 'effect'))!.generation).toBe(1n)
    // The account lease was released.
    expect(await h.accounts.claimLease(account.id, 'follow-up', new Date(Date.now() + 300_000), new Date())).toBe(true)
  })

  it('rotation without a working admin connection degrades and keeps the old credential', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    const before = (await h.credentials.get(account.id, 'read'))!
    await prisma.gitlabProjectCredential.update({
      where: { id: before.id },
      data: { providerExpiresAt: new Date(Date.now() + 3 * 86_400_000) }
    })
    // The admin connection loses its pair (e.g. revoked): rotation cannot run.
    await prisma.gitlabConnectionSecret.deleteMany({})
    await h.accountService.rotateDueCredentials(14 * 86_400_000)

    expect((await h.accounts.get(account.id))!.state).toBe('admin_degraded')
    // The existing credential is untouched — runtime continues until it expires.
    expect((await h.credentials.get(account.id, 'read'))!.externalTokenId).toBe(before.externalTokenId)
    expect(h.fake.tokens.get(Number(before.externalTokenId))!.revoked).toBe(false)
  })

  it('a successful rotation heals a rotation-owned degradation', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    const before = (await h.credentials.get(account.id, 'read'))!
    await prisma.gitlabProjectCredential.update({
      where: { id: before.id },
      data: { providerExpiresAt: new Date(Date.now() + 3 * 86_400_000) }
    })
    await h.accounts.update(account.id, { state: 'admin_degraded', stateReason: 'rotation_gitlab_503' })
    await h.accountService.rotateDueCredentials(14 * 86_400_000)
    expect(await h.accounts.get(account.id)).toMatchObject({ state: 'ready', stateReason: null })
  })

  it('a rotation the instance forbids is named as withdrawn authority and keeps serving (§24.3)', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    const before = (await h.credentials.get(account.id, 'read'))!
    await prisma.gitlabProjectCredential.update({
      where: { id: before.id },
      data: { providerExpiresAt: new Date(Date.now() + 3 * 86_400_000) }
    })
    // The instance takes the delegation away under a live account.
    h.fake.opts.adminOnly = true
    await h.accountService.rotateDueCredentials(14 * 86_400_000)

    expect(await h.accounts.get(account.id)).toMatchObject({
      state: 'service_account_creation_forbidden',
      stateReason: 'rotation_service_account_creation_forbidden'
    })
    // The horizon warning names the authority, not a bare upstream status: an
    // operator learns this from the warning rather than from a silent bot.
    expect(h.warnings.at(-1)).toMatchObject({
      obj: { reason: 'rotation_service_account_creation_forbidden' },
      msg: 'gitlab credential rotation failed'
    })
    // The existing credential is untouched and still serves to its own expiry.
    expect((await h.credentials.get(account.id, 'read'))!.externalTokenId).toBe(before.externalTokenId)
    expect(h.fake.tokens.get(Number(before.externalTokenId))!.revoked).toBe(false)

    h.fake.opts.adminOnly = false
    await h.accountService.rotateDueCredentials(14 * 86_400_000)
    expect(await h.accounts.get(account.id)).toMatchObject({ state: 'ready', stateReason: null })
  })

  it('re-derives the rotation horizon from a clamped expiry, not from the requested one (§24.3)', async () => {
    const h = await harness({ patLifetimeCapDays: 30 })
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    // The ordinary horizon does not reach a credential 30 days out.
    await h.accountService.rotateDueCredentials(14 * 86_400_000)
    expect((await h.credentials.get(account.id, 'read'))!.generation).toBe(1n)
    // A horizon inside the 30-day cap does — which it could not if the row still
    // carried the 90-day expiry that was ASKED for rather than the granted one.
    await h.accountService.rotateDueCredentials(35 * 86_400_000)
    expect((await h.credentials.get(account.id, 'read'))!.generation).toBe(2n)
  })

  it('a live foreign account lease defers rotation to the next sweep', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    const before = (await h.credentials.get(account.id, 'read'))!
    await prisma.gitlabProjectCredential.update({
      where: { id: before.id },
      data: { providerExpiresAt: new Date(Date.now() + 3 * 86_400_000) }
    })
    expect(await h.accounts.claimLease(account.id, 'foreign', new Date(Date.now() + 300_000), new Date())).toBe(true)
    await h.accountService.rotateDueCredentials(14 * 86_400_000)
    // Untouched and NOT degraded — the holder is presumed alive.
    expect((await h.credentials.get(account.id, 'read'))!.externalTokenId).toBe(before.externalTokenId)
    expect((await h.accounts.get(account.id))!.state).toBe('ready')
  })
})
