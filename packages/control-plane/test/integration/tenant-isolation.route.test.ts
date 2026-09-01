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
import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import {
  PgBotRepo,
  PgIntegrationChannelRepo,
  PgIntegrationRepo
} from '../../src/persistence/repositories/integration.repo.js'
import { PgCronRepo } from '../../src/persistence/repositories/cron.repo.js'
import { PgHookRepo } from '../../src/persistence/repositories/hook.repo.js'
import { PgMcpProviderRepo } from '../../src/persistence/repositories/mcp.repo.js'
import { PgSkillSourceRepo } from '../../src/persistence/repositories/skill-source.repo.js'
import { PgOrganizationKnowledgeRepo } from '../../src/persistence/repositories/organization-knowledge.repo.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { PgWebchatConversationRepo } from '../../src/persistence/repositories/webchat-conversation.repo.js'
import { PgGithubInstallationRepo } from '../../src/persistence/repositories/github.repo.js'
import { PgExternalMemoryConnectionRepo } from '../../src/persistence/repositories/memory-connection.repo.js'
import { PgApiKeyRepo } from '../../src/persistence/repositories/api-key.repo.js'
import { AgentMissing, BotMissing, CronMissing, HookMissing } from '../../src/persistence/errors.js'
import { AgentId, BotId, CronId, DaemonId, HookId, IntegrationId, OrgId, SessionId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
/** The revision tables constrain `digest` to `sha256:<64 hex>`. */
const sha256 = (v: string): string => `sha256:${createHash('sha256').update(v).digest('hex')}`
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
let foreignHookId: string
let foreignHookRunId: string
let foreignProjectionId: string
let foreignProviderId: string
let ownProviderId: string
let foreignSkillSourceId: string
let ownSkillSourceId: string
let foreignKnowledgeId: string
let ownKnowledgeId: string
let foreignManagedSkillId: string
let foreignSessionId: string
let ownSessionId: string
let foreignConversationId: string
let foreignInstallationId: string
let foreignMemoryConnectionId: string
let foreignDaemonKeyId: string

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

  // A foreign hook plus one historical run, so the fence has both the definition
  // and its child run rows to keep out of reach.
  foreignHookId = randomUUID()
  await prisma.hookDef.create({
    data: {
      id: foreignHookId,
      orgId: foreignOrgId,
      agentId: foreignAgentId,
      kind: 'webhook',
      name: 'foreign-hook',
      sessionMode: 'perDelivery',
      urlToken: randomUUID().replace(/-/g, ''),
      enabled: true
    }
  })
  foreignHookRunId = randomUUID()
  await prisma.hookRun.create({
    data: {
      id: foreignHookRunId,
      hookId: foreignHookId,
      orgId: foreignOrgId,
      deliveryKey: `delivery-${randomUUID()}`,
      startedAt: new Date('2026-08-01T00:00:00.000Z'),
      status: 'success'
    }
  })
  // A durable Check projection too. `HookRepo.remove` tombstones these on its way
  // to deleting the definition, so a foreign DELETE has an external-effect row to
  // damage — and only seeding one can show it comes back untouched.
  foreignProjectionId = randomUUID()
  await prisma.hookReviewProjection.create({
    data: {
      id: foreignProjectionId,
      hookId: foreignHookId,
      orgId: foreignOrgId,
      agentId: foreignAgentId,
      repoId: 4242n,
      repoFullName: 'example-org/foreign-repo',
      headSha: 'a'.repeat(40),
      reportSha: 'a'.repeat(40),
      projectionEpoch: 1n,
      externalId: `ext-${randomUUID()}`,
      mode: 'check',
      gateMode: 'informational',
      desiredState: 'in_progress'
    }
  })

  // Shareable org registries: an MCP provider and a skill source per org.
  ownProviderId = randomUUID()
  await prisma.mcpProvider.create({
    data: { id: ownProviderId, orgId: DEFAULT_ORG_ID, name: 'own-mcp', url: 'https://mcp.example.test/own' }
  })
  foreignProviderId = randomUUID()
  await prisma.mcpProvider.create({
    data: {
      id: foreignProviderId,
      orgId: foreignOrgId,
      name: 'foreign-mcp',
      url: 'https://mcp.example.test/foreign'
    }
  })
  ownSkillSourceId = randomUUID()
  await prisma.skillSource.create({
    data: { id: ownSkillSourceId, orgId: DEFAULT_ORG_ID, name: 'own-skills', source: 'example-org/own-skills' }
  })
  foreignSkillSourceId = randomUUID()
  await prisma.skillSource.create({
    data: {
      id: foreignSkillSourceId,
      orgId: foreignOrgId,
      name: 'foreign-skills',
      source: 'example-org/foreign-skills'
    }
  })

  // Organization knowledge + one managed skill, each with a current revision.
  ownKnowledgeId = randomUUID()
  await prisma.organizationKnowledge.create({
    data: {
      id: ownKnowledgeId,
      orgId: DEFAULT_ORG_ID,
      title: 'own-runbook',
      currentRevision: 1,
      revisions: { create: { revision: 1, content: 'own content', digest: sha256('own content'), source: 'manual' } }
    }
  })
  foreignKnowledgeId = randomUUID()
  await prisma.organizationKnowledge.create({
    data: {
      id: foreignKnowledgeId,
      orgId: foreignOrgId,
      title: 'foreign-runbook',
      currentRevision: 1,
      revisions: {
        create: { revision: 1, content: 'foreign content', digest: sha256('foreign content'), source: 'manual' }
      }
    }
  })
  foreignManagedSkillId = randomUUID()
  await prisma.managedSkill.create({
    data: {
      id: foreignManagedSkillId,
      orgId: foreignOrgId,
      name: 'foreign-skill',
      description: 'foreign managed skill',
      currentRevision: 1,
      revisions: {
        create: {
          revision: 1,
          archive: Buffer.from('foreign-archive'),
          digest: sha256('foreign-archive'),
          compressedBytes: 15,
          expandedBytes: 15,
          fileCount: 1,
          manifest: {},
          source: 'manual'
        }
      }
    }
  })

  // Sessions and a webchat conversation whose roster is a pure child table.
  ownSessionId = randomUUID()
  await prisma.sessionMeta.create({
    data: {
      id: ownSessionId,
      orgId: DEFAULT_ORG_ID,
      agentId: ownAgentId,
      platform: 'slack',
      channel: '#own',
      phase: 'start',
      lastActivityAt: new Date()
    }
  })
  foreignSessionId = randomUUID()
  await prisma.sessionMeta.create({
    data: {
      id: foreignSessionId,
      orgId: foreignOrgId,
      agentId: foreignAgentId,
      platform: 'slack',
      channel: '#foreign',
      phase: 'start',
      visibility: 'org',
      lastActivityAt: new Date()
    }
  })
  foreignConversationId = randomUUID()
  await prisma.webchatConversation.create({
    data: {
      id: foreignConversationId,
      orgId: foreignOrgId,
      agentId: foreignAgentId,
      // The seeded owner is the only real app_user row; the conversation's ORG
      // is what this block fences on, not who owns it.
      userId: DEFAULT_OWNER_ID,
      participants: {
        create: { agentId: foreignAgentId, role: 'primary', ord: 0, addedByUserId: DEFAULT_OWNER_ID }
      }
    }
  })

  // A GitHub installation claim, an external-memory connection, and one daemon
  // API key — the last three id-addressed org resources.
  foreignInstallationId = randomUUID()
  await prisma.githubInstallation.create({
    data: {
      id: foreignInstallationId,
      orgId: foreignOrgId,
      installationId: 987654321n,
      accountLogin: 'example-foreign-org',
      accountType: 'Organization',
      repositorySelection: 'all',
      permissions: { pull_requests: 'write' }
    }
  })
  const foreignPluginInstallationId = randomUUID()
  await prisma.memoryPluginInstallation.create({
    data: {
      id: foreignPluginInstallationId,
      orgId: foreignOrgId,
      pluginId: 'mem0',
      transport: 'streamable_http',
      endpoint: 'https://memory.example.test/foreign'
    }
  })
  foreignMemoryConnectionId = randomUUID()
  await prisma.externalMemoryConnection.create({
    data: {
      id: foreignMemoryConnectionId,
      orgId: foreignOrgId,
      installationId: foreignPluginInstallationId,
      config: { projectId: 'foreign-project' }
    }
  })
  foreignDaemonKeyId = randomUUID()
  await prisma.apiKey.create({
    data: {
      id: foreignDaemonKeyId,
      principalType: 'daemon',
      orgId: foreignOrgId,
      daemonId: foreignDaemonId,
      hash: `hash-${randomUUID()}`,
      displayTail: 'abcd'
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

async function foreignHookUnmodified(): Promise<void> {
  const row = await prisma.hookDef.findUnique({ where: { id: foreignHookId } })
  expect(row).not.toBeNull()
  expect(row!.orgId).toBe(foreignOrgId)
  expect(row!.agentId).toBe(foreignAgentId)
  expect(row!.name).toBe('foreign-hook')
  expect(row!.enabled).toBe(true)
  // The run row hangs off the hook; a removal would have tombstoned it too.
  expect(await prisma.hookRun.findUnique({ where: { id: foreignHookRunId } })).not.toBeNull()
  // And the durable Check projection. `remove` runs the tombstones and the delete
  // in ONE transaction, so the refusal — the typed `HookMissing` from the early
  // fence, or the delete's own P2025 if it ever regressed to fencing only there —
  // rolls the tombstones back either way. This asserts that end state directly.
  const projection = await prisma.hookReviewProjection.findUnique({ where: { id: foreignProjectionId } })
  expect(projection).not.toBeNull()
  expect(projection!.tombstonedAt).toBeNull()
  expect(projection!.desiredState).toBe('in_progress')
}

async function foreignRegistriesUnmodified(): Promise<void> {
  const provider = await prisma.mcpProvider.findUnique({ where: { id: foreignProviderId } })
  expect(provider).not.toBeNull()
  expect(provider!.orgId).toBe(foreignOrgId)
  expect(provider!.url).toBe('https://mcp.example.test/foreign')
  expect(provider!.visibility).toBe('org')
  const source = await prisma.skillSource.findUnique({ where: { id: foreignSkillSourceId } })
  expect(source).not.toBeNull()
  expect(source!.orgId).toBe(foreignOrgId)
  expect(source!.source).toBe('example-org/foreign-skills')
  expect(source!.visibility).toBe('org')
}

async function foreignKnowledgeUnmodified(): Promise<void> {
  const row = await prisma.organizationKnowledge.findUnique({ where: { id: foreignKnowledgeId } })
  expect(row).not.toBeNull()
  expect(row!.orgId).toBe(foreignOrgId)
  expect(row!.title).toBe('foreign-runbook')
  expect(row!.currentRevision).toBe(1)
  expect(row!.archivedAt).toBeNull()
  // Revisions carry no org of their own — a leaked update would have added one.
  expect(await prisma.organizationKnowledgeRevision.count({ where: { knowledgeId: foreignKnowledgeId } })).toBe(1)
  const skill = await prisma.managedSkill.findUnique({ where: { id: foreignManagedSkillId } })
  expect(skill!.archivedAt).toBeNull()
}

async function foreignSessionUnmodified(): Promise<void> {
  const row = await prisma.sessionMeta.findUnique({ where: { id: foreignSessionId } })
  expect(row).not.toBeNull()
  expect(row!.orgId).toBe(foreignOrgId)
  expect(row!.visibility).toBe('org')
  expect(row!.visibilityRev).toBe(0)
}

async function foreignInfraUnmodified(): Promise<void> {
  const installation = await prisma.githubInstallation.findUnique({ where: { id: foreignInstallationId } })
  expect(installation).not.toBeNull()
  expect(installation!.orgId).toBe(foreignOrgId)
  expect(installation!.revokedAt).toBeNull()
  const connection = await prisma.externalMemoryConnection.findUnique({ where: { id: foreignMemoryConnectionId } })
  expect(connection).not.toBeNull()
  expect(connection!.orgId).toBe(foreignOrgId)
  expect(connection!.revision).toBe(1)
  expect(connection!.config).toEqual({ projectId: 'foreign-project' })
  const key = await prisma.apiKey.findUnique({ where: { id: foreignDaemonKeyId } })
  expect(key).not.toBeNull()
  expect(key!.revokedAt).toBeNull()
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
    // The foreign daemon starts with exactly one seeded key; a leaked mint would
    // have added a second.
    expect(await prisma.apiKey.count({ where: { daemonId: foreignDaemonId } })).toBe(1)
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

    // BotRepo.update refuses at the row-lock read, BEFORE the install recount that
    // would otherwise answer BotStillShared and disclose a foreign bot's occupancy.
    await expect(repo.update(CALLER_ORG, BotId(foreignBotId), { shareable: true })).rejects.toBeInstanceOf(BotMissing)
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

  it('the conversation-name directory answers for the caller’s org only', async () => {
    const channels = new PgIntegrationChannelRepo(prisma)
    const coordinates = [{ platform: 'slack', channelId: foreignChannelId }]
    expect(await channels.namesForOrg(CALLER_ORG, coordinates)).toEqual([])
    // Proof the row is genuinely there — it is the FENCE that hides it, not a bad id.
    expect(await channels.namesForOrg(OrgId(foreignOrgId), coordinates)).toEqual([
      { platform: 'slack', channelId: foreignChannelId, name: 'foreign-channel' }
    ])
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

describe('tenant isolation — Hook over the REST surface', () => {
  it('point-GET of a foreign hook id reads as absent (404)', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/hooks/${foreignHookId}` })
    expect(res.statusCode).toBe(404)
  })

  it('PUT of a foreign hook id is 404 and provably writes nothing', async () => {
    const app = build()
    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/hooks/${foreignHookId}`,
      payload: { kind: 'webhook', agentId: ownAgentId, name: 'hijacked', enabled: false }
    })
    expect(res.statusCode).toBe(404)
    await foreignHookUnmodified()
  })

  it('DELETE of a foreign hook id is 404, and its runs and projections survive', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'DELETE', url: `${ORG}/hooks/${foreignHookId}` })
    expect(res.statusCode).toBe(404)
    await foreignHookUnmodified()
  })

  it('the run history of a foreign hook id is 404', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/hooks/${foreignHookId}/runs` })
    expect(res.statusCode).toBe(404)
  })
})

describe('tenant isolation — HookRepo fences under the routes', () => {
  it('hook reads and mutations treat a cross-org id exactly like a missing row', async () => {
    const repo = new PgHookRepo(prisma)

    expect(await repo.get(CALLER_ORG, HookId(foreignHookId))).toBeNull()
    expect(await repo.get(CALLER_ORG, HookId(randomUUID()))).toBeNull()
    // The batch read simply drops foreign ids, exactly like unknown ones.
    expect(await repo.getMany(CALLER_ORG, [HookId(foreignHookId)])).toEqual([])

    // `upsert` is create-or-edit on an id the caller supplies, so its update
    // branch would rewrite the foreign row's orgId and agentId — refused inside
    // the transaction, before the definition or its projections are touched.
    await expect(
      repo.upsert({
        hookId: HookId(foreignHookId),
        orgId: CALLER_ORG,
        agentId: AgentId(ownAgentId),
        kind: 'webhook',
        name: 'hijacked',
        sessionMode: 'perDelivery'
      })
    ).rejects.toBeInstanceOf(HookMissing)

    // `remove` refuses BEFORE it tombstones the hook's durable review projections.
    await expect(repo.remove(CALLER_ORG, HookId(foreignHookId))).rejects.toBeInstanceOf(HookMissing)

    // Run rows carry their own org, so the history reads empty rather than
    // another organization's delivery record.
    expect(await repo.listRuns(CALLER_ORG, HookId(foreignHookId))).toEqual([])

    await foreignHookUnmodified()

    // The unscoped reads are the GitHub-machinery / daemon escape hatches.
    expect(await repo.getUnscoped(HookId(foreignHookId))).not.toBeNull()
    expect(await repo.getManyUnscoped([HookId(foreignHookId)])).toHaveLength(1)
  })
})

describe('tenant isolation — MCP providers and skill sources over the REST surface', () => {
  it('point-GET of a foreign provider or skill source reads as absent (404)', async () => {
    const app = build()
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers/${foreignProviderId}` })).statusCode).toBe(
      404
    )
    expect(
      (await app.app.inject({ method: 'GET', url: `${ORG}/skill-sources/${foreignSkillSourceId}` })).statusCode
    ).toBe(404)
    // The per-source skill scan is a second read path onto the same row.
    expect(
      (await app.app.inject({ method: 'GET', url: `${ORG}/skill-sources/${foreignSkillSourceId}/skills` })).statusCode
    ).toBe(404)
  })

  it('foreign provider and skill-source writes are 404 and change nothing', async () => {
    const app = build()
    const patchProvider = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/mcp-providers/${foreignProviderId}`,
      payload: { url: 'https://mcp.example.test/hijacked' }
    })
    expect(patchProvider.statusCode).toBe(404)
    const rotate = await app.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers/${foreignProviderId}/grant/rotate`
    })
    expect(rotate.statusCode).toBe(404)
    const shareProvider = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/mcp-providers/${foreignProviderId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [] }
    })
    expect(shareProvider.statusCode).toBe(404)
    const deleteProvider = await app.app.inject({
      method: 'DELETE',
      url: `${ORG}/mcp-providers/${foreignProviderId}`
    })
    expect(deleteProvider.statusCode).toBe(404)

    const patchSource = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/skill-sources/${foreignSkillSourceId}`,
      payload: { source: 'example-org/hijacked' }
    })
    expect(patchSource.statusCode).toBe(404)
    const shareSource = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/skill-sources/${foreignSkillSourceId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [] }
    })
    expect(shareSource.statusCode).toBe(404)
    const deleteSource = await app.app.inject({
      method: 'DELETE',
      url: `${ORG}/skill-sources/${foreignSkillSourceId}`
    })
    expect(deleteSource.statusCode).toBe(404)

    await foreignRegistriesUnmodified()
  })

  it('neither registry list contains a foreign row', async () => {
    const app = build()
    const providers = await app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers` })
    expect(providers.statusCode).toBe(200)
    const providerIds = (providers.json() as Array<{ id: string }>).map((p) => p.id)
    expect(providerIds).toContain(ownProviderId)
    expect(providerIds).not.toContain(foreignProviderId)

    const sources = await app.app.inject({ method: 'GET', url: `${ORG}/skill-sources` })
    expect(sources.statusCode).toBe(200)
    const sourceIds = (sources.json() as Array<{ id: string }>).map((s) => s.id)
    expect(sourceIds).toContain(ownSkillSourceId)
    expect(sourceIds).not.toContain(foreignSkillSourceId)
  })
})

