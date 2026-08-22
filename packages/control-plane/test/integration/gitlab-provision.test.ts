/**
 * Provisioning saga + external cleanup (gitlab-com-integration.md §10.2, §7.2,
 * §7.3, §11.1, §19.4) against real Postgres and the stateful fake gitlab.com
 * edge: per-agent service-account convergence, membership as authorization,
 * purpose-separated PATs with policy validation, the managed webhook, the
 * lifecycle-generation fence, retirement, and claim-preserving disconnect.
 */
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent } from '../fixtures/seed.js'
import { FakeGitlab, type FakeGitlabOptions } from '../fakes/gitlab-api.js'
import { GitlabOauthService } from '../../src/gitlab/oauth.service.js'
import { GitlabAccountService } from '../../src/gitlab/account.service.js'
import { GitlabProvisioner } from '../../src/gitlab/provisioner.js'
import { gitlabAgentAccountUsername, type GitlabWebhookEvents } from '../../src/gitlab/api.js'
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
function usernameOf(agentId: string): string {
  return gitlabAgentAccountUsername(agentId, ROOT_GROUP)
}

async function harness(
  options: FakeGitlabOptions = {},
  webhookEvents: GitlabWebhookEvents | null = null,
  agents: Array<{ id: string; name?: string; gitAccess?: 'read' | 'write' }> = [{ id: AGENT, name: 'review-agent' }]
) {
  const fake = new FakeGitlab(options)
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
  return { fake, bindings, accounts, credentials, credentialSecrets, oauth, accountService, provisioner, binding }
}

describe('GitlabProvisioner (§10.2) — per-agent identity', () => {
  it('converges to ready: one account per agent, member at the derived role, three sealed PATs', async () => {
    const h = await harness()
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.state).toBe('ready')

    const [account] = await h.accounts.listForBinding(h.binding.id)
    expect(account).toMatchObject({ agentId: AGENT, username: usernameOf(AGENT), state: 'ready', lifecycle: 'active' })
    // The username is machine and rename-stable; the display name is the agent's.
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
    expect(accounts.map((a) => a.username).sort()).toEqual([usernameOf(AGENT), usernameOf(SIBLING)].sort())
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

  it('an existing marked account is reused, never duplicated', async () => {
    const h = await harness()
    h.fake.serviceAccounts = [{ id: 7000, username: usernameOf(AGENT), name: 'stale-label' }]
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(h.fake.serviceAccounts).toHaveLength(1)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, AGENT, ROOT_GROUP))!
    expect(account.serviceAccountUserId).toBe(7000n)
    expect(h.fake.serviceAccounts[0]).toMatchObject({ id: 7000, name: 'review-agent' })
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
