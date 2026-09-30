// Repository-grant re-attestation over real Postgres: the claim and verdict writes, the sweep with a fake access answer, and the fences.
import { describe, it, expect, afterEach } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type { AgentUpsert } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { buildHttpApp, TEST_API_KEY_PEPPER, type HttpApp } from '../fakes/build-http.js'
import { GithubService } from '../../src/github/service.js'
import { GithubApiError } from '../../src/github/api.js'
import { UserAuthzDeniedError } from '../../src/github/user-authz.js'
import { RepositoryGrantReattestor } from '../../src/github/repository-grant-reattestor.js'
import {
  PgAgentInstallationAuthorizationRepo,
  PgAgentRepoAuthorizationRepo,
  PgGithubInstallationRepo,
  PgGithubInstallStateStore
} from '../../src/persistence/index.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { NoConnection } from '../../src/orchestrator/outbound.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
import { systemClock } from '../../src/domain/clock.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd8d8d8d8-dddd-4ddd-8ddd-dddddddddddd'
const INSTALLATION = 7654321n
const AFTER_MS = 24 * 60 * 60_000
const REPOS: Record<string, { id: number; full_name: string }> = {
  'acme/infra': { id: 100, full_name: 'acme/infra' },
  'acme/tools': { id: 111, full_name: 'acme/tools' }
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

// A GithubService over the real Pg repos whose fetch answers token mints and repository lookups from REPOS.
function stubbedGithub(): GithubService {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.includes('/access_tokens')) {
      return Response.json(
        { token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() },
        { status: 201 }
      )
    }
    const repoPath = /\/repos\/([^/]+\/[^/]+)$/.exec(url)
    if (repoPath) {
      const hit = REPOS[repoPath[1]!.toLowerCase()]
      if (!hit) return Response.json({ message: 'Not Found' }, { status: 404 })
      return Response.json({ ...hit, private: true, default_branch: 'main' }, { status: 200 })
    }
    throw new Error(`unexpected github call: ${url}`)
  }
  return new GithubService({
    cfg: { appId: 1, slug: 'example-deployment', jwtIssuer: '1', privateKey },
    clock: systemClock,
    installations: new PgGithubInstallationRepo(prisma),
    installState: new PgGithubInstallStateStore(prisma),
    repoAuths: new PgAgentRepoAuthorizationRepo(prisma),
    installationAuths: new PgAgentInstallationAuthorizationRepo(prisma),
    pepper: TEST_API_KEY_PEPPER,
    fetchImpl
  })
}

class UpsertSpy {
  readonly upserts: AgentUpsert[] = []
  async agentUpsert(_daemonId: string, u: AgentUpsert): Promise<void> {
    this.upserts.push(u)
  }
}

/** The fake code-host access answer the sweep and the routes both consult. */
type AccessAnswer = 'held' | 'lost' | 'unreachable'

function app(answer: { current: AccessAnswer }, spy = new UpsertSpy()): { a: HttpApp; spy: UpsertSpy } {
  const assertAccess = async () => {
    if (answer.current === 'lost') throw new UserAuthzDeniedError('no access', 'USER_NO_ACCESS')
    if (answer.current === 'unreachable') throw new GithubApiError('upstream unavailable', 503, 'INTERNAL', true)
    return { permission: 'write', repoPrivate: true, canRead: true, canWrite: true, identityRequired: false }
  }
  const a = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender, {
    github: stubbedGithub(),
    githubUserAuthz: { assertAccess } as never
  })
  opened.push(a)
  return { a, spy }
}

