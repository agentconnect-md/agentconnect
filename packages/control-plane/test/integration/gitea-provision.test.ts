/**
 * The Gitea provisioning saga (gitea-integration.md §6, §7, §4.3, §4.4) against real Postgres and
 * the stateful fake edge: the inactive-by-default webhook armed explicitly, the dropped-event
 * read-back, the blocked-allowlist test delivery, admin lost, token rejected, rotation with its
 * promotion, and claim-preserving cleanup.
 */
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { FakeGitea, type FakeGiteaOptions } from '../fakes/gitea-api.js'
import { GiteaConnectionService } from '../../src/gitea/connection.service.js'
import { GiteaProvisioner } from '../../src/gitea/provisioner.js'
import { GiteaRepositoryClaimConflict } from '../../src/persistence/errors.js'
import {
  PgGiteaConnectionRepo,
  PgGiteaConnectionSecretStore,
  PgGiteaRepositoryBindingRepo,
  PgGiteaWebhookSecretStore
} from '../../src/persistence/repositories/gitea.repo.js'
import { PgCodeHostRepositoryRepo } from '../../src/persistence/repositories/code-host-repository.repo.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { trackedTestClock } from '../fakes/tracked-clock.js'

// Real-time clock whose pending timers die with the test — see fakes/tracked-clock.ts.
const clock = trackedTestClock()
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)
const REPO = 556677n
const EVENTS = [
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_sync',
  'pull_request_review_request',
  'pull_request_comment',
  'pull_request_review'
]

async function harness(
  options: FakeGiteaOptions = {},
  webhookEvents: string[] | null = EVENTS,
  extra: { relayObserves?: boolean; testDeliveryWaitMs?: number } = {}
) {
  const rebroadcasts: bigint[] = []
  /** The relay's observation at the moment the fake fires a test delivery (§6 step 4); one at the rotation successor verifies under its key (§7). */
  const observe = async (hookId: number): Promise<void> => {
    const current = await bindings.byRepo(DEFAULT_ORG_ID, REPO)
    const verifiedWith =
      current?.nextWebhookId !== null && current?.nextWebhookId === BigInt(hookId) ? 'next' : 'current'
    await provisioner.observeDelivery({ repoId: REPO, at: new Date(clock.now()), verifiedWith })
  }
  const fake = new FakeGitea({ ...(extra.relayObserves ? { onTestDelivery: (id) => observe(id) } : {}), ...options })
  const connections = new PgGiteaConnectionRepo(prisma)
  const bindings = new PgGiteaRepositoryBindingRepo(prisma)
  const webhookSecrets = new PgGiteaWebhookSecretStore(prisma, cipher)
  const connectionService = new GiteaConnectionService({
    connections,
    secrets: new PgGiteaConnectionSecretStore(prisma, cipher),
    bindings,
    cipher,
    clock,
    api: fake.api
  })
  const provisioner = new GiteaProvisioner({
    connections,
    tokens: connectionService,
    bindings,
    webhookSecrets,
    catalog: new PgCodeHostRepositoryRepo(prisma),
    clock,
    publicRelayUrl: 'https://relay.example.test',
    desiredWebhookEvents: async () => webhookEvents,
    onConverged: async (_orgId, repoId) => {
      rebroadcasts.push(repoId)
    },
    api: fake.api,
    testDeliveryWaitMs: extra.testDeliveryWaitMs ?? 300
  })
  const connection = await connectionService.connect(DEFAULT_ORG_ID, fake.token)
  // The connect step's own probes (§4.1) are not what these suites inspect.
  fake.requests.length = 0
  const binding = await bindings.createWithClaim({
    orgId: DEFAULT_ORG_ID,
    connectionId: connection.id,
    repoId: REPO,
    repoPath: 'example-org/example-repo',
    axisBaseUrl: fake.opts.baseUrl
  })
  return {
    fake,
    connections,
    bindings,
    webhookSecrets,
    connectionService,
    provisioner,
    connection,
    binding,
    rebroadcasts
  }
}

