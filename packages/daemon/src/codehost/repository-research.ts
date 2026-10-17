// Organization research's code-host reads (assistant-mode.md §5.15 "Code hosts"): one repository's overview, owners or releases, bounded, read only.
import { GITHUB_API_BASE, GITHUB_API_VERSION } from '../github/rest.js'
import { parseCodeHostJson } from './json.js'

/** A README is read up to this many bytes. */
export const README_MAX_BYTES = 8 * 1024
/** A CODEOWNERS file is read whole up to this many bytes. */
export const CODEOWNERS_MAX_BYTES = 16 * 1024
/** Who reviewed which area is counted over merged changes this recent. */
export const REVIEW_WINDOW_MS = 90 * 24 * 60 * 60_000
/** At most this many merged changes are read for their reviewers and files. */
export const REVIEW_CHANGES_MAX = 30
/** The newest releases, or tags, read. */
export const RELEASES_MAX = 20
/** The most areas an owners read names, and the most reviewers per area. */
export const OWNER_AREAS_MAX = 15
export const AREA_REVIEWERS_MAX = 5
/** A JSON answer larger than this is refused rather than parsed. */
const JSON_MAX_BYTES = 2 * 1024 * 1024
/** Changes whose reviewers and files are read at once. */
const CHANGE_READS_AT_ONCE = 4

export type RepositoryPart = 'overview' | 'owners' | 'releases'
export const REPOSITORY_PARTS: readonly RepositoryPart[] = ['overview', 'owners', 'releases']

/** A file's text, cut at its bound; `truncated` when more remained. */
export interface BoundedText {
  text: string
  truncated: boolean
}

export interface RepositoryOverview {
  repository: string
  description: string | null
  topics: string[]
  defaultBranch: string | null
  homepage: string | null
  archived: boolean
  /** Whether the repository is not public: what memory may say of it is its name, purpose and owners alone. */
  private: boolean
  readme: BoundedText | null
}

export interface RepositoryOwners {
  repository: string
  codeowners: (BoundedText & { path: string }) | null
  /** Reviewers counted per top-level path over merged changes in the window, most reviewed area first. */
  reviewedAreas: { path: string; reviewers: { login: string; reviews: number }[] }[]
  changesRead: number
  windowDays: number
}

export interface RepositoryReleases {
  repository: string
  /** Newest first; tags stand in where the repository publishes no release. */
  releases: { name: string; tag: string; publishedAt: string | null; prerelease: boolean }[]
  from: 'releases' | 'tags'
}

/** GET-only access to one provider's API: JSON or a raw file, each undefined when the host answers 404. */
export interface RepositoryReadClient {
  json(path: string): Promise<unknown>
  text(path: string, maxBytes: number, accept?: string): Promise<BoundedText | undefined>
}

/** A read client under one API base with fixed auth headers; any answer but 2xx or 404 fails the read. */
export function repositoryReadClient(input: {
  base: string
  headers: Record<string, string>
  fetchImpl?: typeof globalThis.fetch
  signal?: AbortSignal
}): RepositoryReadClient {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const get = async (path: string, accept: string): Promise<Response | undefined> => {
    const response = await fetchImpl(`${input.base}${path}`, {
      headers: { ...input.headers, accept, 'user-agent': 'agentconnect-daemon' },
      redirect: 'error',
      ...(input.signal ? { signal: input.signal } : {})
    })
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      return undefined
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`the code host answered ${response.status}`)
    }
    return response
  }
  return {
    async json(path) {
      const response = await get(path, 'application/json')
      if (!response) return undefined
      const body = await boundedText(response, JSON_MAX_BYTES)
      if (body.truncated) throw new Error('the code host’s answer was too large')
      return parseCodeHostJson(body.text)
    },
    async text(path, maxBytes, accept = 'text/plain') {
      const response = await get(path, accept)
      return response ? await boundedText(response, maxBytes) : undefined
    }
  }
}