function reattestor(a: HttpApp, clock: FakeClock, answer: { current: AccessAnswer }): RepositoryGrantReattestor {
  return new RepositoryGrantReattestor(
    {
      grants: a.deps.repos.agentRepoAuth,
      installations: a.deps.repos.githubInstallation,
      github: a.deps.github!,
      authz: {
        assertAccess: async () => {
          if (answer.current === 'lost') throw new UserAuthzDeniedError('no access', 'USER_NO_ACCESS')
          if (answer.current === 'unreachable') throw new GithubApiError('upstream unavailable', 503, 'INTERNAL', true)
          return { permission: 'write', repoPrivate: true, canRead: true, canWrite: true, identityRequired: false }
        }
      },
      audit: a.deps.repos.audit,
      reproject: async (orgId, agentId) => {
        const agent = await a.deps.repos.agent.get(orgId, agentId)
        if (!agent) return
        await a.deps.agentDelivery.upsert(agent, (err) => {
          expect(err).toBeInstanceOf(NoConnection)
        })
      },
      clock
    },
    { intervalMs: 600_000, reattestAfterMs: AFTER_MS, batch: 10 }
  )
}

async function seedInstallation(): Promise<void> {
  await prisma.githubInstallation.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      installationId: INSTALLATION,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all'
    }
  })
}

// A placed scratch agent: every GitHub repository it reaches is an explicit grant.
async function scratchAgent(): Promise<string> {
  await seedDaemon(prisma, DAEMON)
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  return agentId
}

async function grantRow(
  agentId: string,
  over: { provider?: string; repoId?: bigint; repoFullName?: string; checkedAt?: Date | null } = {}
): Promise<string> {
  const row = await prisma.agentRepoAuthorization.create({
    data: {
      agentId,
      provider: over.provider ?? 'github',
      repoId: over.repoId ?? 111n,
      repoFullName: over.repoFullName ?? 'acme/tools',
      access: 'read',
      createdByUserId: DEFAULT_OWNER_ID,
      attestedByUserId: DEFAULT_OWNER_ID,
      attestationCheckedAt: over.checkedAt ?? null
    }
  })
  return row.id
}

const revisionOf = async (agentId: string): Promise<bigint> =>
  (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).configRevision

