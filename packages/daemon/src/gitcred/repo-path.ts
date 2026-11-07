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

/** An Azure DevOps organization name: letters, digits and inner hyphens. */
export const AZURE_DEVOPS_ORGANIZATION = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/

/** One decoded Azure Repos project or repository name, or undefined for an empty one, a dot segment, a separator or a control character. */
export function azureDevOpsName(value: string | undefined): string | undefined {
  if (!value || value === '.' || value === '..' || /[/\\\u0000-\u001f\u007f]/.test(value)) return undefined
  return value
}

/** `{organization}/[{project}/]_git/{repository}[.git][/…]` on dev.azure.com as `organization/project/repository`, lowercased; git hands the path already percent-decoded, and the project-less form names the project like its repository. */
export function azureDevOpsRepoFromPath(p: string): string | undefined {
  const segs = p.replace(/^\/+/, '').split('/')
  const at = segs[1]?.toLowerCase() === '_git' ? 1 : segs[2]?.toLowerCase() === '_git' ? 2 : -1
  const organization = segs[0]
  const repository = azureDevOpsName(segs[at + 1]?.replace(/\.git$/i, ''))
  const project = at === 2 ? azureDevOpsName(segs[1]) : repository
  if (at < 0 || !organization || !AZURE_DEVOPS_ORGANIZATION.test(organization) || !project || !repository) {
    return undefined
  }
  return `${organization}/${project}/${repository}`.toLowerCase()
}

/** Keyed by the table's OPEN provider string: a host this side cannot parse is never ours. Gitea has
 *  no subgroups, so its `owner/repo` grammar is GitHub's, measured from the instance root the host
 *  match already stripped (gitea-integration.md §9). */
const PARSERS: Record<string, CredentialRepoPathParser> = {
  github: repoFromPath,
  gitlab: projectFromPath,
  gitea: repoFromPath,
  'azure-devops': azureDevOpsRepoFromPath
}

/** The grammar this provider's credential paths follow; undefined ⇒ a provider this build knows nothing about. */
export function credentialRepoPathParser(provider: string): CredentialRepoPathParser | undefined {
  return PARSERS[provider]
}
