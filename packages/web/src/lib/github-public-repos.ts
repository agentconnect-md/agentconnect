// Anonymous GitHub reads for repositories no App installation covers. A public
// workspace is cloned without credentials, so the browser may verify it itself —
// these calls carry no token and are a UX enhancement only: the control plane
// re-resolves the repository before it accepts the workspace.
import type { GithubRepoDto } from '@/lib/api'

type GithubApiRepo = {
  full_name?: string
  private?: boolean
  default_branch?: string
  description?: string | null
  updated_at?: string | null
}

function repoFromGithubApi(row: GithubApiRepo): GithubRepoDto | null {
  if (!row.full_name) return null
  return {
    fullName: row.full_name,
    private: !!row.private,
    defaultBranch: row.default_branch || 'main',
    description: row.description ?? null,
    updatedAt: row.updated_at ?? null
  }
}

/** `owner/repo` from anything a user pastes — a clone URL, an SSH remote, a bare
 *  path — or null when it is not one GitHub repository. */
export function githubRepoLabelFromInput(input: string): string | null {
  const raw = input
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  if (!raw) return null
  const path = raw
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/^ssh:\/\/git@github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^github\.com\//i, '')
  const [owner, repo, ...rest] = path.split('/').filter(Boolean)
  if (!owner || !repo || rest.length > 0) return null
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner)) return null
  if (!/^[a-z0-9._-]+$/i.test(repo)) return null
  return `${owner}/${repo}`
}

/** One repository, only if it is public — a private repo reads as absent here. */
export async function fetchPublicGithubRepo(fullName: string, signal?: AbortSignal): Promise<GithubRepoDto | null> {
  const label = githubRepoLabelFromInput(fullName)
  if (!label) return null
  const res = await fetch(`https://api.github.com/repos/${label}`, { signal, cache: 'no-store' })
  if (!res.ok) return null
  const repo = repoFromGithubApi((await res.json()) as GithubApiRepo)
  return repo && !repo.private ? repo : null
}

export async function fetchPublicGithubBranches(fullName: string, signal?: AbortSignal): Promise<string[] | null> {
  const label = githubRepoLabelFromInput(fullName)
  if (!label) return null
  const res = await fetch(`https://api.github.com/repos/${label}/branches?per_page=100`, { signal, cache: 'no-store' })
  if (!res.ok) return null
  const rows = (await res.json()) as Array<{ name?: string }>
  return rows.map((r) => r.name).filter((name): name is string => !!name)
}

export async function searchPublicGithubRepos(query: string, signal?: AbortSignal): Promise<GithubRepoDto[]> {
  const q = query.trim()
  if (q.length < 3) return []
  const res = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} in:name is:public`)}&per_page=5`,
    { signal, cache: 'no-store' }
  )
  if (!res.ok) return []
  const body = (await res.json()) as { items?: GithubApiRepo[] }
  return (body.items ?? []).map(repoFromGithubApi).filter((repo): repo is GithubRepoDto => !!repo && !repo.private)
}