describe('repository grant persistence (re-attestation)', () => {
  it('claims the never-checked grant first, then the oldest due one, and stamps each', async () => {
    const agentId = await scratchAgent()
    const repo = new PgAgentRepoAuthorizationRepo(prisma)
    const now = new Date('2026-09-01T00:00:00Z')
    const before = new Date(now.getTime() - AFTER_MS)
    const recent = await grantRow(agentId, { repoId: 1n, checkedAt: new Date(now.getTime() - 60_000) })
    const old = await grantRow(agentId, { repoId: 2n, checkedAt: new Date(before.getTime() - 60_000) })
    const never = await grantRow(agentId, { repoId: 3n })
    await grantRow(agentId, { provider: 'gitlab', repoId: 4n, repoFullName: 'group/project' })

    const first = await repo.claimDueForReattestation('github', before, now)
    const second = await repo.claimDueForReattestation('github', before, now)
    const third = await repo.claimDueForReattestation('github', before, now)

    expect([first?.id, second?.id, third]).toEqual([never, old, null])
    expect(first).toMatchObject({ orgId: DEFAULT_ORG_ID, attestedByUserId: DEFAULT_OWNER_ID, stale: null })
    const stamped = await prisma.agentRepoAuthorization.findMany({ where: { id: { in: [never, old, recent] } } })
    expect(stamped.find((r) => r.id === never)?.attestationCheckedAt).toEqual(now)
    expect(stamped.find((r) => r.id === old)?.attestationCheckedAt).toEqual(now)
    expect(stamped.find((r) => r.id === recent)?.attestationCheckedAt).not.toEqual(now)
  })

  it('a verdict flips honored state once, advances the revision only on a flip, and lands only for the checked attester and tier', async () => {
    const agentId = await scratchAgent()
    const id = await grantRow(agentId)
    const repo = new PgAgentRepoAuthorizationRepo(prisma)
    const subject = { attestedByUserId: DEFAULT_OWNER_ID, access: 'read' as const }
    const t0 = new Date('2026-09-01T00:00:00Z')
    const t1 = new Date('2026-09-02T00:00:00Z')
    const r0 = await revisionOf(agentId)

    expect(await repo.recordAttestation(id, subject, 'access_lost', t0)).toBe(true)
    const r1 = await revisionOf(agentId)
    expect(r1).toBeGreaterThan(r0)
    expect(await repo.recordAttestation(id, subject, 'identity_unlinked', t1)).toBe(false)
    expect((await repo.get(id))?.stale).toEqual({ since: t0, reason: 'identity_unlinked' })
    expect(await revisionOf(agentId)).toBe(r1)

    // A verdict about another attester or tier is moot.
    expect(await repo.recordAttestation(id, { ...subject, access: 'write' }, null, t1)).toBe(false)
    expect(await repo.recordAttestation(id, { ...subject, attestedByUserId: null }, null, t1)).toBe(false)
    expect((await repo.get(id))?.stale).not.toBeNull()

    expect(await repo.recordAttestation(id, subject, null, t1)).toBe(true)
    expect((await repo.get(id))?.stale).toBeNull()
    expect(await revisionOf(agentId)).toBeGreaterThan(r1)
  })

  it('raising a stale grant with an attestation honors it again under the raiser and advances the revision', async () => {
    const agentId = await scratchAgent()
    const id = await grantRow(agentId)
    const repo = new PgAgentRepoAuthorizationRepo(prisma)
    await repo.recordAttestation(id, { attestedByUserId: DEFAULT_OWNER_ID, access: 'read' }, 'access_lost', new Date(0))
    const before = await revisionOf(agentId)
    const at = new Date('2026-09-03T00:00:00Z')

    const raised = await repo.updateAccess(id, 'write', { userId: DEFAULT_OWNER_ID, at })

    expect(raised).toMatchObject({ access: 'write', stale: null, attestedByUserId: DEFAULT_OWNER_ID })
    expect((await prisma.agentRepoAuthorization.findUniqueOrThrow({ where: { id } })).attestationCheckedAt).toEqual(at)
    expect(await revisionOf(agentId)).toBeGreaterThan(before)
  })
})