/** A body read up to `maxBytes`, never past it, cut on a character boundary. */
export async function boundedText(response: Response, maxBytes: number): Promise<BoundedText> {
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const room = maxBytes - total
    if (value.byteLength > room) {
      chunks.push(Buffer.from(value.subarray(0, room)))
      total += room
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(Buffer.from(value))
    total += value.byteLength
  }
  // A cut through a multi-byte character drops its partial bytes.
  const text = Buffer.concat(chunks, total).toString('utf8').replace(/�$/, '')
  return { text, truncated }
}

/** The area a changed file belongs to: its top-level directory, `/` for a file at the root. */
export function topLevelArea(path: string): string {
  const at = path.replace(/^\/+/, '').indexOf('/')
  return at < 0 ? '/' : `${path.replace(/^\/+/, '').slice(0, at)}/`
}

/** Reviews counted per area: each reviewer once per change per area the change touched, authors and bots left out. */
export function reviewedAreas(
  changes: readonly { author?: string | undefined; reviewers: readonly string[]; paths: readonly string[] }[]
): RepositoryOwners['reviewedAreas'] {
  const areas = new Map<string, Map<string, number>>()
  for (const change of changes) {
    const reviewers = new Set(
      change.reviewers.filter((login) => login && login !== change.author && !/\[bot\]$|-bot$/i.test(login))
    )
    for (const area of new Set(change.paths.map(topLevelArea))) {
      const counts = areas.get(area) ?? new Map<string, number>()
      for (const login of reviewers) counts.set(login, (counts.get(login) ?? 0) + 1)
      if (counts.size > 0) areas.set(area, counts)
    }
  }
  const total = (counts: Map<string, number>) => [...counts.values()].reduce((sum, n) => sum + n, 0)
  return [...areas.entries()]
    .sort(([a, x], [b, y]) => total(y) - total(x) || (a < b ? -1 : 1))
    .slice(0, OWNER_AREAS_MAX)
    .map(([path, counts]) => ({
      path,
      reviewers: [...counts.entries()]
        .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
        .slice(0, AREA_REVIEWERS_MAX)
        .map(([login, reviews]) => ({ login, reviews }))
    }))
}

type Json = Record<string, unknown>
const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(record) : [])
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null)
const login = (value: unknown): string | undefined =>
  str(record(value).login) ?? str(record(value).username) ?? undefined

/** One provider's paths and fields, over a read client. */
interface ProviderReads {
  metadata(): Promise<Json | undefined>
  overview(meta: Json): Omit<RepositoryOverview, 'repository' | 'readme'>
  raw(path: string, branch: string | null, maxBytes: number): Promise<BoundedText | undefined>
  readmePaths: readonly string[]
  codeownersPaths: readonly string[]
  /** Merged changes since `since`, newest first, each with its author, reviewers and changed paths. */
  mergedChanges(since: number): Promise<{ author?: string; reviewers: string[]; paths: string[] }[]>
  releases(): Promise<RepositoryReleases['releases']>
  tags(): Promise<RepositoryReleases['releases']>
}

const tagsOf = (rows: Json[]): RepositoryReleases['releases'] =>
  rows.flatMap((row) => {
    const name = str(row.name)
    return name ? [{ name, tag: name, publishedAt: null, prerelease: false }] : []
  })

/** Reads per item, a few at a time, in order. */
async function inBatches<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += CHANGE_READS_AT_ONCE)
    out.push(...(await Promise.all(items.slice(i, i + CHANGE_READS_AT_ONCE).map(read))))
  return out
}

