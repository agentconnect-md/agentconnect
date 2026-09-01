/**
 * The Linear connect funnel end to end against real Postgres and a stubbed Linear
 * (docs/designs/linear-integration.md §7.1, §7.4, §14 "CP integration").
 *
 * The claim under test is an ORDERING one, and it is the reason the grant is keyed by the connection
 * identity rather than by the bot row: nothing exists before the callback, and inside the callback
 * the token upsert PRECEDES the create tail — because `installNewBot` mints the bot id internally
 * and synchronizes the http bot before returning, so a bot-keyed grant could never be written in
 * between. Everything else here is a consequence of that choice: a refused tail leaves an inert row
 * the next connect overwrites, the sweeper collects what no connect comes back for, and the
 * cross-org loser's collection must never revoke the winner's live grant.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { trackedTestClock } from '../fakes/tracked-clock.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { OrgId } from '../../src/domain/ids.js'
import { LinearApiClient } from '../../src/platforms/linear/api.js'
import { LinearTokenService } from '../../src/platforms/linear/token-service.js'
import { LinearOrphanTokenSweeper } from '../../src/platforms/linear/orphan-token-sweeper.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { IntegrationRemove, IntegrationUpsert } from '@agentconnect.md/protocol'
import type { LinearTokenStore } from '../../src/persistence/ports.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const APP = { clientId: 'lin_client_id', clientSecret: 'lin_client_secret', signingSecret: 'lin_signing_secret' }
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const WORKSPACE = 'org_alpha'
const clock = trackedTestClock()

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

/** A scriptable Linear: one handler per endpoint, and a log of what was actually asked. */
class FakeLinear {
  readonly calls: { url: string; body: string }[] = []
  token: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: { access_token: 'access_1', refresh_token: 'refresh_1', expires_in: 86400 }
  })
  viewerOrganizationId = WORKSPACE
  viewer: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: {
      data: { viewer: { id: 'user_app_1', organization: { id: this.viewerOrganizationId, name: 'Acme Engineering' } } }
    }
  })
  revoke: () => { status: number; body: unknown } = () => ({ status: 200, body: {} })

  readonly fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
    this.calls.push({ url, body: String(init?.body ?? '') })
    const answer = url.endsWith('/oauth/token')
      ? this.token()
      : url.endsWith('/oauth/revoke')
        ? this.revoke()
        : this.viewer()
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' }
      })
    )
  }

  count(suffix: string): number {
    return this.calls.filter((c) => c.url.endsWith(suffix)).length
  }
}

interface Harness {
  app: HttpApp
  linear: FakeLinear
  agentId: string
}

/** Captures the daemon-facing integration frames `syncBot` emits, so the fail-closed teardown and
 *  its reconnect restore can be asserted as frames rather than inferred from rows. */
class SpyControl {
  readonly upserts: { spec: IntegrationUpsert }[] = []
  readonly removes: IntegrationRemove[] = []
  async integrationUpsert(_daemonId: string, spec: IntegrationUpsert): Promise<void> {
    this.upserts.push({ spec })
  }
  async integrationRemove(_daemonId: string, r: IntegrationRemove): Promise<void> {
    this.removes.push(r)
  }
  reset(): void {
    this.upserts.length = 0
    this.removes.length = 0
  }
}

/** The deployment app configured, a relay connected, and one placed Linear-capable agent —
 *  everything the funnel start gates on. */
async function harness(
  overrides: { relay?: boolean; onAssign?: (payload: { credentialRevision?: number }) => void } = {}
): Promise<Harness> {
  const linear = new FakeLinear()
  const app = buildHttpApp(prisma, {
    PUBLIC_RELAY_URL: 'https://relay.example.test',
    PUBLIC_CP_URL: 'https://cp.example.test'
  })
  app.platformStubs.linearPlatformApp = APP
  app.platformStubs.linearFetch = linear.fetchImpl
  running = app
  if (overrides.relay !== false) {
    // The relay is where an assign lands, so its `send` is where the broadcast revision is read.
    app.relayReg.add({
      relayId: 'r1',
      send(type: string, payload: unknown) {
        if (type === 'rc/bot-assign') overrides.onAssign?.(payload as { credentialRevision?: number })
      },
      close() {}
    } as unknown as RelayChannel)
  }
  await seedDaemon(prisma, DAEMON, {
    capabilities: { platforms: ['linear'], runtimes: ['claude'], acp: true, features: [] }
  })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  return { app, linear, agentId }
}

const startConnect = (h: Harness, agentId = h.agentId) =>
  h.app.app.inject({ method: 'POST', url: `${ORG}/integrations/linear/connect`, payload: { agentId } })

const callback = (h: Harness, query: Record<string, string>) =>
  h.app.app.inject({
    method: 'GET',
    url: `/v1/integrations/linear/oauth/callback?${new URLSearchParams(query).toString()}`
  })

const status = (h: Harness, id: string) =>
  h.app.app.inject({ method: 'GET', url: `${ORG}/integrations/linear/connect/${id}` })

const grantRow = (organizationId = WORKSPACE, orgId = DEFAULT_ORG_ID) =>
  prisma.linearToken.findUnique({
    where: { orgId_clientId_organizationId: { orgId, clientId: APP.clientId, organizationId } }
  })

