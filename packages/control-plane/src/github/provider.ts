/**
 * The GitHub entry of the code-host provider registry (`codehost/provider.ts`).
 *
 * Every member here is one half of a `kind === 'gitlab' ? … : …` ternary core
 * used to carry. GitHub's halves are the quiet ones: its App webhook is
 * deployment-wide (so no hook write converges an ingress), it has no instance
 * axis (so it negotiates no feature), and its gate axis is the one both hosts'
 * hook rows store. What is NOT here is everything the two hosts genuinely
 * disagree about — the App installation claim, App-JWT credential minting, and
 * the GitHub-only workflow-approval and review surfaces.
 */
import { gitRepoLabel, normalizeGitUrl } from '@agentconnect.md/protocol'
import {
  refuseWorkspaceCredential,
  type CodeHostDeps,
  type CodeHostProviderModule,
  type CodeHostWorkspaceDerivation,
  type DerivedWorkspace
} from '../codehost/provider.js'
import type { AgentWorkspaceCredentialDtoT } from '../http/dto/index.js'
import type { GithubInstallationRecord } from '../persistence/ports.js'
import { isCanonicalGithubAddress } from '../domain/git-host.js'
import { OrgId } from '../domain/ids.js'
import { GithubApiError } from './api.js'
import { UserAuthzDeniedError } from './user-authz.js'
import { LogtoApiError } from './logto-identity.js'

/** owner/repo when the address selects canonical github.com; null otherwise. */
function githubTarget(gitRepo: string): { owner: string; repo: string } | null {
  if (!isCanonicalGithubAddress(gitRepo)) return null
  const parts = gitRepoLabel(gitRepo).split('/')
  const [owner, repo] = parts
  if (parts.length !== 2 || !owner || !repo) refuseWorkspaceCredential('workspace gitRepo is not a github repository')
  return { owner, repo }
}

/** Resolve the covering App installation, converge the catalog row, and hold the
 *  acting human to the access the agent will run with. Null ⇒ not granted. */
async function bindGithubWorkspaceRepo(
  deps: CodeHostDeps,
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
    if (userId === undefined) refuseWorkspaceCredential('a signed-in identity is required to bind this repository')
    await deps.githubUserAuthz.assertAccess(userId, ins, canonicalOwner ?? owner, canonicalRepo ?? repo, access)
  }
  return ref
}

/** The github arm of the §6 outcome table: App installation, else an anonymous public read. */
async function deriveGithubWorkspace(derivation: CodeHostWorkspaceDerivation): Promise<DerivedWorkspace | null> {
  const { deps, orgId, actorUserId, gitRepo, requestedAccess } = derivation
  const gh = githubTarget(gitRepo)
  if (!gh) return null
  const covering = deps.github ? await deps.repos.githubInstallation.liveByOrgAndAccount(OrgId(orgId), gh.owner) : null
  const installation = covering && !covering.suspendedAt ? covering : null
  if (installation) {
    const access = requestedAccess ?? 'write'
    const ref = await bindGithubWorkspaceRepo(deps, orgId, installation, gh.owner, gh.repo, access, actorUserId)
    // An installation token reads any PUBLIC repository, so a miss here means
    // private-and-ungranted (or absent) — an anonymous clone cannot serve it,
    // and the actionable answer is to grant it rather than to degrade silently.
    if (!ref) {
      refuseWorkspaceCredential(
        `${gh.owner}/${gh.repo} is not granted to the GitHub installation — re-select it on GitHub`
      )
    }
    return {
      kind: 'github',
      installationId: installation.id,
      repoId: ref.repoId,
      gitRepo: normalizeGitUrl(ref.fullName),
      defaultBranch: ref.defaultBranch,
      access
    }
  }
  if (requestedAccess === 'write') refuseWorkspaceCredential('github write access requires a GitHub App installation')
  // Anonymous public read. `unreachable` (rate limit, outage) deliberately does
  // NOT refuse — creation never preflighted at all, and a GitHub blip must not
  // block a checkout the daemon's clone boundary will verify anyway.
  const lookup = deps.resolvePublicRepo ? await deps.resolvePublicRepo(gh.owner, gh.repo) : 'unreachable'
  if (lookup === 'not-found') {
    refuseWorkspaceCredential(
      `${gh.owner}/${gh.repo} is not a public repository — install the GitHub App for access to private ones`
    )
  }
  return {
    kind: 'anonymous',
    gitRepo: normalizeGitUrl(lookup === 'unreachable' ? gitRepo : lookup.fullName),
    ...(lookup !== 'unreachable' ? { defaultBranch: lookup.defaultBranch } : {}),
    access: 'read',
    host: 'github'
  }
}