describe('the re-attestation sweep with a fake access answer', () => {
  it('still has access: the grant stays honored and mints', async () => {
    await seedInstallation()
    const agentId = await scratchAgent()
    const id = await grantRow(agentId)
    const answer = { current: 'held' as AccessAnswer }
    const { a, spy } = app(answer)
    const clock = new FakeClock(Date.now())

    const sweep = await reattestor(a, clock, answer).sweep()

    expect(sweep).toMatchObject({ checked: 1, held: 1, flipped: 0 })
    expect((await a.deps.repos.agentRepoAuth.get(id))?.stale).toBeNull()
    expect(spy.upserts).toEqual([])
    const agent = (await a.deps.repos.agent.get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    await expect(a.deps.github!.mintForAgent(agent, [], ['contents'], 'acme/tools')).resolves.toMatchObject({
      repoFullName: 'acme/tools'
    })
  })

  it('lost access: the grant goes stale, leaves the spec, refuses to mint, and returns when access does', async () => {
    await seedInstallation()
    const agentId = await scratchAgent()
    const id = await grantRow(agentId)
    const answer = { current: 'lost' as AccessAnswer }
    const { a, spy } = app(answer)
    const clock = new FakeClock(Date.now())
    const loop = reattestor(a, clock, answer)

    expect(await loop.sweep()).toMatchObject({ checked: 1, stale: 1, flipped: 1 })

    const listed = await a.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}/repos` })
    expect(listed.json()).toEqual([
      expect.objectContaining({ id, stale: { since: expect.any(String), reason: 'access_lost' } })
    ])
    expect(spy.upserts.at(-1)!.spec.workspace).toMatchObject({ additionalRepos: [] })
    expect(await prisma.auditEvent.count({ where: { agentId, kind: 'agent_repo_change' } })).toBe(1)
    const agent = (await a.deps.repos.agent.get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    await expect(a.deps.github!.mintForAgent(agent, [], ['contents'], 'acme/tools')).rejects.toMatchObject({
      code: 'SCOPE_DENIED',
      message: expect.stringContaining('authorization for this agent is suspended')
    })

    answer.current = 'held'
    clock.advance(AFTER_MS + 1)
    expect(await loop.sweep()).toMatchObject({ checked: 1, held: 1, flipped: 1 })
    expect((await a.deps.repos.agentRepoAuth.get(id))?.stale).toBeNull()
    expect(spy.upserts.at(-1)!.spec.workspace).toMatchObject({
      additionalRepos: [{ repoFullName: 'acme/tools', repoId: '111' }]
    })
  })

  it('host unreachable: nothing is marked stale and the sweep stops', async () => {
    await seedInstallation()
    const agentId = await scratchAgent()
    const first = await grantRow(agentId, { repoId: 111n })
    const second = await grantRow(agentId, { repoId: 100n, repoFullName: 'acme/infra' })
    const answer = { current: 'unreachable' as AccessAnswer }
    const { a, spy } = app(answer)
    const before = await revisionOf(agentId)

    const sweep = await reattestor(a, new FakeClock(Date.now()), answer).sweep()

    expect(sweep).toMatchObject({ checked: 1, deferred: true, stale: 0 })
    const rows = await prisma.agentRepoAuthorization.findMany({ where: { id: { in: [first, second] } } })
    expect(rows.map((r) => r.staleSince)).toEqual([null, null])
    // Only the grant whose check failed rotated back; the other is still first in line.
    expect(rows.filter((r) => r.attestationCheckedAt === null)).toHaveLength(1)
    expect(await revisionOf(agentId)).toBe(before)
    expect(spy.upserts).toEqual([])
  })
})

describe('the console and trigger fences on a stale grant', () => {
  it('raising a stale grant re-attests the caller, honors it again and re-projects the spec', async () => {
    await seedInstallation()
    const agentId = await scratchAgent()
    const id = await grantRow(agentId)
    await new PgAgentRepoAuthorizationRepo(prisma).recordAttestation(
      id,
      { attestedByUserId: DEFAULT_OWNER_ID, access: 'read' },
      'access_lost',
      new Date(0)
    )
    const { a, spy } = app({ current: 'held' })

    const raised = await a.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}/repos/${id}`,
      payload: { access: 'write' }
    })

    expect(raised.statusCode).toBe(200)
    expect(raised.json()).toMatchObject({ access: 'write', stale: null })
    expect(spy.upserts).toHaveLength(1)
    expect(spy.upserts[0]!.spec.workspace).toMatchObject({
      additionalRepos: [{ repoFullName: 'acme/tools', repoId: '111' }]
    })
  })

  it('a stale grant authorizes no new trigger', async () => {
    await seedInstallation()
    const agentId = await scratchAgent()
    const id = await grantRow(agentId)
    await new PgAgentRepoAuthorizationRepo(prisma).recordAttestation(
      id,
      { attestedByUserId: DEFAULT_OWNER_ID, access: 'read' },
      'access_lost',
      new Date(0)
    )
    await prisma.relay.create({
      data: {
        id: randomUUID(),
        name: `relay-${randomUUID().slice(0, 8)}`,
        daemonUrl: 'wss://relay-0',
        lastSeenAt: new Date()
      }
    })
    const { a } = app({ current: 'held' })

    const denied = await a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: {
        agentId,
        kind: 'github',
        name: 'gh-hook',
        repoFullName: 'acme/tools',
        family: 'issues',
        events: ['issues:opened']
      }
    })

    expect(denied.statusCode).toBe(409)
    expect(await prisma.hookDef.count()).toBe(0)
  })
})
