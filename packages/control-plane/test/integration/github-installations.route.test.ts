/**
 * GitHub App installation removal over the org-scoped REST surface.
 *
 * The route is deliberately owner-only because it uses the deployment App JWT
 * to uninstall the App from GitHub itself (not merely forget local metadata).
 * A successful removal marks the durable provenance row revoked and
 * re-converges the org's GitHub hook rules; authorization/not-found failures
 * must never reach GitHub, and an upstream failure must leave the row live.
 */
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, TEST_API_KEY_PEPPER, type HttpApp } from '../fakes/build-http.js'
import { GithubService } from '../../src/github/service.js'
import { UserAuthzDeniedError, type GithubUserAuthzService } from '../../src/github/user-authz.js'
import { PgGithubInstallationRepo, PgGithubInstallStateStore, PgUserRepo } from '../../src/persistence/index.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import { OrgId } from '../../src/domain/ids.js'
import { systemClock } from '../../src/domain/clock.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const INSTALLATION = 123456789n
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

const opened: HttpApp[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

interface GithubCall {
  url: string
  method: string | undefined
}

/** A real GithubService with only its HTTP edge stubbed — this proves the REST
 * routes reach GitHub through the service, rather than merely exercising a
 * mocked service method. */
function appAs(
  opts: {
    userId?: string
    githubStatus?: number
    githubFetch?: (url: string, init?: RequestInit) => Promise<Response>
    githubUserAuthz?: Partial<Pick<GithubUserAuthzService, 'assertAccess' | 'filterReposForUser'>>
  } = {}
) {
  const calls: GithubCall[] = []
  const githubStatus = opts.githubStatus ?? 204
  const github = new GithubService({
    cfg: { appId: 1, slug: 'agentconnect-test', jwtIssuer: '1', privateKey },
    clock: systemClock,
    installations: new PgGithubInstallationRepo(prisma),
    installState: new PgGithubInstallStateStore(prisma),
    pepper: TEST_API_KEY_PEPPER,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method })
      if (opts.githubFetch) return opts.githubFetch(url, init)
      return githubStatus === 204
        ? new Response(null, { status: 204 })
        : Response.json({ message: 'upstream failure' }, { status: githubStatus })
    }
  })
  const a = buildHttpApp(prisma, opts.userId ? { DEFAULT_OWNER_ID: opts.userId } : undefined, undefined, undefined, {
    github,
    ...(opts.githubUserAuthz ? { githubUserAuthz: opts.githubUserAuthz as never } : {})
  })
  const rebroadcast = vi.spyOn(a.deps.hooks, 'rebroadcastGithubForOrg').mockResolvedValue()
  opened.push(a)
  return { app: a, calls, rebroadcast }
}