/** GitHub, by `owner/repo`, with a single-repository read token. */
export function githubReads(client: RepositoryReadClient, repository: string): ProviderReads {
  const repo = `/repos/${repository.split('/').map(encodeURIComponent).join('/')}`
  return {
    metadata: async () => record(await client.json(repo)),
    overview: (meta) => ({
      description: str(meta.description),
      topics: Array.isArray(meta.topics) ? meta.topics.filter((t): t is string => typeof t === 'string') : [],
      defaultBranch: str(meta.default_branch),
      homepage: str(meta.homepage),
      archived: meta.archived === true,
      private: meta.private === true
    }),
    raw: async (path, branch, maxBytes) =>
      await client.text(
        path === 'README'
          ? `${repo}/readme${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`
          : `${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`,
        maxBytes,
        'application/vnd.github.raw'
      ),
    readmePaths: ['README'],
    codeownersPaths: ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'],
    async mergedChanges(since) {
      const closed = list(await client.json(`${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`))
      const merged = closed
        .filter((pull) => {
          const at = Date.parse(String(pull.merged_at ?? ''))
          return Number.isFinite(at) && at >= since
        })
        .slice(0, REVIEW_CHANGES_MAX)
      return await inBatches(merged, async (pull) => {
        const number = String(pull.number)
        const [reviews, files] = await Promise.all([
          client.json(`${repo}/pulls/${number}/reviews?per_page=100`),
          client.json(`${repo}/pulls/${number}/files?per_page=100`)
        ])
        return {
          ...(login(pull.user) ? { author: login(pull.user)! } : {}),
          reviewers: list(reviews).flatMap((review) => login(review.user) ?? []),
          paths: list(files).flatMap((file) => str(file.filename) ?? [])
        }
      })
    },
    releases: async () =>
      list(await client.json(`${repo}/releases?per_page=${RELEASES_MAX}`))
        .filter((release) => release.draft !== true)
        .flatMap((release) => {
          const tag = str(release.tag_name)
          return tag
            ? [
                {
                  name: str(release.name) ?? tag,
                  tag,
                  publishedAt: str(release.published_at),
                  prerelease: release.prerelease === true
                }
              ]
            : []
        }),
    tags: async () => tagsOf(list(await client.json(`${repo}/tags?per_page=${RELEASES_MAX}`)))
  }
}

/** GitLab, by numeric project id, with the binding's lease. */
export function gitlabReads(client: RepositoryReadClient, projectId: string): ProviderReads {
  const project = `/projects/${encodeURIComponent(projectId)}`
  return {
    metadata: async () => record(await client.json(project)),
    overview: (meta) => ({
      description: str(meta.description),
      topics: (Array.isArray(meta.topics) ? meta.topics : Array.isArray(meta.tag_list) ? meta.tag_list : []).filter(
        (t): t is string => typeof t === 'string'
      ),
      defaultBranch: str(meta.default_branch),
      homepage: str(meta.web_url),
      archived: meta.archived === true,
      private: meta.visibility !== 'public'
    }),
    raw: async (path, branch, maxBytes) =>
      await client.text(
        `${project}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(branch ?? 'HEAD')}`,
        maxBytes
      ),
    readmePaths: ['README.md', 'README'],
    codeownersPaths: ['.gitlab/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'],
    async mergedChanges(since) {
      const after = new Date(since).toISOString()
      const merged = list(
        await client.json(
          `${project}/merge_requests?state=merged&updated_after=${encodeURIComponent(after)}&order_by=updated_at&per_page=${REVIEW_CHANGES_MAX}`
        )
      )
        .filter((mr) => {
          const at = Date.parse(String(mr.merged_at ?? ''))
          return Number.isFinite(at) && at >= since
        })
        .slice(0, REVIEW_CHANGES_MAX)
      return await inBatches(merged, async (mr) => {
        const iid = String(mr.iid)
        const diffs = await client.json(`${project}/merge_requests/${iid}/diffs?per_page=100`)
        return {
          ...(login(mr.author) ? { author: login(mr.author)! } : {}),
          reviewers: list(mr.reviewers).flatMap((reviewer) => login(reviewer) ?? []),
          paths: list(diffs).flatMap((diff) => str(diff.new_path) ?? [])
        }
      })
    },
    releases: async () =>
      list(await client.json(`${project}/releases?per_page=${RELEASES_MAX}`)).flatMap((release) => {
        const tag = str(release.tag_name)
        return tag
          ? [
              {
                name: str(release.name) ?? tag,
                tag,
                publishedAt: str(release.released_at),
                prerelease: release.upcoming_release === true
              }
            ]
          : []
      }),
    tags: async () => tagsOf(list(await client.json(`${project}/repository/tags?per_page=${RELEASES_MAX}`)))
  }
}

