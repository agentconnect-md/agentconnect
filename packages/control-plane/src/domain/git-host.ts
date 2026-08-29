/**
 * Host classification for stored/typed git addresses (git-workspace-model.md §6).
 * One definition — the derivation, the hook lazy repair, the grant routes, and
 * the repo-layer repair guard all ask the same question and must agree.
 */
import { gitRepoLabel, normalizeGitUrl, workspaceGitOriginOf } from '@agentconnect.md/protocol'

/** Does this address select canonical github.com? Historical rows may predate
 *  clone-target validation, so a normalization failure is a "no". */
export function isCanonicalGithubAddress(gitRepo: string): boolean {
  try {
    const origin = workspaceGitOriginOf(gitRepo)
    return origin === 'https://github.com' || origin === 'ssh://github.com'
  } catch {
    return false
  }
}

/**
 * The project path when the address sits on the deployment's GitLab host; null
 * otherwise. The base URL may carry a path prefix an origin may not (§24.1), so
 * https compares host+prefix; ssh compares the bare host and only when the base
 * has no prefix.
 */
export function gitlabManagedProjectPath(gitRepo: string, baseUrl: string): string | null {
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    return null
  }
  const basePrefix = base.pathname.replace(/\/+$/, '')
  let origin: string
  try {
    origin = workspaceGitOriginOf(gitRepo)
  } catch {
    return null
  }
  const baseHostPort = base.port ? `${base.hostname.toLowerCase()}:${base.port}` : base.hostname.toLowerCase()
  if (origin === `ssh://${baseHostPort}` && basePrefix === '') {
    const path = gitRepoLabel(gitRepo)
    return path.includes('/') ? path : null
  }
  if (origin !== `https://${baseHostPort}`) return null
  let url: URL
  try {
    url = new URL(normalizeGitUrl(gitRepo))
  } catch {
    return null
  }
  const path = url.pathname.replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!path.toLowerCase().startsWith(`${basePrefix.toLowerCase()}/`)) return null
  const projectPath = path.slice(basePrefix.length + 1)
  return projectPath.includes('/') ? projectPath : null
}
