/**
 * Tenant-isolation contract suite (docs/designs/org-scoped-data-layer.md §6).
 *
 * Two organizations share one Postgres; the caller (devAuth = seeded owner of
 * the DEFAULT org) addresses the FOREIGN org's resources by raw id through the
 * caller's own `/orgs/:orgId` subtree. The org fence now lives in the
 * repository layer, so every point read, mutation, and list must behave as if
 * the foreign row does not exist — 404 on the wire, `null`/missing-row errors
 * at the repo — and the foreign row must be provably unmodified afterwards.
 *
 * This file is the acceptance gate for the org-scoped data-layer rollout:
 * migrating a repository (§7 M2) adds its resource block here in the same PR.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import { PgBotRepo, PgIntegrationRepo } from '../../src/persistence/repositories/integration.repo.js'
import { PgCronRepo } from '../../src/persistence/repositories/cron.repo.js'
import { AgentMissing, BotMissing, CronMissing } from '../../src/persistence/errors.js'
import { AgentId, BotId, CronId, DaemonId, IntegrationId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const CALLER_ORG = OrgId(DEFAULT_ORG_ID)

let running: HttpApp | undefined
let foreignOrgId: string
let foreignAgentId: string
let ownAgentId: string
let foreignDaemonId: string
let ownDaemonId: string
let foreignBotId: string
let ownBotId: string
let foreignIntegrationId: string
let ownIntegrationId: string
let foreignChannelId: string
let foreignCronId: string
let ownCronId: string

afterEach(async () => {
  await running?.close()
  running = undefined
})

beforeEach(async () => {
  // The caller's own agent (DEFAULT org) and a foreign org holding one agent.
  ownAgentId = randomUUID()
  await seedAgent(prisma, ownAgentId, { name: 'own-bot' })
  foreignOrgId = `org-foreign-${randomUUID().slice(0, 8)}`
  foreignAgentId = randomUUID()
  await prisma.org.create({ data: { id: foreignOrgId, slug: foreignOrgId } })
  await prisma.agent.create({
    data: { id: foreignAgentId, orgId: foreignOrgId, name: 'foreign-bot', runtime: 'claude' }
  })

  // The same two-org shape for the daemon fleet and the bot directory.
  ownDaemonId = randomUUID()
  await seedDaemon(prisma, ownDaemonId)
  foreignDaemonId = randomUUID()
  await prisma.daemon.create({
    data: {
      id: foreignDaemonId,
      orgId: foreignOrgId,
      name: 'foreign-daemon',
      sessionEpoch: 1n,
      status: 'ready',
      // Deliberately off the column default, so the PATCH below (which sends the
      // default) would be observable if the fence ever let it through.
      sessionRetention: '30d'
    }
  })
  ownBotId = randomUUID()
  await prisma.bot.create({
    data: { id: ownBotId, orgId: DEFAULT_ORG_ID, platform: 'slack', name: 'own-slack-bot' }
  })
  foreignBotId = randomUUID()
  await prisma.bot.create({
    data: {
      id: foreignBotId,
      orgId: foreignOrgId,
      platform: 'slack',
      name: 'foreign-slack-bot',
      transport: 'http',
      slackAppId: `A${randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()}`
    }
  })

  // Installs, one conversation row under the foreign install, and cron definitions.
  ownIntegrationId = randomUUID()
  await prisma.integration.create({
    data: {
      id: ownIntegrationId,
      orgId: DEFAULT_ORG_ID,
      agentId: ownAgentId,
      botId: ownBotId,
      platform: 'slack',
      name: 'own-install'
    }
  })
  foreignIntegrationId = randomUUID()
  await prisma.integration.create({
    data: {
      id: foreignIntegrationId,
      orgId: foreignOrgId,
      agentId: foreignAgentId,
      botId: foreignBotId,
      platform: 'slack',
      name: 'foreign-install'
    }
  })
  foreignChannelId = `C${randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()}`
  await prisma.integrationChannel.create({
    data: {
      integrationId: foreignIntegrationId,
      channelId: foreignChannelId,
      name: 'foreign-channel',
      kind: 'channel',
      trigger: 'mention'
    }
  })
  ownCronId = randomUUID()
  await prisma.cronDef.create({
    data: {
      id: ownCronId,
      orgId: DEFAULT_ORG_ID,
      agentId: ownAgentId,
      name: 'own-cron',
      schedule: '0 9 * * *',
      timezone: 'UTC',
      trigger: 'own trigger'
    }
  })
  foreignCronId = randomUUID()
  await prisma.cronDef.create({
    data: {
      id: foreignCronId,
      orgId: foreignOrgId,
      agentId: foreignAgentId,
      name: 'foreign-cron',
      schedule: '0 9 * * *',
      timezone: 'UTC',
      trigger: 'foreign trigger'
    }
  })
})

function build(): HttpApp {
  const app = buildHttpApp(prisma)
  running = app
  return app
}

async function foreignRowUnmodified(): Promise<void> {
  const row = await prisma.agent.findUnique({ where: { id: foreignAgentId } })
  expect(row).not.toBeNull()
  expect(row!.orgId).toBe(foreignOrgId)
  expect(row!.name).toBe('foreign-bot')
}

async function foreignDaemonUnmodified(): Promise<void> {
  const row = await prisma.daemon.findUnique({ where: { id: foreignDaemonId } })
  expect(row).not.toBeNull()
  expect(row!.orgId).toBe(foreignOrgId)
  expect(row!.name).toBe('foreign-daemon')
  expect(row!.visibility).toBe('org')
  expect(row!.sessionRetention).toBe('30d')
}

async function foreignIntegrationUnmodified(): Promise<void> {
  const row = await prisma.integration.findUnique({ where: { id: foreignIntegrationId } })
  expect(row).not.toBeNull()
  expect(row!.orgId).toBe(foreignOrgId)
  expect(row!.status).toBe('active')
  // The conversation row hangs off the integration and carries no org of its own
  // — its isolation IS the parent's fence (org-scoped-data-layer.md §3.6).
  const channel = await prisma.integrationChannel.findUnique({
    where: { integrationId_channelId: { integrationId: foreignIntegrationId, channelId: foreignChannelId } }
  })
  expect(channel).not.toBeNull()
  expect(channel!.trigger).toBe('mention')
}

async function foreignCronUnmodified(): Promise<void> {
  const row = await prisma.cronDef.findUnique({ where: { id: foreignCronId } })
  expect(row).not.toBeNull()
  expect(row!.orgId).toBe(foreignOrgId)
  expect(row!.agentId).toBe(foreignAgentId)
  expect(row!.name).toBe('foreign-cron')
  expect(row!.trigger).toBe('foreign trigger')
}

async function foreignBotUnmodified(): Promise<void> {
  const row = await prisma.bot.findUnique({ where: { id: foreignBotId } })
  expect(row).not.toBeNull()
  expect(row!.orgId).toBe(foreignOrgId)
  expect(row!.name).toBe('foreign-slack-bot')
  expect(row!.shareable).toBe(false)
}

describe('tenant isolation — Agent over the REST surface', () => {
  it('point-GET of a foreign agent id reads as absent (404), never as someone else’s resource', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${foreignAgentId}` })
    expect(res.statusCode).toBe(404)
  })

  it('PATCH of a foreign agent id is 404 and provably writes nothing', async () => {
    const app = build()
    const res = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${foreignAgentId}`,
      payload: { description: 'hijacked' }
    })
    expect(res.statusCode).toBe(404)
    await foreignRowUnmodified()
  })

  it('DELETE of a foreign agent id is 404 and the row survives', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'DELETE', url: `${ORG}/agents/${foreignAgentId}` })
    expect(res.statusCode).toBe(404)
    await foreignRowUnmodified()
  })

  it('sharing and call-policy writes on a foreign agent id are 404 and write nothing', async () => {
    const app = build()
    const sharing = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${foreignAgentId}/sharing`,
      payload: { visibility: 'org', sharedWith: [] }
    })
    expect(sharing.statusCode).toBe(404)
    const policy = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${foreignAgentId}/call-policy`,
      payload: { callPolicy: 'all', allowedCallerAgentIds: [] }
    })
    expect(policy.statusCode).toBe(404)
    await foreignRowUnmodified()
  })

  it('a PATCH losing the delete race still reads as 404 (AgentMissing → not-found mapping)', async () => {
    const app = build()
    // Delete the row right after the route's SECOND read — the post-lease
    // optimistic-CAS refresh — returns it. An earlier delete is absorbed by the
    // route's own "agent changed" 409 guard; this interleaving is the one only
    // the repo-level update fence can refuse, and it must surface as 404.
    const repo = app.deps.repos.agent
    const realGet = repo.get.bind(repo)
    let reads = 0
    repo.get = async (orgId, id) => {
      const row = await realGet(orgId, id)
      if (row?.id === ownAgentId && ++reads === 2) await prisma.agent.delete({ where: { id: ownAgentId } })
      return row
    }
    const res = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${ownAgentId}`,
      payload: { description: 'race' }
    })
    expect(res.statusCode).toBe(404)
  })

  it('the agents list never contains a foreign row', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/agents` })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as Array<{ id: string }>).map((a) => a.id)
    expect(ids).toContain(ownAgentId)
    expect(ids).not.toContain(foreignAgentId)
  })
})

describe('tenant isolation — AgentRepo fences under the routes', () => {
  it('org-fenced reads and mutations treat a cross-org id exactly like a missing row', async () => {
    const repo = new PgAgentRepo(prisma)

    // Point read: cross-org id and unknown id are indistinguishable.
    expect(await repo.get(CALLER_ORG, AgentId(foreignAgentId))).toBeNull()
    expect(await repo.get(CALLER_ORG, AgentId(randomUUID()))).toBeNull()
    expect(await repo.get(CALLER_ORG, AgentId(ownAgentId))).not.toBeNull()

    // update: the fence throws the typed missing-row error before any write.
    await expect(repo.update(CALLER_ORG, AgentId(foreignAgentId), { description: 'hijacked' })).rejects.toBeInstanceOf(
      AgentMissing
    )

    // delete: the fenced Prisma delete keeps its missing-row error semantics.
    await expect(repo.delete(CALLER_ORG, AgentId(foreignAgentId))).rejects.toThrow()

    // CAS-shaped workspace edit: a cross-org id misses like a stale expectation.
    expect(
      await repo.setWorkspace(CALLER_ORG, AgentId(foreignAgentId), new Date(), 'scratch', { mode: 'scratch' })
    ).toBeNull()

    await foreignRowUnmodified()

    // The unscoped read is the internal-trust-domain escape hatch — it does
    // resolve the row, which is exactly why lint keeps it off the HTTP surface.
    expect(await repo.getUnscoped(AgentId(foreignAgentId))).not.toBeNull()
  })
})

describe('tenant isolation — Daemon over the REST surface', () => {
  it('point-GET of a foreign daemon id reads as absent (404)', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/daemons/${foreignDaemonId}` })
    expect(res.statusCode).toBe(404)
  })

  it('PATCH of a foreign daemon id is 404 and provably writes nothing', async () => {
    const app = build()
    const res = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/daemons/${foreignDaemonId}`,
      payload: { name: 'hijacked', sessionRetention: '7d' }
    })
    expect(res.statusCode).toBe(404)
    await foreignDaemonUnmodified()
  })

  it('DELETE of a foreign daemon id is 404 and the row survives', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'DELETE', url: `${ORG}/daemons/${foreignDaemonId}` })
    expect(res.statusCode).toBe(404)
    await foreignDaemonUnmodified()
  })

  it('a sharing write on a foreign daemon id is 404 and writes nothing', async () => {
    const app = build()
    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/daemons/${foreignDaemonId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [] }
    })
    expect(res.statusCode).toBe(404)
    await foreignDaemonUnmodified()
  })

  it('a foreign daemon mints no enrolment credential — its key surface reads as absent', async () => {
    const app = build()
    const list = await app.app.inject({ method: 'GET', url: `${ORG}/daemons/${foreignDaemonId}/keys` })
    expect(list.statusCode).toBe(404)
    const mint = await app.app.inject({ method: 'POST', url: `${ORG}/daemons/${foreignDaemonId}/keys` })
    expect(mint.statusCode).toBe(404)
    expect(await prisma.apiKey.count({ where: { daemonId: foreignDaemonId } })).toBe(0)
  })

  it('the daemons list never contains a foreign row', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/daemons` })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as Array<{ daemonId: string }>).map((d) => d.daemonId)
    expect(ids).toContain(ownDaemonId)
    expect(ids).not.toContain(foreignDaemonId)
  })
})

describe('tenant isolation — Bot over the REST surface', () => {
  it('point-GET of a foreign bot id reads as absent (404)', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/bots/${foreignBotId}` })
    expect(res.statusCode).toBe(404)
  })

  it('PATCH of a foreign bot id is 404 and the shareable flag is untouched', async () => {
    const app = build()
    const res = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/bots/${foreignBotId}`,
      payload: { shareable: true }
    })
    expect(res.statusCode).toBe(404)
    await foreignBotUnmodified()
  })

  it('DELETE of a foreign bot id is 404 and the row survives', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'DELETE', url: `${ORG}/bots/${foreignBotId}` })
    expect(res.statusCode).toBe(404)
    await foreignBotUnmodified()
  })

  it('the Slack refresh action on a foreign bot id is 404', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'POST', url: `${ORG}/bots/${foreignBotId}/slack/refresh` })
    expect(res.statusCode).toBe(404)
    await foreignBotUnmodified()
  })

  it('the bots list never contains a foreign row', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/bots` })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as Array<{ id: string }>).map((b) => b.id)
    expect(ids).toContain(ownBotId)
    expect(ids).not.toContain(foreignBotId)
  })
})

describe('tenant isolation — DaemonRepo and BotRepo fences under the routes', () => {
  it('daemon reads and mutations treat a cross-org id exactly like a missing row', async () => {
    const repo = new PgDaemonRepo(prisma)

    expect(await repo.get(CALLER_ORG, DaemonId(foreignDaemonId))).toBeNull()
    expect(await repo.get(CALLER_ORG, DaemonId(randomUUID()))).toBeNull()
    expect(await repo.get(CALLER_ORG, DaemonId(ownDaemonId))).not.toBeNull()

    // Every throw-shaped mutation keeps its missing-row error for a foreign id.
    await expect(repo.rename(CALLER_ORG, DaemonId(foreignDaemonId), 'hijacked')).rejects.toThrow()
    await expect(repo.setSessionRetention(CALLER_ORG, DaemonId(foreignDaemonId), '7d')).rejects.toThrow()
    await expect(
      repo.setSharing(CALLER_ORG, DaemonId(foreignDaemonId), { visibility: 'restricted', sharedWith: [] })
    ).rejects.toThrow()
    await expect(repo.delete(CALLER_ORG, DaemonId(foreignDaemonId))).rejects.toThrow()

    await foreignDaemonUnmodified()

    // The unscoped read is the internal-trust-domain escape hatch (WS handlers
    // resolve their own connection's daemon) — lint keeps it off the HTTP surface.
    expect(await repo.getUnscoped(DaemonId(foreignDaemonId))).not.toBeNull()
  })

  it('bot reads and mutations treat a cross-org id exactly like a missing row', async () => {
    const repo = new PgBotRepo(prisma)

    expect(await repo.get(CALLER_ORG, BotId(foreignBotId))).toBeNull()
    expect(await repo.get(CALLER_ORG, BotId(randomUUID()))).toBeNull()
    expect(await repo.get(CALLER_ORG, BotId(ownBotId))).not.toBeNull()

    // setShareable refuses at the row-lock read, BEFORE the install recount that
    // would otherwise answer BotStillShared and disclose a foreign bot's occupancy.
    await expect(repo.setShareable(CALLER_ORG, BotId(foreignBotId), true)).rejects.toBeInstanceOf(BotMissing)
    await expect(repo.markFreed(CALLER_ORG, BotId(foreignBotId), new Date(), 'hijacked')).rejects.toThrow()
    await expect(repo.setWorkspaceMetadata(CALLER_ORG, BotId(foreignBotId), 'THIJACK', 'Hijacked')).rejects.toThrow()
    await expect(repo.delete(CALLER_ORG, BotId(foreignBotId))).rejects.toThrow()

    await foreignBotUnmodified()
    expect((await prisma.bot.findUnique({ where: { id: foreignBotId } }))!.workspaceId).toBeNull()

    // The unscoped read is the orchestration escape hatch (relay convergence
    // resolves a bot by the id relay ingress reported).
    expect(await repo.getUnscoped(BotId(foreignBotId))).not.toBeNull()
  })
})

describe('tenant isolation — Integration and its conversation rows over the REST surface', () => {
  it('the integrations list never contains a foreign row', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as Array<{ id: string }>).map((i) => i.id)
    expect(ids).toContain(ownIntegrationId)
    expect(ids).not.toContain(foreignIntegrationId)
  })

  it('DELETE of a foreign integration id is 404 and the install survives', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${foreignIntegrationId}` })
    expect(res.statusCode).toBe(404)
    await foreignIntegrationUnmodified()
  })

  it('a foreign install’s conversation rows are unreachable — the child fences through its parent', async () => {
    const app = build()
    // PATCH the trigger, then DELETE the row, then LEAVE the space: every
    // per-channel route resolves its integration through the org-fenced read, so
    // all three read as absent rather than as someone else's conversation.
    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${foreignIntegrationId}/channels/${foreignChannelId}`,
      payload: { trigger: 'any' }
    })
    expect(patch.statusCode).toBe(404)
    const del = await app.app.inject({
      method: 'DELETE',
      url: `${ORG}/integrations/${foreignIntegrationId}/channels/${foreignChannelId}`
    })
    expect(del.statusCode).toBe(404)
    const leave = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/${foreignIntegrationId}/leave`,
      payload: { target: { kind: 'conversation', channel: foreignChannelId } }
    })
    expect(leave.statusCode).toBe(404)
    await foreignIntegrationUnmodified()
  })
})

describe('tenant isolation — Cron over the REST surface', () => {
  it('point-GET of a foreign cron id reads as absent (404)', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/crons/${foreignCronId}` })
    expect(res.statusCode).toBe(404)
  })

  it('the client-minted PUT never takes over a foreign cron id', async () => {
    const app = build()
    // The id is the caller's to choose, so the update branch of the upsert is the
    // one fence in this batch that would otherwise be a TAKEOVER, not a leak: it
    // rewrites orgId and agentId along with the definition.
    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${foreignCronId}`,
      payload: {
        agentId: ownAgentId,
        schedule: '*/5 * * * *',
        timezone: 'UTC',
        trigger: 'hijacked'
      }
    })
    expect(res.statusCode).toBe(404)
    await foreignCronUnmodified()
  })

  it('DELETE of a foreign cron id is 404 and the row survives', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'DELETE', url: `${ORG}/crons/${foreignCronId}` })
    expect(res.statusCode).toBe(404)
    await foreignCronUnmodified()
  })

  it('the run history and sharing write of a foreign cron id are 404', async () => {
    const app = build()
    const runs = await app.app.inject({ method: 'GET', url: `${ORG}/crons/${foreignCronId}/runs` })
    expect(runs.statusCode).toBe(404)
    const sharing = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${foreignCronId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [] }
    })
    expect(sharing.statusCode).toBe(404)
    await foreignCronUnmodified()
  })

  it('the crons list never contains a foreign row', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/crons` })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as Array<{ id: string }>).map((c) => c.id)
    expect(ids).toContain(ownCronId)
    expect(ids).not.toContain(foreignCronId)
  })
})

describe('tenant isolation — IntegrationRepo and CronRepo fences under the routes', () => {
  it('integration reads and the delete treat a cross-org id exactly like a missing row', async () => {
    const repo = new PgIntegrationRepo(prisma)

    expect(await repo.get(CALLER_ORG, IntegrationId(foreignIntegrationId))).toBeNull()
    expect(await repo.get(CALLER_ORG, IntegrationId(randomUUID()))).toBeNull()
    expect(await repo.get(CALLER_ORG, IntegrationId(ownIntegrationId))).not.toBeNull()

    await expect(repo.delete(CALLER_ORG, IntegrationId(foreignIntegrationId))).rejects.toThrow()
    await foreignIntegrationUnmodified()

    // The unscoped read is the daemon-trust-domain escape hatch: `event/session`
    // resolves the integration a reporting daemon named as a session's origin.
    expect(await repo.getUnscoped(IntegrationId(foreignIntegrationId))).not.toBeNull()
  })

  it('cron reads and mutations treat a cross-org id exactly like a missing row', async () => {
    const repo = new PgCronRepo(prisma)

    expect(await repo.get(CALLER_ORG, CronId(foreignCronId))).toBeNull()
    expect(await repo.get(CALLER_ORG, CronId(randomUUID()))).toBeNull()
    expect(await repo.get(CALLER_ORG, CronId(ownCronId))).not.toBeNull()

    // The create-or-edit upsert refuses a foreign id before the update branch can
    // rewrite the row (CronMissing), rather than migrating it to the caller's org.
    await expect(
      repo.upsert({
        cronId: CronId(foreignCronId),
        orgId: CALLER_ORG,
        agentId: AgentId(ownAgentId),
        schedule: '*/5 * * * *',
        timezone: 'UTC',
        trigger: 'hijacked'
      })
    ).rejects.toBeInstanceOf(CronMissing)

    await expect(
      repo.setSharing(CALLER_ORG, CronId(foreignCronId), { visibility: 'restricted', sharedWith: [] })
    ).rejects.toThrow()
    await expect(repo.remove(CALLER_ORG, CronId(foreignCronId))).rejects.toThrow()

    // Run rows carry their own org, so the history reads empty rather than another
    // organization's schedule.
    expect(await repo.listRuns(CALLER_ORG, CronId(foreignCronId))).toEqual([])

    await foreignCronUnmodified()
  })

  it('the upsert fence holds when two organizations race for the same fresh cron id', async () => {
    const repo = new PgCronRepo(prisma)
    // The fence's hard case is an id that exists in NEITHER org yet: a plain
    // read-before-write under READ COMMITTED would let the loser's update branch
    // adopt the winner's row. The advisory scope keyed on the id makes the two
    // contend, so exactly one create wins and the other is refused as missing.
    for (let i = 0; i < 6; i++) {
      const contestedId = CronId(randomUUID())
      const input = (orgId: OrgId, agentId: string) => ({
        cronId: contestedId,
        orgId,
        agentId: AgentId(agentId),
        schedule: '*/5 * * * *',
        timezone: 'UTC',
        trigger: `race-${i}`
      })
      const settled = await Promise.allSettled([
        repo.upsert(input(CALLER_ORG, ownAgentId)),
        repo.upsert(input(OrgId(foreignOrgId), foreignAgentId))
      ])
      // Exactly one writer commits. The loser is refused — as CronMissing when it
      // observed the winner's row, or by the id's unique constraint when both
      // reached the insert; either way it never adopts the other org's row.
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const winner = settled.findIndex((r) => r.status === 'fulfilled')
      const row = await prisma.cronDef.findUnique({ where: { id: contestedId } })
      expect(row!.orgId).toBe(winner === 0 ? DEFAULT_ORG_ID : foreignOrgId)
      await prisma.cronDef.delete({ where: { id: contestedId } })
    }
  })
})
