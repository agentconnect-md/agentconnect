/**
 * Provisioning saga + external cleanup (gitlab-com-integration.md §10.2, §7.3,
 * §11.1, §19.4) against real Postgres and the stateful fake gitlab.com edge:
 * service-account convergence, purpose-separated PATs with policy validation,
 * the managed webhook, and claim-preserving disconnect.
 */
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { FakeGitlab, type FakeGitlabOptions } from '../fakes/gitlab-api.js'
import { GitlabOauthService } from '../../src/gitlab/oauth.service.js'
import { GitlabProvisioner, gitlabServiceAccountUsernameForTests } from '../../src/gitlab/provisioner.js'
import {
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
import type { GitlabWebhookEvents } from '../../src/gitlab/api.js'

const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)
const PROJECT = 4455667n
const EVENTS: GitlabWebhookEvents = {
  push_events: true,
  issues_events: true,
  merge_requests_events: true,
  note_events: false
}

async function harness(options: FakeGitlabOptions = {}, webhookEvents: GitlabWebhookEvents | null = null) {
  const fake = new FakeGitlab(options)
  const connections = new PgGitlabConnectionRepo(prisma)
  const bindings = new PgGitlabProjectBindingRepo(prisma)
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
  return { fake, bindings, provisioner, binding }
}

