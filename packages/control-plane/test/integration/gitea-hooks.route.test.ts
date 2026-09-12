/**
 * gitea-kind hooks (gitea-integration.md §7, §8): the create/update/delete routes fenced on a
 * managed binding, the compiled rule with the bot veto set and the signing keys inline, its
 * feature-gated broadcast, the managed-webhook converge kick and its inverse, and the Gitea arm of
 * rc/codehost-membership-authz.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  GITEA_V1_FEATURE,
  GITLAB_COM_V1_FEATURE,
  GITLAB_RERUN_V1_FEATURE,
  type RcHookAssign,
  type RcHookRerun,
  type RcHookRerunResult
} from '@agentconnect.md/protocol'
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

describe('gitea hook rerun — the Console "Run again" route (gitea-integration.md §10.4)', () => {
  const INDEX = 12
  const CURRENT_HEAD = 'cafebabe0000000000000000000000000000cafe'

  /** A relay stand-in that answers `rc/hook-rerun`; `answer` scripts its verdict. */
  function rerunChannel(features: string[], answer?: RcHookRerunResult | (() => RcHookRerunResult)) {
    const sent: Array<{ type: string; payload: unknown }> = []
    const requests: Array<{ type: string; payload: unknown }> = []
    const ch = {
      relayId: `r-${randomUUID().slice(0, 8)}`,
      features,
      send: (type: string, payload: unknown) => {
        sent.push({ type, payload })
      },
      request: async (type: string, payload: unknown) => {
        requests.push({ type, payload })
        const reply = typeof answer === 'function' ? answer() : answer
        return reply ?? { admitted: true, deliveryKey: (payload as { deliveryKey: string }).deliveryKey }
      },
      close() {}
    } as unknown as RelayChannel
    return { ch, sent, requests }
  }

  async function rerunHarness(answer?: RcHookRerunResult | (() => RcHookRerunResult)) {
    const h = await harness()
    const relay = rerunChannel([GITEA_V1_FEATURE], answer)
    h.a.relayReg.add(relay.ch)
    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(h.agentId) })
    expect(created.statusCode).toBe(200)
    const hookId = (created.json() as { id: string }).id
    // Until the create kick has converged the webhook the hook has no compilable rule.
    await vi.waitFor(
      () => {
        expect(h.fake.hooks.size).toBe(1)
        expect(relay.sent.some((frame) => frame.type === 'rc/hook-assign')).toBe(true)
      },
      { timeout: 20_000 }
    )
    await h.seam.settled()
    // The subject as Gitea reports it NOW — a stale stored head must never win.
    h.fake.pulls.set(INDEX, {
      state: 'open',
      headSha: CURRENT_HEAD,
      baseSha: 'ba5e0000000000000000000000000000000ba5e0'
    })
    relay.sent.length = 0
    return { h, relay, hookId }
  }

  const rerun = (a: HttpApp, hookId: string, subject: Record<string, unknown>) =>
    a.app.inject({ method: 'POST', url: `${ORG}/hooks/${hookId}/rerun`, payload: { subject } })

  const reruns = (frames: Array<{ type: string; payload: unknown }>) =>
    frames.filter((frame) => frame.type === 'rc/hook-rerun').map((frame) => frame.payload as RcHookRerun)

  it('re-dispatches the current head to ONE gitea-v1 relay through the gitea member of the frame', async () => {
    const { h, relay, hookId } = await rerunHarness()
    const legacy = rerunChannel([GITLAB_COM_V1_FEATURE, GITLAB_RERUN_V1_FEATURE])
    h.a.relayReg.add(legacy.ch)
    const res = await rerun(h.a, hookId, { kind: 'merge_request', iid: INDEX })
    expect(res.statusCode).toBe(200)
    const dto = res.json() as { accepted: boolean; deliveryKey: string; event: string; headSha: string }
    expect(dto).toMatchObject({ accepted: true, event: 'merge_request:rerun', headSha: CURRENT_HEAD })

    const frames = reruns(relay.requests)
    expect(frames).toHaveLength(1)
    const frame = frames[0]!
    expect(frame).toMatchObject({ hookId, agentId: h.agentId, deliveryKey: dto.deliveryKey })
    expect(frame.gitlab).toBeUndefined()
    expect(frame.gitea).toMatchObject({
      repoId: REPO.toString(),
      repoPath: 'example-org/example-repo',
      host: h.fake.opts.baseUrl,
      target: {
        kind: 'pull',
        index: INDEX,
        headSha: CURRENT_HEAD,
        sourceRepoId: REPO.toString(),
        explicitReviewRequest: true
      }
    })
    // The fence the relay re-checks against its own compiled rule.
    const row = (await new PgHookRepo(prisma).get(OrgId(DEFAULT_ORG_ID), HookId(hookId)))!
    expect(frame.configRevision).toBe(row.configRevision.toString())
    expect(frame.dispatchRevision).toBe(row.dispatchRevision.toString())
    // One click is one turn, to a relay that can decode the member — never to one without gitea-v1.
    expect(reruns(legacy.requests)).toHaveLength(0)
    expect(reruns(relay.sent)).toHaveLength(0)
    // The subject read ran as the connection's bot.
    const subjectReads = h.fake.requests.filter((request) => request.url.includes(`/pulls/${INDEX}`))
    expect(subjectReads.at(-1)!.token).toBe(h.fake.token)
  })

  it('follows the head between reruns instead of pinning the first one', async () => {
    const { h, relay, hookId } = await rerunHarness()
    expect((await rerun(h.a, hookId, { kind: 'merge_request', iid: INDEX })).statusCode).toBe(200)
    h.fake.pulls.set(INDEX, { state: 'open', headSha: 'f00d'.repeat(10) })
    const second = await rerun(h.a, hookId, { kind: 'merge_request', iid: INDEX })
    expect(second.statusCode).toBe(200)
    expect((second.json() as { headSha: string }).headSha).toBe('f00d'.repeat(10))
    const frames = reruns(relay.requests)
    expect(frames.map((frame) => (frame.gitea!.target as { headSha?: string }).headSha)).toEqual([
      CURRENT_HEAD,
      'f00d'.repeat(10)
    ])
    expect(new Set(frames.map((frame) => frame.deliveryKey)).size).toBe(2)
  })

  it('runs an open issue with no head, and refuses a closed, merged, missing, or pull-request-shaped subject', async () => {
    const { h, relay, hookId } = await rerunHarness()
    h.fake.issues.set(7, { state: 'open' })
    h.fake.issues.set(8, { state: 'closed' })
    h.fake.issues.set(INDEX, { state: 'open', isPull: true })

    const open = await rerun(h.a, hookId, { kind: 'issue', iid: 7 })
    expect(open.statusCode).toBe(200)
    expect(open.json()).toMatchObject({ event: 'issues:rerun', headSha: null })
    expect(reruns(relay.requests)[0]!.gitea!.target).toEqual({ kind: 'issue', index: 7 })

    expect((await rerun(h.a, hookId, { kind: 'issue', iid: 8 })).json()).toMatchObject({ code: 'SUBJECT_CLOSED' })
    expect((await rerun(h.a, hookId, { kind: 'issue', iid: 9 })).json()).toMatchObject({ code: 'SUBJECT_NOT_FOUND' })
    // Issues and pull requests share one index space: a pull request is not an issue subject.
    expect((await rerun(h.a, hookId, { kind: 'issue', iid: INDEX })).json()).toMatchObject({
      code: 'SUBJECT_NOT_FOUND'
    })

    h.fake.pulls.set(INDEX, { state: 'closed', headSha: CURRENT_HEAD, merged: true })
    const merged = await rerun(h.a, hookId, { kind: 'merge_request', iid: INDEX })
    expect(merged.statusCode).toBe(409)
    expect((merged.json() as { code: string }).code).toBe('SUBJECT_CLOSED')
    expect((await rerun(h.a, hookId, { kind: 'merge_request', iid: 99 })).json()).toMatchObject({
      code: 'SUBJECT_NOT_FOUND'
    })
    expect(reruns(relay.requests)).toHaveLength(1)
  })

  it('revalidates the hook fence live: a disabled trigger and an unknown hook never reach a relay', async () => {
    const { h, relay, hookId } = await rerunHarness()
    await prisma.hookDef.update({ where: { id: hookId }, data: { enabled: false } })
    const disabled = await rerun(h.a, hookId, { kind: 'merge_request', iid: INDEX })
    expect(disabled.statusCode).toBe(409)
    expect((disabled.json() as { code: string }).code).toBe('HOOK_DISABLED')
    expect((await rerun(h.a, randomUUID(), { kind: 'merge_request', iid: INDEX })).statusCode).toBe(404)
    expect(reruns(relay.requests)).toHaveLength(0)
  })

  it('surfaces a relay refusal as RELAY_REJECTED and no eligible relay as RELAY_UNAVAILABLE', async () => {
    const refused = await rerunHarness({ admitted: false, code: 'rule_mismatch' })
    const answer = await rerun(refused.h.a, refused.hookId, { kind: 'merge_request', iid: INDEX })
    expect(answer.statusCode).toBe(409)
    expect(answer.json()).toMatchObject({ code: 'RELAY_REJECTED' })
    expect(await prisma.hookRun.count({ where: { hookId: refused.hookId } })).toBe(0)

    refused.h.a.relayReg.remove((refused.relay.ch as { relayId: string }).relayId, refused.relay.ch)
    const nobody = await rerun(refused.h.a, refused.hookId, { kind: 'merge_request', iid: INDEX })
    expect(nobody.statusCode).toBe(503)
    expect((nobody.json() as { code: string }).code).toBe('RELAY_UNAVAILABLE')
  })

  it('refuses the rerun once the connection token is rejected, and flips the connection', async () => {
    const { h, relay, hookId } = await rerunHarness()
    h.fake.token = 'gitea-token-rotated-elsewhere'
    const res = await rerun(h.a, hookId, { kind: 'merge_request', iid: INDEX })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { code: string }).code).toBe('BINDING_INACTIVE')
    expect(reruns(relay.requests)).toHaveLength(0)
    expect((await h.seam.connectionRepo.get(DEFAULT_ORG_ID, h.connection.id))!.state).toBe('token_rejected')
  })
})
