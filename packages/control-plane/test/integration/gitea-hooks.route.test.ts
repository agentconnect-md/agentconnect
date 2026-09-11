/**
 * gitea-kind hooks (gitea-integration.md §7, §8): the create/update/delete routes fenced on a
 * managed binding, the compiled rule with the bot veto set and the signing keys inline, its
 * feature-gated broadcast, the managed-webhook converge kick and its inverse, and the Gitea arm of
 * rc/codehost-membership-authz.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { GITEA_V1_FEATURE, GITLAB_COM_V1_FEATURE, type RcHookAssign } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { buildGiteaSeam, type GiteaSeam } from '../fakes/gitea-seam.js'
import { GiteaMembershipAuthzService } from '../../src/gitea/membership-authz.service.js'
import { PgHookRepo } from '../../src/persistence/repositories/hook.repo.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { trackedTestClock } from '../fakes/tracked-clock.js'
import { HookId, OrgId } from '../../src/domain/ids.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const REPO = 556677n
const RELAY_URL = 'https://relay.example.test'
// Real-time clock whose pending timers die with the test — see fakes/tracked-clock.ts.
const clock = trackedTestClock()
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)

let running: HttpApp | undefined
let seam: GiteaSeam | undefined
afterEach(async () => {
  // Own the routes' fire-and-forget convergence: a run outliving its test writes into the next one's swept database.
  await seam?.settled()
  await running?.close()
  running = undefined
  seam = undefined
})

async function harness() {
  const built = buildGiteaSeam(prisma, cipher, clock)
  seam = built
  running = buildHttpApp(prisma, { PUBLIC_RELAY_URL: RELAY_URL }, undefined, undefined, {
    gitea: { connections: built.connections, provisioner: built.provisioner, api: built.api }
  })
  built.broadcast.current = (hook) => running!.deps.hooks.broadcast(hook)
  // A live relay row so the ingress gate passes.
  await prisma.relay.create({
    data: {
      id: randomUUID(),
      name: `relay-${randomUUID().slice(0, 8)}`,
      daemonUrl: 'wss://relay-0',
      lastSeenAt: new Date()
    }
  })
  const connection = await built.connections.connect(DEFAULT_ORG_ID, built.fake.token)
  const binding = await built.bindings.createWithClaim({
    orgId: DEFAULT_ORG_ID,
    connectionId: connection.id,
    repoId: REPO,
    repoPath: 'example-org/example-repo',
    cloneUrl: 'https://gitea.com/example-org/example-repo.git',
    axisBaseUrl: built.fake.opts.baseUrl
  })
  expect(await built.provisioner.provision(DEFAULT_ORG_ID, binding.id)).toEqual({ state: 'ready', reason: null })
  const daemonId = randomUUID()
  await seedDaemon(prisma, daemonId)
  // The agent's workspace IS the repository, so the trigger's watch-repo gate passes (§5).
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId, giteaRepoId: REPO })
  // A second agent holding nothing on the repository.
  const strangerId = randomUUID()
  await seedAgent(prisma, strangerId, { daemonId })
  return { a: running, seam: built, fake: built.fake, connection, binding, agentId, strangerId, daemonId }
}

/** A stand-in relay socket that records what the CP broadcast to it. */
function channel(features?: string[]) {
  const sent: Array<{ type: string; payload: unknown }> = []
  const ch = {
    relayId: `r-${randomUUID().slice(0, 8)}`,
    ...(features ? { features } : {}),
    send: (type: string, payload: unknown) => {
      sent.push({ type, payload })
    },
    request: async () => ({ admitted: true, deliveryKey: 'x' }),
    close() {}
  } as unknown as RelayChannel
  return { ch, sent }
}

const body = (agentId: string, over: Record<string, unknown> = {}) => ({
  agentId,
  kind: 'gitea',
  name: 'gitea-hook',
  repoId: REPO.toString(),
  family: 'merge_request',
  events: ['merge_request:*'],
  commentFamilies: ['merge_request'],
  ...over
})

