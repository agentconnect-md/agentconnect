// Azure DevOps service hooks on the Control Plane (azure-devops-integration.md §11): the trigger write and its grant gate, subscriptions and their read-back, the rotation barrier, the compiled rule, the membership arm, and the reply lease.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AZURE_DEVOPS_HOOKS_V1_FEATURE, GITEA_V1_FEATURE, RcHookAssign } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { trackedTestClock } from '../fakes/tracked-clock.js'
import {
  CLIENT_ID,
  FakeAzureDevOps,
  IDENTITY_ID,
  INSTANCE_ID,
  ORGANIZATION,
  PROJECT_ID,
  REPOSITORY_ID,
  TENANT_ID
} from '../fakes/azure-devops-api.js'
import {
  AzureDevOpsConnectionService,
  azureDevOpsSecretFingerprint
} from '../../src/azure-devops/connection.service.js'
import { AzureDevOpsBindingService } from '../../src/azure-devops/binding.service.js'
import { AzureDevOpsGitcredService } from '../../src/azure-devops/gitcred.service.js'
import { AzureDevOpsHookService, PREVIOUS_KEY_TTL_MS } from '../../src/azure-devops/hook.service.js'
import { AzureDevOpsMembershipAuthzService } from '../../src/azure-devops/membership-authz.service.js'
import { AzureDevOpsTokenCache } from '../../src/azure-devops/token-cache.js'
import {
  PgAzureDevOpsConnectionRepo,
  PgAzureDevOpsConnectionSecretStore,
  PgAzureDevOpsHookRepo,
  PgAzureDevOpsRepositoryBindingRepo
} from '../../src/persistence/repositories/azure-devops.repo.js'
import { PgHookRepo } from '../../src/persistence/repositories/hook.repo.js'
import { PgAgentRepoAuthorizationRepo } from '../../src/persistence/repositories/agent-repo-auth.repo.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { OrgId } from '../../src/domain/ids.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const RELAY_URL = 'https://relay.example.test'
const HOOK_URL = `${RELAY_URL}/webhooks/azure-devops`
const GIT_REPO = 'https://dev.azure.com/example-org/Example%20Project/_git/Example%20Repo'
const ACTOR_ID = '00000000-0000-4000-8000-0000000000a7'
const ACTOR = 'Microsoft.IdentityModel.Claims.ClaimsIdentity;tenant\\person@example.test'
const CONTRIBUTORS = 'Microsoft.TeamFoundation.Identity;S-1-9-1551374245-1'
const clock = trackedTestClock()
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

/** A stand-in relay socket that records what the CP broadcast to it. */
function channel(features: string[]) {
  const sent: Array<{ type: string; payload: unknown }> = []
  const ch = {
    relayId: `r-${randomUUID().slice(0, 8)}`,
    features,
    send: (type: string, payload: unknown) => void sent.push({ type, payload }),
    request: async () => ({}),
    close() {}
  } as unknown as RelayChannel
  const assigned = () =>
    sent.filter((frame) => frame.type === 'rc/hook-assign').map((frame) => RcHookAssign.parse(frame.payload))
  return { ch, sent, assigned }
}

