/**
 * `deriveWorkspaceCredential` — one function, three callers (git-workspace-model.md §6):
 * the agent create route, the workspace replace route, and the resolve endpoint.
 * No other code decides workspace provenance. Provenance depends only on
 * `(orgId, gitRepo)`; eligibility and tier depend on the actor — the identity
 * gate runs INSIDE each host's derivation on purpose, so a route can never
 * re-introduce the per-route divergence the design removes (#1561, #1567).
 *
 * The per-host arms live in the code-host provider registry (`codehost/provider.ts`):
 * this function owns the ORDER they are asked in and the terminal "any other host"
 * outcome, and nothing else here names a host.
 */
import { normalizeGitUrl, CODE_HOST_PROVIDERS } from '@agentconnect.md/protocol'
import type { HttpDeps } from '../deps.js'
import type { AgentWorkspace } from '../../persistence/ports.js'
import { codeHostsOf } from '../../codehost/registry.js'
import {
  refuseWorkspaceCredential,
  WorkspaceCredentialRefused,
  type CodeHostProviderRegistry,
  type DerivedWorkspace
} from '../../codehost/provider.js'

export { WorkspaceCredentialRefused }
export type { DerivedWorkspace }

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
  requestedAccess?: 'read' | 'write',
  /** `write` marks the two persisting callers: a host that binds on first use binds only for them (gitea-integration.md §6). */
  opts: { write?: boolean } = {}
): Promise<DerivedWorkspace> {
  // Asked in the registry's own order, which is the order these arms have always
  // run in: the first host that RECOGNIZES the address owns the outcome, refusals
  // included — a host declines only when the address is not its.
  const codeHosts = codeHostsOf(deps)
  for (const provider of CODE_HOST_PROVIDERS) {
    const derived = await codeHosts[provider].workspace.derive({
      deps,
      orgId,
      ...(actorUserId !== undefined ? { actorUserId } : {}),
      gitRepo,
      ...(requestedAccess !== undefined ? { requestedAccess } : {}),
      ...(opts.write ? { write: true } : {})
    })
    if (derived) return derived
  }

  // Any other host (bare Git, an unmanaged GitLab instance, GHE, …): anonymous,
  // no preflight — the daemon's clone boundary reports failure, exactly as
  // creation behaves today. Its operator-owned origin policy still applies.
  if (requestedAccess === 'write') {
    refuseWorkspaceCredential('write access requires managed credentials — this host is cloned anonymously')
  }
  return { kind: 'anonymous', gitRepo: normalizeGitUrl(gitRepo), access: 'read', host: 'other' }
}

/**
 * The workspace record + repo identity one derivation writes — shared by the
 * create and replace routes so their consumption of a derivation cannot drift.
 */
export function workspaceFromDerived(
  codeHosts: CodeHostProviderRegistry,
  derived: DerivedWorkspace,
  opts: { isolation: 'shared' | 'session'; gitBranch?: string; agentDir?: string }
): { workspace: Extract<AgentWorkspace, { mode: 'git' }>; workspaceRepoId?: bigint } {
  // An anonymous outcome has no vouching host, so it writes neither field.
  const write = derived.kind === 'anonymous' ? null : codeHosts[derived.kind].workspace.writeFromDerived(derived)
  return {
    workspace: {
      mode: 'git',
      isolation: opts.isolation,
      gitRepo: derived.gitRepo,
      gitBranch: opts.gitBranch ?? derived.defaultBranch ?? 'main',
      ...(opts.agentDir !== undefined ? { agentDir: opts.agentDir } : {}),
      ...(write ? { credential: write.credential } : {})
    },
    ...(write ? { workspaceRepoId: write.workspaceRepoId } : {})
  }
}