describe('the connect funnel — nothing exists before the callback (§7.1)', () => {
  it('records the chosen default agent behind a one-shot nonce and mints no rows', async () => {
    const h = await harness()
    const started = await startConnect(h)
    expect(started.statusCode).toBe(201)
    const { id, connectUrl } = started.json() as { id: string; connectUrl: string }

    const url = new URL(connectUrl)
    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe(APP.clientId)
    expect(url.searchParams.get('state')).toBe(id)
    expect(url.searchParams.get('actor')).toBe('app')
    expect(url.searchParams.get('scope')).toBe('read,write,app:assignable,app:mentionable')
    expect(url.searchParams.get('redirect_uri')).toBe('https://cp.example.test/v1/integrations/linear/oauth/callback')

    // NO Bot and NO Integration until the callback — `IntegrationStatus` has no pending value, and
    // an http bot is synchronized the instant it is created.
    expect(await prisma.bot.count({ where: { orgId: DEFAULT_ORG_ID, platform: 'linear' } })).toBe(0)
    expect(await prisma.integration.count({ where: { platform: 'linear' } })).toBe(0)
    expect(await grantRow()).toBeNull()
    // The funnel row carries the choice and no secret material.
    const row = await prisma.linearInstallState.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ orgId: DEFAULT_ORG_ID, defaultAgentId: h.agentId, status: 'pending' })
    expect(JSON.stringify(row)).not.toContain(APP.clientSecret)
  })

  it('applies core’s relay-availability 409 at funnel start (§4.2 — Linear has no other transport)', async () => {
    const h = await harness({ relay: false })
    const res = await startConnect(h)
    expect(res.statusCode).toBe(409)
    expect(await prisma.linearInstallState.count()).toBe(0)
  })

  it('refuses a daemon that does not advertise the linear adapter', async () => {
    const linear = new FakeLinear()
    const app = buildHttpApp(prisma, {
      PUBLIC_RELAY_URL: 'https://relay.example.test',
      PUBLIC_CP_URL: 'https://cp.example.test'
    })
    app.platformStubs.linearPlatformApp = APP
    app.platformStubs.linearFetch = linear.fetchImpl
    running = app
    app.relayReg.add({ relayId: 'r1', send() {}, close() {} } as unknown as RelayChannel)
    await seedDaemon(prisma, DAEMON, {
      capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] }
    })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })

    const res = await startConnect({ app, linear, agentId })
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toMatch(/does not support linear/)
  })

  it('404s an unknown agent, and the routes 404 outright without the deployment app', async () => {
    const h = await harness()
    expect((await startConnect(h, randomUUID())).statusCode).toBe(404)

    const off = buildHttpApp(prisma, { PUBLIC_CP_URL: 'https://cp.example.test' })
    running = off
    const res = await off.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/linear/connect`,
      payload: { agentId: h.agentId }
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('the OAuth callback — §7.1’s exact order', () => {
  it('writes the grant BEFORE the create tail, then mints a shareable workspace bot', async () => {
    const h = await harness()
    const { id } = (await startConnect(h)).json() as { id: string }

    const res = await callback(h, { code: 'the-code', state: id })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Linear workspace connected')

    // Step 1's write is what makes step 2 possible: the token is durable by the time the tail's own
    // `syncBot` drives `projectIntegrationConfig`, and it is keyed by the identity, not the bot.
    const grant = await grantRow()
    expect(grant).not.toBeNull()
    const bot = await prisma.bot.findFirstOrThrow({ where: { orgId: DEFAULT_ORG_ID, platform: 'linear' } })
    expect(grant!.createdAt.getTime()).toBeLessThanOrEqual(bot.createdAt.getTime())

    // The D6 identity is the deployment client id + the Linear organization; sharing is structural.
    expect(bot).toMatchObject({
      externalAppId: APP.clientId,
      externalTenantId: WORKSPACE,
      workspaceId: WORKSPACE,
      workspaceName: 'Acme Engineering',
      botUserId: 'user_app_1',
      shareable: true,
      transport: 'http'
    })
    // The deployment credentials are stamped into the workspace bot's secret row.
    const secret = await prisma.botSecret.findUniqueOrThrow({ where: { botId: bot.id } })
    expect(secret).toMatchObject({ botToken: APP.clientSecret, signingSecret: APP.signingSecret })

    // …and the chosen default agent is a member, active from birth.
    const integration = await prisma.integration.findFirstOrThrow({ where: { botId: bot.id } })
    expect(integration).toMatchObject({ agentId: h.agentId, status: 'active', platform: 'linear' })

    const polled = await status(h, id)
    expect(polled.json()).toMatchObject({ status: 'completed', botId: bot.id, failureReason: null })
  })

  it('admits a SECOND member agent on the connected workspace without touching the grant', async () => {
    const h = await harness()
    const { id } = (await startConnect(h)).json() as { id: string }
    await callback(h, { code: 'the-code', state: id })
    const before = await grantRow()

    const second = randomUUID()
    await seedAgent(prisma, second, { daemonId: DAEMON, name: 'second-agent' })
    const bot = await prisma.bot.findFirstOrThrow({ where: { platform: 'linear' } })
    const added = await h.app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'linear', agentId: second, botId: bot.id }
    })
    expect(added.statusCode).toBe(201)
    expect(await prisma.integration.count({ where: { botId: bot.id } })).toBe(2)

    // Membership churn rides the bot row; the credential rides the connection identity.
    const removed = await h.app.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${added.json().id}` })
    expect(removed.statusCode).toBe(204)
    expect(await grantRow()).toEqual(before)
  })

  it('is one-shot: a replayed callback connects nothing a second time', async () => {
    const h = await harness()
    const { id } = (await startConnect(h)).json() as { id: string }
    await callback(h, { code: 'the-code', state: id })

    const replay = await callback(h, { code: 'the-code', state: id })
    expect(replay.body).toContain('didn’t finish')
    expect(await prisma.bot.count({ where: { platform: 'linear' } })).toBe(1)
    // The claim is what stops the replay, so the code is never spent a second time upstream.
    expect(h.linear.count('/oauth/token')).toBe(1)
    expect((await status(h, id)).json()).toMatchObject({ status: 'completed' })
  })

  it('settles nothing an unknown or denied round trip touched', async () => {
    const h = await harness()
    const { id } = (await startConnect(h)).json() as { id: string }

    expect((await callback(h, { error: 'access_denied', state: id })).statusCode).toBe(200)
    expect((await status(h, id)).json()).toMatchObject({ status: 'pending' })
    expect((await callback(h, { code: 'c', state: randomUUID() })).body).toContain('didn’t finish')
    expect(h.linear.calls).toHaveLength(0)
  })

  it('leaves the funnel row failed — and no bot — when Linear refuses the exchange', async () => {
    const h = await harness()
    const { id } = (await startConnect(h)).json() as { id: string }
    h.linear.token = () => ({ status: 400, body: { error: 'invalid_grant' } })

    await callback(h, { code: 'the-code', state: id })
    expect((await status(h, id)).json()).toMatchObject({ status: 'failed', failureReason: 'error' })
    expect(await prisma.bot.count({ where: { platform: 'linear' } })).toBe(0)
    expect(await grantRow()).toBeNull()
  })
})

