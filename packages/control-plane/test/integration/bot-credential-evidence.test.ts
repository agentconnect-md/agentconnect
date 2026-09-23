// Two tiers of credential evidence against Postgres: a revocation records how it was learned, an ambiguous probe only marks the bot while any relay reports it.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { IntegrationUpsert, RcBotCredentialCheck } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { BotId, OrgId } from '../../src/domain/ids.js'
import { PgRelayRepo } from '../../src/persistence/index.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd3d3d3d3-dddd-4ddd-8ddd-dddddddddddd'
const SLACK = { botToken: 'xoxb-fixture-123', appToken: 'xapp-1-fixture-456' }

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

/** Records every spec push, so a test can prove a rejection moved nothing on the daemons. */
class SpyControl {
  readonly removals: string[] = []
  readonly upserts: IntegrationUpsert[] = []
  async integrationUpsert(_daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push(u)
  }
  async integrationRemove(_daemonId: string, r: { integrationId: string }): Promise<void> {
    this.removals.push(r.integrationId)
  }
  async collaborationRoutes(): Promise<void> {}
}

/** A Slack integration on an agent placed on DAEMON; returns its bot at revision 1 or later. */
async function install(): Promise<{ app: HttpApp; spy: SpyControl; integrationId: string; botId: string }> {
  await seedDaemon(prisma, DAEMON)
  const spy = new SpyControl()
  const app = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
  running = app
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, createdByUserId: DEFAULT_OWNER_ID })
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: { name: 'acme-bot', platform: 'slack', agentId, slack: SLACK }
  })
  expect(res.statusCode).toBe(201)
  const integrationId = (res.json() as { id: string }).id
  const { botId } = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } })
  spy.upserts.length = 0
  return { app, spy, integrationId, botId }
}

const botRow = (botId: string) => prisma.bot.findUniqueOrThrow({ where: { id: botId } })
const integrationStatus = async (id: string) => (await prisma.integration.findUniqueOrThrow({ where: { id } })).status

const observations = (botId: string) => prisma.botCredentialObservation.findMany({ where: { botId } })

/** A registered relay, last seen at `lastSeenAt` (now by default). */
async function seedRelay(lastSeenAt = new Date()): Promise<string> {
  const id = randomUUID()
  await prisma.relay.create({ data: { id, name: `relay-${id}`, daemonUrl: 'wss://relay.example.test', lastSeenAt } })
  return id
}

/** One relay's probe report, as `rc/bot-credential-check` delivers it. */
async function check(
  app: HttpApp,
  botId: string,
  relayId: string,
  over: Partial<{ result: 'ok' | 'rejected'; code: string; observedAtMs: number; credentialRevision: number }> = {}
): Promise<boolean> {
  const revision = over.credentialRevision ?? (await botRow(botId)).credentialRevision
  const base = { botId, credentialRevision: revision, observedAtMs: over.observedAtMs ?? Date.now() }
  const m: RcBotCredentialCheck =
    over.result === 'ok'
      ? { ...base, result: 'ok' }
      : { ...base, result: 'rejected', code: over.code ?? 'invalid_auth' }
  return (await app.deps.httpBot.recordCredentialCheck(m, relayId)).applied
}

/** A fresh credential for the bot, as a reinstall or token replacement writes it. */
async function reinstall(app: HttpApp, botId: string): Promise<void> {
  await app.deps.repos.botCredential.install(
    OrgId(DEFAULT_ORG_ID),
    BotId(botId),
    { botToken: 'xoxb-fixture-789', appToken: SLACK.appToken, signingSecret: null },
    new Date()
  )
}

describe('a definitive revocation records its evidence', () => {
  it('stores the reason, the probe evidence and the platform code with the revocation', async () => {
    const { app, integrationId, botId } = await install()
    const { credentialRevision } = await botRow(botId)

    const { applied } = await app.deps.httpBot.revokeBot(
      botId,
      'tokens_revoked',
      { revision: credentialRevision },
      { evidence: 'probe', code: 'account_inactive' }
    )

    expect(applied).toBe(true)
    expect(await botRow(botId)).toMatchObject({
      revokedReason: 'tokens_revoked',
      revokedEvidence: 'probe',
      revokedCode: 'account_inactive'
    })
    expect(await integrationStatus(integrationId)).toBe('revoked')
  })

  it('records a report that names no evidence (an older relay) as a lifecycle event without a code', async () => {
    const { app, botId } = await install()

    await app.deps.httpBot.revokeBot(botId, 'app_uninstalled', { eventAtMs: Date.now() + 1_000 })

    const row = await botRow(botId)
    expect(row.revokedAt).toBeInstanceOf(Date)
    expect(row).toMatchObject({ revokedReason: 'app_uninstalled', revokedEvidence: 'event', revokedCode: null })
  })

  it('exposes the recorded evidence on the bot', async () => {
    const { app, botId } = await install()
    await app.deps.httpBot.revokeBot(botId, 'tokens_revoked', {}, { evidence: 'probe', code: 'token_revoked' })

    const res = await app.app.inject({ method: 'GET', url: `${ORG}/bots/${botId}` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      revokedReason: 'tokens_revoked',
      revokedEvidence: 'probe',
      revokedCode: 'token_revoked',
      credentialRejectedAt: null,
      credentialRejectedCode: null
    })
  })
})