async function harness() {
  const fake = new FakeAzureDevOps()
  const connectionRepo = new PgAzureDevOpsConnectionRepo(prisma)
  const bindings = new PgAzureDevOpsRepositoryBindingRepo(prisma)
  const hookRepo = new PgAzureDevOpsHookRepo(prisma, cipher)
  const hookDefs = new PgHookRepo(prisma)
  const service = new AzureDevOpsConnectionService({
    connections: connectionRepo,
    secrets: new PgAzureDevOpsConnectionSecretStore(prisma, cipher),
    bindings,
    cipher,
    clock,
    api: fake.api,
    tokens: new AzureDevOpsTokenCache(() => clock.now()),
    secretFingerprint: azureDevOpsSecretFingerprint('example-pepper-example-pepper-example-pepper')
  })
  const hooks = new AzureDevOpsHookService({
    connections: connectionRepo,
    bindings,
    hooks: hookRepo,
    service,
    api: fake.api,
    clock,
    publicRelayUrl: RELAY_URL,
    listHooks: (orgId) => hookDefs.listForOrgKind(OrgId(orgId), 'azure-devops'),
    onChanged: async (orgId, repoId) => {
      for (const row of await hookDefs.listForOrgKind(OrgId(orgId), 'azure-devops')) {
        if (row.repoId === repoId) await running!.deps.hooks.broadcast(row)
      }
    }
  })
  running = buildHttpApp(prisma, { PUBLIC_RELAY_URL: RELAY_URL }, undefined, undefined, {
    azureDevOps: {
      connections: service,
      userAuthz: fake.userAuthz(service),
      bindings: new AzureDevOpsBindingService({ connections: connectionRepo, bindings, service, api: fake.api }),
      hooks
    }
  })
  const a = running
  await prisma.relay.create({
    data: {
      id: randomUUID(),
      name: `relay-${randomUUID().slice(0, 8)}`,
      daemonUrl: 'wss://relay-0',
      lastSeenAt: new Date()
    }
  })
  const connected = await a.app.inject({
    method: 'POST',
    url: `${ORG}/azure-devops/connections`,
    payload: { organization: ORGANIZATION, tenantId: TENANT_ID, clientId: CLIENT_ID, clientSecret: 'example-secret' }
  })
  expect(connected.statusCode).toBe(200)
  // The agent's workspace is the repository, which binds it and authorizes its triggers.
  const agentRes = await a.app.inject({
    method: 'POST',
    url: `${ORG}/agents`,
    payload: {
      name: `ado-${randomUUID().slice(0, 8)}`,
      runtime: 'claude',
      workspace: { mode: 'git', gitRepo: GIT_REPO }
    }
  })
  expect(agentRes.statusCode).toBe(201)
  const agentId = agentRes.json().id as string
  const daemonId = randomUUID()
  await seedDaemon(prisma, daemonId)
  await prisma.agent.update({ where: { id: agentId }, data: { daemonId } })
  const [binding] = await bindings.listForOrg(DEFAULT_ORG_ID)
  const repoId = binding!.repoId
  const capable = channel([AZURE_DEVOPS_HOOKS_V1_FEATURE])
  const legacy = channel([GITEA_V1_FEATURE])
  a.relayReg.add(capable.ch)
  a.relayReg.add(legacy.ch)
  const createHook = (over: Record<string, unknown> = {}) =>
    a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: {
        agentId,
        kind: 'azure-devops',
        name: 'ado-trigger',
        repoId: repoId.toString(),
        family: 'merge_request',
        events: ['merge_request:opened', 'merge_request:synchronize'],
        commentFamilies: ['merge_request'],
        ...over
      }
    })
  /** The route converges fire-and-forget; this joins the run in flight. */
  const settle = () => hooks.convergeRepository(DEFAULT_ORG_ID, repoId)
  const keys = () => hookRepo.keys(DEFAULT_ORG_ID, binding!.id)
  const recorded = () => hookRepo.subscriptions(binding!.id)
  const freshBinding = async () => (await bindings.get(DEFAULT_ORG_ID, binding!.id))!
  return {
    a,
    fake,
    hooks,
    hookRepo,
    bindings,
    service,
    connectionRepo,
    agentId,
    binding: binding!,
    repoId,
    capable,
    legacy,
    createHook,
    settle,
    keys,
    recorded,
    freshBinding
  }
}

type Harness = Awaited<ReturnType<typeof harness>>

/** One PUT per subscription id, counted off the fake's request log. */
const puts = (h: Harness) =>
  h.fake.requests
    .filter((r) => r.method === 'PUT' && r.url.includes('/_apis/hooks/subscriptions/'))
    .map((r) => new URL(r.url).pathname.split('/').pop()!)