async function seedInstallation(opts: { orgId?: string; installationId?: bigint } = {}) {
  return prisma.githubInstallation.create({
    data: {
      orgId: opts.orgId ?? DEFAULT_ORG_ID,
      installationId: opts.installationId ?? INSTALLATION,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all'
    }
  })
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@acme.dev`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

describe('GET /orgs/:orgId/github/installations/:id/repositories', () => {
  it('returns public repositories while explicitly marking private repositories hidden', async () => {
    const row = await seedInstallation()
    let filterCalls = 0
    const filterReposForUser: GithubUserAuthzService['filterReposForUser'] = async (_userId, _installation, repos) => {
      filterCalls += 1
      return {
        repos: repos.filter((repo) => !repo.private),
        privateReposHidden: true
      }
    }
    const h = appAs({
      githubFetch: async (url) => {
        if (url.endsWith(`/app/installations/${INSTALLATION}/access_tokens`)) {
          return Response.json(
            { token: 'ghs_metadata', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
            { status: 201 }
          )
        }
        if (url.includes('/installation/repositories?')) {
          return Response.json({
            total_count: 2,
            repositories: [
              {
                id: 41,
                full_name: 'acme/public-repository',
                private: false,
                default_branch: 'main',
                description: 'Public',
                pushed_at: '2026-08-01T00:00:00.000Z'
              },
              {
                id: 42,
                full_name: 'acme/private-repository',
                private: true,
                default_branch: 'main',
                description: 'Private',
                pushed_at: '2026-08-01T00:00:00.000Z'
              }
            ]
          })
        }
        throw new Error(`unexpected github call: ${url}`)
      },
      githubUserAuthz: { filterReposForUser }
    })

    const res = await h.app.app.inject({
      method: 'GET',
      url: `${ORG}/github/installations/${row.id}/repositories?page=1&perPage=100`
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      repos: [
        {
          repoId: '41',
          fullName: 'acme/public-repository',
          private: false,
          defaultBranch: 'main',
          description: 'Public',
          updatedAt: '2026-08-01T00:00:00.000Z'
        }
      ],
      totalCount: 2,
      privateReposHidden: true
    })
    expect(filterCalls).toBe(1)
  })
})

describe('GET /orgs/:orgId/github/installations/:id/repositories/:owner/:repo', () => {
  it('resolves an authorized private repository outside the initial picker page', async () => {
    const row = await seedInstallation()
    const h = appAs({
      githubFetch: async (url) => {
        if (url.endsWith(`/app/installations/${INSTALLATION}/access_tokens`)) {
          return Response.json(
            { token: 'ghs_metadata', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
            { status: 201 }
          )
        }
        if (url.endsWith('/repos/acme/private-repository')) {
          return Response.json(
            {
              id: 42,
              full_name: 'acme/private-repository',
              private: true,
              default_branch: 'trunk'
            },
            { status: 200 }
          )
        }
        throw new Error(`unexpected github call: ${url}`)
      }
    })

    const res = await h.app.app.inject({
      method: 'GET',
      url: `${ORG}/github/installations/${row.id}/repositories/acme/private-repository`
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      repoId: '42',
      fullName: 'acme/private-repository',
      private: true,
      defaultBranch: 'trunk',
      description: null,
      updatedAt: null
    })
    expect(h.calls).toEqual([
      { url: `https://api.github.com/app/installations/${INSTALLATION}/access_tokens`, method: 'POST' },
      { url: 'https://api.github.com/repos/acme/private-repository', method: 'GET' }
    ])
  })

  it('does not expose an out-of-grant repository', async () => {
    const row = await seedInstallation()
    const h = appAs({
      githubFetch: async (url) => {
        if (url.endsWith(`/app/installations/${INSTALLATION}/access_tokens`)) {
          return Response.json(
            { token: 'ghs_metadata', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
            { status: 201 }
          )
        }
        if (url.endsWith('/repos/acme/not-granted')) return Response.json({ message: 'Not Found' }, { status: 404 })
        throw new Error(`unexpected github call: ${url}`)
      }
    })

    const res = await h.app.app.inject({
      method: 'GET',
      url: `${ORG}/github/installations/${row.id}/repositories/acme/not-granted`
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ message: 'repository not found' })
  })

  it('reads a repository on another account as absent, without asking GitHub', async () => {
    // An installation token reads any PUBLIC repository, so resolving
    // `/repos/{owner}/{repo}` blind reported a repo on an unrelated account as
    // App-backed — the picker then offered a workspace the write path refuses.
    const row = await seedInstallation()
    const h = appAs({
      githubFetch: async (url) => {
        throw new Error(`unexpected github call: ${url}`)
      }
    })

    const res = await h.app.app.inject({
      method: 'GET',
      url: `${ORG}/github/installations/${row.id}/repositories/other-account/public-repository`
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ message: 'repository not found' })
    expect(h.calls).toEqual([]) // no token minted, no upstream read
  })

  it.each(['USER_NO_ACCESS', 'GITHUB_IDENTITY_REQUIRED'] as const)(
    'does not expose a covered private repository when the per-user gate returns %s',
    async (denial) => {
      const row = await seedInstallation()
      const h = appAs({
        githubFetch: async (url) => {
          if (url.endsWith(`/app/installations/${INSTALLATION}/access_tokens`)) {
            return Response.json(
              { token: 'ghs_metadata', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
              { status: 201 }
            )
          }
          if (url.endsWith('/repos/acme/private-repository')) {
            return Response.json(
              {
                id: 42,
                full_name: 'acme/private-repository',
                private: true,
                default_branch: 'trunk'
              },
              { status: 200 }
            )
          }
          throw new Error(`unexpected github call: ${url}`)
        },
        githubUserAuthz: {
          assertAccess: async () => {
            throw new UserAuthzDeniedError('you do not have access to acme/private-repository on GitHub', denial)
          }
        }
      })

      const res = await h.app.app.inject({
        method: 'GET',
        url: `${ORG}/github/installations/${row.id}/repositories/acme/private-repository`
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'Not Found', statusCode: 404, message: 'repository not found' })
    }
  )
})