describe('an ambiguous rejection only marks the bot', () => {
  it('marks the bot and leaves its integrations, specs and revocation alone', async () => {
    const { app, spy, integrationId, botId } = await install()
    const relay = await seedRelay()
    const observedAtMs = Date.now()

    expect(await check(app, botId, relay, { observedAtMs, code: 'invalid_auth' })).toBe(true)

    const row = await botRow(botId)
    expect(row.credentialRejectedAt?.getTime()).toBe(observedAtMs)
    expect(row.credentialRejectedCode).toBe('invalid_auth')
    expect(row.revokedAt).toBeNull()
    expect(await integrationStatus(integrationId)).toBe('active')
    expect(spy.removals).toEqual([])
    expect(spy.upserts).toEqual([])
    const dto = (await app.app.inject({ method: 'GET', url: `${ORG}/bots/${botId}` })).json()
    expect(dto).toMatchObject({ credentialRejectedAt: new Date(observedAtMs).toISOString(), revokedAt: null })
  })

  it('keeps the first sighting and takes the latest code on a repeat from the same relay', async () => {
    const { app, botId } = await install()
    const relay = await seedRelay()
    const first = Date.now() - 60_000

    await check(app, botId, relay, { observedAtMs: first, code: 'invalid_auth' })
    expect(await check(app, botId, relay, { observedAtMs: first + 30_000, code: 'not_allowed_token_type' })).toBe(true)

    const row = await botRow(botId)
    expect(row.credentialRejectedAt?.getTime()).toBe(first)
    expect(row.credentialRejectedCode).toBe('not_allowed_token_type')
    expect(await observations(botId)).toEqual([
      expect.objectContaining({ relayId: relay, result: 'rejected', observedAt: new Date(first + 30_000) })
    ])
  })

  // An IP allowlist can reject one relay and admit another: one relay's ok must not hide another's rejection.
  it.each([
    ['A rejects before B passes', 10, 20],
    ['B passes before A rejects', 20, 10]
  ])('stays marked while any relay is rejected (%s)', async (_order, rejectAt, okAt) => {
    const { app, botId } = await install()
    const [a, b] = [await seedRelay(), await seedRelay()]
    const t = Date.now() - 60_000
    const reports = [
      { relay: a, at: rejectAt, over: { code: 'invalid_auth' } },
      { relay: b, at: okAt, over: { result: 'ok' as const } }
    ].sort((x, y) => x.at - y.at)

    for (const r of reports) expect(await check(app, botId, r.relay, { ...r.over, observedAtMs: t + r.at })).toBe(true)

    expect(await botRow(botId)).toMatchObject({
      credentialRejectedAt: new Date(t + rejectAt),
      credentialRejectedCode: 'invalid_auth'
    })
  })

  it('clears once no relay is rejected, and takes the newest rejected code across relays', async () => {
    const { app, botId } = await install()
    const [a, b] = [await seedRelay(), await seedRelay()]
    const t = Date.now() - 60_000
    await check(app, botId, a, { observedAtMs: t + 10, code: 'invalid_auth' })
    await check(app, botId, b, { result: 'ok', observedAtMs: t + 20 })

    expect(await check(app, botId, a, { result: 'ok', observedAtMs: t + 30 })).toBe(true)
    expect(await botRow(botId)).toMatchObject({ credentialRejectedAt: null, credentialRejectedCode: null })

    expect(await check(app, botId, b, { observedAtMs: t + 40, code: 'invalid_auth' })).toBe(true)
    expect(await check(app, botId, a, { observedAtMs: t + 50, code: 'not_allowed_token_type' })).toBe(true)
    // First sighting across relays, and the newest rejected relay's code.
    expect(await botRow(botId)).toMatchObject({
      credentialRejectedAt: new Date(t + 40),
      credentialRejectedCode: 'not_allowed_token_type'
    })
  })

  // Monotonic per relay: retries and out-of-order delivery can only move a relay forward, never another relay.
  it('ignores an older observation from the same relay, but applies an older one from another relay', async () => {
    const { app, botId } = await install()
    const [a, b] = [await seedRelay(), await seedRelay()]
    const t = Date.now() - 60_000

    expect(await check(app, botId, a, { result: 'ok', observedAtMs: t + 30 })).toBe(true)
    expect(await check(app, botId, a, { observedAtMs: t + 20, code: 'invalid_auth' })).toBe(false)
    expect(await check(app, botId, a, { observedAtMs: t + 30, code: 'invalid_auth' })).toBe(false) // equal is not newer
    expect((await botRow(botId)).credentialRejectedAt).toBeNull()

    expect(await check(app, botId, b, { observedAtMs: t + 10, code: 'invalid_auth' })).toBe(true)
    expect((await botRow(botId)).credentialRejectedAt?.getTime()).toBe(t + 10)
  })

  it('clears a mark held only by a relay the failover sweeper removed', async () => {
    const { app, botId } = await install()
    const t = Date.now()
    const stale = await seedRelay(new Date(t - 10 * 60_000))
    const live = await seedRelay(new Date(t))
    await check(app, botId, stale, { observedAtMs: t - 20 * 60_000, code: 'invalid_auth' })
    await check(app, botId, live, { result: 'ok', observedAtMs: t - 1_000 })
    expect((await botRow(botId)).credentialRejectedAt).toBeInstanceOf(Date)

    expect(await new PgRelayRepo(prisma).sweepStale(new Date(t - 5 * 60_000))).toBe(1)

    expect(await botRow(botId)).toMatchObject({ credentialRejectedAt: null, credentialRejectedCode: null })
    expect(await observations(botId)).toEqual([expect.objectContaining({ relayId: live, result: 'ok' })])
  })

  it('keeps a mark another live relay still holds when the sweeper removes one', async () => {
    const { app, botId } = await install()
    const t = Date.now()
    const stale = await seedRelay(new Date(t - 10 * 60_000))
    const live = await seedRelay(new Date(t))
    await check(app, botId, live, { observedAtMs: t - 30_000, code: 'invalid_auth' })
    await check(app, botId, stale, { observedAtMs: t - 20_000, code: 'not_allowed_token_type' })
    expect((await botRow(botId)).credentialRejectedCode).toBe('not_allowed_token_type')

    await new PgRelayRepo(prisma).sweepStale(new Date(t - 5 * 60_000))

    // Still rejected by the survivor: the first sighting stays, the code falls back to the survivor's.
    expect(await botRow(botId)).toMatchObject({
      credentialRejectedAt: new Date(t - 30_000),
      credentialRejectedCode: 'invalid_auth'
    })
  })

  it('ignores a check of a credential that has since been replaced', async () => {
    const { app, botId } = await install()
    const relay = await seedRelay()
    const { credentialRevision } = await botRow(botId)
    await check(app, botId, relay, { observedAtMs: Date.now() - 1_000 })
    await reinstall(app, botId)

    // The stale probe of the old credential must neither mark the fresh one nor clear anything.
    expect(await check(app, botId, relay, { credentialRevision, code: 'invalid_auth' })).toBe(false)
    expect(await check(app, botId, relay, { credentialRevision, result: 'ok' })).toBe(false)
    expect((await botRow(botId)).credentialRejectedAt).toBeNull()
    expect(await observations(botId)).toEqual([])
    expect(await check(app, botId, relay, { credentialRevision: credentialRevision + 1 })).toBe(true)
  })

  // Observations describe one credential: a new one starts every relay's sequence afresh, even from an earlier probe time.
  it('starts every relay afresh with a new credential', async () => {
    const { app, botId } = await install()
    const relay = await seedRelay()
    const t = Date.now() - 60_000
    await check(app, botId, relay, { observedAtMs: t + 30, code: 'invalid_auth' })
    await reinstall(app, botId)

    expect(await check(app, botId, relay, { observedAtMs: t + 10, code: 'invalid_auth' })).toBe(true)
    expect((await botRow(botId)).credentialRejectedAt?.getTime()).toBe(t + 10)
  })

  it('answers an unknown bot or relay as not applied', async () => {
    const { app, botId } = await install()
    const relay = await seedRelay()

    expect(await check(app, randomUUID(), relay, { credentialRevision: 1 })).toBe(false)
    expect(await check(app, botId, randomUUID())).toBe(false)
    expect(await observations(botId)).toEqual([])
  })
})

describe('a fresh credential', () => {
  it('clears the revocation, its evidence, the rejected mark and every observation in the same step', async () => {
    const { app, botId } = await install()
    const [a, b] = [await seedRelay(), await seedRelay()]
    await check(app, botId, a, { observedAtMs: Date.now() - 2_000, code: 'invalid_auth' })
    await check(app, botId, b, { result: 'ok', observedAtMs: Date.now() - 1_000 })
    await app.deps.httpBot.revokeBot(botId, 'tokens_revoked', {}, { evidence: 'probe', code: 'token_revoked' })
    const before = await botRow(botId)
    expect(before.revokedAt).toBeInstanceOf(Date)
    expect(before.credentialRejectedAt).toBeInstanceOf(Date)

    await reinstall(app, botId)

    expect(await botRow(botId)).toMatchObject({
      credentialRevision: before.credentialRevision + 1,
      revokedAt: null,
      revokedReason: null,
      revokedEvidence: null,
      revokedCode: null,
      credentialRejectedAt: null,
      credentialRejectedCode: null
    })
    expect(await observations(botId)).toEqual([])
  })
})