describe('GiteaProvisioner (§6) — the managed webhook', () => {
  it('installs an ACTIVE json webhook with a fresh hex secret and the event union, then asks for a test delivery', async () => {
    const h = await harness({}, EVENTS, { relayObserves: true })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready', reason: null })
    const hookId = [...h.fake.hooks.keys()][0]!
    const hook = h.fake.hooks.get(hookId)!
    expect(hook).toMatchObject({
      url: 'https://relay.example.test/webhooks/gitea',
      content_type: 'json',
      // The API default is inactive (§7): the saga arms it explicitly.
      active: true
    })
    expect(hook.secret).toMatch(/^[0-9a-f]{64}$/)
    // The stored events are a SUPERSET of the union: the issues umbrella expanded (§16).
    for (const event of EVENTS) expect(hook.events).toContain(event)
    expect(hook.events).toContain('issue_label')
    const created = h.fake.requests.find((r) => r.method === 'POST' && r.url.endsWith('/hooks'))
    expect(created?.body).toMatchObject({ type: 'gitea', active: true, config: { content_type: 'json' } })
    expect(created?.body).not.toHaveProperty('branch_filter')
    // Rules went out BEFORE the test fired — the relay verifies only what it holds a key for.
    expect(h.rebroadcasts.length).toBeGreaterThanOrEqual(1)
    expect(h.fake.tests).toEqual([hookId])
    const row = await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)
    expect(row).toMatchObject({ state: 'ready', stateReason: null, webhookId: BigInt(hookId) })
    expect(row!.lastVerifiedDeliveryAt).not.toBeNull()
    expect(row!.desiredEventsHash).not.toBeNull()
    // The signing key the relay verifies with is the hook's secret, sealed beside the binding.
    expect(await h.webhookSecrets.get(DEFAULT_ORG_ID, h.binding.id)).toEqual({ current: hook.secret, next: null })
    // The catalog carries the provider's own clone URL.
    const catalog = await prisma.codeHostRepository.findFirstOrThrow({ where: { provider: 'gitea', externalId: REPO } })
    expect(catalog.cloneUrl).toBe('https://gitea.com/example-org/example-repo.git')
  })

  it('is ready with webhook_unverified when the relay never observes the test delivery (a blocked allowlist)', async () => {
    const h = await harness()
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'ready',
      reason: 'webhook_unverified'
    })
    const row = await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)
    expect(row).toMatchObject({ state: 'ready', stateReason: 'webhook_unverified', lastVerifiedDeliveryAt: null })
    expect(h.fake.tests).toHaveLength(1)
    // A later verified delivery clears exactly that warning.
    await h.provisioner.observeDelivery({ repoId: REPO, at: new Date(clock.now()) })
    expect(await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)).toMatchObject({ state: 'ready', stateReason: null })
    // A repair does not re-test an installed webhook.
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready', reason: null })
    expect(h.fake.tests).toHaveLength(1)
  })

  it('reads the stored events back by subset and degrades when the instance dropped a name', async () => {
    const h = await harness({ dropEvents: ['pull_request_review'] })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'webhook_events_unsupported'
    })
    const row = await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)
    expect(row!.webhookId).not.toBeNull()
    expect(row!.desiredEventsHash).toBeNull()
    expect(h.fake.tests).toHaveLength(0)
  })

  it('removes the managed webhook and its keys once no enabled hook wants ingress, and is ready without a warning', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(h.fake.hooks.size).toBe(1)
    const quiet = new GiteaProvisioner({
      connections: h.connections,
      tokens: h.connectionService,
      bindings: h.bindings,
      webhookSecrets: h.webhookSecrets,
      catalog: new PgCodeHostRepositoryRepo(prisma),
      clock,
      publicRelayUrl: 'https://relay.example.test',
      desiredWebhookEvents: async () => null,
      api: h.fake.api,
      testDeliveryWaitMs: 100
    })
    expect(await quiet.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready', reason: null })
    expect(h.fake.hooks.size).toBe(0)
    expect(await h.webhookSecrets.get(DEFAULT_ORG_ID, h.binding.id)).toBeNull()
    expect(await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)).toMatchObject({
      webhookId: null,
      desiredEventsHash: null
    })
  })

  it('retires a crash-left hook at the exact managed URL and replaces it with one whose key it sealed', async () => {
    const h = await harness({}, EVENTS)
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const strayId = [...h.fake.hooks.keys()][0]!
    // The create landed but the id was never recorded — and a secret can never be re-keyed in place.
    await h.bindings.update(DEFAULT_ORG_ID, h.binding.id, { webhookId: null, desiredEventsHash: null })
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(h.fake.hooks.size).toBe(1)
    const recorded = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.webhookId
    expect(recorded).not.toBe(BigInt(strayId))
    expect(h.fake.hooks.get(Number(recorded))!.secret).toBe(
      (await h.webhookSecrets.get(DEFAULT_ORG_ID, h.binding.id))!.current
    )
  })

  it('retires a hook at the managed URL that no column records, beside the recorded one', async () => {
    const h = await harness({}, EVENTS)
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const recorded = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.webhookId!
    // A create whose answer was lost: the hook exists at the provider under a key nothing records.
    h.fake.hooks.set(6100, { ...h.fake.hooks.get(Number(recorded))!, secret: 'lost' })
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect([...h.fake.hooks.keys()]).toEqual([Number(recorded)])
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.webhookId).toBe(recorded)
  })

  it('records the created webhook before its read-back, so a failed read-back leaves an id an unbind can delete', async () => {
    const h = await harness({}, EVENTS)
    let failed = false
    h.fake.opts.intercept = (method, route) => {
      if (failed || method !== 'GET' || !/\/hooks\/\d+$/.test(route)) return undefined
      failed = true
      return Response.json({ message: 'unavailable' }, { status: 503 })
    }
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'gitea_503'
    })
    const created = [...h.fake.hooks.keys()][0]!
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.webhookId).toBe(BigInt(created))
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({ removed: true })
    expect(h.fake.hooks.size).toBe(0)
  })

  it('reconciles with the events always sent and never a secret: the provider rebuilds subscriptions and ignores re-keys', async () => {
    const h = await harness({}, EVENTS)
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const hook = [...h.fake.hooks.values()][0]!
    const secret = hook.secret
    // A repair PATCHes the live webhook: the subscription survives, the secret is untouched.
    h.fake.requests.length = 0
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'ready',
      reason: 'webhook_unverified'
    })
    const patch = h.fake.requests.find((r) => r.method === 'PATCH')
    expect(patch?.body).toMatchObject({ events: expect.arrayContaining(EVENTS), active: true })
    expect(JSON.stringify(patch?.body)).not.toContain('secret')
    expect(hook.secret).toBe(secret)
    for (const event of EVENTS) expect(hook.events).toContain(event)
  })

  it('lists every page of the webhooks even though the listing carries no Link header', async () => {
    const h = await harness({ maxResponseItems: 2 }, EVENTS)
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const managed = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.webhookId!
    // Three unrelated hooks sort before ours on the listing, pushing the managed one onto the LAST page.
    for (let i = 0; i < 3; i++) {
      const stray = { ...h.fake.hooks.get(Number(managed))!, url: `https://elsewhere.example.test/${i}` }
      h.fake.hooks.set(6000 + i, stray)
    }
    h.fake.hooks = new Map([...h.fake.hooks.entries()].sort(([a], [b]) => a - b))
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    // Still ours, still one: the recorded id was found on page two rather than forgotten and re-created.
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.webhookId).toBe(managed)
    expect(
      [...h.fake.hooks.values()].filter((hook) => hook.url === 'https://relay.example.test/webhooks/gitea')
    ).toHaveLength(1)
  })
})