describe('gitea hooks — routes, compile, webhook converge (§7)', () => {
  it('compiles the rule for gitea-v1 relays only and installs the managed webhook with the union', async () => {
    const h = await harness()
    const capable = channel([GITEA_V1_FEATURE])
    const legacy = channel([GITLAB_COM_V1_FEATURE])
    h.a.relayReg.add(capable.ch)
    h.a.relayReg.add(legacy.ch)

    const res = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(h.agentId) })
    expect(res.statusCode).toBe(200)
    const dto = res.json() as {
      id: string
      kind: string
      repoId: string
      repoFullName: string
      commentFamilies: string[]
    }
    expect(dto).toMatchObject({ kind: 'gitea', repoId: REPO.toString(), repoFullName: 'example-org/example-repo' })
    await h.seam.settled()

    // The webhook now exists with the union the hook asked for, active, under the relay's endpoint.
    const hook = [...h.fake.hooks.values()][0]!
    expect(hook.active).toBe(true)
    expect(hook.url).toBe(`${RELAY_URL}/webhooks/gitea`)
    for (const event of [
      'pull_request',
      'pull_request_sync',
      'pull_request_review_request',
      'pull_request_comment',
      'pull_request_review',
      'issue_comment'
    ]) {
      expect(hook.events).toContain(event)
    }
    expect(hook.events).not.toContain('push')

    // Only the capable relay received the rule, and it carries the §7 members inline.
    const assigns = capable.sent.filter((m) => m.type === 'rc/hook-assign').map((m) => m.payload as RcHookAssign)
    expect(assigns.length).toBeGreaterThanOrEqual(1)
    const rule = assigns.at(-1)!
    expect(rule.kind).toBe('gitea')
    expect(rule.gitea).toMatchObject({
      repoId: REPO.toString(),
      repoPath: 'example-org/example-repo',
      sessionKeyPrefix: `gitea:${REPO}`,
      events: ['merge_request:*'],
      // The stored merge_request scope is the pull_request SUBJECT on the wire.
      commentFamilies: ['pull_request'],
      botUserId: '9042',
      botUsername: 'example-bot',
      host: 'https://gitea.com'
    })
    expect(rule.gitea!.signingKey).toBe(hook.secret)
    expect(rule.gitea!.nextSigningKey).toBeUndefined()
    expect(legacy.sent.filter((m) => m.type === 'rc/hook-assign')).toHaveLength(0)
    // The hook agent's spec now carries the host (§11).
    const agent = await h.a.deps.repos.agent.get(OrgId(DEFAULT_ORG_ID), h.agentId as never)
    expect((await h.a.deps.agentSpecs.assemble(agent!)).giteaHost).toBe('https://gitea.com')

    // Deleting the last hook removes the webhook again (§7's inverse).
    const removed = await h.a.app.inject({ method: 'DELETE', url: `${ORG}/hooks/${dto.id}` })
    expect(removed.statusCode).toBe(204)
    await h.seam.settled()
    expect(h.fake.hooks.size).toBe(0)
    expect(await prisma.giteaWebhookSecret.count()).toBe(0)
  })

  it('refuses a repository that is not a managed binding, an unauthorized agent, and GitLab-only run notes', async () => {
    const h = await harness()
    const unbound = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: body(h.agentId, { repoId: '999' })
    })
    expect(unbound.statusCode).toBe(409)
    expect((unbound.json() as { message: string }).message).toContain('not a managed Gitea binding')
    // §5: a hook never creates a grant, so the stranger is refused until the repository is authorized.
    const stranger = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(h.strangerId) })
    expect(stranger.statusCode).toBe(409)
    expect((stranger.json() as { message: string }).message).toContain('not authorized for this agent')
    const notes = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: body(h.agentId, { reportingMode: 'check' })
    })
    expect(notes.statusCode).toBe(409)
    expect((notes.json() as { message: string }).message).toContain('run notes')
    expect(h.fake.hooks.size).toBe(0)
  })

  it('updates keep the row on the binding and carry the family shape rules', async () => {
    const h = await harness()
    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(h.agentId) })
    const id = (created.json() as { id: string }).id
    const wrongFamily = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/hooks/${id}`,
      payload: { ...body(h.agentId, { events: ['issues:*'] }), family: undefined }
    })
    expect(wrongFamily.statusCode).toBe(400)
    const ok = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/hooks/${id}`,
      payload: { ...body(h.agentId, { events: ['merge_request:opened'], mentionOnly: true }), family: undefined }
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ events: ['merge_request:opened'], mentionOnly: true })
  })
})

