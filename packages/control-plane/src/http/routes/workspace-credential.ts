/**
 * `deriveWorkspaceCredential` — one function, three callers (git-workspace-model.md §6):
 * the agent create route, the workspace replace route, and the resolve endpoint.
 * No other code decides workspace provenance. Provenance depends only on
 * `(orgId, gitRepo)`; eligibility and tier depend on the actor — the GitHub
 * identity gate runs INSIDE this derivation on purpose, so a route can never
 * re-introduce the per-route divergence the design removes (#1561, #1567).
 */
import { GitCloneUrlError, gitRepoLabel, normalizeGitCloneUrl, normalizeGitUrl } from '@agentconnect.md/protocol'
import { gitlabPublicProject } from '../../gitlab/api.js'
import type { HttpDeps } from '../deps.js'
import type { AgentWorkspace, GithubInstallationRecord } from '../../persistence/ports.js'
import { gitlabManagedProjectPath, isCanonicalGithubAddress } from '../../domain/git-host.js'
import { OrgId } from '../../domain/ids.js'

/** Actionable refusal (§6 table) — the routes answer it as a 409. */
export class WorkspaceCredentialRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceCredentialRefused'
  }
}

/** The derived provenance of one cloneable address, for the acting caller. */
export type DerivedWorkspace =
  | {
      kind: 'github'
      /** The covering live installation (provenance hint persisted on the row). */
      installationId: string
      repoId: bigint
      gitRepo: string // canonical address from the installation lookup, never caller input
      defaultBranch: string
      access: 'read' | 'write'
    }
  | {
      kind: 'gitlab'
      projectId: bigint
      gitRepo: string // the catalog row's provider-authored clone URL (§24.1)
      defaultBranch: string
      access: 'read' | 'write'
    }
  | {
      kind: 'anonymous'
      gitRepo: string
      defaultBranch?: string
      access: 'read'
      /** Which managed host the anonymous target sits on, for display derivation (§7). */
      host: 'github' | 'gitlab' | 'other'
    }

function refuse(message: string): never {
  throw new WorkspaceCredentialRefused(message)
}

/** owner/repo when the address selects canonical github.com; null otherwise. */
function githubTarget(gitRepo: string): { owner: string; repo: string } | null {
  if (!isCanonicalGithubAddress(gitRepo)) return null
  const parts = gitRepoLabel(gitRepo).split('/')
  const [owner, repo] = parts
  if (parts.length !== 2 || !owner || !repo) refuse('workspace gitRepo is not a github repository')
  return { owner, repo }
}

/** Resolve the covering App installation, converge the catalog row, and hold the
 *  acting human to the access the agent will run with. Null ⇒ not granted. */
async function bindGithubWorkspaceRepo(
  deps: HttpDeps,
  orgId: string,
  ins: GithubInstallationRecord,
  owner: string,
  repo: string,
  access: 'read' | 'write',
  userId: string | undefined
): Promise<{ repoId: bigint; fullName: string; defaultBranch: string } | null> {
  const ref = await deps.github!.repoRefFor(ins, owner, repo)
  if (!ref) return null
  await deps.repos.codeHostRepository.upsert({
    orgId,
    provider: 'github',
    externalId: ref.repoId,
    displayPath: ref.fullName,
    cloneUrl: `https://github.com/${ref.fullName}`,
    defaultBranch: ref.defaultBranch
  })
  // The identity gate inside the derivation IS the security check (§6), on the
  // CANONICAL spelling so one repository holds one authz cache entry. Where the
  // gate is configured, an actorless caller fails CLOSED — never a silent allow.
  const [canonicalOwner, canonicalRepo] = ref.fullName.split('/')
  if (deps.githubUserAuthz) {
    if (userId === undefined) refuse('a signed-in identity is required to bind this repository')
    await deps.githubUserAuthz.assertAccess(userId, ins, canonicalOwner ?? owner, canonicalRepo ?? repo, access)
  }
  return ref
}

/**
 * Derive who vouches for `gitRepo` (§6 outcome table) for the acting caller.
 *
 * `requestedAccess` unstated takes the highest tier the target carries: `write`
 * where credentials are minted, `read` for an anonymous checkout — and an
 * explicit `write` against an anonymous target refuses. Throws
 * {@link WorkspaceCredentialRefused} for every table refusal; provider/identity
 * errors (GithubApiError, UserAuthzDeniedError, LogtoApiError, GitlabApiError)
 * bubble for the routes' shared error mapping.
 */
