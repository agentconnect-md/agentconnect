// GitHub REST pieces shared by the skill acquisition path and the workspace source resolver.

export const GITHUB_API_BASE = 'https://api.github.com'
export const GITHUB_API_VERSION = '2022-11-28'

/** The headers every daemon GitHub API read sends; `ifNoneMatch` makes it conditional, so a 304 costs no budget. */
export function githubApiHeaders(opts: {
  accept: string
  token?: string
  ifNoneMatch?: string
}): Record<string, string> {
  return {
    accept: opts.accept,
    'accept-encoding': 'identity',
    'user-agent': 'agentconnect-daemon',
    'x-github-api-version': GITHUB_API_VERSION,
    ...(opts.ifNoneMatch ? { 'if-none-match': opts.ifNoneMatch } : {}),
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
  }
}

/** A repository's identity fields, or undefined when the body is not a JSON object; a field is set only when it is a string. */
export function parseGithubRepositoryIdentity(raw: string): { id?: string; fullName?: string } | undefined {
  let metadata: unknown
  try {
    // Quote every positive `id` before parsing so an id beyond Number.MAX_SAFE_INTEGER compares exactly.
    metadata = JSON.parse(raw.replace(/("id"\s*:\s*)([1-9]\d*)/g, '$1"$2"'))
  } catch {
    return undefined
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const record = metadata as Record<string, unknown>
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.full_name === 'string' ? { fullName: record.full_name } : {})
  }
}

/** A 403/429 that is GitHub's rate limit (primary or secondary) rather than a permission refusal. */
export function isGithubRateLimited(response: Response): boolean {
  if (response.status === 429) return true
  if (response.status !== 403) return false
  return response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')
}
