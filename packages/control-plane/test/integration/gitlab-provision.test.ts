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
import { gitlabAgentAccountUsername, type GitlabWebhookEvents } from '../../src/gitlab/api.js'
import { GitlabAccountService, gitlabAccountUnavailableMessage } from '../../src/gitlab/account.service.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import {
  PgGitlabAgentAccountRepo,
  PgGitlabConnectionRepo,
  PgGitlabConnectionSecretStore,
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
  const connections = new PgGitlabConnectionRepo(prisma)
  const bindings = new PgGitlabProjectBindingRepo(prisma)
  const accounts = new PgGitlabAgentAccountRepo(prisma)
  const credentials = new PgGitlabProjectCredentialRepo(prisma)
  const credentialSecrets = new PgGitlabProjectCredentialSecretStore(prisma, cipher)
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
  const accountService = new GitlabAccountService({
    oauth,
    accounts,
    credentials,
    credentialSecrets,
    agents: new PgAgentRepo(prisma),
    cipher,
    clock: systemClock,
    avatarPng: async (agent) => {
      avatarRenders.push(agent.id)
      return AVATAR_PNG
    },
    fetchImpl: fake.fetch()
  })
  const provisioner = new GitlabProvisioner({
    oauth,
    bindings,
    accounts: accountService,
    webhookSecrets: new PgGitlabWebhookSecretStore(prisma, cipher),
    catalog: new PgCodeHostRepositoryRepo(prisma),
    clock: systemClock,
    publicRelayUrl: 'https://relay.example.test',
    desiredWebhookEvents: async () => webhookEvents,
    fetchImpl: fake.fetch()
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
    bindings,
    accounts,
    credentials,
    credentialSecrets,
    oauth,
    accountService,
    provisioner,
    binding,
    connection
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
    administeringConnectionId: h.connection.id
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
      reason: 'service_account_create_forbidden'
    })
    h.fake.opts.refuseServiceAccountCreate = false
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
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
      installerConnectionId: h.connection.id
    })
    await prisma.agent.update({ where: { id: AGENT }, data: { workspaceRepoId: SECOND_PROJECT } })

    // The project being left owns the account fence first: the new project's
    // run must lose, wait, and come back rather than leave the agent unbound.
    expect(await h.accounts.claimLease(account.id, 'old-project-run', new Date(Date.now() + 300_000), new Date())).toBe(
      true
    )
    const converging = h.provisioner.convergeProject(DEFAULT_ORG_ID, SECOND_PROJECT)
    await vi.waitFor(
      async () => expect((await h.bindings.get(DEFAULT_ORG_ID, second.id))!.stateReason).toBe('account_busy'),
      { timeout: 20_000 }
    )
    await h.accounts.releaseLease(account.id, 'old-project-run')

    await converging
    expect((await h.bindings.get(DEFAULT_ORG_ID, second.id))!.state).toBe('ready')
    expect((await h.accounts.membershipsForBinding(second.id)).map((m) => m.accountId)).toEqual([account.id])
  })

  it('reactivating a generation drops the credentials the interrupted retirement left', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    const before = (await h.credentials.get(account.id, 'read'))!
    await h.accounts.detachMembership(account.id, h.binding.id)
    expect(await h.accounts.beginRetirement(account.id)).toBe(true)

    // Those PATs belong to the identity the retirement was tearing down: keeping
    // them would let the fresh generation read `ready` holding dead tokens.
    expect(await h.accounts.reactivate(account.id)).not.toBeNull()
    expect(await h.credentials.listForAccount(account.id)).toHaveLength(0)
    expect(await prisma.gitlabProjectCredentialSecret.count({ where: { credentialId: before.id } })).toBe(0)

    // The next converge re-provisions the identity from scratch.
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    const fresh = (await h.credentials.get(account.id, 'read'))!
    expect(fresh.externalTokenId).not.toBe(before.externalTokenId)
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

    // The loser waits out the retirement and re-provisions a fresh generation.
    const revived = (await h.accounts.reactivate(account.id))!
    expect(revived.generation).toBe(account.generation + 1n)
    expect(revived.lifecycle).toBe('active')
    expect(
      await h.accounts.attachMembership({
        accountId: account.id,
        generation: revived.generation,
        bindingId: h.binding.id,
        accessLevel: 30
      })
    ).toBe(true)
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