describe('rc/codehost-membership-authz — the gitea arm (§8)', () => {
  async function authz(h: Awaited<ReturnType<typeof harness>>) {
    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(h.agentId) })
    expect(created.statusCode).toBe(200)
    await h.seam.settled()
    const hook = (await new PgHookRepo(prisma).get(
      OrgId(DEFAULT_ORG_ID),
      HookId((created.json() as { id: string }).id)
    ))!
    const service = new GiteaMembershipAuthzService({
      hooks: new PgHookRepo(prisma),
      bindings: h.seam.bindings,
      connections: h.seam.connectionRepo,
      tokens: h.seam.connections,
      api: h.fake.api
    })
    const request = (over: Record<string, unknown> = {}) => ({
      hookId: hook.id,
      provider: 'gitea',
      repoExternalId: REPO.toString(),
      actorExternalId: '515151',
      actorUsername: 'alice',
      configRevision: hook.configRevision.toString(),
      dispatchRevision: hook.dispatchRevision.toString(),
      ...over
    })
    return { service, request, hook }
  }

  it('admits write, admin and owner; refuses none, an unknown login, and a login whose id does not match', async () => {
    const h = await harness()
    const { service, request } = await authz(h)
    h.fake.requests.length = 0
    expect(await service.allowed(request())).toBe(true)
    // The login was re-resolved to its numeric id before the permission was read, with the bot token.
    const calls = h.fake.requests.map((r) => r.url.replace('https://gitea.com/api/v1', ''))
    expect(calls).toEqual(['/users/alice', '/repos/example-org/example-repo/collaborators/alice/permission'])
    expect(h.fake.requests.every((r) => r.token === h.fake.token)).toBe(true)
    for (const permission of ['admin', 'owner'] as const) {
      h.fake.permissions.alice = permission
      expect(await service.allowed(request())).toBe(true)
    }
    // `none` is a 200 answer meaning refuse; `read` is below the bar.
    for (const permission of ['none', 'read'] as const) {
      h.fake.permissions.alice = permission
      expect(await service.allowed(request())).toBe(false)
    }
    expect(await service.allowed(request({ actorExternalId: '606060', actorUsername: 'mallory' }))).toBe(false)
    expect(await service.allowed(request({ actorUsername: 'nobody' }))).toBe(false)
    // A renamed or reassigned login cannot borrow alice's permission (§8).
    h.fake.permissions.alice = 'write'
    expect(await service.allowed(request({ actorExternalId: '999999', actorUsername: 'alice' }))).toBe(false)
    expect(await service.allowed(request({ actorUsername: undefined }))).toBe(false)
  })

  it('refuses the bot itself, a foreign provider, a stale fence, and an admin_degraded binding — closed', async () => {
    const h = await harness()
    const { service, request } = await authz(h)
    expect(await service.allowed(request({ actorExternalId: '9042', actorUsername: 'example-bot' }))).toBe(false)
    expect(await service.allowed(request({ provider: 'gitlab' }))).toBe(false)
    expect(await service.allowed(request({ configRevision: '999' }))).toBe(false)
    // §4.4: the lookup needs the bot's admin, so a demoted bot's binding never authorizes.
    h.fake.repo(Number(REPO)).admin = false
    await h.seam.bindings.update(DEFAULT_ORG_ID, h.binding.id, { state: 'admin_degraded', stateReason: 'admin_lost' })
    h.fake.requests.length = 0
    expect(await service.allowed(request())).toBe(false)
    expect(h.fake.requests).toHaveLength(0)
  })

  it('a rejected token denies the delivery and flips the connection', async () => {
    const h = await harness()
    const { service, request } = await authz(h)
    h.fake.token = 'revoked'
    expect(await service.allowed(request())).toBe(false)
    expect((await h.seam.connectionRepo.get(DEFAULT_ORG_ID, h.connection.id))!.state).toBe('token_rejected')
    expect((await h.seam.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.state).toBe('runtime_degraded')
  })
})
