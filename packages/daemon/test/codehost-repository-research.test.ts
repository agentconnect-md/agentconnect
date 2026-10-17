// Organization research's code-host reads (assistant-mode.md §5.15 "Code hosts"): bounded parts of one repository, research only, its own read token.
import { describe, expect, it, vi } from 'vitest'
import type { GitCredGrant } from '@agentconnect.md/protocol'
import {
  CODEOWNERS_MAX_BYTES,
  README_MAX_BYTES,
  REVIEW_WINDOW_MS,
  githubReads,
  giteaReads,
  gitlabReads,
  readRepositoryPart,
  repositoryReadClient,
  reviewedAreas,
  topLevelArea,
  type RepositoryOverview,
  type RepositoryOwners,
  type RepositoryReleases
} from '../src/codehost/repository-research.js'
import { GitCredentialCache } from '../src/cp/git-credential.js'
import {
  CODE_HOST_RESEARCH_TOOLS,
  listCodeHostRepositories,
  readCodeHostRepository
} from '../src/mcp/ops/code-host-research.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { researchCoordinate } from '../src/session/subsession-coordinate.js'

const NOW = Date.parse('2026-10-17T09:30:00.000Z')
const DAY = 24 * 60 * 60_000

/** A host answering by path; anything unlisted is a 404, and every path asked is recorded. */
function host(routes: Record<string, unknown>) {
  const asked: string[] = []
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const path = String(url).replace('https://api.example.test', '')
    asked.push(path)
    if (!(path in routes)) return new Response('not found', { status: 404 })
    const body = routes[path]
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { client: repositoryReadClient({ base: 'https://api.example.test', headers: {}, fetchImpl }), asked }
}

describe('the shaping', () => {
  it('names a change’s area by its top-level path', () => {
    expect(topLevelArea('src/billing/api.ts')).toBe('src/')
    expect(topLevelArea('/docs/readme.md')).toBe('docs/')
    expect(topLevelArea('package.json')).toBe('/')
  })

  it('counts each reviewer once per change and area, leaving authors and bots out', () => {
    expect(
      reviewedAreas([
        {
          author: 'alice',
          reviewers: ['bob', 'bob', 'alice', 'ci[bot]'],
          paths: ['src/a.ts', 'src/b.ts', 'docs/x.md']
        },
        { author: 'carol', reviewers: ['bob', 'dave'], paths: ['src/c.ts'] },
        { author: 'bob', reviewers: [], paths: ['infra/main.tf'] }
      ])
    ).toEqual([
      {
        path: 'src/',
        reviewers: [
          { login: 'bob', reviews: 2 },
          { login: 'dave', reviews: 1 }
        ]
      },
      { path: 'docs/', reviewers: [{ login: 'bob', reviews: 1 }] }
    ])
  })
})

