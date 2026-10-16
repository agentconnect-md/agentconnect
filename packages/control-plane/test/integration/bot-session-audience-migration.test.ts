import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, OrgId, SessionId } from '../../src/domain/ids.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'

it.each(['telegram', 'discord'] as const)(
  '%s history is fenced without replacing a direct child conversation audience',
  async (platform) => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const channel = platform === 'telegram' ? '-10042' : '100000000000000004'
    const root = await seedSessionMeta(prisma, `root-${randomUUID()}`, agentId, { platform, channel })
    const child = await seedSessionMeta(prisma, `child-${randomUUID()}`, agentId, {
      platform,
      channel: 'a2a:root',
      parentSessionId: root
    })
    const direct = await seedSessionMeta(prisma, `direct-${randomUUID()}`, agentId, {
      platform,
      channel: '12345',
      parentSessionId: root
    })
    await prisma.sessionMeta.update({ where: { id: child }, data: { visibilitySource: 'inherited' } })
    const migration = readFileSync(
      new URL(
        '../../prisma/migrations/20261120000000_telegram_discord_session_audience/migration.sql',
        import.meta.url
      ),
      'utf8'
    )
    await prisma.$executeRawUnsafe(migration)
    const repo = new PgSessionRepo(prisma)
    const orgId = OrgId(DEFAULT_ORG_ID)
    expect(await repo.getExternalAccessPolicy(orgId, platform)).toMatchObject({ state: 'disabled', currentRev: 0n })
    const before = await repo.listPage({
      agentIds: [AgentId(agentId)],
      limit: 10,
      includeTotal: false,
      viewer: {
        role: 'owner',
        identitySet: [],
        externalAccess: {
          policies: [{ provider: platform, readFenceRev: null }],
          allowedScopes: [],
          decisionAt: new Date()
        }
      }
    })
    expect(before.sessions.map((session) => session.id).sort()).toEqual([root, child, direct].sort())
    expect((await repo.setExternalAccessEnabled(orgId, platform, true)).hiddenSessions).toBe(3)
    for (const id of [root, child, direct])
      expect(await repo.getUnscoped(SessionId(id))).toMatchObject({
        visibility: 'external',
        externalProvider: platform,
        externalResolution: 'pending'
      })

    await repo.recordMilestone({
      sessionId: SessionId(root),
      agentId: AgentId(agentId),
      platform,
      channel,
      phase: 'start',
      at: new Date(),
      classification: { visibility: 'org', ownerIdentity: null, source: 'default' },
      externalCandidate: {
        provider: platform,
        resolution: 'settled',
        scope: {
          realmKey: 'bot42',
          resourceKind: 'conversation',
          resourceKey: channel,
          credentialKind: 'bot',
          credentialId: randomUUID()
        }
      }
    })
    const bound = await repo.getUnscoped(SessionId(root))
    expect(bound?.externalResolution).toBe('settled')
    expect(await repo.getUnscoped(SessionId(child))).toMatchObject({
      externalScopeId: bound!.externalScopeId,
      externalResolution: 'settled'
    })
    expect(await repo.getUnscoped(SessionId(direct))).toMatchObject({
      externalScopeId: null,
      externalResolution: 'pending'
    })
  }
)
