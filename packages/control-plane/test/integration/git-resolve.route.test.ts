/**
 * `GET /orgs/:orgId/git/resolve` — the picking preview (git-workspace-model.md §5).
 *
 * It runs the SAME derivation the write paths run, so the picker can no longer
 * disagree with the write path about what a pick means. Covered here: the three
 * outcomes of the §6 table a deployment with a GitHub App can produce — a covered
 * owner's granted repository (provider `github`, the caller's write ceiling), an
 * address on a host nothing manages (`anonymous`, no preflight), and a refusal,
 * which mirrors the write path's as a 409 rather than a bare failure.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildHttpApp, TEST_API_KEY_PEPPER, type HttpApp } from '../fakes/build-http.js'
import { GithubService } from '../../src/github/service.js'
import { UserAuthzDeniedError } from '../../src/github/user-authz.js'
import {
  PgAgentRepoAuthorizationRepo,
  PgGithubInstallationRepo,
  PgGithubInstallStateStore
} from '../../src/persistence/index.js'
import type { HttpDeps } from '../../src/http/deps.js'
import { systemClock } from '../../src/domain/clock.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
/** The one repository the installation grants; every other lookup reads 404. */
const GRANTED = { id: 100, full_name: 'acme/infra', default_branch: 'trunk' }

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

/** A GithubService over the real Pg repos with a URL-routing fetch stub. */
function stubbedGithub(): GithubService {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return new GithubService({
    cfg: { appId: 1, slug: 'agentconnect-test', jwtIssuer: '1', privateKey },
    clock: systemClock,
    installations: new PgGithubInstallationRepo(prisma),
    installState: new PgGithubInstallStateStore(prisma),
    repoAuths: new PgAgentRepoAuthorizationRepo(prisma),
    pepper: TEST_API_KEY_PEPPER,
    fetchImpl: async (url: string): Promise<Response> => {
      if (url.includes('/access_tokens')) {
        return Response.json(
          { token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() },
          { status: 201 }
        )
      }
      const repoPath = /\/repos\/([^/]+\/[^/]+)$/.exec(url)
      if (repoPath) {
        if (repoPath[1]!.toLowerCase() !== GRANTED.full_name) {
          return Response.json({ message: 'Not Found' }, { status: 404 })
        }
        return Response.json({ ...GRANTED, private: true }, { status: 200 })
      }
      throw new Error(`unexpected github call: ${url}`)
    }
  })
}

function app(depsOverrides: Partial<HttpDeps> = {}): HttpApp {
  const a = buildHttpApp(prisma, undefined, undefined, undefined, { github: stubbedGithub(), ...depsOverrides })
  opened.push(a)
  return a
}

const seedInstallation = () =>
  prisma.githubInstallation.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      installationId: 1234567n,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all'
    }
  })

const resolve = (a: HttpApp, gitRepo: string) =>
  a.app.inject({ method: 'GET', url: `${ORG}/git/resolve`, query: { gitRepo } })

describe('GET /git/resolve — the picking preview (§5)', () => {
  it('reports the App installation that vouches, the write ceiling, and the canonical address', async () => {
    await seedInstallation()
    // Shorthand in, full cloneable address out — plus the default branch the
    // picker offers, taken from the installation lookup and not from the caller.
    expect((await resolve(app(), 'ACME/Infra')).json()).toEqual({
      provider: 'github',
      gitRepo: 'https://github.com/acme/infra',
      access: 'write',
      defaultBranch: 'trunk'
    })
  })

  it('answers the caller’s own ceiling rather than enforcing one', async () => {
    await seedInstallation()
    // The identity gate runs inside the derivation (§6), so a caller GitHub holds
    // below write previews as `read` — the picker badges it, nothing is refused.
    const readOnly = app({
      githubUserAuthz: {
        assertAccess: async (_userId: string, _ins: unknown, _owner: string, _repo: string, need: 'read' | 'write') => {
          if (need === 'write') throw new UserAuthzDeniedError('no write access to acme/infra', 'USER_NO_ACCESS')
          return { permission: 'read', repoPrivate: true, canRead: true, canWrite: false, identityRequired: false }
        }
      } as never
    })
    expect((await resolve(readOnly, 'acme/infra')).json()).toMatchObject({ provider: 'github', access: 'read' })
  })

  it('reads an unmanaged host as an anonymous clone, with no preflight to claim a branch', async () => {
    await seedInstallation()
    const res = await resolve(app(), 'https://git.example.test/example-co/tools.git')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      provider: 'anonymous',
      gitRepo: 'https://git.example.test/example-co/tools.git',
      access: 'read',
      host: 'other'
    })
  })

  it('refuses exactly what the write path refuses, as a 409', async () => {
    await seedInstallation()
    // A covered owner's ungranted repository never degrades to anonymous: the miss
    // proves it is private-and-ungranted, and the useful answer names the grant (§9).
    const ungranted = await resolve(app(), 'acme/secret-plans')
    expect(ungranted.statusCode).toBe(409)
    expect(ungranted.json()).toMatchObject({ message: expect.stringContaining('is not granted') })

    // No covering installation and not public either.
    const notPublic = await resolve(app({ resolvePublicRepo: async () => 'not-found' }), 'other-co/private')
    expect(notPublic.statusCode).toBe(409)
    expect(notPublic.json()).toMatchObject({
      message: 'other-co/private is not a public repository — install the GitHub App for access to private ones'
    })
  })
})