describe('tenant isolation — organization knowledge and managed skills over the REST surface', () => {
  it('a foreign knowledge entry is unreachable through its read, revision, and write routes', async () => {
    const app = build()
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/knowledge/${foreignKnowledgeId}` })).statusCode).toBe(
      404
    )
    expect(
      (await app.app.inject({ method: 'GET', url: `${ORG}/knowledge/${foreignKnowledgeId}/revisions` })).statusCode
    ).toBe(404)
    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/knowledge/${foreignKnowledgeId}`,
      payload: { expectedRevision: 1, title: 'hijacked', content: 'hijacked content' }
    })
    expect(patch.statusCode).toBe(404)
    const archive = await app.app.inject({
      method: 'POST',
      url: `${ORG}/knowledge/${foreignKnowledgeId}/archive`,
      payload: { archived: true }
    })
    expect(archive.statusCode).toBe(404)
    // Positive control: the SAME verb and shape on the caller's own entry must
    // reach the handler. Without it a 404 from a mistyped route would read as a
    // passing fence assertion.
    const ownArchive = await app.app.inject({
      method: 'POST',
      url: `${ORG}/knowledge/${ownKnowledgeId}/archive`,
      payload: { archived: true }
    })
    expect(ownArchive.statusCode).toBe(200)
    await foreignKnowledgeUnmodified()
  })

  it('a foreign managed skill is unreachable through its read, revision, and archive routes', async () => {
    const app = build()
    expect(
      (await app.app.inject({ method: 'GET', url: `${ORG}/managed-skills/${foreignManagedSkillId}` })).statusCode
    ).toBe(404)
    expect(
      (await app.app.inject({ method: 'GET', url: `${ORG}/managed-skills/${foreignManagedSkillId}/revisions` }))
        .statusCode
    ).toBe(404)
    const archive = await app.app.inject({
      method: 'POST',
      url: `${ORG}/managed-skills/${foreignManagedSkillId}/archive`,
      payload: { archived: true }
    })
    expect(archive.statusCode).toBe(404)
    await foreignKnowledgeUnmodified()
  })

  it('neither knowledge list contains a foreign row', async () => {
    const app = build()
    const knowledge = await app.app.inject({ method: 'GET', url: `${ORG}/knowledge` })
    expect(knowledge.statusCode).toBe(200)
    const ids = (knowledge.json() as Array<{ id: string }>).map((k) => k.id)
    expect(ids).toContain(ownKnowledgeId)
    expect(ids).not.toContain(foreignKnowledgeId)

    const skills = await app.app.inject({ method: 'GET', url: `${ORG}/managed-skills` })
    expect(skills.statusCode).toBe(200)
    expect((skills.json() as Array<{ id: string }>).map((s) => s.id)).not.toContain(foreignManagedSkillId)
  })
})

