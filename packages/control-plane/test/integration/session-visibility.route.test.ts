/**
 * Session visibility end-to-end (docs/designs/session-visibility.md §9).
 *
 * Exercises the CP read gates, the §4.3 reclassification endpoint, and the §4.5
 * cascade semantics against real Postgres and the real HTTP stack. Under devAuth
 * the principal is fixed, so a second app built with `{ DEFAULT_OWNER_ID }` is
 * how we "act as" another member — same idiom as visibility.route.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedDutyGroup, seedSessionMeta } from '../fixtures/seed.js'
import { seedPoolMember } from '../fakes/member-set.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import { PlacementResolver } from '../../src/orchestrator/placementResolver.js'
import { SessionVisibilityPushService, SNAPSHOT_CHUNK } from '../../src/orchestrator/visibilityPush.js'
import { systemClock } from '../../src/domain/clock.js'
import { SESSION_VISIBILITY_FEATURE, SLACK_SESSION_AUDIENCE_FEATURE } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, OrgId, SessionId } from '../../src/domain/ids.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const users = () => new PgUserRepo(prisma)
const opened: HttpApp[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const email = `${sub}@acme.dev`
  const { userId } = await users().provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users().addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

function appAs(userId: string, deps?: Parameters<typeof buildHttpApp>[4]): HttpApp {
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId }, undefined, undefined, deps)
  opened.push(app)
  return app
}

const sessionIds = (body: unknown): string[] =>
  (body as { sessions: Array<{ sessionId: string }> }).sessions.map((s) => s.sessionId)

describe('session visibility — list & detail', () => {
  it('shows a handoff Session across a hidden Agent boundary without exposing the Agent', async () => {
    const viewer = await makeUser(`sv-hidden-agent-${randomUUID()}`, 'collaborator')
    const selectedViewer = await makeUser(`sv-selected-agent-${randomUUID()}`, 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const supportAgent = await seedAgent(prisma, randomUUID(), { daemonId, name: 'support-agent' })
    const paymentsAgent = await seedAgent(prisma, randomUUID(), {
      daemonId,
      name: 'payments-agent',
      visibility: 'restricted',
      sharedWith: [selectedViewer]
    })
    const parent = await seedSessionMeta(prisma, `s-support-${randomUUID()}`, supportAgent, {})
    const child = await seedSessionMeta(prisma, `s-payments-${randomUUID()}`, paymentsAgent, {
      parentSessionId: parent
    })
    const app = appAs(viewer)

    // The Agent resource stays hidden, including its configuration/workspace.
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/agents/${paymentsAgent}` })).statusCode).toBe(404)

    // The Session audience is independent. A direct hidden-Agent filter remains
    // valid and returns only Session-scoped metadata, including a display name.
    const list = (
      await app.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat&agentId=${paymentsAgent}` })
    ).json() as { sessions: Array<{ sessionId: string; agentName: string | null }> }
    expect(list.sessions).toEqual([expect.objectContaining({ sessionId: child, agentName: 'payments-agent' })])

    const childDetail = await app.app.inject({ method: 'GET', url: `${ORG}/sessions/${child}` })
    expect(childDetail.statusCode).toBe(200)
    expect(childDetail.json()).toMatchObject({
      id: child,
      agentId: paymentsAgent,
      agentName: 'payments-agent',
      parentSession: { id: parent, agentId: supportAgent, agentName: 'support-agent' }
    })

    const parentDetail = (await app.app.inject({ method: 'GET', url: `${ORG}/sessions/${parent}` })).json() as {
      childSessions: Array<{ id: string; agentId: string; agentName: string | null }>
    }
    expect(parentDetail.childSessions).toEqual([
      expect.objectContaining({ id: child, agentId: paymentsAgent, agentName: 'payments-agent' })
    ])
  })

  it('a collaborator sees org sessions and their own private ones, never another member’s', async () => {
    const mine = await makeUser('sv-mine', 'collaborator')
    const theirs = await makeUser('sv-theirs', 'collaborator')
    const owner = await makeUser('sv-owner', 'owner')

    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const orgSession = await seedSessionMeta(prisma, `s-org-${randomUUID()}`, agentId, {})
    const ownSession = await seedSessionMeta(prisma, `s-own-${randomUUID()}`, agentId, {
      visibility: 'private',
      ownerIdentity: `user:${mine}`
    })
    const otherSession = await seedSessionMeta(prisma, `s-other-${randomUUID()}`, agentId, {
      visibility: 'private',
      ownerIdentity: `user:${theirs}`
    })
    // No resolvable owner (ownerIdentity null — nothing for identity linking
    // to match, unlike a §2 owner-orphan's stored tuple): visible to no one.
    const orphanSession = await seedSessionMeta(prisma, `s-orphan-${randomUUID()}`, agentId, {
      visibility: 'private'
    })

    const mineApp = appAs(mine)
    const listed = sessionIds((await mineApp.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat` })).json())
    expect(listed).toEqual(expect.arrayContaining([orgSession, ownSession]))
    expect(listed).not.toContain(otherSession)
    expect(listed).not.toContain(orphanSession)

    // Detail is 404 (never 403) for a session the caller cannot see.
    expect((await mineApp.app.inject({ method: 'GET', url: `${ORG}/sessions/${ownSession}` })).statusCode).toBe(200)
    expect((await mineApp.app.inject({ method: 'GET', url: `${ORG}/sessions/${otherSession}` })).statusCode).toBe(404)
    expect((await mineApp.app.inject({ method: 'GET', url: `${ORG}/sessions/${orphanSession}` })).statusCode).toBe(404)

    // No governance override on sessions: an org owner filters exactly like any
    // other member — a private transcript is its owner's, role grants nothing.
    const ownerApp = appAs(owner)
    const asOwner = sessionIds((await ownerApp.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat` })).json())
    expect(asOwner).toContain(orgSession)
    expect(asOwner).not.toContain(ownSession)
    expect(asOwner).not.toContain(otherSession)
    expect(asOwner).not.toContain(orphanSession)
    expect((await ownerApp.app.inject({ method: 'GET', url: `${ORG}/sessions/${otherSession}` })).statusCode).toBe(404)
  })

  it('reports orgHasSessions even when every session is hidden from the caller', async () => {
    const viewer = await makeUser('sv-ohs-viewer', 'collaborator')
    const other = await makeUser('sv-ohs-other', 'collaborator')

    // Before any session exists: the boolean is present and false on the first page.
    const viewerApp = appAs(viewer)
    const emptyPage = (await viewerApp.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat` })).json() as {
      sessions: unknown[]
      orgHasSessions?: boolean
    }
    expect(emptyPage.orgHasSessions).toBe(false)

    // The org's ONLY session is another member's private one — invisible to the
    // viewer, but the bare boolean still reports the org has sessions, so the
    // getting-started conversation step doesn't ask for a redundant chat.
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    await seedSessionMeta(prisma, `s-ohs-${randomUUID()}`, agentId, {
      visibility: 'private',
      ownerIdentity: `user:${other}`
    })
    const page = (await viewerApp.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat` })).json() as {
      sessions: unknown[]
      orgHasSessions?: boolean
    }
    expect(page.sessions).toHaveLength(0)
    expect(page.orgHasSessions).toBe(true)
  })

  it('keeps keyset pagination stable under the visibility predicate', async () => {
    const viewer = await makeUser('sv-page', 'collaborator')
    const other = await makeUser('sv-page-other', 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })

    // Interleave visible and hidden rows so a page boundary lands mid-run.
    const visible: string[] = []
    for (let i = 0; i < 6; i++) {
      const at = new Date(Date.now() - i * 1000)
      const isHidden = i % 2 === 1
      const id = await seedSessionMeta(prisma, `s-page-${i}-${randomUUID()}`, agentId, {
        lastActivityAt: at,
        ...(isHidden ? { visibility: 'private' as const, ownerIdentity: `user:${other}` } : {})
      })
      if (!isHidden) visible.push(id)
    }

    const app = appAs(viewer)
    const collected: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const url = `${ORG}/sessions?view=flat&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const body = (await app.app.inject({ method: 'GET', url })).json() as {
        sessions: Array<{ sessionId: string }>
        nextCursor: string | null
      }
      collected.push(...body.sessions.map((s) => s.sessionId))
      cursor = body.nextCursor
      if (!cursor) break
    }
    // Every visible row exactly once, newest-first, with no hidden row leaking.
    expect(collected).toEqual(visible)
  })

  it('hides private relatives from the detail relationship links', async () => {
    const viewer = await makeUser('sv-rel', 'collaborator')
    const other = await makeUser('sv-rel-other', 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })

    const parent = await seedSessionMeta(prisma, `s-parent-${randomUUID()}`, agentId, {})
    const visibleChild = await seedSessionMeta(prisma, `s-child-ok-${randomUUID()}`, agentId, {
      parentSessionId: parent
    })
    const hiddenChild = await seedSessionMeta(prisma, `s-child-hidden-${randomUUID()}`, agentId, {
      parentSessionId: parent,
      visibility: 'private',
      ownerIdentity: `user:${other}`
    })

    const body = (await appAs(viewer).app.inject({ method: 'GET', url: `${ORG}/sessions/${parent}` })).json() as {
      childSessions: Array<{ id: string }>
    }
    expect(body.childSessions.map((c) => c.id)).toEqual([visibleChild])
    expect(body.childSessions.map((c) => c.id)).not.toContain(hiddenChild)

    const visibleChildBody = (
      await appAs(viewer).app.inject({ method: 'GET', url: `${ORG}/sessions/${visibleChild}` })
    ).json() as { siblingSessions: Array<{ id: string }> }
    expect(visibleChildBody.siblingSessions).toEqual([])
  })
})

describe('session visibility — external conversation audiences', () => {
  it('keeps a provider-bound p2p owner-only until live audience sync is enabled', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const sessionId = `s-feishu-p2p-${randomUUID()}`
    const ownerIdentity = 'feishu:lark:cli_custom:on_owner'
    const repo = new PgSessionRepo(prisma)
    const recorded = await repo.recordMilestone({
      sessionId: SessionId(sessionId),
      agentId,
      phase: 'start',
      platform: 'feishu',
      channel: 'oc_p2p',
      at: new Date(),
      classification: { visibility: 'private', ownerIdentity, source: 'default' },
      externalCandidate: {
        provider: 'feishu',
        resolution: 'settled',
        scope: {
          realmKey: 'lark:cli_custom',
          resourceKind: 'conversation',
          resourceKey: 'oc_p2p',
          credentialKind: 'bot',
          credentialId: randomUUID()
        }
      }
    })
    expect(recorded.session).toMatchObject({ visibility: 'private', externalProvider: 'feishu' })
    const [scope] = await repo.getExternalScopes([recorded.session!.externalScopeId!])

    const baseline = {
      role: 'collaborator' as const,
      identitySet: [ownerIdentity],
      externalAccess: {
        policies: [{ provider: 'feishu', readFenceRev: null }],
        allowedScopes: [],
        decisionAt: new Date()
      }
    }
    expect(
      (await repo.listPage({ agentIds: [agentId], limit: 10, includeTotal: false, viewer: baseline })).sessions.map(
        (session) => session.id
      )
    ).toEqual([sessionId])
    expect(
      (
        await repo.listPage({
          agentIds: [agentId],
          limit: 10,
          includeTotal: false,
          viewer: { ...baseline, identitySet: [] }
        })
      ).sessions
    ).toHaveLength(0)
    const enabled = await repo.setExternalAccessEnabled(OrgId(DEFAULT_ORG_ID), 'feishu', true)
    const external = await repo.getUnscoped(SessionId(sessionId))
    expect(external).toMatchObject({ visibility: 'external', externalProvider: 'feishu' })
    expect(
      (
        await repo.listPage({
          agentIds: [agentId],
          limit: 10,
          includeTotal: false,
          viewer: {
            ...baseline,
            identitySet: [],
            externalAccess: {
              policies: [{ provider: 'feishu', readFenceRev: enabled.policy.readFenceRev }],
              allowedScopes: [{ id: scope!.id, aclRevision: scope!.aclRevision }],
              decisionAt: new Date()
            }
          }
        })
      ).sessions.map((session) => session.id)
    ).toEqual([sessionId])
  })

  it('reports the verified Lark region for an inherited Feishu-provider session', async () => {
    const viewer = await makeUser(`sv-lark-region-${randomUUID()}`, 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)
    const parentId = `s-lark-parent-${randomUUID()}`
    const childId = `s-lark-child-${randomUUID()}`

    await repo.recordMilestone({
      sessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      platform: 'feishu',
      channel: 'oc_lark',
      at: new Date(),
      classification: { visibility: 'private', ownerIdentity: `user:${viewer}`, source: 'default' },
      externalCandidate: {
        provider: 'feishu',
        resolution: 'settled',
        scope: {
          realmKey: 'lark:cli_custom',
          resourceKind: 'conversation',
          resourceKey: 'oc_lark',
          credentialKind: 'bot',
          credentialId: randomUUID()
        }
      }
    })
    const child = await repo.recordMilestone({
      sessionId: SessionId(childId),
      parentSessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      platform: 'dream',
      channel: 'a2a',
      at: new Date(),
      classification: { inherit: true }
    })
    expect(child.session).toMatchObject({
      externalProvider: 'feishu',
      externalResolution: 'settled',
      tenantScope: null
    })

    const response = await appAs(viewer).app.inject({ method: 'GET', url: `${ORG}/sessions/${childId}` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ feishuRegion: 'lark' })
  })

  it('lets only owners change sync and withholds hidden-session diagnostics from other members', async () => {
    const owner = await makeUser(`sv-slack-owner-${randomUUID()}`, 'owner')
    const collaborator = await makeUser(`sv-slack-collab-${randomUUID()}`, 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)
    await repo.recordMilestone({
      sessionId: SessionId(`s-slack-hidden-${randomUUID()}`),
      agentId,
      phase: 'start',
      platform: 'slack',
      channel: 'C_UNRESOLVED',
      at: new Date(),
      classification: { visibility: 'org', ownerIdentity: null, source: 'default' },
      externalCandidate: { provider: 'slack', resolution: 'pending' }
    })

    const collaboratorApp = appAs(collaborator)
    const read = (await collaboratorApp.app.inject({ method: 'GET', url: `${ORG}/session-access/slack` })).json()
    expect(read).not.toHaveProperty('hiddenSessions')
    expect(
      (
        await collaboratorApp.app.inject({
          method: 'PUT',
          url: `${ORG}/session-access/slack`,
          payload: { enabled: true }
        })
      ).statusCode
    ).toBe(403)

    const unavailable = await appAs(owner).app.inject({
      method: 'PUT',
      url: `${ORG}/session-access/slack`,
      payload: { enabled: true }
    })
    expect(unavailable.statusCode).toBe(409)

    const ownerResponse = await appAs(owner, {
      sessionAccessPlugins: [
        { provider: 'slack', available: true, resolve: async () => ({ allowedScopes: [], degraded: false }) }
      ]
    }).app.inject({
      method: 'PUT',
      url: `${ORG}/session-access/slack`,
      payload: { enabled: true }
    })
    expect(ownerResponse.statusCode).toBe(200)
    // The pre-existing candidate stays hidden and is reported, but enabling
    // marks it legacy: unrecoverable history is not a fault state.
    expect(ownerResponse.json()).toMatchObject({ enabled: true, state: 'enabled', hiddenSessions: 1 })

    const stillHidden = (
      await appAs(owner, {
        sessionAccessPlugins: [
          { provider: 'slack', available: true, resolve: async () => ({ allowedScopes: [], degraded: false }) }
        ]
      }).app.inject({ method: 'GET', url: `${ORG}/session-access/slack` })
    ).json()
    expect(stillHidden).toMatchObject({ state: 'enabled', hiddenSessions: 1 })
  })

  it('degrades only when a candidate goes unresolved after enablement', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)
    const legacySessionId = `s-slack-legacy-${randomUUID()}`
    await repo.recordMilestone({
      sessionId: SessionId(legacySessionId),
      agentId,
      phase: 'start',
      platform: 'slack',
      channel: 'C_LEGACY',
      at: new Date(),
      classification: { visibility: 'org', ownerIdentity: null, source: 'default' },
      externalCandidate: { provider: 'slack', resolution: 'pending' }
    })

    const enabled = await repo.setExternalAccessEnabled(OrgId(DEFAULT_ORG_ID), 'slack', true)
    expect(enabled).toMatchObject({ hiddenSessions: 1 })
    expect(enabled.policy).toMatchObject({ state: 'enabled' })

    // A candidate that fails to resolve AFTER enablement carries no legacy mark
    // — that one IS actionable.
    await repo.recordMilestone({
      sessionId: SessionId(`s-slack-new-${randomUUID()}`),
      agentId,
      phase: 'start',
      platform: 'slack',
      channel: 'C_NEW',
      at: new Date(),
      classification: { visibility: 'org', ownerIdentity: null, source: 'default' },
      externalCandidate: { provider: 'slack', resolution: 'pending' }
    })
    expect((await repo.getExternalAccessPolicy(OrgId(DEFAULT_ORG_ID), 'slack'))?.state).toBe('degraded')

    // Turnover must not absolve the live failure: settling the LEGACY candidate
    // leaves the post-enable one unresolved, so the policy stays degraded. An
    // aggregate low-water mark would read "back to one unresolved row" here and
    // silently return to 'enabled'.
    await repo.recordMilestone({
      sessionId: SessionId(legacySessionId),
      agentId,
      phase: 'plan',
      platform: 'slack',
      channel: 'C_LEGACY',
      at: new Date(),
      classification: { visibility: 'org', ownerIdentity: null, source: 'default' },
      externalCandidate: {
        provider: 'slack',
        resolution: 'settled',
        scope: {
          realmKey: 'T_INSTALL',
          resourceKind: 'conversation',
          resourceKey: 'C_LEGACY',
          credentialKind: 'bot',
          credentialId: randomUUID()
        }
      }
    })
    expect(await repo.countExternalUnresolved(OrgId(DEFAULT_ORG_ID), 'slack')).toBe(1)
    expect((await repo.getExternalAccessPolicy(OrgId(DEFAULT_ORG_ID), 'slack'))?.state).toBe('degraded')
  })

  // §4.2 direct destination: a child whose coordinates are its OWN conversation (an agent's
  // channel-ROOT post) reports a settled classification instead of `inherit`. It keeps the
  // parent for lineage, but must not take the parent's audience — a DM seeded from a public
  // channel session would otherwise be readable by that channel's audience.
  it('keeps a direct-destination child out of its parent audience while keeping the lineage', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)
    const parentId = `s-dd-parent-${randomUUID()}`
    const childId = `s-dd-child-${randomUUID()}`

    // The origin turn: an org-visible Slack channel session with a human owner.
    await seedSessionMeta(prisma, parentId, agentId, {
      daemonId,
      channel: 'C_ORIGIN',
      ownerIdentity: 'slack:T1:U1'
    })

    const child = await repo.recordMilestone({
      sessionId: SessionId(childId),
      parentSessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      platform: 'slack',
      channel: 'D_PEER',
      at: new Date(),
      classification: { visibility: 'private', ownerIdentity: null, source: 'default' }
    })
    expect(child.session).toMatchObject({
      parentSessionId: parentId,
      visibility: 'private',
      ownerIdentity: null,
      // Not `inherited`/`inherited_pending`: this row classified itself, so no settlement
      // scan will ever hand it the parent's audience either.
      visibilitySource: 'default',
      externalProvider: null,
      externalScopeId: null
    })
  })

  // …but a TIGHTENED parent still reaches it: the §4.3 cascade rewrites every descendant it
  // can see, so a row that classifies itself must land in the same state whether it arrives
  // before the tightening (cascade catches it) or after (this path applies it). Otherwise the
  // outcome is commit-order dependent.
  it('applies a tightened parent to a direct-destination child that arrives after the cascade', async () => {
    const owner = await makeUser('sv-dd-tighten', 'owner')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)
    const parentId = `s-dd-tight-parent-${randomUUID()}`
    const early = `s-dd-tight-early-${randomUUID()}`
    const late = `s-dd-tight-late-${randomUUID()}`

    await seedSessionMeta(prisma, parentId, agentId, { daemonId, ownerIdentity: `user:${owner}` })
    const settled = { visibility: 'org' as const, ownerIdentity: null, source: 'default' as const }
    // One child arrives BEFORE the tightening and is swept by the cascade…
    await repo.recordMilestone({
      sessionId: SessionId(early),
      parentSessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      platform: 'slack',
      channel: 'C_POSTED',
      at: new Date(),
      classification: settled
    })
    await appAs(owner).app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${parentId}/visibility`,
      payload: { visibility: 'private' }
    })
    // …the other arrives after it, and must not read as the wider row the cascade already removed.
    const after = await repo.recordMilestone({
      sessionId: SessionId(late),
      parentSessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      platform: 'slack',
      channel: 'C_POSTED',
      at: new Date(),
      classification: settled
    })
    const expected = { visibility: 'private', ownerIdentity: `user:${owner}`, visibilitySource: 'inherited' }
    expect(await prisma.sessionMeta.findUnique({ where: { id: early } })).toMatchObject(expected)
    expect(after.session).toMatchObject(expected)
  })

  // The post-commit settlement path (§4.5) inherits the parent's audience after
  // the child's own transaction closed — including the interleaving where the
  // parent lands and is stamped legacy in between. Provenance must ride along, or
  // the child settles as an unmarked unresolved row and reports a live failure
  // that never happened.
  it('carries legacy provenance through out-of-order parent settlement', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)
    const parentId = `s-slack-parent-${randomUUID()}`
    const childId = `s-slack-child-${randomUUID()}`
    const credentialId = randomUUID()

    // The child arrives first and finds no parent: private + inherited_pending.
    const orphan = await repo.recordMilestone({
      sessionId: SessionId(childId),
      parentSessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      platform: 'slack',
      channel: 'C_LEGACY',
      at: new Date(),
      classification: { inherit: true }
    })
    expect(orphan.session).toMatchObject({ visibilitySource: 'inherited_pending', externalProvider: null })

    // The parent lands as an unresolved Slack candidate (seeded directly so it
    // does not settle the child on the way in), and enabling stamps it legacy.
    await seedSessionMeta(prisma, parentId, agentId, { daemonId, channel: 'C_LEGACY' })
    await prisma.sessionMeta.update({
      where: { id: parentId },
      // classifiedPolicyRev is required by session_meta_external_shape_check
      // whenever a provider is set; 0 is the pre-enable policy revision.
      data: { externalProvider: 'slack', externalResolution: 'pending', classifiedPolicyRev: 0n }
    })
    const enabled = await repo.setExternalAccessEnabled(OrgId(DEFAULT_ORG_ID), 'slack', true)
    expect(enabled.policy.state).toBe('enabled')

    // Now the child's settlement runs and copies the parent's audience.
    await repo.recordMilestone({
      sessionId: SessionId(childId),
      parentSessionId: SessionId(parentId),
      agentId,
      phase: 'plan',
      platform: 'slack',
      channel: 'C_LEGACY',
      at: new Date(),
      classification: { inherit: true }
    })
    expect(await repo.getUnscoped(SessionId(childId))).toMatchObject({
      visibilitySource: 'inherited',
      externalProvider: 'slack',
      externalResolution: 'pending',
      legacyUnresolved: true
    })

    // Settling the parent forces a policy recomputation: the inherited child is
    // expected backlog, so nothing degrades.
    await repo.recordMilestone({
      sessionId: SessionId(parentId),
      agentId,
      phase: 'plan',
      platform: 'slack',
      channel: 'C_LEGACY',
      at: new Date(),
      classification: { visibility: 'org', ownerIdentity: null, source: 'default' },
      externalCandidate: {
        provider: 'slack',
        resolution: 'settled',
        scope: {
          realmKey: 'T_INSTALL',
          resourceKind: 'conversation',
          resourceKey: 'C_LEGACY',
          credentialKind: 'bot',
          credentialId
        }
      }
    })
    expect((await repo.getExternalAccessPolicy(OrgId(DEFAULT_ORG_ID), 'slack'))?.state).toBe('enabled')
  })

  it('keeps the creation-time scope fixed and applies current membership only after enable', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const sessionId = `s-slack-scope-${randomUUID()}`
    const credentialId = randomUUID()
    const repo = new PgSessionRepo(prisma)
    const pending = await repo.recordMilestone({
      sessionId: SessionId(sessionId),
      agentId: AgentId(agentId),
      phase: 'start',
      platform: 'slack',
      channel: 'C_PRIVATE',
      at: new Date(),
      // A migration-marked shared row may retain a legacy explicit source. Once
      // it carries the external candidate marker, that source is provenance,
      // not authority, and a trusted retry must still settle its scope.
      classification: { visibility: 'org', ownerIdentity: null, source: 'explicit' },
      externalCandidate: {
        provider: 'slack',
        resolution: 'pending'
      }
    })
    expect(pending.session).toMatchObject({
      visibility: 'org',
      externalProvider: 'slack',
      externalResolution: 'pending'
    })

    const recorded = await repo.recordMilestone({
      sessionId: SessionId(sessionId),
      agentId: AgentId(agentId),
      phase: 'plan',
      platform: 'slack',
      channel: 'C_PRIVATE',
      at: new Date(),
      classification: { visibility: 'org', ownerIdentity: null, source: 'default' },
      externalCandidate: {
        provider: 'slack',
        resolution: 'settled',
        scope: {
          realmKey: 'T_INSTALL',
          resourceKind: 'conversation',
          resourceKey: 'C_PRIVATE',
          credentialKind: 'bot',
          credentialId
        }
      }
    })
    expect(recorded.session).toMatchObject({
      visibility: 'org',
      externalProvider: 'slack',
      externalResolution: 'settled'
    })

    const baselineViewer = {
      role: 'owner' as const,
      identitySet: [],
      externalAccess: {
        policies: [{ provider: 'slack', readFenceRev: null }],
        allowedScopes: [],
        decisionAt: new Date()
      }
    }
    expect(
      (await repo.listPage({ agentIds: [AgentId(agentId)], limit: 10, includeTotal: false, viewer: baselineViewer }))
        .sessions
    ).toHaveLength(1)

    const enabled = await repo.setExternalAccessEnabled(OrgId(DEFAULT_ORG_ID), 'slack', true)
    expect(enabled.policy.state).toBe('enabled')
    const external = await repo.getUnscoped(SessionId(sessionId))
    expect(external).toMatchObject({ visibility: 'external', externalResolution: 'settled' })

    const denied = await repo.listPage({
      agentIds: [AgentId(agentId)],
      limit: 10,
      includeTotal: false,
      viewer: {
        ...baselineViewer,
        externalAccess: {
          policies: [{ provider: 'slack', readFenceRev: enabled.policy.readFenceRev }],
          allowedScopes: [],
          decisionAt: new Date()
        }
      }
    })
    expect(denied.sessions).toHaveLength(0)

    const [scope] = await repo.getExternalScopes([external!.externalScopeId!])
    const allowed = await repo.listPage({
      agentIds: [AgentId(agentId)],
      limit: 10,
      includeTotal: false,
      viewer: {
        ...baselineViewer,
        externalAccess: {
          policies: [{ provider: 'slack', readFenceRev: enabled.policy.readFenceRev }],
          allowedScopes: [{ id: scope!.id, aclRevision: scope!.aclRevision }],
          decisionAt: new Date()
        }
      }
    })
    expect(allowed.sessions.map((session) => session.id)).toEqual([sessionId])

    const repeated = await repo.setExternalAccessEnabled(OrgId(DEFAULT_ORG_ID), 'slack', true)
    expect(repeated.policy.currentRev).toBe(enabled.policy.currentRev)
    expect(repeated.affected).toEqual([])

    const retrySessionId = `s-slack-retry-${randomUUID()}`
    await repo.recordMilestone({
      sessionId: SessionId(retrySessionId),
      agentId: AgentId(agentId),
      phase: 'start',
      platform: 'slack',
      channel: 'C_RETRY',
      at: new Date(),
      classification: { visibility: 'org', ownerIdentity: null, source: 'default' },
      externalCandidate: { provider: 'slack', resolution: 'pending' }
    })
    expect((await repo.getExternalAccessPolicy(OrgId(DEFAULT_ORG_ID), 'slack'))?.state).toBe('degraded')

    await repo.recordMilestone({
      sessionId: SessionId(retrySessionId),
      agentId: AgentId(agentId),
      phase: 'plan',
      platform: 'slack',
      channel: 'C_RETRY',
      at: new Date(),
      classification: { visibility: 'org', ownerIdentity: null, source: 'default' },
      externalCandidate: {
        provider: 'slack',
        resolution: 'settled',
        scope: {
          realmKey: 'T_INSTALL',
          resourceKind: 'conversation',
          resourceKey: 'C_RETRY',
          credentialKind: 'bot',
          credentialId
        }
      }
    })
    expect((await repo.getExternalAccessPolicy(OrgId(DEFAULT_ORG_ID), 'slack'))?.state).toBe('enabled')
  })

  it('stops showing the sessions synced while sync was on once it is turned back off', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const sessionId = `s-slack-offswitch-${randomUUID()}`
    const repo = new PgSessionRepo(prisma)
    const record = (channel: string, id: string) =>
      repo.recordMilestone({
        sessionId: SessionId(id),
        agentId: AgentId(agentId),
        phase: 'start',
        platform: 'slack',
        channel,
        at: new Date(),
        classification: { visibility: 'org', ownerIdentity: null, source: 'default' },
        externalCandidate: {
          provider: 'slack',
          resolution: 'settled',
          scope: {
            realmKey: 'T_INSTALL',
            resourceKind: 'conversation',
            resourceKey: channel,
            credentialKind: 'bot',
            credentialId: randomUUID()
          }
        }
      })
    const viewerWith = (readFenceRev: bigint | null, allowedScopes: { id: string; aclRevision: bigint }[]) => ({
      role: 'owner' as const,
      identitySet: [],
      externalAccess: { policies: [{ provider: 'slack', readFenceRev }], allowedScopes, decisionAt: new Date() }
    })
    const visible = async (viewer: ReturnType<typeof viewerWith>) =>
      (await repo.listPage({ agentIds: [AgentId(agentId)], limit: 10, includeTotal: false, viewer })).sessions.map(
        (session) => session.id
      )

    // Sync off from the start: the candidate keeps its `org` baseline and the
    // provider arm — not the direct arm, which requires a NULL provider — is
    // what makes it visible to the whole org.
    await record('C_BEFORE', sessionId)
    expect(await repo.getUnscoped(SessionId(sessionId))).toMatchObject({
      visibility: 'org',
      externalProvider: 'slack'
    })
    expect(await visible(viewerWith(null, []))).toEqual([sessionId])

    // On: the row binds to the platform audience and needs the granted scope.
    const enabled = await repo.setExternalAccessEnabled(OrgId(DEFAULT_ORG_ID), 'slack', true)
    const bound = await repo.getUnscoped(SessionId(sessionId))
    expect(bound).toMatchObject({ visibility: 'external' })
    const [scope] = await repo.getExternalScopes([bound!.externalScopeId!])
    const granted = [{ id: scope!.id, aclRevision: scope!.aclRevision }]
    expect(await visible(viewerWith(enabled.policy.readFenceRev, granted))).toEqual([sessionId])

    // Off again: the row is untouched, but nobody is maintaining that audience
    // any more, so it stops showing even for the viewer who still holds the
    // grant. This is the half the settings copy has to state out loud.
    const disabled = await repo.setExternalAccessEnabled(OrgId(DEFAULT_ORG_ID), 'slack', false)
    expect(disabled.policy.state).toBe('disabled')
    expect(await repo.getUnscoped(SessionId(sessionId))).toMatchObject({ visibility: 'external' })
    expect(await visible(viewerWith(disabled.policy.readFenceRev, granted))).toEqual([])

    // …and a session created while off is org-visible again, so turning sync
    // off never leaves the org with nothing to look at.
    const afterId = `s-slack-after-${randomUUID()}`
    await record('C_AFTER', afterId)
    expect(await visible(viewerWith(disabled.policy.readFenceRev, granted))).toEqual([afterId])

    // Re-enabling restores the synced history — "hidden", never deleted.
    const reEnabled = await repo.setExternalAccessEnabled(OrgId(DEFAULT_ORG_ID), 'slack', true)
    const restored = await repo.getExternalScopes([bound!.externalScopeId!])
    expect(
      await visible(
        viewerWith(
          reEnabled.policy.readFenceRev,
          restored.map((row) => ({ id: row.id, aclRevision: row.aclRevision }))
        )
      )
    ).toContain(sessionId)
  })
})

describe('session visibility — membership across an agent filter', () => {
  it('resolves the scopes of members the filter excluded, so membership does not lose them', async () => {
    // A conversation where A is org-visible and B is visible ONLY through the
    // Slack audience. Filtering the list to A still has to report B as a member
    // (merged-conversation-view.md §5.2) — and that only works if B's scope was
    // resolved, because the membership query is authorized against the viewer
    // snapshot built from those scopes. Resolve scopes over the narrower filter
    // and B is dropped for having been filtered out, not for being invisible.
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentA = await seedAgent(prisma, randomUUID(), { daemonId })
    const agentB = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)
    const credentialId = randomUUID()
    const thread = `T-${randomUUID()}`
    const sessionA = `s-mix-a-${randomUUID()}`
    const sessionB = `s-mix-b-${randomUUID()}`

    await repo.recordMilestone({
      sessionId: SessionId(sessionA),
      agentId: AgentId(agentA),
      phase: 'start',
      platform: 'slack',
      channel: 'C_MIXED',
      thread,
      at: new Date(1_000),
      classification: { visibility: 'org', ownerIdentity: null, source: 'default' }
    })
    await repo.recordMilestone({
      sessionId: SessionId(sessionB),
      agentId: AgentId(agentB),
      phase: 'start',
      platform: 'slack',
      channel: 'C_MIXED',
      thread,
      at: new Date(2_000),
      classification: { visibility: 'org', ownerIdentity: null, source: 'default' },
      externalCandidate: {
        provider: 'slack',
        resolution: 'settled',
        scope: {
          realmKey: 'T_INSTALL',
          resourceKind: 'conversation',
          resourceKey: 'C_MIXED',
          credentialKind: 'bot',
          credentialId
        }
      }
    })
    const enabled = await repo.setExternalAccessEnabled(OrgId(DEFAULT_ORG_ID), 'slack', true)
    expect((await repo.getUnscoped(SessionId(sessionB)))?.visibility).toBe('external')

    const filtered = { agentIds: [AgentId(agentA)] }
    const widened = { ...filtered, memberAgentIds: [AgentId(agentA), AgentId(agentB)] }
    expect(await repo.listExternalScopes(filtered)).toEqual([])
    const scopes = await repo.listExternalScopes(widened)
    expect(scopes).toHaveLength(1)

    const viewer = {
      role: 'owner' as const,
      identitySet: [],
      externalAccess: {
        policies: [{ provider: 'slack' as const, readFenceRev: enabled.policy.readFenceRev }],
        allowedScopes: scopes.map((scope) => ({ id: scope.id, aclRevision: scope.aclRevision })),
        decisionAt: new Date()
      }
    }
    const page = await repo.listConversationPage({ ...widened, viewer, limit: 10, includeTotal: false })
    const conversation = page.conversations.find((c) => c.key.thread === thread)!
    expect(conversation.sessions.map((s) => s.id)).toEqual([sessionA])
    expect(conversation.memberSessionIds).toEqual([sessionB, sessionA])
  })
})

describe('session visibility — GitHub repository audience', () => {
  it('exposes an independent owner-only sync setting', async () => {
    const owner = await makeUser(`sv-github-owner-${randomUUID()}`, 'owner')
    const collaborator = await makeUser(`sv-github-collab-${randomUUID()}`, 'collaborator')

    const read = await appAs(collaborator).app.inject({ method: 'GET', url: `${ORG}/session-access/github` })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toMatchObject({ provider: 'github', available: false, enabled: false })
    expect(read.json()).not.toHaveProperty('hiddenSessions')

    const forbidden = await appAs(collaborator).app.inject({
      method: 'PUT',
      url: `${ORG}/session-access/github`,
      payload: { enabled: true }
    })
    expect(forbidden.statusCode).toBe(403)

    const enabled = await appAs(owner, {
      sessionAccessPlugins: [
        { provider: 'github', available: true, resolve: async () => ({ allowedScopes: [], degraded: false }) }
      ]
    }).app.inject({
      method: 'PUT',
      url: `${ORG}/session-access/github`,
      payload: { enabled: true }
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json()).toMatchObject({ provider: 'github', available: true, enabled: true, state: 'enabled' })
  })

  it('keeps allowed GitHub alternatives when another integration is selected', async () => {
    const viewer = await makeUser(`sv-github-facets-${randomUUID()}`, 'owner')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const hookId = randomUUID()
    const repo = new PgSessionRepo(prisma)

    await prisma.hookDef.create({
      data: {
        id: hookId,
        orgId: DEFAULT_ORG_ID,
        agentId,
        kind: 'github',
        name: 'example-org/example-repo',
        sessionMode: 'perThread',
        repoId: 123n,
        repoFullName: 'example-org/example-repo'
      }
    })
    const githubSessionId = SessionId(`s-github-facet-${randomUUID()}`)
    await repo.recordMilestone({
      sessionId: githubSessionId,
      agentId: AgentId(agentId),
      phase: 'start',
      platform: 'hook',
      channel: hookId,
      triggeredBy: `hook:${hookId}`,
      at: new Date(1_000),
      classification: { visibility: 'org', ownerIdentity: null, source: 'default' },
      externalCandidate: {
        provider: 'github',
        resolution: 'settled',
        scope: {
          realmKey: 'github.com',
          resourceKind: 'repository',
          resourceKey: '123',
          credentialKind: 'github_installation',
          credentialId: randomUUID()
        }
      }
    })
    await repo.recordMilestone({
      sessionId: SessionId(`s-webchat-facet-${randomUUID()}`),
      agentId: AgentId(agentId),
      phase: 'start',
      platform: 'webchat',
      channel: randomUUID(),
      at: new Date(2_000),
      classification: { visibility: 'private', ownerIdentity: `user:${viewer}`, source: 'default' }
    })

    await repo.setExternalAccessEnabled(OrgId(DEFAULT_ORG_ID), 'github', true)
    expect(await repo.getUnscoped(githubSessionId)).toMatchObject({
      visibility: 'external',
      externalResolution: 'settled'
    })

    const response = await appAs(viewer, {
      sessionAccessPlugins: [
        {
          provider: 'github',
          available: true,
          resolve: async (scopes) => ({
            allowedScopes: scopes.map((scope) => ({ id: scope.id, aclRevision: scope.aclRevision })),
            degraded: false
          })
        }
      ]
    }).app.inject({ method: 'GET', url: `${ORG}/sessions/facets?integration=webchat` })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ integrations: ['webchat', 'github'] })
  })
})

describe('session visibility — PUT /sessions/:id/visibility (§4.3)', () => {
  it('lets the recorded owner pull an org session private and publish it back', async () => {
    const initiator = await makeUser('sv-put-owner', 'collaborator')
    const orgOwner = await makeUser('sv-put-admin', 'owner')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const session = await seedSessionMeta(prisma, `s-put-${randomUUID()}`, agentId, {
      ownerIdentity: `user:${initiator}`
    })

    // The initiator of an `org` channel session may pull it private…
    const initiatorApp = appAs(initiator)
    const res = await initiatorApp.app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${session}/visibility`,
      payload: { visibility: 'private' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: session, visibility: 'private', visibilityRev: 1 })

    // …after which even an org owner cannot reach it (no view ⇒ no reclassify;
    // 404, never 403 — no existence oracle)…
    const denied = await appAs(orgOwner).app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${session}/visibility`,
      payload: { visibility: 'org' }
    })
    expect(denied.statusCode).toBe(404)

    // …and only the owner themselves may publish it back (widening is explicit,
    // never cascaded).
    const back = await initiatorApp.app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${session}/visibility`,
      payload: { visibility: 'org' }
    })
    expect(back.statusCode).toBe(200)
    expect(back.json()).toMatchObject({ visibility: 'org', visibilityRev: 2 })
  })

  it('403s a member who can see the session but does not own it, and 404s one who cannot', async () => {
    const initiator = await makeUser('sv-put-init', 'collaborator')
    const bystander = await makeUser('sv-put-bystander', 'collaborator')
    const orgOwner = await makeUser('sv-put-role-admin', 'owner')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })

    const orgSession = await seedSessionMeta(prisma, `s-put-org-${randomUUID()}`, agentId, {
      ownerIdentity: `user:${initiator}`
    })
    const privateSession = await seedSessionMeta(prisma, `s-put-priv-${randomUUID()}`, agentId, {
      visibility: 'private',
      ownerIdentity: `user:${initiator}`
    })

    const app = appAs(bystander)
    // Visible but not theirs ⇒ 403.
    expect(
      (
        await app.app.inject({
          method: 'PUT',
          url: `${ORG}/sessions/${orgSession}/visibility`,
          payload: { visibility: 'private' }
        })
      ).statusCode
    ).toBe(403)
    // The org-owner ROLE grants nothing either: pulling someone's published
    // session back to private would override the owner's own decision.
    const asOrgOwner = await appAs(orgOwner).app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${orgSession}/visibility`,
      payload: { visibility: 'private' }
    })
    expect(asOrgOwner.statusCode).toBe(403)
    expect((await prisma.sessionMeta.findUnique({ where: { id: orgSession } }))?.visibility).toBe('org')
    // Invisible ⇒ 404, never 403: no existence oracle.
    expect(
      (
        await app.app.inject({
          method: 'PUT',
          url: `${ORG}/sessions/${privateSession}/visibility`,
          payload: { visibility: 'org' }
        })
      ).statusCode
    ).toBe(404)
  })

  it('refuses a former owner’s widen queued behind a concurrent re-owning tighten', async () => {
    const initiator = await makeUser('sv-queued-init', 'collaborator')
    const newOwner = await makeUser('sv-queued-newowner', 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const session = await seedSessionMeta(prisma, `s-queued-${randomUUID()}`, agentId, {
      ownerIdentity: `user:${initiator}`
    })

    // A concurrent tighten (as an ancestor cascade would) re-owns the row but
    // does NOT commit yet, so the former owner's PUT pre-reads the
    // still-committed `org` row under their identity, passes the view gate and
    // the unlocked authorization, and queues on `setVisibility`'s FOR UPDATE —
    // the exact TOCTOU window the locked-row re-check exists for.
    let lockTaken!: () => void
    const lockHeld = new Promise<void>((resolve) => (lockTaken = resolve))
    let commitTighten!: () => void
    const tightenHeld = new Promise<void>((resolve) => (commitTighten = resolve))
    const tighten = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          UPDATE "session_meta" SET
            "visibility" = 'private'::"SessionVisibility",
            "ownerIdentity" = ${`user:${newOwner}`},
            "visibilitySource" = 'inherited'::"VisibilitySource",
            "visibilityRev" = "visibilityRev" + 1
          WHERE "id" = ${session}`
        lockTaken()
        await tightenHeld
      },
      { timeout: 20_000 }
    )
    await lockHeld

    const queuedWiden = appAs(initiator).app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${session}/visibility`,
      payload: { visibility: 'org' }
    })
    // Only commit the tighten once the PUT is provably parked on the row lock —
    // i.e. it already passed its unlocked pre-read against the `org` row.
    for (let i = 0; ; i++) {
      const waiters = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
      if ((waiters[0]?.n ?? 0) > 0) break
      if (i > 2_000) throw new Error('the queued PUT never blocked on the row lock')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    commitTighten()
    await tighten

    // The lock-time re-check sees a private row owned by someone else: the
    // former owner no longer matches, 403, and the session stays private —
    // the queued request cannot reopen it.
    expect((await queuedWiden).statusCode).toBe(403)
    expect((await prisma.sessionMeta.findUnique({ where: { id: session } }))?.visibility).toBe('private')
  })

  it('reports `applied` when no daemon can ever ack the change', async () => {
    const owner = await makeUser('sv-state', 'owner')
    const agentId = await seedAgent(prisma, randomUUID()) // unplaced: no daemon
    const session = await seedSessionMeta(prisma, `s-state-${randomUUID()}`, agentId, {
      ownerIdentity: `user:${owner}` // re-classification is owner-only, role grants nothing
    })

    const res = await appAs(owner).app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${session}/visibility`,
      payload: { visibility: 'private' }
    })
    expect(res.json()).toMatchObject({ state: 'applied' })
  })
})

describe('session visibility — §5.1 daemon-ack cutover', () => {
  // The pending→applied decision itself (which needs a live, feature-advertising
  // daemon connection) is unit-tested in src/orchestrator/visibilityPush.test.ts;
  // here we pin the durable half: the revision it compares against.
  it('bumps the revision on every change and never lowers the ack watermark', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const session = await seedSessionMeta(prisma, `s-ack-${randomUUID()}`, agentId, { daemonId })
    const repo = new PgSessionRepo(prisma)

    // -1 is "never acknowledged" — distinct from an ack of revision 0, which is
    // a real revision for a session ingested and never re-classified.
    expect((await repo.getUnscoped(SessionId(session)))?.visibilityAckedRev).toBe(-1)
    const { affected } = await repo.setVisibility(OrgId(DEFAULT_ORG_ID), SessionId(session), 'private')
    expect(affected[0]).toMatchObject({ visibilityRev: 1, visibilityAckedRev: -1 })

    // At-least-once delivery means acks can arrive out of order; the watermark
    // is monotonic so a late one for an older revision cannot un-apply a change.
    await repo.recordVisibilityAck(SessionId(session), 0)
    expect((await repo.getUnscoped(SessionId(session)))?.visibilityAckedRev).toBe(0)
    await repo.recordVisibilityAck(SessionId(session), 1)
    await repo.recordVisibilityAck(SessionId(session), 0)
    expect((await repo.getUnscoped(SessionId(session)))?.visibilityAckedRev).toBe(1)

    // A no-op re-set neither bumps the revision nor re-opens the cutover.
    expect((await repo.setVisibility(OrgId(DEFAULT_ORG_ID), SessionId(session), 'private')).affected).toEqual([])
    expect((await repo.getUnscoped(SessionId(session)))?.visibilityRev).toBe(1)
  })

  it('replays an unacknowledged gate ahead of newer acknowledged ones', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)

    // An OLD session tightened while the daemon was offline: it must ride the
    // snapshot no matter how far past a newest-first cap it sits, or the daemon
    // keeps capturing against a stale `org` gate forever.
    const stale = await seedSessionMeta(prisma, `s-stale-${randomUUID()}`, agentId, {
      daemonId,
      lastActivityAt: new Date(Date.now() - 86_400_000)
    })
    await repo.setVisibility(OrgId(DEFAULT_ORG_ID), SessionId(stale), 'private')
    const fresh = await seedSessionMeta(prisma, `s-fresh-${randomUUID()}`, agentId, {
      daemonId,
      lastActivityAt: new Date()
    })
    await repo.recordVisibilityAck(SessionId(fresh), 0)

    expect(await repo.countUnackedVisibilityForAgents([agentId])).toBe(1)
    const capped = await repo.visibilitySnapshotForAgents([agentId], 1)
    expect(capped).toEqual([
      {
        sessionId: stale,
        orgId: DEFAULT_ORG_ID,
        agentId,
        visibility: 'private',
        sharedMemoryExcluded: true,
        visibilityRev: 1
      }
    ])
  })

  it('reports the cutover as pending while a DESCENDANT daemon is still behind', async () => {
    const owner = await makeUser('sv-subtree', 'owner')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)

    const root = await seedSessionMeta(prisma, `s-sub-root-${randomUUID()}`, agentId, { daemonId })
    const child = await seedSessionMeta(prisma, `s-sub-child-${randomUUID()}`, agentId, {
      daemonId,
      parentSessionId: root
    })
    const { affected } = await repo.setVisibility(OrgId(DEFAULT_ORG_ID), SessionId(root), 'private')
    expect(affected.map((a) => a.id).sort()).toEqual([child, root].sort())

    // Only the root's daemon acks. The child holds text copied from the root, so
    // the cutover is NOT complete — the detail view must keep saying pending.
    await repo.recordVisibilityAck(SessionId(root), 1)
    const subtree = await repo.visibilitySubtree(SessionId(root), 100)
    expect(subtree.map((r) => r.id).sort()).toEqual([child, root].sort())
    expect(subtree.find((r) => r.id === child)).toMatchObject({ visibilityAckedRev: -1, visibilityRev: 1 })
  })

  it('snapshots the gate state for the agents a daemon serves, newest first', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const otherDaemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const otherAgentId = await seedAgent(prisma, randomUUID(), { daemonId: otherDaemonId })
    const older = await seedSessionMeta(prisma, `s-snap-old-${randomUUID()}`, agentId, {
      daemonId,
      lastActivityAt: new Date(Date.now() - 60_000)
    })
    const newer = await seedSessionMeta(prisma, `s-snap-new-${randomUUID()}`, agentId, {
      daemonId,
      visibility: 'private',
      lastActivityAt: new Date()
    })
    // Another agent's session never rides this page, whichever daemon first reported it.
    await seedSessionMeta(prisma, `s-snap-elsewhere-${randomUUID()}`, otherAgentId, { daemonId: otherDaemonId })

    const snapshot = await new PgSessionRepo(prisma).visibilitySnapshotForAgents([agentId], 10)
    expect(snapshot).toEqual([
      {
        sessionId: newer,
        orgId: DEFAULT_ORG_ID,
        agentId,
        visibility: 'private',
        sharedMemoryExcluded: true,
        visibilityRev: 0
      },
      {
        sessionId: older,
        orgId: DEFAULT_ORG_ID,
        agentId,
        visibility: 'org',
        sharedMemoryExcluded: false,
        visibilityRev: 0
      }
    ])
  })
})

/**
 * #1029 — the reconnect replay is what "ultimately closes the bypass" for a gate a member missed.
 * It paged by `session_meta.daemonId`, the daemon that FIRST reported the session (nulled once
 * that member is reaped), so a duty that moved after a rollout left the new holder replaying
 * nothing and capturing from a session the user had marked private.
 */
