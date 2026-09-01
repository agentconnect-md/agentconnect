/**
 * The Linear platform provider against real Postgres (linear-integration.md §7.2, §9.2).
 *
 * The connect funnel and its OAuth callback land later, so a connected workspace is staged here the
 * way the callback will stage it — the `linear_token` row FIRST, under the connection identity, then
 * the Bot row — which is precisely the ordering §7.1 depends on and the reason the token is keyed by
 * `(orgId, clientId, organizationId)` rather than by the bot id.
 *
 * What is pinned: the D6 identity the projector writes through `PgBotRepo.create`, that
 * `projectIntegrationConfig` resolves the grant BY that identity (and answers fail-closed when it is
 * another organization's), that the credential-paste path is refused at the live create route, that
 * a grant that is GONE pulls the send-only bundle off the daemon rather than leaving it on the last
 * good token, that core's bot-delete runs the provider's `onBotDelete` so the grant no bot row
 * references is actually collected, and that the funnel nonce is redeemable exactly once.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../src/domain/ids.js'
import { PgLinearTokenStore } from '../../src/persistence/repositories/linear.repo.js'
import { PlaintextSecretCipher } from '../../src/secrets/cipher.js'
import type { BotRecord, IntegrationRecord } from '../../src/persistence/ports.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import type {
  IntegrationCoreEnvelope,
  IntegrationLinearConfig,
  IntegrationRemove,
  IntegrationUpsert
} from '@agentconnect.md/protocol'

const CORE: IntegrationCoreEnvelope = { mode: 'shared', bindRules: [], mutedChannels: [], gated: false }

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const APP = { clientId: 'lin_client_id', clientSecret: 'lin_client_secret', signingSecret: 'lin_signing_secret' }
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

/** Records the integration frames core would have pushed to the member agents' daemons. */
class SpyControl {
  readonly upserts: Array<{ daemonId: string; integrationId: string }> = []
  readonly removes: Array<{ daemonId: string; integrationId: string }> = []
  async integrationUpsert(daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push({ daemonId, integrationId: u.integrationId })
  }
  async integrationRemove(daemonId: string, r: IntegrationRemove): Promise<void> {
    this.removes.push({ daemonId, integrationId: r.integrationId })
  }
}

/** The harness app with the deployment Linear app configured — the platform is disabled without it. */
function withLinearApp(control?: ControlSender): HttpApp {
  const app = buildHttpApp(prisma, { PUBLIC_RELAY_URL: 'https://relay.example.test' }, undefined, control)
  app.platformStubs.linearPlatformApp = APP
  running = app
  return app
}

/** Stage a connected workspace the way §7.1's callback will: grant first, Bot row second. */
async function connectWorkspace(app: HttpApp, workspace: string) {
  await app.deps.repos.linearToken.put(
    { orgId: OrgId(DEFAULT_ORG_ID), clientId: APP.clientId, organizationId: workspace },
    {
      accessToken: `access-${workspace}`,
      refreshToken: `refresh-${workspace}`,
      expiresAt: new Date('2026-01-02T00:00:00.000Z')
    }
  )
  const bot = await app.deps.repos.bot.create({
    id: BotId(randomUUID()),
    orgId: OrgId(DEFAULT_ORG_ID),
    platform: 'linear',
    name: `workspace-${workspace}`,
    workspaceId: workspace,
    workspaceName: `Workspace ${workspace}`,
    botUserId: `user_app_${workspace}`,
    shareable: true,
    transport: 'http'
  })
  await app.deps.repos.botSecret.put(OrgId(DEFAULT_ORG_ID), bot.id, {
    botToken: APP.clientSecret,
    appToken: null,
    signingSecret: APP.signingSecret
  })
  return bot
}

/** One member Integration on that workspace bot, as core would hand it to the projector. */
function memberOf(bot: BotRecord, agentId = AgentId(randomUUID())): IntegrationRecord {
  return {
    id: IntegrationId(randomUUID()),
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId,
    botId: bot.id,
    platform: 'linear',
    name: bot.name,
    status: 'active',
    createdAt: bot.createdAt
  }
}

/** The spec payload the provider projects for one member of `bot`. */
async function projectConfig(app: HttpApp, bot: BotRecord): Promise<IntegrationLinearConfig | undefined> {
  const secrets = await app.deps.repos.botSecret.get(OrgId(DEFAULT_ORG_ID), bot.id)
  const provider = app.deps.platforms.get('linear')!
  return (await provider.projectIntegrationConfig(memberOf(bot), bot, CORE, secrets!)) as
    IntegrationLinearConfig | undefined
}