describe('the D6 fences — a refusal after step 1 leaves an inert row (§7.1)', () => {
  /** Give another organization the workspace bot, so this org's connect loses both fences. */
  async function foreignWinner(): Promise<string> {
    const foreignOrg = `org-linear-${randomUUID()}`
    await prisma.org.create({ data: { id: foreignOrg, slug: foreignOrg } })
    await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: foreignOrg,
        platform: 'linear',
        name: 'winner',
        transport: 'http',
        shareable: true,
        externalAppId: APP.clientId,
        externalTenantId: WORKSPACE
      }
    })
    return foreignOrg
  }

  it('refuses the tail, keeps the token row, and the NEXT connect overwrites it', async () => {
    const h = await harness()
    const foreignOrg = await foreignWinner()
    const first = (await startConnect(h)).json() as { id: string }

    const res = await callback(h, { code: 'the-code', state: first.id })
    expect(res.body).toContain('already connected to a different AgentConnect organization')
    expect((await status(h, first.id)).json()).toMatchObject({ status: 'failed', failureReason: 'workspace_taken' })
    // No bot in THIS org, and the step-1 row is inert: no bot references it.
    expect(await prisma.bot.count({ where: { orgId: DEFAULT_ORG_ID, platform: 'linear' } })).toBe(0)
    const inert = await grantRow()
    expect(inert).not.toBeNull()

    // A second attempt (the winner having gone away) replaces the inert row in place.
    await prisma.bot.deleteMany({ where: { orgId: foreignOrg } })
    h.linear.token = () => ({
      status: 200,
      body: { access_token: 'access_2', refresh_token: 'refresh_2', expires_in: 86400 }
    })
    const second = (await startConnect(h)).json() as { id: string }
    expect((await callback(h, { code: 'code-2', state: second.id })).body).toContain('connected')
    expect(await prisma.linearToken.count({ where: { organizationId: WORKSPACE } })).toBe(1)
    expect((await grantRow())!.accessToken).toBe('access_2')
  })
})