describe('tenant isolation — MCP, skill-source and knowledge fences under the routes', () => {
  it('provider and skill-source reads and mutations treat a cross-org id like a missing row', async () => {
    const providers = new PgMcpProviderRepo(prisma)
    expect(await providers.get(CALLER_ORG, foreignProviderId)).toBeNull()
    expect(await providers.get(CALLER_ORG, ownProviderId)).not.toBeNull()
    await expect(providers.update(CALLER_ORG, foreignProviderId, { url: 'https://x.example.test' })).rejects.toThrow()
    await expect(
      providers.setSharing(CALLER_ORG, foreignProviderId, { visibility: 'restricted', sharedWith: [] })
    ).rejects.toThrow()
    await expect(providers.delete(CALLER_ORG, foreignProviderId)).rejects.toThrow()

    const sources = new PgSkillSourceRepo(prisma)
    expect(await sources.get(CALLER_ORG, foreignSkillSourceId)).toBeNull()
    expect(await sources.get(CALLER_ORG, ownSkillSourceId)).not.toBeNull()
    await expect(sources.update(CALLER_ORG, foreignSkillSourceId, { source: 'example-org/hijacked' })).rejects.toThrow()
    await expect(
      sources.setSharing(CALLER_ORG, foreignSkillSourceId, { visibility: 'restricted', sharedWith: [] })
    ).rejects.toThrow()
    // Delete answers 'deleted' — the same word an unknown id gets. Answering
    // 'referenced' would confirm the foreign row AND leak its agent enable-lists.
    expect(await sources.delete(CALLER_ORG, foreignSkillSourceId)).toBe('deleted')

    await foreignRegistriesUnmodified()
  })

  it('knowledge, managed-skill and suggestion reads and mutations treat a cross-org id like a missing row', async () => {
    const repo = new PgOrganizationKnowledgeRepo(prisma)

    expect(await repo.getKnowledge(CALLER_ORG, foreignKnowledgeId)).toBeNull()
    expect(await repo.getKnowledge(CALLER_ORG, ownKnowledgeId)).not.toBeNull()
    expect(await repo.getManagedSkill(CALLER_ORG, foreignManagedSkillId)).toBeNull()
    expect(await repo.getSuggestion(CALLER_ORG, randomUUID())).toBeNull()

    // The revision CAS and the fence share one `where`, so a cross-org id misses
    // exactly like a stale expectedRevision — null, and no revision row written.
    expect(
      await repo.updateKnowledge(
        CALLER_ORG,
        foreignKnowledgeId,
        1,
        { title: 'hijacked', content: 'hijacked content' },
        { source: 'manual' }
      )
    ).toBeNull()
    await expect(repo.setKnowledgeArchived(CALLER_ORG, foreignKnowledgeId, true)).rejects.toThrow()
    await expect(repo.setManagedSkillArchived(CALLER_ORG, foreignManagedSkillId, true)).rejects.toThrow()

    await foreignKnowledgeUnmodified()
  })
})