describe('DELETE /orgs/:orgId/github/installations/:id', () => {
  it('owner uninstalls on GitHub, marks the provenance row revoked, and re-converges hooks', async () => {
    const row = await seedInstallation()
    const h = appAs()

    const res = await h.app.app.inject({ method: 'DELETE', url: `${ORG}/github/installations/${row.id}` })

    expect(res.statusCode).toBe(204)
    expect(h.calls).toEqual([
      {
        url: `https://api.github.com/app/installations/${INSTALLATION}`,
        method: 'DELETE'
      }
    ])
    expect((await prisma.githubInstallation.findUniqueOrThrow({ where: { id: row.id } })).revokedAt).toBeInstanceOf(
      Date
    )
    await vi.waitFor(() => expect(h.rebroadcast).toHaveBeenCalledWith(OrgId(DEFAULT_ORG_ID)))
  })

  it.each(['collaborator', 'viewer'] as const)('%s cannot uninstall an organization installation', async (role) => {
    const row = await seedInstallation()
    const userId = await makeUser(`github-uninstall-${role}`, role)
    const h = appAs({ userId })

    const res = await h.app.app.inject({ method: 'DELETE', url: `${ORG}/github/installations/${row.id}` })

    expect(res.statusCode).toBe(403)
    expect(h.calls).toEqual([])
    expect((await prisma.githubInstallation.findUniqueOrThrow({ where: { id: row.id } })).revokedAt).toBeNull()
    expect(h.rebroadcast).not.toHaveBeenCalled()
  })

  it('foreign and missing installation rows return 404 without reaching GitHub', async () => {
    const foreignOrg = await prisma.org.create({ data: { name: 'Foreign', slug: 'github-uninstall-foreign' } })
    const foreign = await seedInstallation({ orgId: foreignOrg.id, installationId: INSTALLATION + 1n })
    const h = appAs()

    const foreignRes = await h.app.app.inject({
      method: 'DELETE',
      url: `${ORG}/github/installations/${foreign.id}`
    })
    const missingRes = await h.app.app.inject({
      method: 'DELETE',
      url: `${ORG}/github/installations/00000000-0000-4000-8000-000000000000`
    })

    expect(foreignRes.statusCode).toBe(404)
    expect(missingRes.statusCode).toBe(404)
    expect(h.calls).toEqual([])
    expect((await prisma.githubInstallation.findUniqueOrThrow({ where: { id: foreign.id } })).revokedAt).toBeNull()
    expect(h.rebroadcast).not.toHaveBeenCalled()
  })

  it('an upstream failure returns 502 and leaves the installation live', async () => {
    const row = await seedInstallation()
    const h = appAs({ githubStatus: 500 })

    const res = await h.app.app.inject({ method: 'DELETE', url: `${ORG}/github/installations/${row.id}` })

    expect(res.statusCode).toBe(502)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toMatchObject({
      url: `https://api.github.com/app/installations/${INSTALLATION}`,
      method: 'DELETE'
    })
    expect((await prisma.githubInstallation.findUniqueOrThrow({ where: { id: row.id } })).revokedAt).toBeNull()
    expect(h.rebroadcast).not.toHaveBeenCalled()
  })
})
