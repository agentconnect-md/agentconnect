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
    await h.bindings.beginCleanup(DEFAULT_ORG_ID, h.binding.id, PROJECT)
    const outcome = await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(outcome).toEqual({ state: 'admin_degraded', reason: 'claim_fence_lost' })
    // Nothing was created against the provider.
    expect(h.fake.serviceAccounts).toHaveLength(0)
    expect(h.fake.tokens.size).toBe(0)
  })

  it('the reservation is mutually exclusive with cleanup, in both orders', async () => {
    const h = await harness()
    // Reservation held: cleanup must wait — no check-to-write window exists.
    expect(await h.bindings.markProviderMutationStarted(DEFAULT_ORG_ID, h.binding.id, PROJECT)).toBe(true)
    expect(await h.bindings.beginCleanup(DEFAULT_ORG_ID, h.binding.id, PROJECT)).toBe(false)
    expect(await h.bindings.claimFenceHeld(DEFAULT_ORG_ID, h.binding.id, PROJECT)).toBe(true)
    // Released: cleanup wins, and a late marker/fence check refuses.
    await h.bindings.endProviderMutation(DEFAULT_ORG_ID, h.binding.id, PROJECT)
    expect(await h.bindings.beginCleanup(DEFAULT_ORG_ID, h.binding.id, PROJECT)).toBe(true)
    expect(await h.bindings.claimFenceHeld(DEFAULT_ORG_ID, h.binding.id, PROJECT)).toBe(false)
    expect(await h.bindings.markProviderMutationStarted(DEFAULT_ORG_ID, h.binding.id, PROJECT)).toBe(false)
  })

  it('disconnect during a held reservation is refused, then succeeds after release', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(await h.bindings.markProviderMutationStarted(DEFAULT_ORG_ID, h.binding.id, PROJECT)).toBe(true)
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      removed: false,
      reason: 'provisioning_in_progress'
    })
    await h.bindings.endProviderMutation(DEFAULT_ORG_ID, h.binding.id, PROJECT)
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