describe('tenant isolation — Session and webchat conversation over the REST surface', () => {
  it('point-GET of a foreign session id reads as absent (404)', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/sessions/${foreignSessionId}` })
    expect(res.statusCode).toBe(404)
  })

  it('the visibility write on a foreign session id is 404 and never bumps its revision', async () => {
    const app = build()
    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${foreignSessionId}/visibility`,
      payload: { visibility: 'private' }
    })
    expect(res.statusCode).toBe(404)
    await foreignSessionUnmodified()
  })

  it('the proxied transcript and tool-body reads of a foreign session id are 404', async () => {
    const app = build()
    expect(
      (await app.app.inject({ method: 'GET', url: `${ORG}/sessions/${foreignSessionId}/messages` })).statusCode
    ).toBe(404)
    expect(
      (
        await app.app.inject({
          method: 'GET',
          url: `${ORG}/sessions/${foreignSessionId}/tool-body?toolCallId=t1`
        })
      ).statusCode
    ).toBe(404)
  })

  it('the sessions list never contains a foreign row', async () => {
    const app = build()
    // `view=flat` is the ungrouped shape; the default groups rows by conversation.
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat` })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as { sessions?: Array<{ sessionId: string }> }).sessions?.map((s) => s.sessionId) ?? []
    expect(ids).toContain(ownSessionId)
    expect(ids).not.toContain(foreignSessionId)
  })
})

describe('tenant isolation — SessionRepo and WebchatConversationRepo fences under the routes', () => {
  it('session reads and the visibility write treat a cross-org id exactly like a missing row', async () => {
    const repo = new PgSessionRepo(prisma)

    expect(await repo.get(CALLER_ORG, SessionId(foreignSessionId))).toBeNull()
    expect(await repo.get(CALLER_ORG, SessionId(randomUUID()))).toBeNull()
    expect(await repo.get(CALLER_ORG, SessionId(ownSessionId))).not.toBeNull()

    // The fence rides the row-lock read, so a cross-org id takes the SILENT
    // no-op exit — not the `forbidden: true` the immutable-audience guard just
    // below would answer, which would confirm the foreign row exists.
    expect(await repo.setVisibility(CALLER_ORG, SessionId(foreignSessionId), 'private')).toEqual({ affected: [] })
    await foreignSessionUnmodified()

    // The unscoped read is the daemon escape hatch: `session/child-status`
    // resolves the parent a reporting daemon claims, then proves it owns it.
    expect(await repo.getUnscoped(SessionId(foreignSessionId))).not.toBeNull()
  })

  it('a tighten never follows session lineage across the tenancy boundary', async () => {
    const repo = new PgSessionRepo(prisma)
    // `parentSessionId` is a daemon-reported free string with NO foreign key, so
    // a session in ANOTHER org can name one of ours as its parent. Nothing stops
    // the claim from being made; what must hold is that our cascade ignores it.
    const rootId = randomUUID()
    await prisma.sessionMeta.create({
      data: {
        id: rootId,
        orgId: DEFAULT_ORG_ID,
        agentId: ownAgentId,
        platform: 'slack',
        channel: '#lineage',
        phase: 'start',
        visibility: 'org',
        lastActivityAt: new Date()
      }
    })
    const ownChildId = randomUUID()
    await prisma.sessionMeta.create({
      data: {
        id: ownChildId,
        orgId: DEFAULT_ORG_ID,
        agentId: ownAgentId,
        parentSessionId: rootId,
        platform: 'slack',
        channel: '#lineage',
        phase: 'start',
        visibility: 'org',
        lastActivityAt: new Date()
      }
    })
    const impostorChildId = randomUUID()
    await prisma.sessionMeta.create({
      data: {
        id: impostorChildId,
        orgId: foreignOrgId,
        agentId: foreignAgentId,
        parentSessionId: rootId, // the cross-org claim
        platform: 'slack',
        channel: '#lineage',
        phase: 'start',
        visibility: 'org',
        lastActivityAt: new Date()
      }
    })

    const { affected } = await repo.setVisibility(CALLER_ORG, SessionId(rootId), 'private')
    const affectedIds = affected.map((a) => a.id)
    expect(affectedIds).toContain(rootId)
    expect(affectedIds).toContain(ownChildId) // the real descendant IS rewritten
    expect(affectedIds).not.toContain(impostorChildId)

    // The impostor keeps its own audience and revision — it was neither rewritten
    // nor handed to the foreign org's daemon as a visibility push.
    const impostor = await prisma.sessionMeta.findUnique({ where: { id: impostorChildId } })
    expect(impostor!.visibility).toBe('org')
    expect(impostor!.visibilityRev).toBe(0)
    expect(impostor!.ownerIdentity).toBeNull()

    // The subtree the orchestrator pushes is confined the same way.
    const subtree = (await repo.visibilitySubtree(SessionId(rootId), 50)).map((row) => row.id)
    expect(subtree).toEqual(expect.arrayContaining([rootId, ownChildId]))
    expect(subtree).not.toContain(impostorChildId)
  })

  it('a foreign webchat conversation’s roster reads empty — the child fences through its parent', async () => {
    const repo = new PgWebchatConversationRepo(prisma)

    // Roster rows carry no org, so the fence is the relational filter on the
    // owning conversation. Empty is exactly what an unknown id returns, and
    // every caller fails closed on it.
    expect(await repo.participants(CALLER_ORG, foreignConversationId)).toEqual([])
    expect(await repo.participants(OrgId(foreignOrgId), foreignConversationId)).toHaveLength(1)

    // The mid-conversation join writes nothing for a cross-org id.
    await repo.addParticipant(CALLER_ORG, foreignConversationId, AgentId(ownAgentId), 'attacker')
    expect(await repo.participants(OrgId(foreignOrgId), foreignConversationId)).toHaveLength(1)
    expect(await prisma.webchatConversationAgent.count({ where: { conversationId: foreignConversationId } })).toBe(1)
  })
})

describe('tenant isolation — GitHub installations, memory connections and daemon keys', () => {
  // NOTE: the `/github/*` route tree self-disables when the GitHub App feature is
  // off, which it is in this harness — a 404 there would prove nothing about the
  // fence. The installation's tenancy is asserted at the repository instead (see
  // the fences block below); its route callers are held to `orgOf(req)` by the
  // tightened signature itself.

  it('a foreign external-memory connection is unreachable through its read and write routes', async () => {
    const app = build()
    const base = `${ORG}/external-memory-connections/${foreignMemoryConnectionId}`
    expect((await app.app.inject({ method: 'GET', url: base })).statusCode).toBe(404)
    const patch = await app.app.inject({ method: 'PATCH', url: base, payload: { config: { projectId: 'hijacked' } } })
    expect(patch.statusCode).toBe(404)
    const rotate = await app.app.inject({ method: 'POST', url: `${base}/grant/rotate` })
    expect(rotate.statusCode).toBe(404)
    expect((await app.app.inject({ method: 'DELETE', url: base })).statusCode).toBe(404)
    await foreignInfraUnmodified()
  })

  it('a foreign daemon’s key cannot be listed or revoked through the caller’s org', async () => {
    const app = build()
    const list = await app.app.inject({ method: 'GET', url: `${ORG}/daemons/${foreignDaemonId}/keys` })
    expect(list.statusCode).toBe(404)
    // The revoke route binds a raw key id to the org-fenced daemon key list, so
    // even a correct foreign key id reads as absent rather than being killed.
    const revoke = await app.app.inject({
      method: 'DELETE',
      url: `${ORG}/daemons/${foreignDaemonId}/keys/${foreignDaemonKeyId}`
    })
    expect(revoke.statusCode).toBe(404)
    // …and so does pairing it with a daemon the caller CAN see.
    const crossed = await app.app.inject({
      method: 'DELETE',
      url: `${ORG}/daemons/${ownDaemonId}/keys/${foreignDaemonKeyId}`
    })
    expect(crossed.statusCode).toBe(404)
    await foreignInfraUnmodified()
  })

  it('the connections list never contains a foreign row', async () => {
    const app = build()
    const connections = await app.app.inject({ method: 'GET', url: `${ORG}/external-memory-connections` })
    expect(connections.statusCode).toBe(200)
    expect(JSON.stringify(connections.json())).not.toContain(foreignMemoryConnectionId)
  })
})

describe('tenant isolation — installation, memory-connection and key fences under the routes', () => {
  it('these reads and mutations treat a cross-org id exactly like a missing row', async () => {
    const installations = new PgGithubInstallationRepo(prisma)
    expect(await installations.get(CALLER_ORG, foreignInstallationId)).toBeNull()
    // The doorbell lookup stays deliberately CROSS-ORG: resolving which
    // organization owns an installation is the whole point of that read.
    expect(await installations.getByInstallationId(987654321n)).not.toBeNull()

    const connections = new PgExternalMemoryConnectionRepo(prisma)
    expect(await connections.get(CALLER_ORG, foreignMemoryConnectionId)).toBeNull()
    expect(await connections.get(OrgId(foreignOrgId), foreignMemoryConnectionId)).not.toBeNull()
    await expect(
      connections.update(CALLER_ORG, foreignMemoryConnectionId, { config: { projectId: 'hijacked' } })
    ).rejects.toThrow()
    await expect(connections.delete(CALLER_ORG, foreignMemoryConnectionId)).rejects.toThrow()

    // The daemon key list is what the revoke route binds a raw key id against,
    // so its fence is what keeps a cross-tenant kill unreachable.
    const keys = new PgApiKeyRepo(prisma)
    expect(await keys.listForDaemon(CALLER_ORG, DaemonId(foreignDaemonId))).toEqual([])
    expect(await keys.listForDaemon(OrgId(foreignOrgId), DaemonId(foreignDaemonId))).toHaveLength(1)

    await foreignInfraUnmodified()
  })
})