export const githubCodeHostProvider: CodeHostProviderModule = {
  provider: 'github',
  displayName: 'GitHub',
  repositorySubject: 'repository',
  features: {
    // github.com is the only instance this App model addresses, so neither the
    // deployment nor a projected spec carries a host and nothing is negotiated.
    deploymentHost: () => undefined,
    specHost: () => undefined,
    ruleHost: () => undefined,
    required: () => [],
    requiredForInstance: () => []
  },
  workspace: {
    derive: deriveGithubWorkspace,
    writeFromDerived: (derived) =>
      derived.kind === 'github'
        ? {
            credential: { provider: 'github', installationId: derived.installationId, access: derived.access },
            workspaceRepoId: derived.repoId
          }
        : null,
    // installationId stays server-side; the DTO names the provider and the tier.
    toDto: (credential): AgentWorkspaceCredentialDtoT | null =>
      credential.provider === 'github' ? { provider: 'github', access: credential.access } : null,
    // installationId and access stay off the wire: minting re-resolves the live
    // installation by owner, and the CP clamps minted tokens server-side.
    toSpec: (credential) => (credential.provider === 'github' ? { provider: 'github' } : null),
    legacySpecArm: (shared, credential) =>
      credential.provider === 'github' ? { mode: 'github', ...shared, gitCredential: 'github-app' as const } : null
  },
  hooks: {
    effects: (body) => ({
      reviewPolicy: body.reviewPolicy ?? 'off',
      reportingMode: body.reportingMode ?? 'off',
      gateMode: body.gateMode ?? 'informational'
    }),
    // The App's webhook is deployment-wide: no hook or grant write can change
    // what it delivers, so there is nothing to converge.
    convergeManagedRepository: () => {}
  },

  /** Raising the tier re-checks the CALLER's own GitHub permission on the repository. */
  async upgradeRepoAuthorization({ deps, req, reply, orgId, agent, row, access, toDto }) {
    const [owner, repo] = row.repoFullName.split('/')
    const installation = owner ? await deps.repos.githubInstallation.liveByOrgAndAccount(orgId, owner) : null
    if (!owner || !repo || !installation || installation.suspendedAt) {
      void reply.code(409).send({
        error: 'Conflict',
        statusCode: 409,
        message: 'repository is not covered by a live GitHub App installation'
      })
      return undefined
    }
    try {
      if (deps.githubUserAuthz) {
        await deps.githubUserAuthz.assertAccess(
          req.principal!.userId,
          installation,
          owner,
          repo,
          access === 'write' ? 'write' : 'read'
        )
      }
      const updated = await deps.repos.agentRepoAuth.updateAccess(row.id, access)
      if (!updated) {
        void reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'authorization not found' })
        return undefined
      }
      void deps.repos.audit
        .append({
          kind: 'agent_repo_change',
          orgId,
          agentId: agent.id,
          ...(req.principal ? { actorUserId: req.principal.userId } : {}),
          frameType: 'gitcred/grant',
          message: `repo ${updated.repoFullName} authorization upgraded (${row.access} → ${updated.access})`,
          details: {
            repoAuthId: updated.id,
            repoFullName: updated.repoFullName,
            previousAccess: row.access,
            access: updated.access
          }
        })
        .catch(() => {})
      return toDto(updated)
    } catch (e) {
      if (e instanceof UserAuthzDeniedError) {
        void reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: e.message, code: e.code })
        return undefined
      }
      if (e instanceof GithubApiError) {
        const status = e.code === 'RATE_LIMITED' ? 429 : 502
        void reply.code(status).send({
          error: status === 429 ? 'Too Many Requests' : 'Bad Gateway',
          statusCode: status,
          message: `github: ${e.message}`
        })
        return undefined
      }
      if (e instanceof LogtoApiError) {
        void reply.code(502).send({ error: 'Bad Gateway', statusCode: 502, message: e.message })
        return undefined
      }
      throw e
    }
  }
}