async function hooked(h: Harness, over: Record<string, unknown> = {}) {
  h.fake.serviceHookGrants.add(PROJECT_ID)
  const res = await h.createHook(over)
  expect(res.statusCode).toBe(200)
  await h.settle()
  return res.json() as { id: string }
}

describe('the trigger write (§11.1, §11.9)', () => {
  it('refuses an enabled trigger on a project without Allow triggers, and saves a disabled one without subscribing', async () => {
    const h = await harness()
    const refused = await h.createHook()
    expect(refused.statusCode).toBe(409)
    expect(refused.json().message).toContain('allow triggers on this project in Manage project access')
    const disabled = await h.createHook({ enabled: false })
    expect(disabled.statusCode).toBe(200)
    await h.settle()
    expect(h.fake.subscriptions.size).toBe(0)
    expect(await h.keys()).toBeNull()
  })

  it('accepts every review policy and a status report, refuses a run note, and an issues family outright', async () => {
    const h = await harness()
    h.fake.serviceHookGrants.add(PROJECT_ID)
    const check = await h.createHook({ reportingMode: 'check' })
    expect(check.statusCode).toBe(409)
    expect(check.json().message).toContain('report a status')
    const created = await h.createHook({ reviewPolicy: 'full', reportingMode: 'status' })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({ reviewPolicy: 'full', reportingMode: 'status' })
    expect((await h.createHook({ family: 'issues', events: ['issues:opened'], commentFamilies: [] })).statusCode).toBe(
      400
    )
  })
})

