// A credentialed GitLab skill Source (source-cache.md §5, §11): its project on the deployment's instance, and the daemon's read seam.
import { skillSourceCredential, type AgentSkillEntry } from '@agentconnect.md/protocol'
import type { CodeHostRepositoryRef, ResolveRefResult } from '../codehost/repository.js'
import { normalizeManagedBaseUrl } from '../gitcred/managed-hosts.js'
import { gitlabApiBaseUrl } from '../gitlab/api-base.js'

export interface GitlabSkillRepository extends CodeHostRepositoryRef {
  provider: 'gitlab'
  /** The instance base the project path is measured from, without a trailing slash. */
  baseUrl: string
  /** The instance's `/api/v4` root. */
  apiBaseUrl: string
}

/** The project a `credential: gitlab` entry names on the instance; undefined for any other entry or an address off that instance. */
export function gitlabSkillRepository(
  entry: Pick<AgentSkillEntry, 'credential'> & { private?: boolean },
  cloneUrl: string,
  gitlabHost: string | undefined
): GitlabSkillRepository | undefined {
  const credential = skillSourceCredential(entry)
  if (credential?.provider !== 'gitlab') return undefined
  let url: URL
  let base: URL
  try {
    url = new URL(cloneUrl)
    // The spec's instance when it names one; otherwise the Source's own origin, an instance at the URL root.
    base = new URL(normalizeManagedBaseUrl(gitlabHost) ?? url.origin)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined
  if (base.origin !== url.origin) return undefined
  const prefix = `${base.origin}${base.pathname.replace(/\/+$/, '')}`
  const location = `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')}`
  if (!location.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) return undefined
  const path = location.slice(prefix.length + 1)
  // GitLab's `path_with_namespace` is always namespace/project.
  if (!path.includes('/') || path.split('/').some((part) => part === '')) return undefined
  return {
    provider: 'gitlab',
    externalId: credential.projectId,
    cloneUrl,
    path,
    baseUrl: prefix,
    apiBaseUrl: gitlabApiBaseUrl(prefix)
  }
}

/** How the daemon reads a credentialed GitLab Source: CP-minted tokens only, never a spawned Git helper (source-cache.md §5). */
export interface GitlabSkillReads {
  /** The GitLab instance the agent's replicated spec names, if any. */
  host(agentId: string): string | undefined
  /** The agent's own resolution: identity by project id and path, then the entry's ref to a commit. */
  resolve(entry: AgentSkillEntry, agentId: string): Promise<ResolveRefResult>
  /** A CP-minted read token for the project, as the agent's own authority. */
  token(agentId: string, projectId: string): Promise<string>
}

// One daemon per process, wired at start like the Git credential injection; absent ⇒ a credentialed GitLab Source fails closed.
let reads: GitlabSkillReads | undefined

export function configureGitlabSkillReads(value: GitlabSkillReads | undefined): void {
  reads = value
}

export function gitlabSkillReads(): GitlabSkillReads {
  if (!reads) throw new Error('skill GitLab reads are not configured on this daemon')
  return reads
}