describe('GiteaProvisioner (§4.3, §4.4) — degraded states', () => {
  it('admin_lost: a bot demoted below admin keeps the facts converging but suspends every webhook write', async () => {
    const h = await harness()
    h.fake.repo(Number(REPO)).admin = false
    h.fake.repo(Number(REPO)).full_name = 'example-org/renamed-repo'
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'admin_lost'
    })
    // Repository facts still refreshed by numeric id; nothing was written to the webhook surface.
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.repoPath).toBe('example-org/renamed-repo')
    expect(h.fake.hooks.size).toBe(0)
    expect(h.fake.requests.some((r) => r.url.includes('/hooks'))).toBe(false)
  })

  it('token_rejected: a definite rejection degrades the connection and every servable binding', async () => {
    const h = await harness()
    const sibling = await h.bindings.createWithClaim({
      orgId: DEFAULT_ORG_ID,
      connectionId: h.connection.id,
      repoId: 556680n,
      repoPath: 'example-org/sibling',
      axisBaseUrl: 'https://gitea.com'
    })
    await h.bindings.update(DEFAULT_ORG_ID, sibling.id, { state: 'ready' })
    h.fake.token = 'revoked'
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'runtime_degraded',
      reason: 'token_rejected'
    })
    expect((await h.connections.get(DEFAULT_ORG_ID, h.connection.id))!.state).toBe('token_rejected')
    expect(await h.bindings.get(DEFAULT_ORG_ID, sibling.id)).toMatchObject({
      state: 'runtime_degraded',
      stateReason: 'token_rejected'
    })
    // Settled: no provider call until a replacement lands.
    h.fake.requests.length = 0
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'runtime_degraded',
      reason: 'token_rejected'
    })
    expect(h.fake.requests).toHaveLength(0)
  })

  it('instance_version_unsupported: a downgraded instance is recorded and refused before any write', async () => {
    const h = await harness()
    h.fake.version = '1.22.9'
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'admin_degraded',
      reason: 'instance_version_unsupported'
    })
    expect((await h.connections.get(DEFAULT_ORG_ID, h.connection.id))!.instanceVersion).toBe('1.22.9')
    expect(h.fake.hooks.size).toBe(0)
  })

  it('busy: a live foreign lease is observed, never overwritten, and the obligation is recorded', async () => {
    const h = await harness()
    const until = new Date(clock.now() + 60_000)
    expect(
      await h.bindings.markProviderMutationStarted(DEFAULT_ORG_ID, h.binding.id, REPO, 'peer', until, new Date())
    ).toBe(true)
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'busy',
      reason: 'provisioning_or_cleanup_in_progress'
    })
    const row = await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)
    expect(row!.state).toBe('provisioning')
    expect(row!.convergeOwedAt).not.toBeNull()
    expect(h.provisioner.hasPendingWork(DEFAULT_ORG_ID)).toBe(true)
  })

  it('the deployment-global claim admits one managing organization per repository', async () => {
    const h = await harness()
    const foreign = await prisma.org.create({ data: { name: 'Foreign', slug: 'foreign-gitea' } })
    await expect(
      h.bindings.createWithClaim({
        orgId: foreign.id,
        connectionId: h.connection.id,
        repoId: REPO,
        repoPath: 'example-org/example-repo',
        axisBaseUrl: 'https://gitea.com'
      })
    ).rejects.toBeInstanceOf(GiteaRepositoryClaimConflict)
  })
})