describe('reconnect — a dead grant is replaced in place (§7.4)', () => {
  it('restarts the funnel against the existing bot and rotates the grant, keeping the members', async () => {
    const h = await harness()
    const { id } = (await startConnect(h)).json() as { id: string }
    await callback(h, { code: 'the-code', state: id })
    const bot = await prisma.bot.findFirstOrThrow({ where: { platform: 'linear' } })
    const membersBefore = await prisma.integration.count({ where: { botId: bot.id } })

    const started = await h.app.app.inject({ method: 'POST', url: `${ORG}/bots/${bot.id}/linear/reconnect` })
    expect(started.statusCode).toBe(201)
    const reconnect = started.json() as { id: string }
    // A reconnect nonce records NO default agent — it must never be able to mint a bot.
    expect(await prisma.linearInstallState.findUniqueOrThrow({ where: { id: reconnect.id } })).toMatchObject({
      defaultAgentId: null
    })

    h.linear.token = () => ({
      status: 200,
      body: { access_token: 'access_fresh', refresh_token: 'refresh_fresh', expires_in: 86400 }
    })
    expect((await callback(h, { code: 'code-2', state: reconnect.id })).body).toContain('connected')

    expect((await grantRow())!.accessToken).toBe('access_fresh')
    expect(await prisma.bot.count({ where: { platform: 'linear' } })).toBe(1)
    expect(await prisma.integration.count({ where: { botId: bot.id } })).toBe(membersBefore)
    expect((await status(h, reconnect.id)).json()).toMatchObject({ status: 'completed', botId: bot.id })
  })

  it('restores the REVOKED credential lifecycle, not just the grant', async () => {
    // The way a workspace normally ends up needing a reconnect is the `OAuthApp revoked` doorbell,
    // and `revokeBot` stamps `Bot.revokedAt` and flips every membership to revoked. A reconnect that
    // only rewrote `linear_token` would then re-broadcast against an EMPTY member set (`agentIds` is
    // active-only) — unassigning the bot while reporting success — and would leave
    // `credentialRevision` where the dead grant left it, so a delayed revoke report for that grant
    // would still pass the fence and kill the credential that just replaced it.
    const assigns: { credentialRevision?: number }[] = []
    const h = await harness({ onAssign: (payload) => assigns.push(payload) })
    const { id } = (await startConnect(h)).json() as { id: string }
    await callback(h, { code: 'the-code', state: id })
    const bot = await prisma.bot.findFirstOrThrow({ where: { platform: 'linear' } })
    const integrationId = (await prisma.integration.findFirstOrThrow({ where: { botId: bot.id } })).id

    // Linear reports the app revoked.
    const revokedAtRevision = bot.credentialRevision
    expect(await h.app.deps.httpBot.revokeBot(bot.id, 'tokens_revoked', { revision: revokedAtRevision })).toEqual({
      applied: true
    })
    expect(await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).toMatchObject({
      revokedAt: expect.any(Date)
    })
    expect(await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } })).toMatchObject({
      status: 'revoked'
    })

    const reconnect = (
      await h.app.app.inject({ method: 'POST', url: `${ORG}/bots/${bot.id}/linear/reconnect` })
    ).json() as { id: string }
    assigns.length = 0
    expect((await callback(h, { code: 'code-2', state: reconnect.id })).body).toContain('connected')

    // The revocation is fully undone: the bot is live again and the membership revoked WITH the
    // replaced generation is active, so the workspace actually serves traffic.
    const after = await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })
    expect(after.revokedAt).toBeNull()
    expect(await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } })).toMatchObject({
      status: 'active'
    })
    // The generation advanced, and the re-broadcast carries it — not an unassign.
    expect(after.credentialRevision).toBeGreaterThan(revokedAtRevision)
    expect(assigns.at(-1)?.credentialRevision).toBe(after.credentialRevision)

    // …so a revoke report that was in flight for the OLD grant is refused rather than killing the
    // credential the operator just restored.
    expect(await h.app.deps.httpBot.revokeBot(bot.id, 'tokens_revoked', { revision: revokedAtRevision })).toEqual({
      applied: false
    })
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).revokedAt).toBeNull()
  })

  it('refuses a reconnect that authorized a different workspace of the same organization', async () => {
    // The nonce is bound to ONE workspace. Without that binding an operator repairing A who
    // authorizes already-connected B would rotate B's grant, be told it worked, and leave A dead.
    const h = await harness()
    const first = (await startConnect(h)).json() as { id: string }
    await callback(h, { code: 'the-code', state: first.id })
    const botA = await prisma.bot.findFirstOrThrow({ where: { externalTenantId: WORKSPACE } })

    // A second workspace connected in the SAME organization.
    const second = randomUUID()
    await seedAgent(prisma, second, { daemonId: DAEMON, name: 'second-agent' })
    h.linear.viewerOrganizationId = 'org_beta'
    const betaConnect = (await startConnect(h, second)).json() as { id: string }
    await callback(h, { code: 'code-beta', state: betaConnect.id })
    const botB = await prisma.bot.findFirstOrThrow({ where: { externalTenantId: 'org_beta' } })
    const betaGrantBefore = await grantRow('org_beta')

    // Reconnect A, but authorize B.
    const reconnect = (
      await h.app.app.inject({ method: 'POST', url: `${ORG}/bots/${botA.id}/linear/reconnect` })
    ).json() as { id: string }
    h.linear.viewerOrganizationId = 'org_beta'
    h.linear.token = () => ({
      status: 200,
      body: { access_token: 'access_wrong', refresh_token: 'refresh_wrong', expires_in: 86400 }
    })
    const res = await callback(h, { code: 'code-2', state: reconnect.id })

    expect(res.body).toContain('different workspace')
    expect((await status(h, reconnect.id)).json()).toMatchObject({ failureReason: 'wrong_workspace' })
    // B's grant is untouched — the refusal precedes step 1, so nothing was rotated…
    expect(await grantRow('org_beta')).toEqual(betaGrantBefore)
    // …and A, the workspace actually being repaired, is not silently reported fixed.
    expect((await grantRow(WORKSPACE))!.accessToken).not.toBe('access_wrong')
    expect(await prisma.bot.count({ where: { platform: 'linear' } })).toBe(2)
    expect(botB.id).not.toBe(botA.id)
  })

  it('restores the daemon-side integration the dead grant had torn down', async () => {
    // Since the provider's `undefined` became true absence, a grant that goes away actively PULLS
    // the send-only bundle on the live http path. Reconnect has to put it back, not merely rotate a
    // row: this asserts the round trip through the very frames `syncBot` emits.
    const control = new SpyControl()
    const linear = new FakeLinear()
    const app = buildHttpApp(
      prisma,
      { PUBLIC_RELAY_URL: 'https://relay.example.test', PUBLIC_CP_URL: 'https://cp.example.test' },
      undefined,
      control as unknown as ControlSender
    )
    app.platformStubs.linearPlatformApp = APP
    app.platformStubs.linearFetch = linear.fetchImpl
    running = app
    app.relayReg.add({ relayId: 'r1', send() {}, close() {} } as unknown as RelayChannel)
    await seedDaemon(prisma, DAEMON, {
      capabilities: { platforms: ['linear'], runtimes: ['claude'], acp: true, features: [] }
    })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const h: Harness = { app, linear, agentId }

    const { id } = (await startConnect(h)).json() as { id: string }
    await callback(h, { code: 'the-code', state: id })
    const bot = await prisma.bot.findFirstOrThrow({ where: { platform: 'linear' } })
    const integration = await prisma.integration.findFirstOrThrow({ where: { botId: bot.id } })
    expect(control.upserts.map((u) => u.spec.integrationId)).toContain(integration.id)

    // The grant dies (revoked upstream, or swept): the next convergence pulls the bundle rather
    // than leaving the daemon posting on a credential Linear no longer honors.
    await app.deps.repos.linearToken.delete({
      orgId: OrgId(DEFAULT_ORG_ID),
      clientId: APP.clientId,
      organizationId: WORKSPACE
    })
    control.reset()
    await app.deps.httpBot.syncBot(bot.id)
    expect(control.removes.map((r) => r.integrationId)).toEqual([integration.id])
    expect(control.upserts).toHaveLength(0)

    // Reconnect writes a fresh grant and re-pushes — the entry comes back, with the new token.
    const reconnect = (
      await app.app.inject({ method: 'POST', url: `${ORG}/bots/${bot.id}/linear/reconnect` })
    ).json() as { id: string }
    linear.token = () => ({
      status: 200,
      body: { access_token: 'access_fresh', refresh_token: 'refresh_fresh', expires_in: 86400 }
    })
    control.reset()
    expect((await callback(h, { code: 'code-2', state: reconnect.id })).body).toContain('connected')
    expect(control.upserts.map((u) => u.spec.integrationId)).toEqual([integration.id])
    expect(control.removes).toHaveLength(0)
    expect((control.upserts[0]!.spec.config as { accessToken: string }).accessToken).toBe('access_fresh')
  })

  it('refuses a bot that is not a connected Linear workspace of this deployment app', async () => {
    const h = await harness()
    const foreign = await prisma.bot.create({
      data: { id: randomUUID(), orgId: DEFAULT_ORG_ID, platform: 'slack', name: 'slack', transport: 'http' }
    })
    expect(
      (await h.app.app.inject({ method: 'POST', url: `${ORG}/bots/${foreign.id}/linear/reconnect` })).statusCode
    ).toBe(409)
    expect(
      (await h.app.app.inject({ method: 'POST', url: `${ORG}/bots/${randomUUID()}/linear/reconnect` })).statusCode
    ).toBe(404)
  })

  it('a reconnect nonce that authorizes an unconnected workspace mints nothing', async () => {
    const h = await harness()
    const { id } = (await startConnect(h)).json() as { id: string }
    await callback(h, { code: 'the-code', state: id })
    const bot = await prisma.bot.findFirstOrThrow({ where: { platform: 'linear' } })

    const reconnect = (
      await h.app.app.inject({ method: 'POST', url: `${ORG}/bots/${bot.id}/linear/reconnect` })
    ).json() as { id: string }
    h.linear.viewerOrganizationId = 'org_somewhere_else'
    await callback(h, { code: 'code-2', state: reconnect.id })

    // The nonce's workspace binding catches this before the missing-default arm ever comes up, so
    // the operator is told the truth ("that was a different workspace") — and, because the check
    // precedes step 1, the unrelated workspace gets no grant written for it either.
    expect((await status(h, reconnect.id)).json()).toMatchObject({ failureReason: 'wrong_workspace' })
    expect(await prisma.bot.count({ where: { platform: 'linear' } })).toBe(1)
    expect(await grantRow('org_somewhere_else')).toBeNull()
  })
})