describe('session visibility — §5.1 replay follows the serving member', () => {
  const RETIRED = 'd5555555-5555-4555-8555-555555555555'
  const NEW_HOLDER = 'd6666666-6666-4666-8666-666666666666'
  const GROUP = '00000000-0000-4000-8000-0000000009a2'

  /** The push service as the container builds it, over a capturing sender and a registry that
   *  says every daemon is connected and speaks the visibility features. */
  function pushService() {
    const snapshots: Array<{ daemonId: string; orgId: string; entries: Array<{ sessionId: string }> }> = []
    const push = new SessionVisibilityPushService({
      repos: { session: new PgSessionRepo(prisma), agent: new PgAgentRepo(prisma) },
      control: {
        sessionVisibilitySnapshot: async (daemonId: string, orgId: string, entries: Array<{ sessionId: string }>) => {
          snapshots.push({ daemonId, orgId, entries })
          return { ok: true }
        }
      } as never,
      connReg: {
        get: () => ({
          capabilities: { features: [SESSION_VISIBILITY_FEATURE, SLACK_SESSION_AUDIENCE_FEATURE] }
        })
      } as never,
      placement: new PlacementResolver({ duties: new PgDutyGroupRepo(prisma), clock: systemClock }),
      duties: new PgDutyGroupRepo(prisma),
      clock: systemClock
    })
    return { push, snapshots }
  }

  it('replays a pool agent’s tightened gate to the member holding its duty now', async () => {
    const setId = await seedPoolMember(prisma, NEW_HOLDER)
    await seedDaemon(prisma, RETIRED)
    const agentId = await seedAgent(prisma, randomUUID(), { setId })
    const repo = new PgSessionRepo(prisma)
    // Reported by the member that has since been rolled away — the column still names it.
    const sessionId = await seedSessionMeta(prisma, `s-pool-${randomUUID()}`, agentId, { daemonId: RETIRED })
    await repo.setVisibility(OrgId(DEFAULT_ORG_ID), SessionId(sessionId), 'private')
    await seedDutyGroup(prisma, GROUP, NEW_HOLDER, [agentId])

    const { push, snapshots } = pushService()
    await push.replayTo(NEW_HOLDER as never)

    expect(snapshots.map((s) => ({ daemonId: s.daemonId, sessions: s.entries.map((e) => e.sessionId) }))).toEqual([
      { daemonId: NEW_HOLDER, sessions: [sessionId] }
    ])
    // …and the unacked counter agrees, so nothing reports a convergence that did not happen.
    expect(await repo.countUnackedVisibilityForAgents([agentId])).toBe(0)
  })

  it('a member holding no duty for the agent still replays nothing', async () => {
    const setId = await seedPoolMember(prisma, NEW_HOLDER)
    await seedDaemon(prisma, RETIRED)
    const agentId = await seedAgent(prisma, randomUUID(), { setId })
    const sessionId = await seedSessionMeta(prisma, `s-unheld-${randomUUID()}`, agentId, { daemonId: RETIRED })
    await new PgSessionRepo(prisma).setVisibility(OrgId(DEFAULT_ORG_ID), SessionId(sessionId), 'private')

    const { push, snapshots } = pushService()
    await push.replayTo(NEW_HOLDER as never)

    expect(snapshots).toEqual([])
  })

  // The exact leak the ACK watermark allows, end to end. `visibilityAckedRev` is per SESSION, so
  // the PREVIOUS holder's ack makes every row look delivered; ordering then puts the old private
  // session past the 500-row page, and phase 1 stops on `unacked === 0`. Without the private phase
  // the new holder never receives it and — because losing a duty preserves its local gate state —
  // can go on capturing from a session the user marked private.
  //
  // Mutation check: drop `replayPrivatePages` and this test fails on exactly that session.
  it('sends an old private gate the previous holder acked, past the page cap', async () => {
    const setId = await seedPoolMember(prisma, NEW_HOLDER)
    await seedDaemon(prisma, RETIRED)
    const agentId = await seedAgent(prisma, randomUUID(), { setId })
    const repo = new PgSessionRepo(prisma)

    // One OLD session, tightened and acked while RETIRED held the agent.
    const old = `s-old-private-${randomUUID()}`
    await seedSessionMeta(prisma, old, agentId, {
      daemonId: RETIRED,
      lastActivityAt: new Date(Date.now() - 365 * 86_400_000)
    })
    await repo.setVisibility(OrgId(DEFAULT_ORG_ID), SessionId(old), 'private')
    await repo.recordVisibilityAck(SessionId(old), 1)

    // …behind a full page of newer, already-acked sessions.
    await prisma.sessionMeta.createMany({
      data: Array.from({ length: SNAPSHOT_CHUNK }, (_, i) => ({
        id: `s-bulk-${i}-${randomUUID()}`,
        agentId,
        orgId: DEFAULT_ORG_ID,
        platform: 'slack',
        channel: '#bulk',
        phase: 'start' as const,
        // Acked at their initial revision — the state a previous holder's replay leaves behind.
        visibilityAckedRev: 0,
        lastActivityAt: new Date(Date.now() - i * 1000)
      }))
    })
    // Nothing is outstanding as far as the watermark is concerned.
    expect(await repo.countUnackedVisibilityForAgents([agentId])).toBe(0)

    await seedDutyGroup(prisma, GROUP, NEW_HOLDER, [agentId])
    const { push, snapshots } = pushService()
    await push.replayTo(NEW_HOLDER as never)

    const delivered = snapshots.flatMap((s) => s.entries.map((e) => e.sessionId))
    expect(delivered).toContain(old)
  })

  it('the private page is cursored, agent-scoped and blind to the ack watermark', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const mine = await seedAgent(prisma, randomUUID(), { daemonId })
    const theirs = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)
    const ids: string[] = []
    for (const owner of [mine, mine, theirs]) {
      const id = `s-priv-${randomUUID()}`
      await seedSessionMeta(prisma, id, owner)
      await repo.setVisibility(OrgId(DEFAULT_ORG_ID), SessionId(id), 'private')
      await repo.recordVisibilityAck(SessionId(id), 1) // fully acked — phase 1 would skip these
      if (owner === mine) ids.push(id)
    }
    // An org session of the same agent is not a gate anyone can be wrong about the safe way.
    await seedSessionMeta(prisma, `s-org-${randomUUID()}`, mine)
    const ordered = [...ids].sort()

    const first = await repo.privateVisibilityPage([mine], 1)
    expect(first.map((r) => r.sessionId)).toEqual([ordered[0]])
    expect(first[0]).toMatchObject({ visibility: 'private', sharedMemoryExcluded: true })

    const next = await repo.privateVisibilityPage([mine], 10, true, ordered[0])
    expect(next.map((r) => r.sessionId)).toEqual([ordered[1]]) // the other agent's row never appears
    expect(await repo.privateVisibilityPage([mine], 10, true, ordered[1])).toEqual([])
  })

  it('a machine-placed agent still replays to its placement', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const sessionId = await seedSessionMeta(prisma, `s-pinned-${randomUUID()}`, agentId, { daemonId })
    await new PgSessionRepo(prisma).setVisibility(OrgId(DEFAULT_ORG_ID), SessionId(sessionId), 'private')

    const { push, snapshots } = pushService()
    await push.replayTo(daemonId as never)

    expect(snapshots.map((s) => ({ daemonId: s.daemonId, sessions: s.entries.map((e) => e.sessionId) }))).toEqual([
      { daemonId, sessions: [sessionId] }
    ])
  })
})