describe('GiteaProvisioner (§7) — signing-key rotation by successor webhook', () => {
  it('creates a successor under the new key, deactivates the old hook, and holds the overlap until a delivery verifies under the successor', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const oldId = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.webhookId!
    const before = (await h.webhookSecrets.get(DEFAULT_ORG_ID, h.binding.id))!
    h.rebroadcasts.length = 0
    h.fake.requests.length = 0
    h.fake.tests.length = 0
    // No relay observes the successor's test delivery: the overlap stands.
    expect(await h.provisioner.rotateWebhookSecret(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      rotated: true,
      promoted: false
    })
    const overlap = (await h.webhookSecrets.get(DEFAULT_ORG_ID, h.binding.id))!
    expect(overlap.current).toBe(before.current)
    expect(overlap.next).toMatch(/^[0-9a-f]{64}$/)
    const row = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!
    expect(row.webhookId).toBe(oldId)
    expect(row.nextWebhookId).not.toBeNull()
    const successorId = Number(row.nextWebhookId)
    // Two webhooks live: the successor active under the new key with the FULL subscription, the old one inactive.
    expect(h.fake.hooks.size).toBe(2)
    const successor = h.fake.hooks.get(successorId)!
    expect(successor).toMatchObject({ secret: overlap.next, active: true })
    for (const event of EVENTS) expect(successor.events).toContain(event)
    const old = h.fake.hooks.get(Number(oldId))!
    expect(old).toMatchObject({ secret: before.current, active: false })
    for (const event of EVENTS) expect(old.events).toContain(event)
    // Order: the relays learned both keys before the old hook was deactivated and the successor tested.
    expect(h.rebroadcasts).toEqual([REPO])
    const kinds = h.fake.requests
      .filter((r) => r.method !== 'GET')
      .map((r) => `${r.method} ${r.url.split('/hooks')[1] ?? ''}`)
    expect(kinds).toEqual(['POST ', `PATCH /${oldId}`, `POST /${successorId}/tests`])
    expect(h.fake.tests).toEqual([successorId])
    // Nothing was ever PATCHed with a secret.
    expect(
      h.fake.requests.every((r) => !JSON.stringify(r.body ?? {}).includes('"secret"') || r.method === 'POST')
    ).toBe(true)

    // A delivery under the current key promotes nothing; one under the successor retires the old hook.
    await h.provisioner.observeDelivery({ repoId: REPO, at: new Date(clock.now()), verifiedWith: 'current' })
    expect(await h.webhookSecrets.get(DEFAULT_ORG_ID, h.binding.id)).toEqual(overlap)
    expect(h.fake.hooks.size).toBe(2)
    await h.provisioner.observeDelivery({ repoId: REPO, at: new Date(clock.now()), verifiedWith: 'next' })
    expect(await h.webhookSecrets.get(DEFAULT_ORG_ID, h.binding.id)).toEqual({ current: overlap.next, next: null })
    expect(h.fake.hooks.size).toBe(1)
    expect(h.fake.hooks.get(successorId)).toBeDefined()
    expect(await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)).toMatchObject({
      webhookId: BigInt(successorId),
      nextWebhookId: null
    })
    expect(h.rebroadcasts).toEqual([REPO, REPO])
    // A later repair reconciles the promoted webhook and creates nothing.
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(h.fake.hooks.size).toBe(1)
  })

  it('promotes inside the rotation when the relay observes the successor test delivery', async () => {
    const h = await harness({}, EVENTS, { relayObserves: true })
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const oldId = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.webhookId!
    const before = (await h.webhookSecrets.get(DEFAULT_ORG_ID, h.binding.id))!
    expect(await h.provisioner.rotateWebhookSecret(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      rotated: true,
      promoted: true
    })
    const after = (await h.webhookSecrets.get(DEFAULT_ORG_ID, h.binding.id))!
    expect(after.next).toBeNull()
    expect(after.current).not.toBe(before.current)
    expect(h.fake.hooks.size).toBe(1)
    const promotedId = [...h.fake.hooks.keys()][0]!
    const promoted = h.fake.hooks.get(promotedId)!
    expect(promotedId).not.toBe(Number(oldId))
    expect(promoted).toMatchObject({ secret: after.current, active: true })
    expect(await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)).toMatchObject({
      webhookId: BigInt(promotedId),
      nextWebhookId: null
    })
  })

  it('a repair mid-overlap keeps the successor live and the old hook inactive; a vanished successor abandons the rotation', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    await h.provisioner.rotateWebhookSecret(DEFAULT_ORG_ID, h.binding.id)
    const row = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      state: 'ready',
      reason: 'webhook_unverified'
    })
    expect(h.fake.hooks.get(Number(row.nextWebhookId))!.active).toBe(true)
    expect(h.fake.hooks.get(Number(row.webhookId))!.active).toBe(false)
    // The successor is deleted at the provider: the old key stays current and the old hook comes back.
    h.fake.hooks.delete(Number(row.nextWebhookId))
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)).toMatchObject({
      webhookId: row.webhookId,
      nextWebhookId: null
    })
    expect((await h.webhookSecrets.get(DEFAULT_ORG_ID, h.binding.id))!.next).toBeNull()
    expect(h.fake.hooks.get(Number(row.webhookId))!.active).toBe(true)
  })

  it('records the successor before its read-back: a failed read-back is adopted by the retry, not duplicated', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const oldId = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.webhookId!
    // The successor's read-back answers 503 once, after its create landed.
    let failed = false
    h.fake.opts.intercept = (method, route) => {
      if (failed || method !== 'GET' || !/\/hooks\/\d+$/.test(route)) return undefined
      failed = true
      return Response.json({ message: 'unavailable' }, { status: 503 })
    }
    h.rebroadcasts.length = 0
    expect(await h.provisioner.rotateWebhookSecret(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      rotated: false,
      reason: 'gitea_503'
    })
    const row = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!
    expect(row.nextWebhookId).not.toBeNull()
    expect(h.fake.hooks.size).toBe(2)
    expect(h.fake.hooks.get(Number(row.nextWebhookId))!.secret).toBe(
      (await h.webhookSecrets.get(DEFAULT_ORG_ID, h.binding.id))!.next
    )
    // The step stopped before the relays learned the key or the old hook was deactivated.
    expect(h.rebroadcasts).toEqual([])
    expect(h.fake.hooks.get(Number(oldId))!.active).toBe(true)
    // The retry adopts the recorded successor instead of creating a third webhook, and finishes the step.
    expect(await h.provisioner.rotateWebhookSecret(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      rotated: true,
      promoted: false
    })
    expect(h.fake.hooks.size).toBe(2)
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.nextWebhookId).toBe(row.nextWebhookId)
    expect(h.rebroadcasts).toEqual([REPO])
    expect(h.fake.hooks.get(Number(oldId))!.active).toBe(false)
    expect(h.fake.hooks.get(Number(row.nextWebhookId))!.active).toBe(true)
  })

  it('unbinds right after a failed successor read-back and takes the recorded successor with it', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    let failed = false
    h.fake.opts.intercept = (method, route) => {
      if (failed || method !== 'GET' || !/\/hooks\/\d+$/.test(route)) return undefined
      failed = true
      return Response.json({ message: 'unavailable' }, { status: 503 })
    }
    expect(await h.provisioner.rotateWebhookSecret(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      rotated: false,
      reason: 'gitea_503'
    })
    expect(h.fake.hooks.size).toBe(2)
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({ removed: true })
    expect(h.fake.hooks.size).toBe(0)
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitea' } })).toBe(0)
  })

  it('refuses to replace a working webhook with a successor that lost subscriptions', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const before = (await h.webhookSecrets.get(DEFAULT_ORG_ID, h.binding.id))!
    h.fake.opts.dropEvents = ['pull_request_review']
    expect(await h.provisioner.rotateWebhookSecret(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      rotated: false,
      reason: 'webhook_events_unsupported'
    })
    expect(h.fake.hooks.size).toBe(1)
    expect(await h.webhookSecrets.get(DEFAULT_ORG_ID, h.binding.id)).toEqual(before)
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.nextWebhookId).toBeNull()
  })
})