describe('the funnel row’s TTL reaper', () => {
  it('reaps an abandoned connect and leaves a fresh one alone', async () => {
    const h = await harness()
    const stale = (await startConnect(h)).json() as { id: string }
    const fresh = (await startConnect(h)).json() as { id: string }
    await prisma.linearInstallState.update({
      where: { id: stale.id },
      data: { createdAt: new Date('2020-01-01T00:00:00Z') }
    })

    const reaper = h.app.deps.platforms.get('linear')!.pendingInstalls!
    expect(reaper.map((d) => d.label)).toEqual(['linear-install-state'])
    expect(await reaper[0]!.store.reapExpired(new Date('2021-01-01T00:00:00Z'))).toBe(1)
    expect(await prisma.linearInstallState.findUnique({ where: { id: stale.id } })).toBeNull()
    expect(await prisma.linearInstallState.findUnique({ where: { id: fresh.id } })).not.toBeNull()
  })
})

describe('the orphan-token sweeper — org-scoped selection, global revoke (§7.1)', () => {
  /** A sweeper over the harness's stores, driven by `tick()` so no timer is ever armed. */
  function sweeper(h: Harness, linear = h.linear) {
    const api = new LinearApiClient({ fetchImpl: linear.fetchImpl, clock })
    const service = new LinearTokenService({ app: APP, tokens: h.app.deps.repos.linearToken, api, clock })
    return new LinearOrphanTokenSweeper({
      app: APP,
      tokens: h.app.deps.repos.linearToken,
      service,
      clock,
      graceMs: 0
    })
  }

  /** A store that DELEGATES to the real one, with named overrides. Spreading the instance instead
   *  would drop every prototype method and turn a race test into a silent TypeError the sweeper's
   *  own try/catch swallows — which passes for the wrong reason. */
  function storeWith(base: LinearTokenStore, overrides: Partial<LinearTokenStore>): LinearTokenStore {
    return {
      get: (i) => base.get(i),
      put: (i, m) => base.put(i, m),
      delete: (i) => base.delete(i),
      listOrphans: (c, s, l) => base.listOrphans(c, s, l),
      withIdentityLock: (i, act) => base.withIdentityLock(i, act),
      ...overrides
    }
  }

  /** A winner Bot for the identity, in some OTHER organization. */
  async function admitWinnerElsewhere(organizationId: string): Promise<string> {
    const winnerOrg = `org-linear-${randomUUID()}`
    await prisma.org.create({ data: { id: winnerOrg, slug: winnerOrg } })
    await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: winnerOrg,
        platform: 'linear',
        name: 'winner',
        transport: 'http',
        externalAppId: APP.clientId,
        externalTenantId: organizationId
      }
    })
    return winnerOrg
  }

  const putGrant = (h: Harness, orgId: string, organizationId: string) =>
    h.app.deps.repos.linearToken.put(
      { orgId: OrgId(orgId), clientId: APP.clientId, organizationId },
      { accessToken: `access-${orgId}`, refreshToken: 'r', expiresAt: new Date(Date.now() + 86_400_000) }
    )

  it('sweeps the cross-org loser’s row WITHOUT revoking the live winner’s grant', async () => {
    const h = await harness()
    const winnerOrg = `org-linear-${randomUUID()}`
    await prisma.org.create({ data: { id: winnerOrg, slug: winnerOrg } })
    await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: winnerOrg,
        platform: 'linear',
        name: 'winner',
        transport: 'http',
        externalAppId: APP.clientId,
        externalTenantId: WORKSPACE
      }
    })
    await putGrant(h, winnerOrg, WORKSPACE)
    await putGrant(h, DEFAULT_ORG_ID, WORKSPACE) // the loser's inert step-1 row

    await sweeper(h).tick()

    // The loser's row is gone — dead weight in its own organization either way…
    expect(await grantRow(WORKSPACE, DEFAULT_ORG_ID)).toBeNull()
    // …the winner's row and its live install are untouched…
    expect(await grantRow(WORKSPACE, winnerOrg)).not.toBeNull()
    // …and nothing was revoked upstream: the same app + workspace backs that install.
    expect(h.linear.count('/oauth/revoke')).toBe(0)
  })

  it('revokes upstream when NO organization holds the identity', async () => {
    const h = await harness()
    await putGrant(h, DEFAULT_ORG_ID, 'org_unowned')

    await sweeper(h).tick()

    expect(await grantRow('org_unowned')).toBeNull()
    expect(h.linear.count('/oauth/revoke')).toBe(1)
  })

  it('never touches a grant whose own organization still holds the bot', async () => {
    const h = await harness()
    const { id } = (await startConnect(h)).json() as { id: string }
    await callback(h, { code: 'the-code', state: id })

    await sweeper(h).tick()

    expect(await grantRow()).not.toBeNull()
    expect(h.linear.count('/oauth/revoke')).toBe(0)
  })

  it('reaches an orphan sitting behind a full batch of live grants', async () => {
    // The oldest stale rows in a real deployment are overwhelmingly HEALTHY installs — a workspace
    // that simply has not needed a refresh in an hour. Taking the oldest N and filtering afterwards
    // therefore lets those N fill every pass and starves the orphans behind them forever, so the
    // live-owner exclusion has to be part of the selection.
    const h = await harness()
    const older = new Date(Date.now() - 86_400_000)
    for (let i = 0; i < 120; i++) {
      const workspace = `org_live_${i}`
      const orgId = `org-linear-${randomUUID()}`
      await prisma.org.create({ data: { id: orgId, slug: orgId } })
      await prisma.bot.create({
        data: {
          id: randomUUID(),
          orgId,
          platform: 'linear',
          name: `live-${i}`,
          transport: 'http',
          externalAppId: APP.clientId,
          externalTenantId: workspace
        }
      })
      await putGrant(h, orgId, workspace)
      // Older than the orphan, so an unfiltered "oldest first" would take all 120 before reaching it.
      await prisma.linearToken.updateMany({ where: { orgId, organizationId: workspace }, data: { updatedAt: older } })
    }
    await putGrant(h, DEFAULT_ORG_ID, 'org_buried_orphan')

    const candidates = await h.app.deps.repos.linearToken.listOrphans(APP.clientId, new Date(), 100)
    expect(candidates.map((c) => c.identity.organizationId)).toEqual(['org_buried_orphan'])

    await sweeper(h).tick()
    expect(await grantRow('org_buried_orphan')).toBeNull()
    // …and not one of the 120 live grants was touched.
    expect(await prisma.linearToken.count({ where: { clientId: APP.clientId } })).toBe(120)
  })

  it('never revokes or deletes a grant a concurrent reconnect re-granted', async () => {
    // The window the grace period cannot close: a retry callback's step-1 upsert lands between the
    // sweep's snapshot and its act. Revoking THAT token upstream would kill the install the retry
    // just repaired, so the row is claimed against the snapshot before anything irreversible.
    const h = await harness()
    await putGrant(h, DEFAULT_ORG_ID, 'org_racing')
    const snapshot = await h.app.deps.repos.linearToken.listOrphans(APP.clientId, new Date(), 100)
    expect(snapshot.map((c) => c.identity.organizationId)).toEqual(['org_racing'])

    // The reconnect wins the race: a fresh grant for the same identity.
    const identity = { orgId: OrgId(DEFAULT_ORG_ID), clientId: APP.clientId, organizationId: 'org_racing' }
    await h.app.deps.repos.linearToken.put(identity, {
      accessToken: 'access_fresh',
      refreshToken: 'refresh_fresh',
      expiresAt: new Date(Date.now() + 86_400_000)
    })

    // Now drive the real loop with that stale snapshot — the sweeper as it would be mid-pass when
    // the upsert landed. The claim finds the row moved on, so the candidate is skipped: no upstream
    // revoke of the fresh token, and the row that now backs the repaired install survives.
    const store = h.app.deps.repos.linearToken
    const stale = new LinearOrphanTokenSweeper({
      app: APP,
      tokens: storeWith(store, { listOrphans: () => Promise.resolve(snapshot) }),
      service: new LinearTokenService({
        app: APP,
        tokens: store,
        api: new LinearApiClient({ fetchImpl: h.linear.fetchImpl, clock }),
        clock
      }),
      clock,
      graceMs: 0
    })
    await stale.tick()

    expect((await grantRow('org_racing'))!.accessToken).toBe('access_fresh')
    expect(h.linear.count('/oauth/revoke')).toBe(0)
  })

  it('never revokes when the SAME organization re-grants between the snapshot and the claim', async () => {
    // The gap that survived the row-level guard. The ownership question deliberately does not count
    // the caller's own organization — a disconnect must not see the row it is itself removing — so
    // with the claim outside the lock, a same-org retry could re-grant in between and the sweep
    // would read "unowned" and revoke the authorization backing that brand-new grant. Under one
    // uninterrupted hold the retry cannot land there at all: it needs the same lock.
    const h = await harness()
    await putGrant(h, DEFAULT_ORG_ID, WORKSPACE)
    const store = h.app.deps.repos.linearToken
    const identity = { orgId: OrgId(DEFAULT_ORG_ID), clientId: APP.clientId, organizationId: WORKSPACE }
    const snapshot = await store.listOrphans(APP.clientId, new Date(), 100)
    expect(snapshot.map((c) => c.identity.organizationId)).toEqual([WORKSPACE])

    // The retry wins the race to the lock and re-grants — exactly what §7.1 step 1 does.
    await store.put(identity, {
      accessToken: 'access_retry',
      refreshToken: 'refresh_retry',
      expiresAt: new Date(Date.now() + 86_400_000)
    })

    // The sweep proceeds on its now-stale snapshot.
    await new LinearOrphanTokenSweeper({
      app: APP,
      tokens: storeWith(store, { listOrphans: () => Promise.resolve(snapshot) }),
      service: new LinearTokenService({
        app: APP,
        tokens: store,
        api: new LinearApiClient({ fetchImpl: h.linear.fetchImpl, clock }),
        clock
      }),
      clock,
      graceMs: 0
    }).tick()

    // The claim finds the row moved on, so nothing was collected and nothing was revoked.
    expect((await grantRow(WORKSPACE))!.accessToken).toBe('access_retry')
    expect(h.linear.count('/oauth/revoke')).toBe(0)
  })

  it('holds the claim and the ownership question in ONE hold a re-grant cannot enter', async () => {
    // The stronger statement, and the one that actually distinguishes one hold from two: a same-org
    // re-grant must not be able to COMMIT between the claim and the ownership question. That is the
    // exact shape of the bug — a fresh row, committed and visible, that the ownership query then
    // ignores because it excludes the caller's own organization — and the ordering above cannot
    // catch it, since a `put` before the claim simply moves `updatedAt` and fails the claim.
    const h = await harness()
    await putGrant(h, DEFAULT_ORG_ID, WORKSPACE)
    const store = h.app.deps.repos.linearToken
    const identity = { orgId: OrgId(DEFAULT_ORG_ID), clientId: APP.clientId, organizationId: WORKSPACE }
    const snapshot = await store.listOrphans(APP.clientId, new Date(), 100)

    let landedInsideSection: boolean | undefined
    let retry: Promise<void> | undefined
    let holds = 0
    const probing = storeWith(store, {
      listOrphans: () => Promise.resolve(snapshot),
      withIdentityLock: (i, act) => (
        holds++,
        store.withIdentityLock(i, (section) =>
          act({
            claim: async (updatedAt) => {
              const removed = await section.claim(updatedAt)
              // Fire a re-grant right here and give it a real chance. NOT awaited: it needs the very
              // lock this section holds, so awaiting it would deadlock against the fence under test.
              let landed = false
              retry = store
                .put(identity, {
                  accessToken: 'access_retry',
                  refreshToken: 'r',
                  expiresAt: new Date(Date.now() + 86_400_000)
                })
                .then(() => {
                  landed = true
                })
              await new Promise((r) => setTimeout(r, 250))
              landedInsideSection = landed
              return removed
            },
            owned: () => section.owned()
          })
        )
      )
    })

    await new LinearOrphanTokenSweeper({
      app: APP,
      tokens: probing,
      service: new LinearTokenService({
        app: APP,
        tokens: store,
        api: new LinearApiClient({ fetchImpl: h.linear.fetchImpl, clock }),
        clock
      }),
      clock,
      graceMs: 0
    }).tick()
    await retry

    // THE FENCE, two ways. First structurally: the whole collection is ONE acquisition, so there is
    // no "between the claim and the question" for a re-grant to commit in — which is the only shape
    // the bug had, since a `put` before the claim merely moves `updatedAt` and fails it.
    expect(holds).toBe(1)
    // And behaviourally: while that hold is open a same-org re-grant genuinely cannot land.
    expect(landedInsideSection).toBe(false)
  })

  it('never revokes when another organization wins the identity AFTER the row was claimed', async () => {
    // The last window the row-level guard cannot see. A different organization completing a connect
    // for the same (clientId, organizationId) touches NONE of this organization's rows, so the
    // updatedAt-guarded delete still succeeds — and a listing-time "nobody owns it" carried down to
    // here would revoke the app↔workspace grant the winner just obtained. The decision is therefore
    // re-asked under the identity's advisory lock, at the moment of acting.
    const h = await harness()
    await putGrant(h, DEFAULT_ORG_ID, WORKSPACE)
    const store = h.app.deps.repos.linearToken

    let winnerOrg: string | undefined
    const racing = storeWith(store, {
      withIdentityLock: (identity, act) =>
        store.withIdentityLock(identity, async (section) =>
          act({
            claim: async (updatedAt) => {
              const removed = await section.claim(updatedAt)
              // The winner lands in exactly the gap the old split left open: after the claim,
              // before the ownership question. Under one hold this can only be a Bot row appearing
              // (a token `put` would block), which is precisely the cross-org winner's create tail.
              winnerOrg = await admitWinnerElsewhere(WORKSPACE)
              return removed
            },
            owned: () => section.owned()
          })
        )
    })
    await new LinearOrphanTokenSweeper({
      app: APP,
      tokens: racing,
      service: new LinearTokenService({
        app: APP,
        tokens: store,
        api: new LinearApiClient({ fetchImpl: h.linear.fetchImpl, clock }),
        clock
      }),
      clock,
      graceMs: 0
    }).tick()

    expect(winnerOrg).toBeDefined()
    // The local delete already happened and is fine — the row was dead weight in ITS organization.
    expect(await grantRow(WORKSPACE)).toBeNull()
    // …but the irreversible half was withheld, so the winner's brand-new grant still works.
    expect(h.linear.count('/oauth/revoke')).toBe(0)
  })

  it('serializes the revoke decision against a connect claiming the same identity', async () => {
    // The fence itself: `put` (§7.1 step 1, every claimant's first durable write) and the revoke
    // decision take the SAME advisory lock, so they cannot interleave. Holding the decision open
    // must therefore hold a concurrent claim off.
    const h = await harness()
    await putGrant(h, DEFAULT_ORG_ID, 'org_contended')
    const store = h.app.deps.repos.linearToken
    const identity = { orgId: OrgId(DEFAULT_ORG_ID), clientId: APP.clientId, organizationId: 'org_contended' }
    const otherOrg = `org-linear-${randomUUID()}`
    await prisma.org.create({ data: { id: otherOrg, slug: otherOrg } })

    let claimed = false
    let claim: Promise<void> | undefined

    await store.withIdentityLock(identity, async () => {
      // A different organization tries to claim the same workspace while the lock is held. It is
      // deliberately NOT awaited here: the lock lives with this transaction, so waiting for a
      // contender inside it would deadlock against the very fence under test.
      claim = store
        .put(
          { orgId: OrgId(otherOrg), clientId: APP.clientId, organizationId: 'org_contended' },
          { accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 86_400_000) }
        )
        .then(() => {
          claimed = true
        })
      // Give it a real chance to land; it must not, because it is queued behind this lock.
      await new Promise((r) => setTimeout(r, 150))
      expect(claimed).toBe(false)
    })

    // …and once the decision's transaction ended, the claim went through.
    await claim
    expect(claimed).toBe(true)
    expect(await grantRow('org_contended', otherOrg)).not.toBeNull()
  })

  it('respects the grace window, so a callback between steps 1 and 2 is never swept', async () => {
    const h = await harness()
    await putGrant(h, DEFAULT_ORG_ID, 'org_in_flight')
    const graced = new LinearOrphanTokenSweeper({
      app: APP,
      tokens: h.app.deps.repos.linearToken,
      service: new LinearTokenService({
        app: APP,
        tokens: h.app.deps.repos.linearToken,
        api: new LinearApiClient({ fetchImpl: h.linear.fetchImpl, clock }),
        clock
      }),
      clock
    })
    await graced.tick()
    expect(await grantRow('org_in_flight')).not.toBeNull()
  })

  it('is inert without the deployment app, and is published alongside the re-stamp loop', async () => {
    const h = await harness()
    await putGrant(h, DEFAULT_ORG_ID, 'org_unowned')
    const disabled = new LinearOrphanTokenSweeper({
      tokens: h.app.deps.repos.linearToken,
      service: new LinearTokenService({
        tokens: h.app.deps.repos.linearToken,
        api: new LinearApiClient({ fetchImpl: h.linear.fetchImpl, clock }),
        clock
      }),
      clock,
      graceMs: 0
    })
    await disabled.tick()
    expect(await grantRow('org_unowned')).not.toBeNull()
    // The composed provider publishes BOTH convergence loops — the §10.6 re-stamp and this sweep.
    // They are independently optional, so asserting the pair here is what catches a composition
    // that quietly drops one (see the provider suite for the same claim at the unit level).
    expect(h.app.deps.platforms.get('linear')!.backgroundLoops?.map((l) => l.label)).toEqual([
      'linear-credential-restamp',
      'linear-orphan-token'
    ])
  })
})