/** Gitea, by `owner/repo`, with the binding's lease. */
export function giteaReads(client: RepositoryReadClient, repository: string): ProviderReads {
  const repo = `/repos/${repository.split('/').map(encodeURIComponent).join('/')}`
  return {
    metadata: async () => record(await client.json(repo)),
    overview: (meta) => ({
      description: str(meta.description),
      topics: Array.isArray(meta.topics) ? meta.topics.filter((t): t is string => typeof t === 'string') : [],
      defaultBranch: str(meta.default_branch),
      homepage: str(meta.website) ?? str(meta.html_url),
      archived: meta.archived === true,
      private: meta.private === true
    }),
    raw: async (path, branch, maxBytes) =>
      await client.text(
        `${repo}/raw/${path.split('/').map(encodeURIComponent).join('/')}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`,
        maxBytes
      ),
    readmePaths: ['README.md', 'README'],
    codeownersPaths: ['.gitea/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'],
    async mergedChanges(since) {
      const merged = list(await client.json(`${repo}/pulls?state=closed&sort=recentupdate&limit=50`))
        .filter((pull) => {
          const at = Date.parse(String(pull.merged_at ?? ''))
          return pull.merged === true && Number.isFinite(at) && at >= since
        })
        .slice(0, REVIEW_CHANGES_MAX)
      return await inBatches(merged, async (pull) => {
        const index = String(pull.number)
        const [reviews, files] = await Promise.all([
          client.json(`${repo}/pulls/${index}/reviews`),
          client.json(`${repo}/pulls/${index}/files?limit=100`)
        ])
        return {
          ...(login(pull.user) ? { author: login(pull.user)! } : {}),
          reviewers: list(reviews).flatMap((review) => login(review.user) ?? []),
          paths: list(files).flatMap((file) => str(file.filename) ?? [])
        }
      })
    },
    releases: async () =>
      list(await client.json(`${repo}/releases?limit=${RELEASES_MAX}`))
        .filter((release) => release.draft !== true)
        .flatMap((release) => {
          const tag = str(release.tag_name)
          return tag
            ? [
                {
                  name: str(release.name) ?? tag,
                  tag,
                  publishedAt: str(release.published_at),
                  prerelease: release.prerelease === true
                }
              ]
            : []
        }),
    tags: async () => tagsOf(list(await client.json(`${repo}/tags?limit=${RELEASES_MAX}`)))
  }
}

/** The first of these files that exists, read to its bound. */
async function firstFile(
  reads: ProviderReads,
  paths: readonly string[],
  branch: string | null,
  maxBytes: number
): Promise<(BoundedText & { path: string }) | null> {
  for (const path of paths) {
    const found = await reads.raw(path, branch, maxBytes)
    if (found) return { ...found, path }
  }
  return null
}

/** One part of one repository, bounded as §5.15 says. */
export async function readRepositoryPart(
  reads: ProviderReads,
  repository: string,
  part: RepositoryPart,
  now: number
): Promise<RepositoryOverview | RepositoryOwners | RepositoryReleases> {
  const meta = await reads.metadata()
  if (!meta || Object.keys(meta).length === 0) throw new Error(`${repository} could not be read`)
  const overview = reads.overview(meta)
  if (part === 'overview') {
    const readme = await firstFile(reads, reads.readmePaths, overview.defaultBranch, README_MAX_BYTES)
    return { repository, ...overview, readme: readme ? { text: readme.text, truncated: readme.truncated } : null }
  }
  if (part === 'owners') {
    const codeowners = await firstFile(reads, reads.codeownersPaths, overview.defaultBranch, CODEOWNERS_MAX_BYTES)
    const changes = await reads.mergedChanges(now - REVIEW_WINDOW_MS)
    return {
      repository,
      codeowners,
      reviewedAreas: reviewedAreas(changes),
      changesRead: changes.length,
      windowDays: Math.round(REVIEW_WINDOW_MS / (24 * 60 * 60_000))
    }
  }
  const releases = await reads.releases()
  if (releases.length > 0) return { repository, releases: releases.slice(0, RELEASES_MAX), from: 'releases' }
  return { repository, releases: (await reads.tags()).slice(0, RELEASES_MAX), from: 'tags' }
}

/** GitHub's REST headers for a read token. */
export function githubReadHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'x-github-api-version': GITHUB_API_VERSION }
}

export { GITHUB_API_BASE }
