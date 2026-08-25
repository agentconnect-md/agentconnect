/**
 * `/orgs` — the caller's organizations (picker, create, owner-gated rename) plus
 * the org-scoping seams the multi-tenant model hangs off: cross-org reads come
 * back empty/404 and the RBAC guards bite on write routes.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import { seedDutyGroup } from '../fixtures/seed.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { Prisma } from '../../src/generated/prisma/client.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

// Console routes are org-scoped: /orgs/:orgId/… (devAuth = seeded owner of the default org).
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const OIDC_AUDIENCE = 'org-quota-test'

let oidcServer: Server
let oidcIssuer = ''
let mintBearer: (subject: string, claims?: Record<string, unknown>) => Promise<string>

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'org-quota-test', use: 'sig' }
  oidcServer = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer: oidcIssuer, jwks_uri: `${oidcIssuer}/jwks` }))
      return
    }
    if (req.url === '/jwks') {
      res.end(JSON.stringify({ keys: [jwk] }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve, reject) => {
    oidcServer.once('error', reject)
    oidcServer.listen(0, '127.0.0.1', resolve)
  })
  const { port } = oidcServer.address() as AddressInfo
  oidcIssuer = `http://127.0.0.1:${port}`
  mintBearer = (subject, claims = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'org-quota-test' })
      .setIssuer(oidcIssuer)
      .setAudience(OIDC_AUDIENCE)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey)
})

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      oidcServer.close((err) => (err ? reject(err) : resolve()))
    })
)

interface OrgBody {
  id: string
  name: string | null
  slug: string
  defaultAgentVisibility: 'all' | 'selected'
  role: string
  memberCount: number
  createdAt: string
}

describe('GET /orgs', () => {
  it('returns the devAuth principal’s orgs — the seeded default org as owner', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/orgs' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as OrgBody[]
      expect(body).toHaveLength(1)
      expect(body[0]!.id).toBe(DEFAULT_ORG_ID)
      expect(body[0]!.role).toBe('owner')
      expect(body[0]!.memberCount).toBe(1)
      expect(body[0]!.defaultAgentVisibility).toBe('all')
    } finally {
      await close()
    }
  })

  it('remembers the active org per membership and returns it first', async () => {
    const other = await prisma.org.create({ data: { name: 'Other', slug: 'other' } })
    await prisma.membership.create({ data: { orgId: other.id, userId: DEFAULT_OWNER_ID, role: 'collaborator' } })
    const peer = await prisma.user.create({ data: { email: 'org-choice-peer@example.com' } })
    await prisma.membership.create({ data: { orgId: other.id, userId: peer.id, role: 'collaborator' } })
    const { app, close } = buildHttpApp(prisma)
    try {
      const selected = await app.inject({
        method: 'PUT',
        url: `/api/v1/orgs/${other.id}/selection`
      })
      expect(selected.statusCode).toBe(204)

      const list = (await (await app.inject({ method: 'GET', url: '/api/v1/orgs' })).json()) as OrgBody[]
      expect(list.map((org) => org.id)).toEqual([other.id, DEFAULT_ORG_ID])
      const [mine, theirs] = await Promise.all([
        prisma.membership.findUniqueOrThrow({
          where: { orgId_userId: { orgId: other.id, userId: DEFAULT_OWNER_ID } },
          select: { lastSelectedAt: true }
        }),
        prisma.membership.findUniqueOrThrow({
          where: { orgId_userId: { orgId: other.id, userId: peer.id } },
          select: { lastSelectedAt: true }
        })
      ])
      expect(mine.lastSelectedAt).toBeInstanceOf(Date)
      expect(theirs.lastSelectedAt).toBeNull()
    } finally {
      await close()
    }
  })
})

describe('POST /orgs', () => {
  it('enforces the deployment quota for non-admins while ADMIN accounts bypass it', async () => {
    const { app, close } = buildHttpApp(prisma, { OIDC_ISSUER: oidcIssuer, OIDC_AUDIENCE }, undefined, undefined, {
      maxOrgsPerNonAdminUser: 0
    })
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        headers: {
          authorization: `Bearer ${await mintBearer('org-quota-user', { email: 'quota-route@example.com' })}`
        },
        payload: { slug: 'quota-route-denied' }
      })
      expect(denied.statusCode).toBe(403)
      expect(denied.json()).toMatchObject({ code: 'ORG_CREATION_LIMIT_REACHED' })

      const allowed = await app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        headers: {
          authorization: `Bearer ${await mintBearer('org-admin-user', {
            email: 'admin-route@example.com',
            roles: ['ADMIN']
          })}`
        },
        payload: { slug: 'quota-route-admin' }
      })
      expect(allowed.statusCode).toBe(201)
    } finally {
      await close()
    }
  })

  it('creates an org owned by the caller; duplicate slug → 409', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        payload: { name: 'Acme Corp', slug: 'acme' }
      })
      expect(res.statusCode).toBe(201)
      const org = res.json() as OrgBody
      expect(org.role).toBe('owner')
      expect(org.memberCount).toBe(1)
      expect(org.defaultAgentVisibility).toBe('all')

      const list = (await (await app.inject({ method: 'GET', url: '/api/v1/orgs' })).json()) as OrgBody[]
      expect(list.map((o) => o.slug)).toContain('acme')

      const dup = await app.inject({ method: 'POST', url: '/api/v1/orgs', payload: { name: 'Other', slug: 'acme' } })
      expect(dup.statusCode).toBe(409)
    } finally {
      await close()
    }
  })

  it('omitting (or blanking) the display name is allowed → name comes back null', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const omitted = await app.inject({ method: 'POST', url: '/api/v1/orgs', payload: { slug: 'noname' } })
      expect(omitted.statusCode).toBe(201)
      expect((omitted.json() as OrgBody).name).toBeNull()

      const blank = await app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        payload: { name: '   ', slug: 'blankname' }
      })
      expect(blank.statusCode).toBe(201)
      expect((blank.json() as OrgBody).name).toBeNull()
    } finally {
      await close()
    }
  })

  it('rejects a malformed slug and a RESERVED one (400) — page names share the URL segment', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const malformed = await app.inject({
        method: 'POST',
        url: '/api/v1/orgs',
        payload: { name: 'X', slug: 'Bad Slug!' }
      })
      expect(malformed.statusCode).toBe(400)
      const reserved = await app.inject({ method: 'POST', url: '/api/v1/orgs', payload: { name: 'X', slug: 'agents' } })
      expect(reserved.statusCode).toBe(400)
      // Including the pages that live OUTSIDE the org segment — org onboarding is
      // where an org-less account is sent, so it cannot also be an org.
      const welcome = await app.inject({ method: 'POST', url: '/api/v1/orgs', payload: { name: 'X', slug: 'welcome' } })
      expect(welcome.statusCode).toBe(400)
      const dash = await app.inject({ method: 'POST', url: '/api/v1/orgs', payload: { name: 'X', slug: '-' } })
      expect(dash.statusCode).toBe(400) // the default org's reserved segment
    } finally {
      await close()
    }
  })
})

describe('PATCH /orgs/:id', () => {
  it('renames name + slug for an owner', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/orgs/${DEFAULT_ORG_ID}`,
        payload: { name: 'Acme HQ', slug: 'acme-hq' }
      })
      expect(res.statusCode).toBe(200)
      const org = res.json() as OrgBody
      expect(org.name).toBe('Acme HQ')
      expect(org.slug).toBe('acme-hq')
      const row = await prisma.org.findUnique({ where: { id: DEFAULT_ORG_ID } })
      expect(row?.slug).toBe('acme-hq')
    } finally {
      await close()
    }
  })

  it('a blank name clears the display name back to null', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'PATCH', url: `/api/v1/orgs/${DEFAULT_ORG_ID}`, payload: { name: '' } })
      expect(res.statusCode).toBe(200)
      expect((res.json() as OrgBody).name).toBeNull()
      const row = await prisma.org.findUnique({ where: { id: DEFAULT_ORG_ID } })
      expect(row?.name).toBeNull()
    } finally {
      await close()
    }
  })

  it('uses the org visibility default for future agents without rewriting existing agents', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const before = await app.inject({
        method: 'POST',
        url: `${ORG}/agents`,
        payload: { name: 'before-policy-change', runtime: 'claude' }
      })
      expect(before.statusCode).toBe(201)
      expect(before.json()).toMatchObject({ callPolicy: 'all', outboundPolicy: 'all' })

      const updated = await app.inject({
        method: 'PATCH',
        url: ORG,
        payload: { defaultAgentVisibility: 'selected' }
      })
      expect(updated.statusCode).toBe(200)
      expect((updated.json() as OrgBody).defaultAgentVisibility).toBe('selected')

      const after = await app.inject({
        method: 'POST',
        url: `${ORG}/agents`,
        payload: { name: 'after-policy-change', runtime: 'claude' }
      })
      expect(after.statusCode).toBe(201)
      expect(after.json()).toMatchObject({
        callPolicy: 'selected',
        allowedCallerAgentIds: [],
        outboundPolicy: 'selected',
        allowedTargetAgentIds: []
      })

      const unchanged = await app.inject({
        method: 'GET',
        url: `${ORG}/agents/${(before.json() as { id: string }).id}`
      })
      expect(unchanged.json()).toMatchObject({ callPolicy: 'all', outboundPolicy: 'all' })
    } finally {
      await close()
    }
  })

  it('marks onboarding completed (finish/skip) and reads it back false-by-default', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const fresh = (await (await app.inject({ method: 'GET', url: ORG })).json()) as { onboardingCompleted: boolean }
      expect(fresh.onboardingCompleted).toBe(false)
      const res = await app.inject({ method: 'PATCH', url: ORG, payload: { onboardingCompleted: true } })
      expect(res.statusCode).toBe(200)
      expect((res.json() as { onboardingCompleted: boolean }).onboardingCompleted).toBe(true)
      // One-way flag: the wizard only ever sets it — unsetting is not part of the body schema.
      const unset = await app.inject({ method: 'PATCH', url: ORG, payload: { onboardingCompleted: false } })
      expect(unset.statusCode).toBe(400)
    } finally {
      await close()
    }
  })

  it('ratchets gettingStartedStep forward only — a stale lower PATCH never regresses it', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const fresh = (await (await app.inject({ method: 'GET', url: ORG })).json()) as { gettingStartedStep: number }
      expect(fresh.gettingStartedStep).toBe(0)
      const forward = await app.inject({ method: 'PATCH', url: ORG, payload: { gettingStartedStep: 4 } })
      expect(forward.statusCode).toBe(200)
      expect((forward.json() as { gettingStartedStep: number }).gettingStartedStep).toBe(4)
      // A stale tab/device still on an older position must not move shared progress back.
      const stale = await app.inject({ method: 'PATCH', url: ORG, payload: { gettingStartedStep: 2 } })
      expect(stale.statusCode).toBe(200)
      expect((stale.json() as { gettingStartedStep: number }).gettingStartedStep).toBe(4)
    } finally {
      await close()
    }
  })

  it('403s for a non-owner and 404s for a non-member', async () => {
    // Make the devAuth principal a mere collaborator of a second org…
    const other = await prisma.org.create({ data: { name: 'Other', slug: 'other' } })
    await prisma.membership.create({ data: { orgId: other.id, userId: DEFAULT_OWNER_ID, role: 'collaborator' } })
    // …and create a third org they are not in at all.
    const foreign = await prisma.org.create({ data: { name: 'Foreign', slug: 'foreign' } })

    const { app, close } = buildHttpApp(prisma)
    try {
      const asCollab = await app.inject({ method: 'PATCH', url: `/api/v1/orgs/${other.id}`, payload: { name: 'Nope' } })
      expect(asCollab.statusCode).toBe(403)
      const asStranger = await app.inject({
        method: 'PATCH',
        url: `/api/v1/orgs/${foreign.id}`,
        payload: { name: 'Nope' }
      })
      expect(asStranger.statusCode).toBe(404)
    } finally {
      await close()
    }
  })
})

describe('DELETE /orgs/:orgId', () => {
  it('deletes an empty org (204) — memberships and agents cascade, /orgs stops listing it', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const created = (await (
        await app.inject({ method: 'POST', url: '/api/v1/orgs', payload: { name: 'Doomed', slug: 'doomed' } })
      ).json()) as OrgBody
      // Give it an agent to prove the cascade.
      await prisma.agent.create({
        data: { id: '88888888-8888-4888-8888-888888888888', orgId: created.id, name: 'doomed-agent', runtime: 'claude' }
      })

      const res = await app.inject({ method: 'DELETE', url: `/api/v1/orgs/${created.id}` })
      expect(res.statusCode).toBe(204)
      expect(await prisma.org.findUnique({ where: { id: created.id } })).toBeNull()
      expect(await prisma.agent.findUnique({ where: { id: '88888888-8888-4888-8888-888888888888' } })).toBeNull()

      const list = (await (await app.inject({ method: 'GET', url: '/api/v1/orgs' })).json()) as OrgBody[]
      expect(list.map((o) => o.id)).not.toContain(created.id)

      // The crypto-shred intent outlives the org it names: after the cascade
      // nothing else remembers the id, and the key must still be destroyed
      // (docs/designs/per-org-secret-encryption.md §6). Deliberately no FK, so
      // the cascade above cannot take it.
      expect(await prisma.pendingKeyShred.findUnique({ where: { orgId: created.id } })).not.toBeNull()
    } finally {
      await close()
    }
  })

  it('does not treat install-wide pool members as org deletion blockers', async () => {
    const poolMember = await new PgDaemonRepo(prisma).resolvePoolClusterIdentity(
      'system:serviceaccount:agentconnect:ac-cloud-daemon',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
    const { app, close } = buildHttpApp(prisma)
    try {
      const created = (await (
        await app.inject({ method: 'POST', url: '/api/v1/orgs', payload: { name: 'Doomed', slug: 'doomed' } })
      ).json()) as OrgBody

      expect((await app.inject({ method: 'DELETE', url: `/api/v1/orgs/${created.id}` })).statusCode).toBe(204)
      expect(await prisma.org.findUnique({ where: { id: created.id } })).toBeNull()
      expect(await prisma.daemon.findUnique({ where: { id: poolMember.id } })).not.toBeNull()
    } finally {
      await close()
    }
  })

  it('tells the pool member holding the org\u2019s agents that they are gone', async () => {
    // Nothing else can: DutyGroup cascades from Org, so the moment the delete lands there is no
    // row left saying which member serves these agents. A member never told keeps their sandbox
    // claims \u2014 and the pods and workspace volumes those claims own \u2014 for good. Per-agent
    // DELETE sends this already; an org's built-in agent cannot be deleted that way at all.
    const poolMember = await new PgDaemonRepo(prisma).resolvePoolClusterIdentity(
      'system:serviceaccount:agentconnect:ac-cloud-daemon',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
    const removes: Array<{ daemonId: string; agentId: string }> = []
    const control = {
      agentUpsert: async () => {},
      agentRemove: async (daemonId: string, r: { agentId: string }) => void removes.push({ daemonId, ...r })
    } as unknown as ControlSender
    const { app, close } = buildHttpApp(prisma, undefined, undefined, control)
    try {
      const created = (await (
        await app.inject({ method: 'POST', url: '/api/v1/orgs', payload: { name: 'Doomed', slug: 'doomed' } })
      ).json()) as OrgBody
      const agentId = '77777777-7777-4777-8777-777777777777'
      await prisma.agent.create({
        data: { id: agentId, orgId: created.id, name: 'pool-agent', runtime: 'claude', placementKind: 'set' }
      })
      await seedDutyGroup(prisma, '66666666-6666-4666-8666-666666666666', poolMember.id, [agentId], {
        orgId: created.id
      })

      expect((await app.inject({ method: 'DELETE', url: `/api/v1/orgs/${created.id}` })).statusCode).toBe(204)
      expect(removes).toEqual([{ daemonId: poolMember.id, agentId }])
    } finally {
      await close()
    }
  })

  it('announces nothing when the deletion is refused', async () => {
    // The rows are still there, so a member told to drop them would stop serving a LIVE org.
    await prisma.daemon.create({
      data: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', orgId: DEFAULT_ORG_ID, sessionEpoch: 1n, status: 'ready' }
    })
    const removes: string[] = []
    const control = {
      agentUpsert: async () => {},
      agentRemove: async (_d: string, r: { agentId: string }) => void removes.push(r.agentId)
    } as unknown as ControlSender
    const { app, close } = buildHttpApp(prisma, undefined, undefined, control)
    try {
      expect((await app.inject({ method: 'DELETE', url: ORG })).statusCode).toBe(409)
      expect(removes).toEqual([])
    } finally {
      await close()
    }
  })

  it('records NO shred intent when the deletion is refused', async () => {
    await prisma.daemon.create({
      data: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', orgId: DEFAULT_ORG_ID, sessionEpoch: 1n, status: 'ready' }
    })
    const { app, close } = buildHttpApp(prisma)
    try {
      expect((await app.inject({ method: 'DELETE', url: ORG })).statusCode).toBe(409)
      // A tombstone here would schedule the destruction of a LIVE org's key.
      expect(await prisma.pendingKeyShred.findUnique({ where: { orgId: DEFAULT_ORG_ID } })).toBeNull()
    } finally {
      await close()
    }
  })

  it('refuses (409) while the org still has daemons', async () => {
    await prisma.daemon.create({
      data: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', orgId: DEFAULT_ORG_ID, sessionEpoch: 1n, status: 'ready' }
    })
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'DELETE', url: ORG })
      expect(res.statusCode).toBe(409)
      expect(await prisma.org.findUnique({ where: { id: DEFAULT_ORG_ID } })).not.toBeNull()
    } finally {
      await close()
    }
  })

  it('transactionally rechecks daemons when the route preflight misses one', async () => {
    await prisma.daemon.create({
      data: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', orgId: DEFAULT_ORG_ID, sessionEpoch: 1n, status: 'ready' }
    })
    const { app, close } = buildHttpApp(prisma, undefined, undefined, undefined, {
      registry: { list: async () => [] } as never
    })
    try {
      const res = await app.inject({ method: 'DELETE', url: ORG })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ message: expect.stringContaining('still has daemons') })
      expect(await prisma.org.findUnique({ where: { id: DEFAULT_ORG_ID } })).not.toBeNull()
    } finally {
      await close()
    }
  })

  it('retains cleanup authority until an external Check is failed, then deletes metadata atomically', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const created = (await (
        await app.inject({ method: 'POST', url: '/api/v1/orgs', payload: { name: 'Checks', slug: 'checks-delete' } })
      ).json()) as OrgBody
      const agentId = randomUUID()
      const hookId = randomUUID()
      const projectionId = randomUUID()
      await prisma.agent.create({
        data: { id: agentId, orgId: created.id, name: 'checks-agent', runtime: 'claude' }
      })
      await prisma.hookDef.create({
        data: {
          id: hookId,
          orgId: created.id,
          agentId,
          kind: 'github',
          name: 'checks-hook',
          sessionMode: 'perThread',
          repoId: 477n,
          repoFullName: 'acme/checks',
          reportingMode: 'check'
        }
      })
      await prisma.githubInstallation.create({
        data: {
          orgId: created.id,
          installationId: 47_700n,
          accountLogin: 'acme',
          accountType: 'Organization',
          repositorySelection: 'selected',
          permissions: { checks: 'write', pull_requests: 'read' }
        }
      })
      await prisma.hookReviewProjection.create({
        data: {
          id: projectionId,
          hookId,
          orgId: created.id,
          agentId,
          repoId: 477n,
          repoFullName: 'acme/checks',
          headSha: 'a'.repeat(40),
          reportSha: 'a'.repeat(40),
          projectionEpoch: 1n,
          generation: 1n,
          externalId: projectionId,
          checkRunId: '90071992547409931',
          mode: 'check',
          gateMode: 'informational',
          desiredState: 'success',
          observedState: 'success',
          sealedThrough: 1n
        }
      })
      await prisma.hookRun.create({
        data: {
          hookId,
          orgId: created.id,
          deliveryKey: 'org-delete-run',
          startedAt: new Date('2026-07-11T00:00:00.000Z'),
          agentId,
          projectionId,
          projectionGeneration: 1n
        }
      })

      const pending = await app.inject({ method: 'DELETE', url: `/api/v1/orgs/${created.id}` })
      expect(pending.statusCode).toBe(409)
      expect((pending.json() as { message: string }).message).toContain('GitHub Check cleanup is pending')
      expect(await prisma.org.findUnique({ where: { id: created.id } })).not.toBeNull()
      expect(await prisma.githubInstallation.findFirst({ where: { orgId: created.id } })).not.toBeNull()
      expect(await prisma.hookDef.findUniqueOrThrow({ where: { id: hookId } })).toMatchObject({ enabled: false })
      const tombstoned = await prisma.hookReviewProjection.findUniqueOrThrow({ where: { id: projectionId } })
      expect(tombstoned).toMatchObject({
        desiredState: 'failure',
        observedState: null,
        tombstonedAt: expect.any(Date),
        nextAttemptAt: expect.any(Date)
      })

      // Model the durable reporter's completed failing PATCH. The retry must
      // remove owner-independent projection/run metadata in the same commit as
      // the Org and its installation facts.
      await prisma.hookReviewProjection.update({
        where: { id: projectionId },
        data: {
          observedState: 'failure',
          nextAttemptAt: null,
          leaseOwner: null,
          leaseUntil: null,
          pendingIntent: Prisma.DbNull,
          writeMarker: null,
          writePhase: null,
          writeStartedAt: null,
          lastErrorCode: null
        }
      })
      const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/orgs/${created.id}` })
      expect(deleted.statusCode).toBe(204)
      expect(await prisma.org.findUnique({ where: { id: created.id } })).toBeNull()
      expect(await prisma.hookReviewProjection.findUnique({ where: { id: projectionId } })).toBeNull()
      expect(await prisma.hookRun.findFirst({ where: { orgId: created.id } })).toBeNull()
      expect(await prisma.githubInstallation.findFirst({ where: { orgId: created.id } })).toBeNull()
    } finally {
      await close()
    }
  })

  it('deletes a never-published projection in one pass without creating cleanup work', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const created = (await (
        await app.inject({ method: 'POST', url: '/api/v1/orgs', payload: { name: 'Local', slug: 'local-delete' } })
      ).json()) as OrgBody
      const projectionId = randomUUID()
      await prisma.hookReviewProjection.create({
        data: {
          id: projectionId,
          hookId: randomUUID(),
          orgId: created.id,
          agentId: randomUUID(),
          repoId: 478n,
          repoFullName: 'acme/local',
          headSha: 'b'.repeat(40),
          reportSha: 'b'.repeat(40),
          projectionEpoch: 1n,
          generation: 1n,
          externalId: projectionId,
          mode: 'check',
          gateMode: 'informational',
          desiredState: 'queued'
        }
      })

      const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/orgs/${created.id}` })
      expect(deleted.statusCode).toBe(204)
      expect(await prisma.org.findUnique({ where: { id: created.id } })).toBeNull()
      expect(await prisma.hookReviewProjection.findUnique({ where: { id: projectionId } })).toBeNull()
    } finally {
      await close()
    }
  })

  it('403s for a non-owner', async () => {
    const other = await prisma.org.create({ data: { name: 'Other', slug: 'other-del' } })
    await prisma.membership.create({ data: { orgId: other.id, userId: DEFAULT_OWNER_ID, role: 'collaborator' } })
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'DELETE', url: `/api/v1/orgs/${other.id}` })
      expect(res.statusCode).toBe(403)
    } finally {
      await close()
    }
  })

  it('deleting the LAST org leaves the caller in none — nothing is conjured back', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'DELETE', url: ORG })
      expect(res.statusCode).toBe(204)
      const list = (await (await app.inject({ method: 'GET', url: '/api/v1/orgs' })).json()) as OrgBody[]
      expect(list).toEqual([]) // the console sends this caller to org onboarding
    } finally {
      await close()
    }
  })
})

describe('org scoping — cross-org key revocation is refused', () => {
  it("DELETE /daemons/:id/keys/:keyId 404s for a key that belongs to another org's daemon", async () => {
    // A foreign org with its own daemon + key…
    const foreignOrg = await prisma.org.create({ data: { name: 'Foreign', slug: 'foreign-keys' } })
    await prisma.daemon.create({
      data: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', orgId: foreignOrg.id, sessionEpoch: 1n, status: 'ready' }
    })
    const foreignKey = await prisma.apiKey.create({
      data: {
        principalType: 'daemon',
        orgId: foreignOrg.id,
        daemonId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        hash: 'x'.repeat(64),
        displayTail: 'ffff'
      }
    })

    const { app, close } = buildHttpApp(prisma)
    try {
      // …and the caller's own daemon in the default org.
      const mine = (await (await app.inject({ method: 'POST', url: `${ORG}/daemons/token` })).json()) as {
        daemonId: string
      }
      const res = await app.inject({ method: 'DELETE', url: `${ORG}/daemons/${mine.daemonId}/keys/${foreignKey.id}` })
      expect(res.statusCode).toBe(404)
      const untouched = await prisma.apiKey.findUnique({ where: { id: foreignKey.id } })
      expect(untouched?.revokedAt).toBeNull() // the foreign key survives
    } finally {
      await close()
    }
  })
})

describe('org scoping — cross-org isolation on console reads', () => {
  it('agents created in another org are invisible to the caller’s active org', async () => {
    // A stranger with an org of their own; put an agent in it.
    const stranger = await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: 'sub-x',
      email: 'x@x.dev',
      emailVerified: true
    })
    const strangerOrg = (
      await new PgOrgRepo(prisma).create({ name: null, slug: 'stranger-org', ownerUserId: stranger.userId })
    ).id
    await prisma.agent.create({
      data: { id: '99999999-9999-4999-8999-999999999999', orgId: strangerOrg, name: 'foreign-agent', runtime: 'claude' }
    })

    const { app, close } = buildHttpApp(prisma)
    try {
      const list = await app.inject({ method: 'GET', url: `${ORG}/agents` })
      expect(list.statusCode).toBe(200)
      expect((list.json() as { id: string }[]).map((a) => a.id)).not.toContain('99999999-9999-4999-8999-999999999999')

      const get = await app.inject({ method: 'GET', url: `${ORG}/agents/99999999-9999-4999-8999-999999999999` })
      expect(get.statusCode).toBe(404) // cross-org id reads as absent
    } finally {
      await close()
    }
  })
})