describe('Linear provider — connected-workspace storage and projection (real Postgres)', () => {
  it('writes the D6 identity from the deployment client id + the workspace, not from a row column', async () => {
    const app = withLinearApp()
    const bot = await connectWorkspace(app, 'org_alpha')
    // The app half is a CONSTANT across every workspace bot, so it can only come from the config
    // slice; the tenant half is the Linear organization id the connect flow captured.
    expect(bot.externalAppId).toBe(APP.clientId)
    expect(bot.externalTenantId).toBe('org_alpha')
    expect(bot.platformConfig).toEqual({
      clientId: APP.clientId,
      organizationId: 'org_alpha',
      workspaceName: 'Workspace org_alpha'
    })
  })

  it('projects the spec config from the grant resolved by that identity', async () => {
    const app = withLinearApp()
    const bot = await connectWorkspace(app, 'org_alpha')
    const config = await projectConfig(app, bot)

    expect(config).toEqual({
      workspaceId: 'org_alpha',
      workspaceName: 'Workspace org_alpha',
      appUserId: 'user_app_org_alpha',
      accessToken: 'access-org_alpha',
      accessTokenExpiresAt: '2026-01-02T00:00:00.000Z'
    })
    // The rotating half never leaves the CP, and neither does the client secret it refreshes with.
    expect(JSON.stringify(config)).not.toContain('refresh-org_alpha')
    expect(JSON.stringify(config)).not.toContain(APP.clientSecret)
  })

  it('never crosses workspaces: each bot resolves only its own grant, and a missing one fails closed', async () => {
    const app = withLinearApp()
    const alpha = await connectWorkspace(app, 'org_alpha')
    const beta = await connectWorkspace(app, 'org_beta')
    expect((await projectConfig(app, alpha))?.accessToken).toBe('access-org_alpha')
    expect((await projectConfig(app, beta))?.accessToken).toBe('access-org_beta')

    // A dead grant (revoked upstream, awaiting reconnect) leaves no token in the spec at all.
    await app.deps.repos.linearToken.delete({
      orgId: OrgId(DEFAULT_ORG_ID),
      clientId: APP.clientId,
      organizationId: 'org_beta'
    })
    expect(await projectConfig(app, beta)).toBeUndefined()
    expect((await projectConfig(app, alpha))?.accessToken).toBe('access-org_alpha')
  })

  it('refuses the generic credential path at the live create route, pointing at the connect flow', async () => {
    const app = withLinearApp()
    await seedDaemon(prisma, DAEMON, {
      capabilities: { platforms: ['linear'], runtimes: ['claude'], acp: true, features: [] }
    })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'linear', agentId, linear: {} }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/Connect Linear/)
    // Nothing was minted: a member Integration must never exist outside a connected workspace.
    expect(await prisma.integration.count({ where: { agentId } })).toBe(0)
    expect(await prisma.bot.count({ where: { orgId: DEFAULT_ORG_ID, platform: 'linear' } })).toBe(0)
  })
})