describe('GitHub', () => {
  const repo = '/repos/example-org/example-repo'
  const meta = { description: 'Billing service', topics: ['payments'], default_branch: 'main', private: true }

  it('reads an overview with the README cut at 8 KB', async () => {
    const { client } = host({ [repo]: meta, [`${repo}/readme?ref=main`]: 'x'.repeat(README_MAX_BYTES + 100) })
    const overview = (await readRepositoryPart(
      githubReads(client, 'example-org/example-repo'),
      'example-org/example-repo',
      'overview',
      NOW
    )) as RepositoryOverview
    expect(overview).toMatchObject({
      repository: 'example-org/example-repo',
      description: 'Billing service',
      topics: ['payments'],
      defaultBranch: 'main',
      private: true
    })
    expect(overview.readme?.text).toHaveLength(README_MAX_BYTES)
    expect(overview.readme?.truncated).toBe(true)
  })

  it('reads owners from the first CODEOWNERS found and reviews of the last 90 days’ merged pull requests', async () => {
    const inWindow = new Date(NOW - 10 * DAY).toISOString()
    const tooOld = new Date(NOW - REVIEW_WINDOW_MS - DAY).toISOString()
    const { client, asked } = host({
      [repo]: meta,
      [`${repo}/contents/CODEOWNERS?ref=main`]: '* @example-org/billing\n',
      [`${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]: [
        { number: 7, merged_at: inWindow, user: { login: 'alice' } },
        { number: 8, merged_at: null, user: { login: 'carol' } },
        { number: 9, merged_at: tooOld, user: { login: 'dave' } }
      ],
      [`${repo}/pulls/7/reviews?per_page=100`]: [{ user: { login: 'bob' } }],
      [`${repo}/pulls/7/files?per_page=100`]: [{ filename: 'src/api.ts' }]
    })
    const owners = (await readRepositoryPart(
      githubReads(client, 'example-org/example-repo'),
      'example-org/example-repo',
      'owners',
      NOW
    )) as RepositoryOwners
    expect(owners.codeowners).toEqual({ path: 'CODEOWNERS', text: '* @example-org/billing\n', truncated: false })
    expect(owners.reviewedAreas).toEqual([{ path: 'src/', reviewers: [{ login: 'bob', reviews: 1 }] }])
    expect(owners).toMatchObject({ changesRead: 1, windowDays: 90 })
    // .github/CODEOWNERS was tried first, and only the merged change in the window was read further.
    expect(asked).toContain(`${repo}/contents/.github/CODEOWNERS?ref=main`)
    expect(asked.some((path) => path.includes('/pulls/9/'))).toBe(false)
  })

  it('reads at most 16 KB of CODEOWNERS', async () => {
    const { client } = host({ [repo]: meta, [`${repo}/contents/.github/CODEOWNERS?ref=main`]: 'y'.repeat(20_000) })
    const owners = (await readRepositoryPart(
      githubReads(client, 'example-org/example-repo'),
      'r',
      'owners',
      NOW
    )) as RepositoryOwners
    expect(owners.codeowners?.text).toHaveLength(CODEOWNERS_MAX_BYTES)
    expect(owners.codeowners?.truncated).toBe(true)
  })

  it('reads releases, skipping drafts, else its tags', async () => {
    const releases = host({
      [repo]: meta,
      [`${repo}/releases?per_page=20`]: [
        { tag_name: 'v2.0.0', name: 'Two', published_at: '2026-10-01T00:00:00Z', prerelease: false },
        { tag_name: 'v2.1.0-rc', draft: true }
      ]
    })
    expect(
      (
        (await readRepositoryPart(
          githubReads(releases.client, 'example-org/example-repo'),
          'r',
          'releases',
          NOW
        )) as RepositoryReleases
      ).releases
    ).toEqual([{ name: 'Two', tag: 'v2.0.0', publishedAt: '2026-10-01T00:00:00Z', prerelease: false }])
    const tags = host({
      [repo]: meta,
      [`${repo}/releases?per_page=20`]: [],
      [`${repo}/tags?per_page=20`]: [{ name: 'v1' }]
    })
    expect(
      await readRepositoryPart(githubReads(tags.client, 'example-org/example-repo'), 'r', 'releases', NOW)
    ).toEqual({
      repository: 'r',
      releases: [{ name: 'v1', tag: 'v1', publishedAt: null, prerelease: false }],
      from: 'tags'
    })
  })

  it('fails a read the host refuses, and one of a repository it cannot find', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 })) as unknown as typeof globalThis.fetch
    const refused = repositoryReadClient({ base: 'https://api.example.test', headers: {}, fetchImpl })
    await expect(readRepositoryPart(githubReads(refused, 'a/b'), 'a/b', 'overview', NOW)).rejects.toThrow(
      'answered 403'
    )
    await expect(readRepositoryPart(githubReads(host({}).client, 'a/b'), 'a/b', 'overview', NOW)).rejects.toThrow(
      'could not be read'
    )
  })
})

describe('GitLab and Gitea', () => {
  it('reads a GitLab project by its numeric id', async () => {
    const project = '/projects/4455667'
    const { client } = host({
      [project]: { description: 'Example', topics: ['ops'], default_branch: 'main', visibility: 'internal' },
      [`${project}/repository/files/README.md/raw?ref=main`]: '# Example\n',
      [`${project}/releases?per_page=20`]: [{ tag_name: 'v3', released_at: '2026-09-01T00:00:00Z' }]
    })
    const reads = gitlabReads(client, '4455667')
    expect(await readRepositoryPart(reads, 'example-group/example-project', 'overview', NOW)).toMatchObject({
      private: true,
      readme: { text: '# Example\n' }
    })
    expect(((await readRepositoryPart(reads, 'p', 'releases', NOW)) as RepositoryReleases).releases[0]).toMatchObject({
      tag: 'v3'
    })
  })

  it('reads a Gitea repository by its path', async () => {
    const repo = '/repos/example-org/example-repo'
    const inWindow = new Date(NOW - DAY).toISOString()
    const { client } = host({
      [repo]: { description: 'Example', default_branch: 'main', private: false },
      [`${repo}/pulls?state=closed&sort=recentupdate&limit=50`]: [
        { number: 3, merged: true, merged_at: inWindow, user: { login: 'alice' } }
      ],
      [`${repo}/pulls/3/reviews`]: [{ user: { login: 'erin' } }],
      [`${repo}/pulls/3/files?limit=100`]: [{ filename: 'api/handler.go' }]
    })
    expect(
      (
        (await readRepositoryPart(
          giteaReads(client, 'example-org/example-repo'),
          'r',
          'owners',
          NOW
        )) as RepositoryOwners
      ).reviewedAreas
    ).toEqual([{ path: 'api/', reviewers: [{ login: 'erin', reviews: 1 }] }])
  })
})

describe('the tools', () => {
  it('are offered to research alone, and refuse any other session', async () => {
    const deps = {
      codeHostResearch: { list: vi.fn(async () => ({ repositories: [] })), read: vi.fn(async () => ({})) }
    }
    const at = (thread: string) => ({ agentId: 'bot-a', thread }) as SessionContext
    await expect(listCodeHostRepositories(at(researchCoordinate('1')), {}, deps)).resolves.toEqual({ repositories: [] })
    await expect(listCodeHostRepositories(at('append:1'), {}, deps)).rejects.toThrow('organization research only')
    await expect(
      readCodeHostRepository(at('subsession:1'), { repository: 'a/b', part: 'overview' }, deps)
    ).rejects.toThrow('organization research only')
    await expect(
      readCodeHostRepository(at(researchCoordinate('1')), { repository: 'a/b', part: 'code' }, deps)
    ).rejects.toThrow('part')
    await readCodeHostRepository(at(researchCoordinate('1')), { repository: 'a/b', part: 'owners' }, deps)
    expect(deps.codeHostResearch.read).toHaveBeenCalledWith(expect.anything(), { repository: 'a/b', part: 'owners' })
  })

  it('keep each description and schema within the runtimes’ limits', () => {
    for (const tool of CODE_HOST_RESEARCH_TOOLS) {
      expect('oneOf' in tool.inputSchema).toBe(false)
      expect(tool.description.length).toBeLessThanOrEqual(2_048)
      expect(Buffer.byteLength(JSON.stringify(tool.inputSchema))).toBeLessThanOrEqual(5_000)
    }
  })
})

describe('research’s GitHub read token', () => {
  it('asks for one repository’s contents and pull requests read-only, cached apart from the gh wrapper’s', async () => {
    const asked: Record<string, unknown>[] = []
    const cache = new GitCredentialCache({
      request: async (payload) => {
        asked.push(payload)
        return {
          username: 'x-access-token',
          token: `ghs_${asked.length}`,
          ttlSec: 3600,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          repoFullName: 'example-org/example-repo',
          access: 'read'
        } as GitCredGrant
      },
      log: { warn: () => {} }
    })
    const read = await cache.getResearchReadToken('bot-a', 'example-org/example-repo')
    expect(asked[0]).toMatchObject({
      agentId: 'bot-a',
      capabilities: ['contents', 'pull_requests'],
      repoFullName: 'example-org/example-repo',
      requestedAccess: 'read'
    })
    expect((await cache.getResearchReadToken('bot-a', 'example-org/example-repo')).token).toBe(read.token)
    const wrapper = await cache.get('bot-a', 'helper', { plane: 'gh', repo: 'example-org/example-repo' })
    expect(wrapper.token).not.toBe(read.token)
    expect(asked).toHaveLength(2)
  })
})