export async function deriveWorkspaceCredential(
  deps: HttpDeps,
  orgId: string,
  actorUserId: string | undefined,
  gitRepo: string,
  requestedAccess?: 'read' | 'write'
): Promise<DerivedWorkspace> {
  const gh = githubTarget(gitRepo)
  if (gh) {
    const covering = deps.github
      ? await deps.repos.githubInstallation.liveByOrgAndAccount(OrgId(orgId), gh.owner)
      : null
    const installation = covering && !covering.suspendedAt ? covering : null
    if (installation) {
      const access = requestedAccess ?? 'write'
      const ref = await bindGithubWorkspaceRepo(deps, orgId, installation, gh.owner, gh.repo, access, actorUserId)
      // An installation token reads any PUBLIC repository, so a miss here means
      // private-and-ungranted (or absent) — an anonymous clone cannot serve it,
      // and the actionable answer is to grant it rather than to degrade silently.
      if (!ref) refuse(`${gh.owner}/${gh.repo} is not granted to the GitHub installation — re-select it on GitHub`)
      return {
        kind: 'github',
        installationId: installation.id,
        repoId: ref.repoId,
        gitRepo: normalizeGitUrl(ref.fullName),
        defaultBranch: ref.defaultBranch,
        access
      }
    }
    if (requestedAccess === 'write') refuse('github write access requires a GitHub App installation')
    // Anonymous public read. `unreachable` (rate limit, outage) deliberately does
    // NOT refuse — creation never preflighted at all, and a GitHub blip must not
    // block a checkout the daemon's clone boundary will verify anyway.
    const lookup = deps.resolvePublicRepo ? await deps.resolvePublicRepo(gh.owner, gh.repo) : 'unreachable'
    if (lookup === 'not-found') {
      refuse(`${gh.owner}/${gh.repo} is not a public repository — install the GitHub App for access to private ones`)
    }
    return {
      kind: 'anonymous',
      gitRepo: normalizeGitUrl(lookup === 'unreachable' ? gitRepo : lookup.fullName),
      ...(lookup !== 'unreachable' ? { defaultBranch: lookup.defaultBranch } : {}),
      access: 'read',
      host: 'github'
    }
  }

  const gitlabPath = deps.gitlab ? gitlabManagedProjectPath(gitRepo, deps.gitlab.api.baseUrl) : null
  if (gitlabPath && deps.gitlab) {
    const binding = await deps.repos.gitlabProjectBinding.byProjectPath(orgId, gitlabPath)
    if (binding) {
      // A binding mid-removal must refuse, never demote to an anonymous clone of
      // the same path — the managed identity still exists until cleanup finishes.
      if (binding.state === 'cleanup_pending') {
        refuse(`${gitlabPath} is being removed from this organization — wait for cleanup to finish`)
      }
      // The persisted catalog row, not caller input and never a composed URL, is
      // the authority for the clone URL (§24.1).
      const catalogRow = await deps.repos.codeHostRepository.byExternalId(orgId, 'gitlab', binding.projectId)
      if (!catalogRow?.cloneUrl) {
        refuse('the GitLab project binding has no clone URL yet — repair the project first')
      }
      return {
        kind: 'gitlab',
        projectId: binding.projectId,
        gitRepo: catalogRow.cloneUrl,
        defaultBranch: binding.defaultBranch ?? 'main',
        // A managed binding always mints, so an unstated tier is write.
        access: requestedAccess ?? 'write'
      }
    }
    if (requestedAccess === 'write') {
      refuse('gitlab write access requires a managed project — add the project to the organization first')
    }
    const project = await gitlabPublicProject(gitlabPath, deps.gitlab.api)
    if (!project) {
      refuse(`${gitlabPath} is not a managed GitLab project in this organization — add the project first`)
    }
    // The provider's own clone URL, held to the same codec every stored address
    // passes; a malformed answer falls back to the caller's normalized input.
    let cloneUrl: string
    try {
      cloneUrl = normalizeGitCloneUrl(project.http_url_to_repo ?? gitRepo)
    } catch (e) {
      if (!(e instanceof GitCloneUrlError)) throw e
      cloneUrl = normalizeGitUrl(gitRepo)
    }
    return {
      kind: 'anonymous',
      gitRepo: cloneUrl,
      ...(typeof project.default_branch === 'string' ? { defaultBranch: project.default_branch } : {}),
      access: 'read',
      host: 'gitlab'
    }
  }

  // Any other host (bare Git, an unmanaged GitLab instance, GHE, …): anonymous,
  // no preflight — the daemon's clone boundary reports failure, exactly as
  // creation behaves today. Its operator-owned origin policy still applies.
  if (requestedAccess === 'write') refuse('write access requires managed credentials — this host is cloned anonymously')
  return { kind: 'anonymous', gitRepo: normalizeGitUrl(gitRepo), access: 'read', host: 'other' }
}

/**
 * The workspace record + repo identity one derivation writes — shared by the
 * create and replace routes so their consumption of a derivation cannot drift.
 */
export function workspaceFromDerived(
  derived: DerivedWorkspace,
  opts: { isolation: 'shared' | 'session'; gitBranch?: string; agentDir?: string }
): { workspace: Extract<AgentWorkspace, { mode: 'git' }>; workspaceRepoId?: bigint } {
  return {
    workspace: {
      mode: 'git',
      isolation: opts.isolation,
      gitRepo: derived.gitRepo,
      gitBranch: opts.gitBranch ?? derived.defaultBranch ?? 'main',
      ...(opts.agentDir !== undefined ? { agentDir: opts.agentDir } : {}),
      ...(derived.kind === 'github'
        ? { credential: { provider: 'github', installationId: derived.installationId, access: derived.access } }
        : derived.kind === 'gitlab'
          ? { credential: { provider: 'gitlab', access: derived.access } }
          : {})
    },
    ...(derived.kind === 'github'
      ? { workspaceRepoId: derived.repoId }
      : derived.kind === 'gitlab'
        ? { workspaceRepoId: derived.projectId }
        : {})
  }
}