describe('Linear provider — the disconnect edge (§7.4)', () => {
  it('core’s bot delete runs onBotDelete, collecting the grant no bot row references', async () => {
    const app = withLinearApp()
    const bot = await connectWorkspace(app, 'org_alpha')
    const survivor = await connectWorkspace(app, 'org_beta')

    const res = await app.app.inject({ method: 'DELETE', url: `${ORG}/bots/${bot.id}` })
    expect(res.statusCode).toBe(204)

    // The disconnected workspace's grant is gone — it hung off no bot row, so nothing else would
    // ever have collected it — and the workspace still connected keeps its own.
    expect(
      await prisma.linearToken.findUnique({
        where: {
          orgId_clientId_organizationId: {
            orgId: DEFAULT_ORG_ID,
            clientId: APP.clientId,
            organizationId: 'org_alpha'
          }
        }
      })
    ).toBeNull()
    expect(
      await prisma.linearToken.findUnique({
        where: {
          orgId_clientId_organizationId: {
            orgId: DEFAULT_ORG_ID,
            clientId: APP.clientId,
            organizationId: 'org_beta'
          }
        }
      })
    ).not.toBeNull()
    expect(await prisma.bot.findUnique({ where: { id: survivor.id } })).not.toBeNull()
  })

  it('pulls the send-only bundle off the daemon once the grant is gone', async () => {
    // The live http path a Linear bot actually rides. A dead grant must PULL the spec, the same
    // teardown a workspace-side revoke performs — not leave the daemon on the last good token.
    const spy = new SpyControl()
    const app = withLinearApp(spy as unknown as ControlSender)
    app.relayReg.add({ relayId: 'r1', send() {}, close() {} } as RelayChannel)
    const bot = await connectWorkspace(app, 'org_alpha')
    await seedDaemon(prisma, DAEMON, {
      capabilities: { platforms: ['linear'], runtimes: ['claude'], acp: true, features: [] }
    })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const member = memberOf(bot, AgentId(agentId))
    await app.deps.repos.integration.create({ ...member, name: 'member' })

    await app.deps.httpBot.syncBot(String(bot.id))
    expect(spy.upserts.map((u) => u.integrationId)).toEqual([member.id])
    expect(spy.removes).toEqual([])

    await app.deps.repos.linearToken.delete({
      orgId: OrgId(DEFAULT_ORG_ID),
      clientId: APP.clientId,
      organizationId: 'org_alpha'
    })
    await app.deps.httpBot.syncBot(String(bot.id))
    expect(spy.removes.map((r) => r.integrationId)).toEqual([member.id])
    // …and no second upsert: a config-less spec is never put on the wire.
    expect(spy.upserts.map((u) => u.integrationId)).toEqual([member.id])
  })

  it('leaves the grant alone when the delete itself is refused', async () => {
    const app = withLinearApp()
    const bot = await connectWorkspace(app, 'org_alpha')
    await seedDaemon(prisma, DAEMON, {
      capabilities: { platforms: ['linear'], runtimes: ['claude'], acp: true, features: [] }
    })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await app.deps.repos.integration.create({
      ...memberOf(bot, AgentId(agentId)),
      name: 'member'
    })

    const res = await app.app.inject({ method: 'DELETE', url: `${ORG}/bots/${bot.id}` })
    expect(res.statusCode).toBe(409)
    // The side effect runs only after the row is actually gone, so a live install keeps its grant.
    expect(
      await prisma.linearToken.count({
        where: { orgId: DEFAULT_ORG_ID, clientId: APP.clientId, organizationId: 'org_alpha' }
      })
    ).toBe(1)
  })
})

