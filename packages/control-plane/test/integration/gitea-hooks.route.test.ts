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
import type { FakeGitea, FakeGiteaTeam } from '../fakes/gitea-api.js'
import {
  GiteaMembershipAuthzService,
  TEAM_LOOKUP_UNAVAILABLE_REASON
} from '../../src/gitea/membership-authz.service.js'
import { PgHookRepo } from '../../src/persistence/repositories/hook.repo.js'
import { PgCodeHostTrustedActorRepo } from '../../src/persistence/repositories/code-host-trusted-actor.repo.js'
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
    gitea: built.httpDeps
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

/** Every path the CP asked the fake for, base-relative, in order. */
const paths = (fake: FakeGitea) => fake.requests.map((r) => r.url.replace(`${fake.opts.baseUrl}/api/v1`, ''))

/** A General Access team as Gitea ≥ 1.24 stores it (go-gitea/gitea#34128): flat `read`, the grants only in the units. */
const codeWriters = (over: Partial<FakeGiteaTeam> = {}): FakeGiteaTeam => ({
  id: 31,
  name: 'developers',
  permission: 'read',
  units: { 'repo.code': 'write', 'repo.issues': 'write', 'repo.pulls': 'write', 'repo.wiki': 'read' },
  members: ['alice'],
  ...over
})

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

    const res = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: body(h.agentId, { labelFilter: ['needs-review'] })
    })
    expect(res.statusCode).toBe(200)
    const dto = res.json() as {
      id: string
      kind: string
      repoId: string
      repoFullName: string
      commentFamilies: string[]
      labelFilter: string[]
    }
    expect(dto).toMatchObject({
      kind: 'gitea',
      repoId: REPO.toString(),
      repoFullName: 'example-org/example-repo',
      labelFilter: ['needs-review']
    })
    await h.seam.settled()

    // The webhook now exists with the union the hook asked for, active, under the relay's endpoint.
    const hook = [...h.fake.hooks.values()][0]!
    expect(hook.active).toBe(true)
    expect(hook.url).toBe(`${RELAY_URL}/webhooks/gitea`)
    for (const event of [
      'pull_request',
      'pull_request_sync',
      'pull_request_label',
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
      labelFilter: ['needs-review'],
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

  it('refuses a repository the bot cannot see, an unauthorized agent, and GitLab-only run notes', async () => {
    const h = await harness()
    // Binding on first use (§6) reaches only what the bot administers: an unknown id is the bot's 404, answered as such.
    const unbound = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: body(h.agentId, { repoId: '999' })
    })
    expect(unbound.statusCode).toBe(400)
    expect((unbound.json() as { message: string }).message).toContain('not accessible through this connection')
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

  it('a PUT without labelFilter keeps the stored filter; an explicit empty array clears it', async () => {
    const h = await harness()
    const created = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: body(h.agentId, { labelFilter: ['bug', 'needs-review'] })
    })
    const id = (created.json() as { id: string }).id
    // A client predating the filter echoes the row without the key.
    const kept = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/hooks/${id}`,
      payload: { ...body(h.agentId), family: undefined }
    })
    expect(kept.statusCode).toBe(200)
    expect((kept.json() as { labelFilter: string[] }).labelFilter).toEqual(['bug', 'needs-review'])
    const cleared = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/hooks/${id}`,
      payload: { ...body(h.agentId, { labelFilter: [] }), family: undefined }
    })
    expect(cleared.statusCode).toBe(200)
    expect((cleared.json() as { labelFilter: string[] }).labelFilter).toEqual([])
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
    const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = []
    const service = new GiteaMembershipAuthzService({
      hooks: new PgHookRepo(prisma),
      bindings: h.seam.bindings,
      connections: h.seam.connectionRepo,
      tokens: h.seam.connections,
      trustedActors: new PgCodeHostTrustedActorRepo(prisma),
      api: h.fake.api,
      log: { warn: (obj, msg) => warnings.push({ obj: obj as Record<string, unknown>, msg }) }
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
    return { service, request, hook, warnings }
  }

  /** The team routes among the calls made — empty when the gate settled above the bar. */
  const teamPaths = (fake: FakeGitea) => paths(fake).filter((p) => p.startsWith('/teams/') || p.endsWith('/teams'))

  // "Trusted users" (webhook-triggers-and-github-events.md): the route resolves the login through the
  // connection token and stores the numeric id; the gate then admits that id below the write bar.
  it('lets a maintainer vouch for a below-bar user by login, matched by id, until the vouch is withdrawn', async () => {
    const h = await harness()
    const { service, request, hook } = await authz(h)
    h.fake.permissions.alice = 'read'
    // A qualifying team alice is not on: the teams refuse her, so only the vouch can admit.
    h.fake.teams.push(codeWriters({ members: ['mallory'] }))
    expect(await service.allowed(request())).toBe(false)

    const added = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks/${hook.id}/trusted-actors`,
      payload: { login: 'alice' }
    })
    expect(added.statusCode).toBe(201)
    expect(added.json()).toMatchObject({
      provider: 'gitea',
      repoId: REPO.toString(),
      actorId: '515151',
      login: 'alice'
    })
    const listed = await h.a.app.inject({ method: 'GET', url: `${ORG}/hooks/${hook.id}/trusted-actors` })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toHaveLength(1)

    // Below the bar, but vouched for — and the list is read before any team is, so none was.
    h.fake.requests.length = 0
    expect(await service.allowed(request())).toBe(true)
    expect(teamPaths(h.fake)).toEqual([])
    // A login whose id does not match is an identity failure the vouch never rescues.
    expect(await service.allowed(request({ actorExternalId: '606060', actorUsername: 'alice' }))).toBe(false)
    // A login the host does not know is refused at the door, not stored.
    const unknown = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks/${hook.id}/trusted-actors`,
      payload: { login: 'nobody' }
    })
    expect(unknown.statusCode).toBe(404)

    const removed = await h.a.app.inject({
      method: 'DELETE',
      url: `${ORG}/hooks/${hook.id}/trusted-actors/${(added.json() as { id: string }).id}`
    })
    expect(removed.statusCode).toBe(204)
    expect(await service.allowed(request())).toBe(false)
  })

  it('admits write, admin and owner; refuses none, an unknown login, and a login whose id does not match', async () => {
    const h = await harness()
    const { service, request } = await authz(h)
    // A qualifying team with nobody on it: never consulted above the bar, and admitting no one below it.
    h.fake.teams.push(codeWriters({ members: [] }))
    h.fake.requests.length = 0
    expect(await service.allowed(request())).toBe(true)
    // The login was re-resolved to its numeric id before the permission was read, with the bot token; no team call.
    expect(paths(h.fake)).toEqual(['/users/alice', '/repos/example-org/example-repo/collaborators/alice/permission'])
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

  // Gitea ≥ 1.24 stores a General Access team as flat `read` (go-gitea/gitea#34128), so the lookup alone refuses every member.
  it('admits a member of a team whose repo.code unit reaches write when the lookup reads back read', async () => {
    const h = await harness()
    const { service, request, warnings } = await authz(h)
    h.fake.permissions.alice = 'read'
    h.fake.teams.push(codeWriters())
    h.fake.requests.length = 0
    expect(await service.allowed(request())).toBe(true)
    // Identity first, the flat permission second, the teams only once it fell short; the team is read before its roster.
    expect(paths(h.fake)).toEqual([
      '/users/alice',
      '/repos/example-org/example-repo/collaborators/alice/permission',
      '/repos/example-org/example-repo/teams',
      '/teams/31',
      '/teams/31/members/alice'
    ])
    expect(h.fake.requests.every((r) => r.token === h.fake.token)).toBe(true)
    // The `synchronize` that follows an `opened` is the same question asked live again: nothing cached, the same verdict.
    h.fake.requests.length = 0
    expect(await service.allowed(request())).toBe(true)
    expect(paths(h.fake)).toHaveLength(5)
    expect(warnings).toEqual([])
  })

  it('refuses a team whose write stops at issues, and a non-member of a qualifying team', async () => {
    const h = await harness()
    const { service, request, warnings } = await authz(h)
    h.fake.permissions.alice = 'read'
    // Issue or pull write alone is not push permission: the bar stays where `write` puts it, so no team is even read.
    h.fake.teams.push(codeWriters({ units: { 'repo.code': 'read', 'repo.issues': 'write', 'repo.pulls': 'write' } }))
    h.fake.requests.length = 0
    expect(await service.allowed(request())).toBe(false)
    expect(teamPaths(h.fake)).toEqual(['/repos/example-org/example-repo/teams'])
    // A qualifying team alice is not on: a readable team's 404 is definitive, refused without a warning.
    h.fake.teams.push(codeWriters({ id: 32, name: 'maintainers', members: ['mallory'] }))
    h.fake.requests.length = 0
    expect(await service.allowed(request())).toBe(false)
    expect(teamPaths(h.fake)).toEqual(['/repos/example-org/example-repo/teams', '/teams/32', '/teams/32/members/alice'])
    expect(warnings).toEqual([])
    // Administrator Access is a flat mode above the bar whatever the units say.
    h.fake.teams.push(codeWriters({ id: 33, name: 'admins', permission: 'admin', units: {}, members: ['alice'] }))
    expect(await service.allowed(request())).toBe(true)
  })

  it('fails closed, logging team_lookup_unavailable, when the bot can read no qualifying team', async () => {
    const h = await harness()
    const { service, request, warnings } = await authz(h)
    h.fake.permissions.alice = 'read'
    h.fake.teams.push(codeWriters({ visibility: 'private' }))
    // An organization member outside the Owners team: a private team answers it 403 (§4.4).
    h.fake.botRole = 'org_member'
    h.fake.requests.length = 0
    expect(await service.allowed(request())).toBe(false)
    expect(teamPaths(h.fake)).toEqual(['/repos/example-org/example-repo/teams', '/teams/31'])
    expect(warnings).toEqual([
      expect.objectContaining({
        obj: expect.objectContaining({ reason: TEAM_LOOKUP_UNAVAILABLE_REASON, repoId: REPO.toString(), teams: 1 })
      })
    ])
    // A bot that is only a repository collaborator is outside the organization: the same route answers 404.
    h.fake.botRole = 'collaborator_only'
    expect(await service.allowed(request())).toBe(false)
    expect(warnings).toHaveLength(2)
    // A `limited` team is readable by any organization member (1.27+), so the member is admitted.
    h.fake.botRole = 'org_member'
    h.fake.teams[0]!.visibility = 'limited'
    expect(await service.allowed(request())).toBe(true)
    // One readable team refusing beside one unreadable is the user's refusal, not the bot's: no warning.
    h.fake.teams[0]!.visibility = 'private'
    h.fake.teams.push(codeWriters({ id: 32, name: 'maintainers', visibility: 'public', members: ['mallory'] }))
    expect(await service.allowed(request())).toBe(false)
    expect(warnings).toHaveLength(2)
  })

  it('refuses a roster answer whose id is not the delivered one', async () => {
    const h = await harness()
    const { service, request } = await authz(h)
    h.fake.permissions.alice = 'read'
    h.fake.teams.push(codeWriters())
    // A members route answering another account under alice's login: identity is checked on every hop.
    h.fake.opts.intercept = (method, route) =>
      method === 'GET' && route === '/teams/31/members/alice'
        ? Response.json({ id: 999999, login: 'alice' })
        : undefined
    expect(await service.allowed(request())).toBe(false)
    delete h.fake.opts.intercept
    expect(await service.allowed(request())).toBe(true)
  })

  it('reads the whole unpaged listing but only the qualifying team, and treats a personal repository as teamless', async () => {
    const h = await harness()
    const { service, request, warnings } = await authz(h)
    h.fake.permissions.alice = 'read'
    // Gitea answers every team in one body whatever `limit` says: the qualifying team is the 60th, past any page size.
    for (let index = 0; index < 59; index++) {
      h.fake.teams.push(codeWriters({ id: 100 + index, name: `readers-${index}`, units: { 'repo.code': 'read' } }))
    }
    h.fake.teams.push(codeWriters())
    h.fake.requests.length = 0
    expect(await service.allowed(request())).toBe(true)
    expect(teamPaths(h.fake)).toEqual(['/repos/example-org/example-repo/teams', '/teams/31', '/teams/31/members/alice'])
    // A user-owned repository has no teams: upstream answers 405, a plain refusal that warns of nothing.
    h.fake.opts.intercept = (method, route) =>
      method === 'GET' && route === '/repos/example-org/example-repo/teams'
        ? Response.json({ message: 'repo is not owned by an organization' }, { status: 405 })
        : undefined
    h.fake.requests.length = 0
    expect(await service.allowed(request())).toBe(false)
    expect(teamPaths(h.fake)).toEqual(['/repos/example-org/example-repo/teams'])
    expect(warnings).toEqual([])
  })
})
