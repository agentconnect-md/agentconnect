// Two tiers of credential evidence against Postgres: a revocation records how it was learned, an ambiguous probe only marks the bot.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { IntegrationUpsert, RcBotCredentialCheck } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { BotId, OrgId } from '../../src/domain/ids.js'
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

async function check(
  app: HttpApp,
  botId: string,
  over: Partial<{ result: 'ok' | 'rejected'; code: string; observedAtMs: number; credentialRevision: number }> = {}
): Promise<boolean> {
  const revision = over.credentialRevision ?? (await botRow(botId)).credentialRevision
  const base = { botId, credentialRevision: revision, observedAtMs: over.observedAtMs ?? Date.now() }
  const m: RcBotCredentialCheck =
    over.result === 'ok'
      ? { ...base, result: 'ok' }
      : { ...base, result: 'rejected', code: over.code ?? 'invalid_auth' }
  return (await app.deps.httpBot.recordCredentialCheck(m)).applied
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
    const observedAtMs = Date.now()

    expect(await check(app, botId, { observedAtMs, code: 'invalid_auth' })).toBe(true)

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

  it('keeps the first sighting and takes the latest code on a repeat', async () => {
    const { app, botId } = await install()
    const first = Date.now() - 60_000

    await check(app, botId, { observedAtMs: first, code: 'invalid_auth' })
    expect(await check(app, botId, { observedAtMs: first + 30_000, code: 'not_allowed_token_type' })).toBe(true)

    const row = await botRow(botId)
    expect(row.credentialRejectedAt?.getTime()).toBe(first)
    expect(row.credentialRejectedCode).toBe('not_allowed_token_type')
    expect(row.credentialCheckedAt?.getTime()).toBe(first + 30_000)
  })

  // Relay replicas and retries can deliver checks out of order; only a strictly newer observation applies.
  it('keeps a newer rejection against an ok observed between two rejections', async () => {
    const { app, botId } = await install()
    const t = Date.now() - 60_000

    await check(app, botId, { observedAtMs: t + 10, code: 'invalid_auth' })
    await check(app, botId, { observedAtMs: t + 30, code: 'invalid_auth' })
    expect(await check(app, botId, { result: 'ok', observedAtMs: t + 20 })).toBe(false)

    const row = await botRow(botId)
    expect(row.credentialRejectedAt?.getTime()).toBe(t + 10)
    expect(row.credentialRejectedCode).toBe('invalid_auth')
    expect(row.credentialCheckedAt?.getTime()).toBe(t + 30)
  })

  it('does not re-mark after an ok when an older rejection arrives late', async () => {
    const { app, botId } = await install()
    const t = Date.now() - 60_000

    expect(await check(app, botId, { result: 'ok', observedAtMs: t + 20 })).toBe(true)
    expect(await check(app, botId, { observedAtMs: t + 10, code: 'invalid_auth' })).toBe(false)

    const row = await botRow(botId)
    expect(row.credentialRejectedAt).toBeNull()
    expect(row.credentialRejectedCode).toBeNull()
    expect(row.credentialCheckedAt?.getTime()).toBe(t + 20)
  })

  it('treats a check observed at the watermark itself as already applied', async () => {
    const { app, botId } = await install()
    const t = Date.now() - 60_000
    await check(app, botId, { observedAtMs: t, code: 'invalid_auth' })

    // A retried report of the same observation, and a different verdict claiming the same instant, both change nothing.
    expect(await check(app, botId, { observedAtMs: t, code: 'not_allowed_token_type' })).toBe(false)
    expect(await check(app, botId, { result: 'ok', observedAtMs: t })).toBe(false)

    const row = await botRow(botId)
    expect(row.credentialRejectedAt?.getTime()).toBe(t)
    expect(row.credentialRejectedCode).toBe('invalid_auth')
  })

  it('clears the mark on a later ok, but not on an ok observed before the rejection', async () => {
    const { app, botId } = await install()
    const rejectedAt = Date.now() - 60_000
    await check(app, botId, { observedAtMs: rejectedAt })

    // A delayed answer from before the rejection says nothing about it.
    expect(await check(app, botId, { result: 'ok', observedAtMs: rejectedAt - 1_000 })).toBe(false)
    expect((await botRow(botId)).credentialRejectedAt?.getTime()).toBe(rejectedAt)

    expect(await check(app, botId, { result: 'ok', observedAtMs: rejectedAt + 1_000 })).toBe(true)
    const row = await botRow(botId)
    expect(row.credentialRejectedAt).toBeNull()
    expect(row.credentialRejectedCode).toBeNull()
    // Idempotent: an ok with no mark to clear is still a verdict about the current credential.
    expect(await check(app, botId, { result: 'ok', observedAtMs: rejectedAt + 2_000 })).toBe(true)
  })

  it('ignores a check of a credential that has since been replaced', async () => {
    const { app, botId } = await install()
    const { credentialRevision } = await botRow(botId)
    await check(app, botId, { observedAtMs: Date.now() - 1_000 })
    await app.deps.repos.botCredential.install(
      OrgId(DEFAULT_ORG_ID),
      BotId(botId),
      { botToken: 'xoxb-fixture-789', appToken: SLACK.appToken, signingSecret: null },
      new Date()
    )

    // The stale probe of the old credential must neither mark the fresh one nor clear anything.
    expect(await check(app, botId, { credentialRevision, code: 'invalid_auth' })).toBe(false)
    expect(await check(app, botId, { credentialRevision, result: 'ok' })).toBe(false)
    expect((await botRow(botId)).credentialRejectedAt).toBeNull()
    expect(await check(app, botId, { credentialRevision: credentialRevision + 1 })).toBe(true)
  })

  // The watermark describes one credential: a new one starts its own sequence, even from an earlier probe time.
  it('resets the watermark with a new credential', async () => {
    const { app, botId } = await install()
    const t = Date.now() - 60_000
    await check(app, botId, { observedAtMs: t + 30, code: 'invalid_auth' })
    await app.deps.repos.botCredential.install(
      OrgId(DEFAULT_ORG_ID),
      BotId(botId),
      { botToken: 'xoxb-fixture-789', appToken: SLACK.appToken, signingSecret: null },
      new Date()
    )
    expect((await botRow(botId)).credentialCheckedAt).toBeNull()

    expect(await check(app, botId, { observedAtMs: t + 10, code: 'invalid_auth' })).toBe(true)
    const row = await botRow(botId)
    expect(row.credentialRejectedAt?.getTime()).toBe(t + 10)
    expect(row.credentialCheckedAt?.getTime()).toBe(t + 10)
  })

  it('answers an unknown bot as not applied', async () => {
    const { app } = await install()

    expect(await check(app, randomUUID(), { credentialRevision: 1 })).toBe(false)
  })
})

describe('a fresh credential', () => {
  it('clears the revocation, its evidence and the rejected mark in the same step', async () => {
    const { app, botId } = await install()
    await check(app, botId, { observedAtMs: Date.now() - 1_000, code: 'invalid_auth' })
    await app.deps.httpBot.revokeBot(botId, 'tokens_revoked', {}, { evidence: 'probe', code: 'token_revoked' })
    const before = await botRow(botId)
    expect(before.revokedAt).toBeInstanceOf(Date)
    expect(before.credentialRejectedAt).toBeInstanceOf(Date)

    await app.deps.repos.botCredential.install(
      OrgId(DEFAULT_ORG_ID),
      BotId(botId),
      { botToken: 'xoxb-fixture-789', appToken: SLACK.appToken, signingSecret: null },
      new Date()
    )

    expect(await botRow(botId)).toMatchObject({
      credentialRevision: before.credentialRevision + 1,
      revokedAt: null,
      revokedReason: null,
      revokedEvidence: null,
      revokedCode: null,
      credentialRejectedAt: null,
      credentialRejectedCode: null,
      credentialCheckedAt: null
    })
  })
})