describe('the provider-owned tables', () => {
  it('upserts a grant in place and passes every value through the cipher', async () => {
    const sealed = {
      seal: (plaintext: string) => Promise.resolve(`sealed:${plaintext}`),
      open: (stored: string) => Promise.resolve(stored.startsWith('sealed:') ? stored.slice('sealed:'.length) : stored)
    }
    const store = new PgLinearTokenStore(prisma, sealed)
    const identity = { orgId: OrgId(DEFAULT_ORG_ID), clientId: APP.clientId, organizationId: 'org_alpha' }

    await store.put(identity, { accessToken: 'a1', refreshToken: 'r1', expiresAt: new Date('2026-01-02T00:00:00Z') })
    const row = await prisma.linearToken.findUniqueOrThrow({
      where: {
        orgId_clientId_organizationId: {
          orgId: DEFAULT_ORG_ID,
          clientId: APP.clientId,
          organizationId: 'org_alpha'
        }
      }
    })
    expect(row.accessToken).toBe('sealed:a1')
    expect(row.refreshToken).toBe('sealed:r1')
    expect(await store.get(identity)).toMatchObject({ accessToken: 'a1', refreshToken: 'r1' })

    // Refresh ROTATES both halves; the reconnect arm of §7.4 is this same in-place replace.
    await store.put(identity, { accessToken: 'a2', refreshToken: 'r2', expiresAt: new Date('2026-01-03T00:00:00Z') })
    expect(await prisma.linearToken.count({ where: { orgId: DEFAULT_ORG_ID, organizationId: 'org_alpha' } })).toBe(1)
    expect(await store.get(identity)).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' })

    // A grant issued without a refresh token stores NULL rather than a sealed empty string.
    await store.put(identity, { accessToken: 'a3', refreshToken: null, expiresAt: new Date('2026-01-04T00:00:00Z') })
    expect((await store.get(identity))?.refreshToken).toBeNull()

    await store.delete(identity)
    expect(await store.get(identity)).toBeNull()
    // Deleting an already-swept identity is a no-op, not a throw.
    await expect(store.delete(identity)).resolves.toBeUndefined()
  })

  it('shreds a grant with its organization', async () => {
    const orgId = `org-linear-${randomUUID()}`
    await prisma.org.create({ data: { id: orgId, slug: orgId } })
    const store = new PgLinearTokenStore(prisma, new PlaintextSecretCipher())
    const identity = { orgId: OrgId(orgId), clientId: APP.clientId, organizationId: 'org_alpha' }
    await store.put(identity, { accessToken: 'a', refreshToken: 'r', expiresAt: new Date() })

    await prisma.org.delete({ where: { id: orgId } })
    expect(await prisma.linearToken.count({ where: { orgId } })).toBe(0)
  })

  it('holds a connect funnel row with no secrets, and TTL-reaps an abandoned one', async () => {
    const app = withLinearApp()
    const agentId = randomUUID()
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const nonce = randomUUID()
    const stale = randomUUID()

    const created = await app.deps.repos.linearInstallState.create({
      id: nonce,
      orgId: OrgId(DEFAULT_ORG_ID),
      defaultAgentId: AgentId(agentId),
      createdByUserId: 'user-1'
    })
    expect(created).toMatchObject({ id: nonce, defaultAgentId: agentId, createdByUserId: 'user-1' })

    // An abandoned connect tab must not leave a live state nonce; a fresh one is untouched.
    await app.deps.repos.linearInstallState.create({ id: stale, orgId: OrgId(DEFAULT_ORG_ID) })
    await prisma.linearInstallState.update({
      where: { id: stale },
      data: { createdAt: new Date('2020-01-01T00:00:00Z') }
    })
    expect(await app.deps.repos.linearInstallState.reapExpired(new Date('2021-01-01T00:00:00Z'))).toBe(1)
    expect(await prisma.linearInstallState.findUnique({ where: { id: stale } })).toBeNull()
    expect(await prisma.linearInstallState.findUnique({ where: { id: nonce } })).not.toBeNull()

    // Redemption returns the row and claims it in the same statement. The row SURVIVES claimed —
    // it is the console's completion signal — so `claimedAt`, not absence, is what spends the nonce.
    expect(await app.deps.repos.linearInstallState.consume(nonce)).toMatchObject({
      id: nonce,
      defaultAgentId: agentId
    })
    expect(await prisma.linearInstallState.findUniqueOrThrow({ where: { id: nonce } })).toMatchObject({
      claimedAt: expect.any(Date)
    })
    // A replayed callback finds nothing to claim rather than a second live nonce.
    expect(await app.deps.repos.linearInstallState.consume(nonce)).toBeNull()
    expect(await app.deps.repos.linearInstallState.consume(randomUUID())).toBeNull()
    // …while the read-only poll still answers, which is the whole reason the row is kept.
    expect(await app.deps.repos.linearInstallState.peek(nonce)).toMatchObject({ id: nonce, status: 'pending' })
  })

  it('redeems a nonce exactly once under concurrent callbacks', async () => {
    // The hazard a read-then-write pair leaves open: a double-clicked authorize tab, or Linear
    // replaying the redirect, gives two requests the SAME live row and both go on to mint a
    // workspace. One compare-and-set statement takes the row lock, so the losers re-evaluate
    // against a row that is already claimed and match nothing.
    const app = withLinearApp()
    const agentId = randomUUID()
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const nonce = randomUUID()
    await app.deps.repos.linearInstallState.create({
      id: nonce,
      orgId: OrgId(DEFAULT_ORG_ID),
      defaultAgentId: AgentId(agentId)
    })

    const outcomes = await Promise.all([
      app.deps.repos.linearInstallState.consume(nonce),
      app.deps.repos.linearInstallState.consume(nonce),
      app.deps.repos.linearInstallState.consume(nonce)
    ])
    const winners = outcomes.filter((row) => row !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]).toMatchObject({ id: nonce, defaultAgentId: agentId })
    // Exactly one claim landed, and the row is still there for the winner to settle.
    expect(await prisma.linearInstallState.findUniqueOrThrow({ where: { id: nonce } })).toMatchObject({
      claimedAt: expect.any(Date),
      status: 'pending'
    })
  })
})