describe('disconnect — the bot delete revokes only what nobody holds (§7.4)', () => {
  it('revokes upstream and drops the grant when the deleted bot was the last holder', async () => {
    const h = await harness()
    const { id } = (await startConnect(h)).json() as { id: string }
    await callback(h, { code: 'the-code', state: id })
    const bot = await prisma.bot.findFirstOrThrow({ where: { platform: 'linear' } })
    await prisma.integration.deleteMany({ where: { botId: bot.id } })

    expect((await h.app.app.inject({ method: 'DELETE', url: `${ORG}/bots/${bot.id}` })).statusCode).toBe(204)
    expect(await grantRow()).toBeNull()
    expect(h.linear.count('/oauth/revoke')).toBe(1)
  })

  it('never revokes on behalf of a row another organization’s bot still backs', async () => {
    const h = await harness()
    const winnerOrg = `org-linear-${randomUUID()}`
    await prisma.org.create({ data: { id: winnerOrg, slug: winnerOrg } })
    await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: winnerOrg,
        platform: 'linear',
        name: 'winner',
        transport: 'http',
        externalAppId: APP.clientId,
        externalTenantId: WORKSPACE
      }
    })
    // A local bot for the SAME workspace can only exist without the D6 identity, which is exactly
    // the shape whose teardown must stay a no-op rather than guess at an identity.
    const local = await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        platform: 'linear',
        name: 'pre-capture',
        transport: 'http'
      }
    })
    await h.app.deps.repos.linearToken.put(
      { orgId: OrgId(DEFAULT_ORG_ID), clientId: APP.clientId, organizationId: WORKSPACE },
      { accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 86_400_000) }
    )

    expect((await h.app.app.inject({ method: 'DELETE', url: `${ORG}/bots/${local.id}` })).statusCode).toBe(204)
    expect(await grantRow()).not.toBeNull()
    expect(h.linear.count('/oauth/revoke')).toBe(0)
  })
})