describe('GiteaProvisioner (§6) — unbind', () => {
  it('parks the binding with its claim in ONE transaction before any provider call', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(await h.bindings.beginCleanup(DEFAULT_ORG_ID, h.binding.id, REPO, new Date(clock.now()))).toBe('parked')
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.state).toBe('cleanup_pending')
    const claim = await prisma.codeHostRepositoryClaim.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'gitea', externalId: REPO } }
    })
    expect(claim.state).toBe('cleanup_pending')
    // The same flip without an attached claim (an already-tombstoned one).
    await prisma.codeHostRepositoryClaim.update({ where: { id: claim.id }, data: { bindingRef: null } })
    await h.bindings.update(DEFAULT_ORG_ID, h.binding.id, { state: 'ready' })
    expect(await h.bindings.beginCleanup(DEFAULT_ORG_ID, h.binding.id, REPO, new Date(clock.now()))).toBe('parked')
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.state).toBe('cleanup_pending')
    // A live lease refuses, and the binding is left exactly as it was.
    await h.bindings.update(DEFAULT_ORG_ID, h.binding.id, { state: 'ready' })
    await prisma.codeHostRepositoryClaim.update({
      where: { id: claim.id },
      data: { bindingRef: h.binding.id, state: 'active' }
    })
    const until = new Date(clock.now() + 60_000)
    expect(
      await h.bindings.markProviderMutationStarted(DEFAULT_ORG_ID, h.binding.id, REPO, 'peer', until, new Date())
    ).toBe(true)
    expect(await h.bindings.beginCleanup(DEFAULT_ORG_ID, h.binding.id, REPO, new Date(clock.now()))).toBe('leased')
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.state).toBe('ready')
  })

  it('deletes the managed webhook by its recorded id and releases the claim with the local rows', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({ removed: true })
    expect(h.fake.hooks.size).toBe(0)
    expect(await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)).toBeNull()
    expect(await prisma.giteaWebhookSecret.count()).toBe(0)
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitea' } })).toBe(0)
  })

  it('sweeps a hook at the managed URL whose id was never recorded, beside the recorded ones', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    const recorded = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.webhookId!
    h.fake.hooks.set(6100, { ...h.fake.hooks.get(Number(recorded))!, secret: 'lost' })
    h.fake.hooks.set(6101, { ...h.fake.hooks.get(Number(recorded))!, url: 'https://elsewhere.example.test/hook' })
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({ removed: true })
    // Only the hooks at OUR URL went; a foreign one at the repository is not ours to delete.
    expect([...h.fake.hooks.keys()]).toEqual([6101])
  })

  it('completes an unbind whose repository is already gone at the provider', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    await h.provisioner.rotateWebhookSecret(DEFAULT_ORG_ID, h.binding.id)
    expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.nextWebhookId).not.toBeNull()
    // The repository was deleted at Gitea: the deletes by id AND the sweep's listing answer 404.
    h.fake.repositories.splice(0, h.fake.repositories.length)
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({ removed: true })
    expect(await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)).toBeNull()
    expect(await prisma.giteaWebhookSecret.count()).toBe(0)
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitea' } })).toBe(0)
  })

  it('parks in cleanup_pending and RETAINS the claim when the token is rejected, then finishes under a replacement', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    h.fake.token = 'revoked'
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({
      removed: false,
      reason: 'token_rejected'
    })
    // Rules and grants stopped when the claim flipped, not when the DELETE failed.
    expect(h.rebroadcasts.at(-1)).toBe(REPO)
    expect(await h.bindings.get(DEFAULT_ORG_ID, h.binding.id)).toMatchObject({
      state: 'cleanup_pending',
      stateReason: 'token_rejected'
    })
    const claim = await prisma.codeHostRepositoryClaim.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'gitea', externalId: REPO } }
    })
    expect(claim.state).toBe('cleanup_pending')
    expect(h.fake.hooks.size).toBe(1)
    // A replacement token lets the parked removal finish.
    h.fake.token = 'gitea-token-2'
    await h.connectionService.replaceToken(DEFAULT_ORG_ID, h.connection.id, 'gitea-token-2')
    expect(await h.provisioner.disconnect(DEFAULT_ORG_ID, h.binding.id)).toEqual({ removed: true })
    expect(h.fake.hooks.size).toBe(0)
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitea' } })).toBe(0)
  })

  it('an organization deletion cascades the binding but preserves a claim whose webhook still exists', async () => {
    const h = await harness()
    await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)
    await prisma.giteaRepositoryBinding.delete({ where: { id: h.binding.id } })
    const claim = await prisma.codeHostRepositoryClaim.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'gitea', externalId: REPO } }
    })
    expect(claim).toMatchObject({ state: 'cleanup_pending', bindingRef: null })
    expect(claim.tombstone).toMatchObject({ repoId: REPO.toString(), repoPath: 'example-org/example-repo' })
  })
})