describe('subscriptions and the compiled rule (§11.2, §11.3)', () => {
  it('creates one subscription per kind with the relay address and the key as the Basic password, and compiles a rule naming every one for hooks-v1 relays only', async () => {
    const h = await harness()
    const hook = await hooked(h)
    // opened, revision and comment for the trigger; state for cleanup, never "merge attempted".
    expect([...h.fake.subscriptions.values()].map((sub) => sub.eventType).sort()).toEqual([
      'git.pullrequest.created',
      'git.pullrequest.updated',
      'git.pullrequest.updated',
      'ms.vss-code.git-pullrequest-comment-event'
    ])
    const keys = (await h.keys())!
    for (const sub of h.fake.subscriptions.values()) {
      expect(sub.publisherInputs).toMatchObject({ projectId: PROJECT_ID, repository: REPOSITORY_ID })
      expect(sub.consumerInputs).toMatchObject({
        url: HOOK_URL,
        basicAuthUsername: 'agentconnect',
        basicAuthPassword: keys.current,
        messagesToSend: 'none',
        detailedMessagesToSend: 'none'
      })
    }
    expect(keys.current).toMatch(/^[0-9a-f]{64}$/)
    expect(
      h.fake.subscriptionsOf('git.pullrequest.updated', 'PushNotification')[0]!.consumerInputs.resourceDetailsToSend
    ).toBe('minimal')
    expect(h.fake.subscriptionsOf('git.pullrequest.created')[0]!.consumerInputs).not.toHaveProperty(
      'resourceDetailsToSend'
    )
    expect((await h.freshBinding()).hookReason).toBe('webhook_unverified')

    const rule = h.capable
      .assigned()
      .filter((r) => r.hookId === hook.id)
      .at(-1)!
    expect(rule.kind).toBe('azure-devops')
    expect(rule.routing).toBeUndefined()
    expect(rule.azureDevOps).toMatchObject({
      repoId: h.repoId.toString(),
      sessionKeyPrefix: `azure-devops:${h.repoId}`,
      organization: ORGANIZATION,
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      instanceId: INSTANCE_ID,
      identityId: IDENTITY_ID,
      events: ['merge_request:opened', 'merge_request:synchronize'],
      commentFamilies: ['pull_request'],
      mentionOnly: false,
      signingKey: keys.current
    })
    expect(new Set(rule.azureDevOps!.subscriptions.map((s) => s.subscriptionId))).toEqual(
      new Set(h.fake.subscriptions.keys())
    )
    expect(h.legacy.assigned().some((r) => r.kind === 'azure-devops')).toBe(false)
    // A relay without the endpoint is told to drop any copy it holds.
    expect(
      h.legacy.sent.some((f) => f.type === 'rc/hook-remove' && (f.payload as { hookId: string }).hookId === hook.id)
    ).toBe(true)
  })

  it('reads back: rewrites drift whole with the real key, recreates a deleted one, re-enables a disabled or probation one, and follows the union down to nothing', async () => {
    const h = await harness()
    const hook = await hooked(h)
    const keys = (await h.keys())!
    const [opened] = h.fake.subscriptionsOf('git.pullrequest.created')
    const [comment] = h.fake.subscriptionsOf('ms.vss-code.git-pullrequest-comment-event')
    const [state] = h.fake.subscriptionsOf('git.pullrequest.updated', 'StatusUpdateNotification')
    opened!.consumerInputs.url = 'https://elsewhere.example.test/hook'
    opened!.consumerInputs.httpHeaders = 'X-Example: 1'
    const [revision] = h.fake.subscriptionsOf('git.pullrequest.updated', 'PushNotification')
    comment!.status = 'disabledBySystem'
    revision!.status = 'onProbation'
    h.fake.subscriptions.delete(state!.id)
    await h.hooks.convergeRepository(DEFAULT_ORG_ID, h.repoId)
    const rewritten = h.fake.subscriptions.get(opened!.id)!
    expect(rewritten.consumerInputs).toEqual({
      url: HOOK_URL,
      basicAuthUsername: 'agentconnect',
      basicAuthPassword: keys.current,
      messagesToSend: 'none',
      detailedMessagesToSend: 'none'
    })
    expect(h.fake.subscriptions.get(comment!.id)!.status).toBe('enabled')
    expect(h.fake.subscriptions.get(revision!.id)!.status).toBe('enabled')
    expect(h.fake.subscriptionsOf('git.pullrequest.updated', 'StatusUpdateNotification')).toHaveLength(1)
    expect(h.fake.subscriptions.size).toBe(4)
    // A masked password is never sent back.
    for (const req of h.fake.requests.filter((r) => r.method === 'PUT')) expect(req.body).not.toContain('********')

    // Down to pushes only: what no trigger needs is deleted.
    const updated = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/hooks/${hook.id}`,
      payload: {
        agentId: h.agentId,
        kind: 'azure-devops',
        name: 'ado-trigger',
        repoId: h.repoId.toString(),
        events: ['merge_request:reopened'],
        commentFamilies: []
      }
    })
    expect(updated.statusCode).toBe(200)
    await h.settle()
    expect((await h.recorded()).map((r) => r.kind).sort()).toEqual(['state'])
    expect(h.fake.subscriptions.size).toBe(1)

    // The last trigger going away takes every subscription and the keys; the binding stays.
    expect((await h.a.app.inject({ method: 'DELETE', url: `${ORG}/hooks/${hook.id}` })).statusCode).toBe(204)
    await h.settle()
    expect(h.fake.subscriptions.size).toBe(0)
    expect(await h.recorded()).toHaveLength(0)
    expect(await h.keys()).toBeNull()
    expect(await h.freshBinding()).toMatchObject({ state: 'ready', hookReason: null })
  })

  it('marks a lost grant as triggers_not_allowed and re-enables nothing until it returns', async () => {
    const h = await harness()
    await hooked(h)
    for (const sub of h.fake.subscriptions.values()) sub.status = 'disabledByInactiveIdentity'
    h.fake.serviceHookGrants.delete(PROJECT_ID)
    await h.hooks.convergeRepository(DEFAULT_ORG_ID, h.repoId)
    expect((await h.freshBinding()).hookReason).toBe('triggers_not_allowed')
    expect([...h.fake.subscriptions.values()].every((sub) => sub.status === 'disabledByInactiveIdentity')).toBe(true)
    expect(puts(h)).toHaveLength(0)
    h.fake.serviceHookGrants.add(PROJECT_ID)
    await h.hooks.convergeRepository(DEFAULT_ORG_ID, h.repoId)
    expect([...h.fake.subscriptions.values()].every((sub) => sub.status === 'enabled')).toBe(true)
    expect((await h.freshBinding()).hookReason).toBe('webhook_unverified')
    // A verified delivery clears the warning.
    await h.hooks.observeDelivery({ repoId: h.repoId, at: new Date(clock.now()) })
    expect(await h.freshBinding()).toMatchObject({ hookReason: null })
  })

  it('keeps an enabled hook with no subscriptions in the sweep, so a repaired configuration recovers', async () => {
    const h = await harness()
    await hooked(h)
    // The state a first pass leaves when the relay address is unset: no subscriptions, nothing owed.
    await prisma.azureDevOpsHookSubscription.deleteMany({ where: { bindingId: h.binding.id } })
    await prisma.azureDevOpsRepositoryBinding.update({
      where: { id: h.binding.id },
      data: { hookConvergeOwedAt: null, hookReason: 'relay_url_unconfigured' }
    })
    h.fake.subscriptions.clear()
    expect((await h.hookRepo.listHooked(100)).map((b) => b.id)).toContain(h.binding.id)
    await h.hooks.sweep()
    expect(await h.recorded()).toHaveLength(4)
    expect(h.fake.subscriptions.size).toBe(4)
  })

  it('deletes the subscriptions of a removed binding', async () => {
    const h = await harness()
    await hooked(h)
    expect(h.fake.subscriptions.size).toBe(4)
    // The workspace references the binding; once the agent is gone nothing does.
    await prisma.agent.delete({ where: { id: h.agentId } })
    const removed = await h.a.app.inject({ method: 'DELETE', url: `${ORG}/azure-devops/repositories/${h.binding.id}` })
    expect(removed.statusCode).toBe(204)
    expect(h.fake.subscriptions.size).toBe(0)
  })
})

describe('the rotation barrier (§11.2)', () => {
  it('promotes no key before every subscription switched, resumes without re-keying a switched one, and keeps the old key 36 hours', async () => {
    const h = await harness()
    const hook = await hooked(h)
    const before = (await h.keys())!
    const ids = [...h.fake.subscriptions.keys()]
    h.fake.failPutOnce.add(ids[2]!)
    const rotated = await h.hooks.rotate(DEFAULT_ORG_ID, h.binding.id)
    expect(rotated).toMatchObject({ rotated: true, total: 4 })
    expect(rotated.switched).toBeLessThan(4)
    const mid = (await h.keys())!
    expect(mid.current).toBe(before.current)
    expect(mid.next).toMatch(/^[0-9a-f]{64}$/)
    // Both keys reach the relays before any subscription is switched.
    const midRule = h.capable
      .assigned()
      .filter((r) => r.hookId === hook.id)
      .at(-1)!
    expect(midRule.azureDevOps).toMatchObject({ signingKey: before.current, nextSigningKey: mid.next })

    // A delivery under the next key before the barrier promotes nothing.
    await h.hooks.observeDelivery({ repoId: h.repoId, at: new Date(clock.now()), verifiedWith: 'next' })
    expect((await h.keys())!).toMatchObject({ current: before.current, next: mid.next, previous: null })

    // A subscription created mid-rotation takes the next key and counts as switched.
    const push = await h.createHook({ name: 'pushes', family: 'push', events: ['push:*'], commentFamilies: [] })
    expect(push.statusCode).toBe(200)
    await h.settle()
    const [pushSub] = h.fake.subscriptionsOf('git.push')
    expect(pushSub!.consumerInputs.basicAuthPassword).toBe(mid.next)

    // The convergence resumed the cut-short PUT, under the same next key, and switched nobody twice.
    const counts = new Map<string, number>()
    for (const id of puts(h)) counts.set(id, (counts.get(id) ?? 0) + 1)
    expect(counts.get(ids[2]!)).toBe(2)
    for (const id of ids.filter((id) => id !== ids[2])) expect(counts.get(id)).toBe(1)
    for (const sub of h.fake.subscriptions.values()) expect(sub.consumerInputs.basicAuthPassword).toBe(mid.next)

    // A delivery under the current key promotes nothing; one under the next key, past the barrier, does.
    await h.hooks.observeDelivery({ repoId: h.repoId, at: new Date(clock.now()), verifiedWith: 'current' })
    expect((await h.keys())!.next).toBe(mid.next)
    const at = clock.now()
    await h.hooks.observeDelivery({ repoId: h.repoId, at: new Date(at), verifiedWith: 'next' })
    const after = (await h.keys())!
    expect(after).toMatchObject({ current: mid.next, next: null, previous: before.current })
    expect(after.generation).toBe(before.generation + 1n)
    expect(Math.abs(after.previousExpiresAt!.getTime() - (at + PREVIOUS_KEY_TTL_MS))).toBeLessThan(60_000)
    const rule = h.capable
      .assigned()
      .filter((r) => r.hookId === hook.id)
      .at(-1)!
    expect(rule.azureDevOps).toMatchObject({ signingKey: mid.next, previousSigningKey: before.current })
    expect(rule.azureDevOps!.nextSigningKey).toBeUndefined()
    expect(rule.azureDevOps!.subscriptions).toHaveLength(5)
  })

  it('answers the rotation route with the switched count', async () => {
    const h = await harness()
    await hooked(h)
    const res = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/azure-devops/repositories/${h.binding.id}/rotate-hook-key`,
      payload: {}
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ rotated: true, switched: 4, total: 4, reason: null })
  })
})