describe('session visibility — §4.5 inheritance and cascade', () => {
  it('tightening cascades transitively (explicit descendants included); widening never does', async () => {
    const owner = await makeUser('sv-cascade', 'owner')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })

    // The root keeps the acting user's identity: once tightened, only its
    // identity-matched owner can still see it to widen it back.
    const root = await seedSessionMeta(prisma, `s-root-${randomUUID()}`, agentId, {
      ownerIdentity: `user:${owner}`
    })
    const child = await seedSessionMeta(prisma, `s-kid-${randomUUID()}`, agentId, { parentSessionId: root })
    const grandchild = await seedSessionMeta(prisma, `s-grandkid-${randomUUID()}`, agentId, {
      parentSessionId: child
    })
    // A descendant a human already re-classified: privacy still wins over it.
    await prisma.sessionMeta.update({ where: { id: grandchild }, data: { visibilitySource: 'explicit' } })

    const app = appAs(owner)
    await app.app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${root}/visibility`,
      payload: { visibility: 'private' }
    })
    for (const id of [root, child, grandchild]) {
      expect((await prisma.sessionMeta.findUnique({ where: { id } }))?.visibility).toBe('private')
    }

    // Widening the root leaves every descendant private — each is its own decision.
    await app.app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${root}/visibility`,
      payload: { visibility: 'org' }
    })
    expect((await prisma.sessionMeta.findUnique({ where: { id: root } }))?.visibility).toBe('org')
    for (const id of [child, grandchild]) {
      expect((await prisma.sessionMeta.findUnique({ where: { id } }))?.visibility).toBe('private')
    }
  })

  it('re-owns an already-private descendant, so its old owner loses the copied content', async () => {
    const owner = await makeUser('sv-reown', 'owner')
    const other = await makeUser('sv-reown-other', 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })

    const root = await seedSessionMeta(prisma, `s-reown-root-${randomUUID()}`, agentId, {
      ownerIdentity: `user:${owner}`
    })
    // A child that is ALREADY private but owned by someone else. Its transcript
    // holds text delegated from the root, so tightening the root must hand it
    // the root's owner — leaving `other` on it keeps their access to that text.
    const child = await seedSessionMeta(prisma, `s-reown-child-${randomUUID()}`, agentId, {
      parentSessionId: root,
      visibility: 'private',
      ownerIdentity: `user:${other}`
    })

    await appAs(owner).app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${root}/visibility`,
      payload: { visibility: 'private' }
    })

    expect(await prisma.sessionMeta.findUnique({ where: { id: child } })).toMatchObject({
      visibility: 'private',
      ownerIdentity: `user:${owner}`,
      visibilitySource: 'inherited'
    })
    // …and the former owner can no longer read it.
    expect((await appAs(other).app.inject({ method: 'GET', url: `${ORG}/sessions/${child}` })).statusCode).toBe(404)
  })

  it('re-authorizes against the locked row, so a revoked owner cannot still widen', async () => {
    const owner = await makeUser('sv-toctou', 'owner')
    const child_owner = await makeUser('sv-toctou-child', 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)

    const root = await seedSessionMeta(prisma, `s-toctou-root-${randomUUID()}`, agentId, {
      ownerIdentity: `user:${owner}`
    })
    const child = await seedSessionMeta(prisma, `s-toctou-child-${randomUUID()}`, agentId, {
      parentSessionId: root,
      visibility: 'private',
      ownerIdentity: `user:${child_owner}`
    })

    // The ancestor cascade re-owns the child to the root's owner.
    await repo.setVisibility(OrgId(DEFAULT_ORG_ID), SessionId(root), 'private')

    // The child's FORMER owner now tries to publish it. The route's own check
    // could have passed on a pre-cascade read; the lock-time re-check refuses.
    const denied = await repo.setVisibility(
      OrgId(DEFAULT_ORG_ID),
      SessionId(child),
      'org',
      (row) => row.ownerIdentity === `user:${child_owner}`
    )
    expect(denied).toMatchObject({ forbidden: true, affected: [] })
    expect((await repo.getUnscoped(SessionId(child)))?.visibility).toBe('private')
  })

  it('settles an out-of-order child once, and never over a human decision', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)
    const parentId = `s-late-parent-${randomUUID()}`

    // The child's milestone arrives first: no parent row to inherit from yet.
    const child = await repo.recordMilestone({
      sessionId: SessionId(`s-early-child-${randomUUID()}`),
      parentSessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      classification: { inherit: true },
      at: new Date()
    })
    expect(child.session).toMatchObject({ visibility: 'private', visibilitySource: 'inherited_pending' })

    // A second pending child that its owner re-classifies before settlement.
    const pinned = await repo.recordMilestone({
      sessionId: SessionId(`s-pinned-child-${randomUUID()}`),
      parentSessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      classification: { inherit: true },
      at: new Date()
    })
    await repo.setVisibility(OrgId(DEFAULT_ORG_ID), pinned.session!.id, 'org')

    // Now the parent lands as an org channel session.
    const parent = await repo.recordMilestone({
      sessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      classification: { visibility: 'org', ownerIdentity: 'slack:T1:U1', source: 'default' },
      at: new Date()
    })

    // The still-pending child settles from the parent, exactly once…
    expect(parent.settled.map((s) => s.id)).toEqual([child.session!.id])
    const settled = await prisma.sessionMeta.findUnique({ where: { id: child.session!.id } })
    expect(settled).toMatchObject({ visibility: 'org', ownerIdentity: 'slack:T1:U1', visibilitySource: 'inherited' })
    // …and the human decision is untouched (still `explicit`, not re-settled).
    const untouched = await prisma.sessionMeta.findUnique({ where: { id: pinned.session!.id } })
    expect(untouched).toMatchObject({ visibility: 'org', visibilitySource: 'explicit' })
  })

  it('settles a whole chain that arrived root-last, not just its first level', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)
    const rootId = `s-chain-root-${randomUUID()}`
    const childId = `s-chain-child-${randomUUID()}`
    const grandchildId = `s-chain-grandchild-${randomUUID()}`

    // Deepest first: each arrival's parent is missing, or present but itself
    // still pending — either way the row must stay pending, or the settlement
    // scan (which matches only `inherited_pending`) would skip it forever.
    for (const [id, parent] of [
      [grandchildId, childId],
      [childId, rootId]
    ] as const) {
      const r = await repo.recordMilestone({
        sessionId: SessionId(id),
        parentSessionId: SessionId(parent),
        agentId,
        phase: 'start',
        classification: { inherit: true },
        at: new Date()
      })
      expect(r.session).toMatchObject({ visibility: 'private', visibilitySource: 'inherited_pending' })
    }

    const root = await repo.recordMilestone({
      sessionId: SessionId(rootId),
      agentId,
      phase: 'start',
      classification: { visibility: 'org', ownerIdentity: 'slack:T1:U7', source: 'default' },
      at: new Date()
    })

    // Both levels settle, and both are reported so each gets a §5.1 gate push.
    expect(root.settled.map((s) => s.id).sort()).toEqual([childId, grandchildId].sort())
    for (const id of [childId, grandchildId]) {
      expect(await prisma.sessionMeta.findUnique({ where: { id } })).toMatchObject({
        visibility: 'org',
        ownerIdentity: 'slack:T1:U7',
        visibilitySource: 'inherited'
      })
    }
  })

  it('inherits a private parent at ingest, so a delegated prompt is never org-visible', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)

    const parentId = `s-dm-parent-${randomUUID()}`
    await repo.recordMilestone({
      sessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      classification: { visibility: 'private', ownerIdentity: 'user:u-1', source: 'default' },
      at: new Date()
    })
    const child = await repo.recordMilestone({
      sessionId: SessionId(`s-dm-child-${randomUUID()}`),
      parentSessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      classification: { inherit: true },
      at: new Date()
    })
    expect(child.session).toMatchObject({
      visibility: 'private',
      ownerIdentity: 'user:u-1',
      visibilitySource: 'inherited'
    })
  })

  it('never leaves an org-visible descendant of a private parent, in either commit order', async () => {
    const owner = await makeUser('sv-race', 'owner')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)
    const app = appAs(owner)

    for (const childFirst of [true, false]) {
      const rootId = `s-race-root-${randomUUID()}`
      // The root's recorded owner is the acting user: the §4.3 PUT below is
      // owner-only (roles grant nothing), and this test is about the cascade.
      await repo.recordMilestone({
        sessionId: SessionId(rootId),
        agentId,
        phase: 'start',
        classification: { visibility: 'org', ownerIdentity: `user:${owner}`, source: 'default' },
        at: new Date()
      })
      const childId = `s-race-child-${randomUUID()}`
      const grandchildId = `s-race-grandchild-${randomUUID()}`
      await repo.recordMilestone({
        sessionId: SessionId(childId),
        parentSessionId: SessionId(rootId),
        agentId,
        phase: 'start',
        classification: { inherit: true },
        at: new Date()
      })

      // A grandchild ingest racing the ancestor's tighten — the depth-2 case the
      // lock-then-scan-to-fixpoint cascade exists for.
      const tighten = app.app.inject({
        method: 'PUT',
        url: `${ORG}/sessions/${rootId}/visibility`,
        payload: { visibility: 'private' }
      })
      const insertGrandchild = repo.recordMilestone({
        sessionId: SessionId(grandchildId),
        parentSessionId: SessionId(childId),
        agentId,
        phase: 'start',
        classification: { inherit: true },
        at: new Date()
      })
      await (childFirst ? Promise.all([insertGrandchild, tighten]) : Promise.all([tighten, insertGrandchild]))

      for (const id of [rootId, childId, grandchildId]) {
        const row = await prisma.sessionMeta.findUnique({ where: { id } })
        expect({ id, visibility: row?.visibility }).toEqual({ id, visibility: 'private' })
      }
    }
  })
})