describe('GitlabProvisioner (§10.2)', () => {
  it('converges to ready: marked service account, Developer member, three sealed PATs', async () => {
    const h = await harness()
    const outcome = await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(outcome).toEqual({ state: 'ready' })

    const binding = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!
    expect(binding.state).toBe('ready')
    expect(binding.serviceAccountUsername).toBe(gitlabServiceAccountUsernameForTests(PROJECT))
    expect(binding.credentialEpoch).toBe(h.binding.credentialEpoch + 3n)
    // Developer, never higher (§7.2).
    expect(h.fake.members.get(Number(binding.serviceAccountUserId))).toBe(30)

    const creds = new PgGitlabProjectCredentialRepo(prisma)
    const store = new PgGitlabProjectCredentialSecretStore(prisma, cipher)
    const rows = await creds.listForBinding(h.binding.id)
    expect(rows.map((row) => row.purpose).sort()).toEqual(['effect', 'git_write', 'read'])
    for (const row of rows) {
      expect(await store.get(DEFAULT_ORG_ID, row.id)).toMatch(/^glpat-/)
      // §7.3: explicit finite expiry, ~90 days out.
      const days = (row.providerExpiresAt.getTime() - Date.now()) / 86_400_000
      expect(days).toBeGreaterThan(88)
      expect(days).toBeLessThan(91)
    }

    // Idempotent: a second run reuses everything and mints nothing new.
    const tokenCount = h.fake.tokens.size
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
    expect(h.fake.tokens.size).toBe(tokenCount)
  })

  it('reports the human prerequisite when service-account creation is forbidden, and repairs later', async () => {
    const h = await harness({ refuseServiceAccountCreate: true })
    const outcome = await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(outcome).toEqual({ state: 'admin_degraded', reason: 'service_account_create_forbidden' })
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.state).toBe('admin_degraded')

    h.fake.opts.refuseServiceAccountCreate = false
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
  })

  it('revokes an out-of-policy token and fails closed (§7.3)', async () => {
    const h = await harness({ patExpiryOverride: null })
    const outcome = await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(outcome).toEqual({ state: 'admin_degraded', reason: 'out_of_policy_token' })
    // The returned token was revoked by id, and nothing was sealed.
    expect([...h.fake.tokens.values()].every((token) => token.revoked)).toBe(true)
    expect(await prisma.gitlabProjectCredential.count({ where: { bindingId: h.binding.id } })).toBe(0)
  })

  it('refuses a personal namespace (§5)', async () => {
    const h = await harness({ namespaceKind: 'user' })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'personal_namespace_unsupported'
    })
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
    const sealed = await new PgGitlabWebhookSecretStore(prisma, cipher).get(DEFAULT_ORG_ID, h.binding.id)
    expect(sealed).toBe(hook.token)
  })

  it('disconnect retires webhook, tokens, and the service account, then releases the claim (§19.4)', async () => {
    const h = await harness({}, EVENTS)
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const outcome = await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)
    expect(outcome).toEqual({ removed: true })
    expect(await prisma.gitlabProjectBinding.count()).toBe(0)
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitlab' } })).toBe(0)
    expect(h.fake.webhooks.size).toBe(0)
    expect([...h.fake.tokens.values()].every((token) => token.revoked)).toBe(true)
    expect(h.fake.deletedServiceAccounts).toHaveLength(1)
  })

  it('provision loses to a concurrent cleanup: no provider write after the fence flips (§10.2)', async () => {
    const h = await harness()
    // Cleanup entered first: the fence is gone before provision's first write.
    await h.bindings.beginCleanup(DEFAULT_ORG_ID, h.binding.id, PROJECT, new Date())
    const outcome = await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(outcome).toEqual({ state: 'busy', reason: 'provisioning_or_cleanup_in_progress' })
    // Nothing was created against the provider.
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

  it('an expired lease is reclaimable by a new run and by cleanup (crash recovery)', async () => {
    const h = await harness()
    const now = new Date()
    const expired = new Date(Date.now() - 1_000)
    expect(
      await h.bindings.markProviderMutationStarted(DEFAULT_ORG_ID, h.binding.id, PROJECT, 'dead', expired, now)
    ).toBe(true)
    // The dead run's lease no longer blocks either successor.
    expect(
      await h.bindings.markProviderMutationStarted(
        DEFAULT_ORG_ID,
        h.binding.id,
        PROJECT,
        'next',
        new Date(Date.now() + 600_000),
        now
      )
    ).toBe(true)
    await h.bindings.endProviderMutation(DEFAULT_ORG_ID, h.binding.id, PROJECT, 'next')
    expect(
      await h.bindings.markProviderMutationStarted(DEFAULT_ORG_ID, h.binding.id, PROJECT, 'dead2', expired, now)
    ).toBe(true)
    expect(await h.bindings.beginCleanup(DEFAULT_ORG_ID, h.binding.id, PROJECT, now)).toBe(true)
  })

  it('two concurrent provisions: exactly one runs, the other observes busy', async () => {
    const h = await harness()
    const [a, b] = await Promise.all([
      h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id),
      h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    ])
    const states = [a.state, b.state].sort()
    expect(states).toEqual(['busy', 'ready'])
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
    const creds = new PgGitlabProjectCredentialRepo(prisma)
    const before = (await creds.get(h.binding.id, 'read'))!
    // Simulate the crash: the provider token exists but our record is gone.
    await prisma.gitlabProjectCredential.delete({ where: { id: before.id } })
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    // The stray was revoked; a fresh token took its place.
    expect(h.fake.tokens.get(Number(before.externalTokenId))!.revoked).toBe(true)
    const after = (await creds.get(h.binding.id, 'read'))!
    expect(after.externalTokenId).not.toBe(before.externalTokenId)
    expect(h.fake.tokens.get(Number(after.externalTokenId))!.revoked).toBe(false)
  })

  it('disconnect reconciles a marked service account even when no local id was recorded', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    // Simulate the crash: the account exists at GitLab, the local facts do not.
    await prisma.gitlabProjectCredential.deleteMany({})
    await prisma.gitlabProjectBinding.update({
      where: { id: h.binding.id },
      data: { serviceAccountUserId: null, serviceAccountUsername: null, webhookId: null }
    })
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({ removed: true })
    // The marker-found account was deleted before the claim released.
    expect(h.fake.deletedServiceAccounts).toHaveLength(1)
    expect(h.fake.serviceAccounts).toHaveLength(0)
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitlab' } })).toBe(0)
  })

  it('disconnect retires BOTH a stale recorded id and a crash-left marked replacement', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    // Recovery sequence: recorded account A was removed externally; a repair
    // created marker-matching replacement B and crashed before persisting it.
    const bindingRow = await prisma.gitlabProjectBinding.findUniqueOrThrow({ where: { id: h.binding.id } })
    const recordedId = Number(bindingRow.serviceAccountUserId)
    h.fake.serviceAccounts = h.fake.serviceAccounts.filter((account) => account.id !== recordedId)
    h.fake.serviceAccounts.push({ id: 99999, username: 'agentconnect-p4455667', name: 'AgentConnect (replacement)' })
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({ removed: true })
    // The union was reconciled: the marked replacement is gone too, and the
    // claim released only after the marker read came back absent.
    expect(h.fake.serviceAccounts).toHaveLength(0)
    expect(h.fake.deletedServiceAccounts).toContain(99999)
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitlab' } })).toBe(0)
  })

  it('incomplete cleanup keeps cleanup_pending and RETAINS the claim (§19.4)', async () => {
    const h = await harness({ failTokenRevoke: true })
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const outcome = await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)
    expect(outcome.removed).toBe(false)
    const binding = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!
    expect(binding.state).toBe('cleanup_pending')
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitlab' } })).toBe(1)
  })
})