describe('the membership arm (§11.4)', () => {
  async function gate(h: Harness, hookId: string) {
    const authz = new AzureDevOpsMembershipAuthzService({
      hooks: new PgHookRepo(prisma),
      bindings: h.bindings,
      connections: h.connectionRepo,
      service: h.service,
      api: h.fake.api,
      clock
    })
    const row = (await prisma.hookDef.findUnique({ where: { id: hookId } }))!
    const req = {
      hookId,
      provider: 'azure-devops',
      repoExternalId: h.repoId.toString(),
      actorIdentityId: ACTOR_ID,
      configRevision: row.configRevision.toString(),
      dispatchRevision: row.dispatchRevision.toString()
    }
    return { authz, req }
  }

  it('admits a member of a group the project allows through an inheriting repository, keyed on the identity id', async () => {
    const h = await harness()
    const hook = await hooked(h)
    h.fake.identities.set(ACTOR_ID, { descriptor: ACTOR, memberOf: [CONTRIBUTORS] })
    h.fake.acls.set(`repoV2/${PROJECT_ID}/${REPOSITORY_ID}`, { inheritPermissions: true, aces: {} })
    h.fake.acls.set(`repoV2/${PROJECT_ID}`, {
      inheritPermissions: true,
      aces: { [CONTRIBUTORS]: { allow: 4, deny: 0 } }
    })
    const { authz, req } = await gate(h, hook.id)
    expect(await authz.allowed(req)).toBe(true)
    // The other actor form, a stale fence, and the connection's own identity are refused.
    expect(await authz.allowed({ ...req, actorIdentityId: undefined, actorExternalId: '42' } as never)).toBe(false)
    expect(await authz.allowed({ ...req, configRevision: '999' })).toBe(false)
    expect(await authz.allowed({ ...req, actorIdentityId: IDENTITY_ID })).toBe(false)
    expect(await authz.allowed({ ...req, actorIdentityId: '00000000-0000-4000-8000-0000000000a8' })).toBe(false)
  })

  it('reads past an organization-wide list the connection may not read', async () => {
    const h = await harness()
    const hook = await hooked(h)
    h.fake.identities.set(ACTOR_ID, { descriptor: ACTOR, memberOf: [CONTRIBUTORS] })
    h.fake.acls.set(`repoV2/${PROJECT_ID}/${REPOSITORY_ID}`, { inheritPermissions: true, aces: {} })
    h.fake.acls.set(`repoV2/${PROJECT_ID}`, {
      inheritPermissions: true,
      aces: { [CONTRIBUTORS]: { allow: 4, deny: 0 } }
    })
    h.fake.aclForbidden.add('repoV2')
    const { authz, req } = await gate(h, hook.id)
    expect(await authz.allowed(req)).toBe(true)
  })

  it('fails closed when the repository or project list is refused', async () => {
    const h = await harness()
    const hook = await hooked(h)
    h.fake.identities.set(ACTOR_ID, { descriptor: ACTOR, memberOf: [CONTRIBUTORS] })
    h.fake.acls.set(`repoV2/${PROJECT_ID}`, {
      inheritPermissions: true,
      aces: { [CONTRIBUTORS]: { allow: 4, deny: 0 } }
    })
    h.fake.aclForbidden.add(`repoV2/${PROJECT_ID}/${REPOSITORY_ID}`)
    const { authz, req } = await gate(h, hook.id)
    expect(await authz.allowed(req)).toBe(false)
  })

  it('takes no ancestor allow beyond a repository that does not inherit', async () => {
    const h = await harness()
    const hook = await hooked(h)
    h.fake.identities.set(ACTOR_ID, { descriptor: ACTOR, memberOf: [CONTRIBUTORS] })
    h.fake.acls.set(`repoV2/${PROJECT_ID}/${REPOSITORY_ID}`, { inheritPermissions: false, aces: {} })
    h.fake.acls.set(`repoV2/${PROJECT_ID}`, {
      inheritPermissions: true,
      aces: { [CONTRIBUTORS]: { allow: 4, deny: 0 } }
    })
    h.fake.acls.set('repoV2', { aces: { [CONTRIBUTORS]: { allow: 4, deny: 0 } } })
    const { authz, req } = await gate(h, hook.id)
    expect(await authz.allowed(req)).toBe(false)
    // Nothing beyond the boundary was even read.
    expect(
      h.fake.requests.some(
        (r) => r.url.includes('accesscontrollists') && r.url.includes(`token=repoV2%2F${PROJECT_ID}&`)
      )
    ).toBe(false)
  })

  it('refuses a deny on the repository whatever the project allows', async () => {
    const h = await harness()
    const hook = await hooked(h)
    h.fake.identities.set(ACTOR_ID, { descriptor: ACTOR, memberOf: [CONTRIBUTORS] })
    h.fake.acls.set(`repoV2/${PROJECT_ID}/${REPOSITORY_ID}`, {
      inheritPermissions: true,
      aces: { [ACTOR]: { allow: 0, deny: 4 } }
    })
    h.fake.acls.set(`repoV2/${PROJECT_ID}`, {
      inheritPermissions: true,
      aces: { [CONTRIBUTORS]: { allow: 4, deny: 0 } }
    })
    const { authz, req } = await gate(h, hook.id)
    expect(await authz.allowed(req)).toBe(false)
  })
})

describe('the reply lease (§11.5)', () => {
  it('serves the connection token at comment on the hooked binding', async () => {
    const h = await harness()
    await hooked(h)
    const gitcred = new AzureDevOpsGitcredService({
      agents: h.a.deps.repos.agent,
      authz: h.fake.userAuthz(h.service),
      connections: h.connectionRepo,
      bindings: h.bindings,
      repoAuths: new PgAgentRepoAuthorizationRepo(prisma),
      service: h.service,
      api: h.fake.api,
      clock
    })
    const grant = await gitcred.grantForHookReply(DEFAULT_ORG_ID, h.repoId)
    expect(grant).toMatchObject({
      access: 'comment',
      provider: 'azure-devops',
      externalRepoId: h.repoId.toString(),
      username: IDENTITY_ID
    })
  })
})
