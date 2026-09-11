/**
 * The repository path one managed code host spells in a git credential request, for both ends of the
 * credential channel (gitlab-com-integration.md §13.2, §24.4).
 *
 * A leaf beside the host table and for the same reason: the credential helper is bundled for the
 * sandbox image and may import nothing but node builtins, so it cannot reach the daemon-side
 * provider registry. The registry's entry for a provider points at the parser registered here, so a
 * host has ONE path grammar whichever side of the channel asks for it.
 */

/** git's credential `path` as this host's repository path, or undefined when it names no repository. */
export type CredentialRepoPathParser = (path: string) => string | undefined

/** The full namespaced GitLab project path — arbitrary subgroup depth, tolerating a leading slash, a
 *  `.git` suffix, and LFS-ish subpaths (`group/sub/project.git/info/lfs`). */
export function projectFromPath(p: string): string | undefined {
  const cleaned = p.replace(/^\/+/, '')
  const gitSuffix = cleaned.search(/\.git(?:\/|$)/i)
  const path = (gitSuffix >= 0 ? cleaned.slice(0, gitSuffix) : cleaned).replace(/\/+$/, '')
  return path.includes('/') ? path.toLowerCase() : undefined
}

/** "owner/repo" — tolerates a leading slash, a `.git` suffix, and LFS-ish subpaths
 *  (`owner/repo.git/info/lfs`). */
export function repoFromPath(p: string): string | undefined {
  const segs = p.replace(/^\/+/, '').split('/')
  const owner = segs[0]
  const repo = segs[1]?.replace(/\.git$/i, '')
  if (!owner || !repo) return undefined
  return `${owner}/${repo}`.toLowerCase()
}

/** Keyed by the table's OPEN provider string: a host this side cannot parse is never ours. */
const PARSERS: Record<string, CredentialRepoPathParser> = {
  github: repoFromPath,
  gitlab: projectFromPath
}

/** The grammar this provider's credential paths follow; undefined ⇒ a provider this build knows nothing about. */
export function credentialRepoPathParser(provider: string): CredentialRepoPathParser | undefined {
  return PARSERS[provider]
}
