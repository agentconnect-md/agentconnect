/**
 * GitLab skill-source admission and preview (source-cache.md §11, CP3.2): a project on the
 * deployment's GitLab instance is admitted as a plain HTTPS address, anonymous when public
 * and credentialed by its numeric project id when it is a managed private or internal project.
 */
import { GitCloneUrlError, normalizeGitCloneUrl } from '@agentconnect.md/protocol'
import { gitlabManagedProjectPath } from '../domain/git-host.js'
import { pickSkillLayout } from '../github/service.js'
import type { GitlabProjectBindingRecord, GitlabProjectBindingRepo } from '../persistence/ports.js'
import {
  GitlabApiError,
  gitlabProject,
  gitlabPublicProject,
  gitlabRepositoryBlobPaths,
  gitlabRepositoryRefNames,
  type GitlabApiClient
} from './api.js'
import { GitlabOauthDenied, type GitlabOauthService } from './oauth.service.js'

export interface GitlabSkillSourceDeps {
  api: GitlabApiClient
  oauth: Pick<GitlabOauthService, 'withAccessToken'>
  bindings: Pick<GitlabProjectBindingRepo, 'byProjectPath' | 'byProject'>
}

/** What admission learned about a project; `credential` is set only for a managed non-public one. */
export type GitlabSkillProject =
  | {
      status: 'ok'
      projectPath: string
      /** The stored source: the instance base plus the project's current path, never a typed spelling. */
      source: string
      defaultBranch?: string
      credential: { projectId: bigint; cloneUrl?: string } | null
    }
  /** `subpath`: a GitLab route (`/-/tree/…`) instead of a project; ref and subdirectory travel separately. */
  | { status: 'subpath' | 'not-found' | 'needs-binding' | 'unreachable' }

/** The project path when `source` names the deployment's GitLab instance; null for any other host. */
export function gitlabSkillProjectPath(deps: Pick<GitlabSkillSourceDeps, 'api'>, source: string): string | null {
  return gitlabManagedProjectPath(source, deps.api.baseUrl)
}

function cloneUrlOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    return normalizeGitCloneUrl(raw)
  } catch (e) {
    if (e instanceof GitCloneUrlError) return undefined
    throw e
  }
}

/** The installer connection's token for a managed project, or null when no connection can answer for it. */
async function bindingToken(deps: GitlabSkillSourceDeps, binding: GitlabProjectBindingRecord): Promise<string | null> {
  if (!binding.installerConnectionId) return null
  try {
    return await deps.oauth.withAccessToken(binding.orgId, binding.installerConnectionId)
  } catch (e) {
    if (e instanceof GitlabOauthDenied) return null
    throw e
  }
}

/** Resolve a GitLab skill source: a public project needs no binding, a private or internal one needs a managed binding. */
export async function resolveGitlabSkillProject(
  deps: GitlabSkillSourceDeps,
  orgId: string,
  source: string
): Promise<GitlabSkillProject | null> {
  const path = gitlabSkillProjectPath(deps, source)
  if (path === null) return null
  if (path.split('/').includes('-')) return { status: 'subpath' }
  const ok = (
    projectPath: string,
    defaultBranch: string | undefined,
    credential: { projectId: bigint; cloneUrl?: string } | null
  ): GitlabSkillProject => ({
    status: 'ok',
    projectPath,
    source: `${deps.api.baseUrl}/${projectPath}`,
    ...(defaultBranch ? { defaultBranch } : {}),
    credential
  })
  try {
    // An anonymous read answers only for a public project, which then acquires anonymously.
    const pub = await gitlabPublicProject(path, deps.api)
    if (pub) return ok(pub.path_with_namespace, pub.default_branch, null)
    const binding = await deps.bindings.byProjectPath(orgId, path)
    if (!binding || binding.state === 'cleanup_pending') return { status: 'needs-binding' }
    const token = await bindingToken(deps, binding)
    // Without a usable connection the binding's own converged facts stand in for a fresh read.
    if (token === null)
      return ok(binding.projectPath, binding.defaultBranch ?? undefined, { projectId: binding.projectId })
    const project = await gitlabProject(token, binding.projectId, deps.api)
    if (!project) return { status: 'not-found' }
    const cloneUrl = cloneUrlOf(project.http_url_to_repo)
    return ok(project.path_with_namespace, project.default_branch, {
      projectId: binding.projectId,
      ...(cloneUrl ? { cloneUrl } : {})
    })
  } catch (e) {
    if (e instanceof GitlabApiError) return { status: 'unreachable' }
    throw e
  }
}

/** Best-effort SKILL.md scan of a project at parity with the GitHub preview: ref choices plus the manifest under `subDir`. */
export async function scanGitlabSkillProject(
  deps: GitlabSkillSourceDeps,
  orgId: string,
  target: { projectId: bigint } | { projectPath: string },
  ref?: string,
  subDir?: string
): Promise<{ branches: string[]; tags: string[]; skills: Array<{ name: string; dirPath: string }> }> {
  let auth: string | null = null
  let project: bigint | string
  if ('projectId' in target) {
    const binding = await deps.bindings.byProject(orgId, target.projectId)
    if (!binding || binding.state === 'cleanup_pending')
      throw new GitlabOauthDenied('the project is not managed here', 404)
    auth = await bindingToken(deps, binding)
    if (auth === null) throw new GitlabOauthDenied('no GitLab connection can read the project', 409)
    project = target.projectId
  } else {
    project = target.projectPath
  }
  const [branches, tags, paths] = await Promise.all([
    gitlabRepositoryRefNames(auth, project, 'branches', deps.api).catch(() => [] as string[]),
    gitlabRepositoryRefNames(auth, project, 'tags', deps.api).catch(() => [] as string[]),
    gitlabRepositoryBlobPaths(auth, project, ref, deps.api)
  ])
  let skillPaths = paths.filter((p) => p.endsWith('SKILL.md'))
  // Scope discovery to the subdirectory the source installs from, as the GitHub scan does.
  const prefix = subDir?.replace(/^\/+|\/+$/g, '')
  if (prefix) skillPaths = skillPaths.filter((p) => p.startsWith(`${prefix}/`)).map((p) => p.slice(prefix.length + 1))
  return { branches, tags, skills: pickSkillLayout(skillPaths) }
}
