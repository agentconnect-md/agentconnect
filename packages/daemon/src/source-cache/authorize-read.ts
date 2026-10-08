// The single gate for a credentialed Source Cache read (source-cache.md §5, §7): no cred GET without this success.
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import type { Agent } from '../agents/agent-schema.js'
import {
  codeHostCredentials,
  credentialProviderOf,
  specHostsOf,
  workspaceRepositoryPath
} from '../codehost/credentials.js'
import { tokenFailureOf, type CodeHostRefResolver } from '../codehost/ref-resolver.js'
import {
  codeHostRepository,
  type CodeHostRepositoryModule,
  type RepositoryReadTokens,
  type ResolveRefFailureReason
} from '../codehost/repository.js'
import { originOnManagedHost } from '../workspace/git-injection.js'
import { assertBranchRef, credRepoId } from './keys.js'

export type CredentialedCacheReadDecision =
  | {
      ok: true
      repository: { provider: CodeHostProvider; externalId: string }
      /** The `cred` repository id the Source Cache keys this workspace under. */
      credRepoId: string
      ref: string
      commit: string
      checkedAt: number
    }
  | { ok: false; reason: ResolveRefFailureReason | 'anonymous'; detail: string }

/** Authorizes a cred read of the agent's primary workspace only; the token ask is that workspace's own credential. */
export type AuthorizeCredentialedCacheRead = (agent: Agent) => Promise<CredentialedCacheReadDecision>

export interface CredentialedCacheReadAuthorizerDeps {
  resolver: Pick<CodeHostRefResolver, 'resolveRef'>
  tokens: RepositoryReadTokens
  /** Test seam; defaults to the code-host repository registry. */
  modules?: (provider: CodeHostProvider) => CodeHostRepositoryModule | undefined
}

const refuse = (reason: ResolveRefFailureReason | 'anonymous', detail: string): CredentialedCacheReadDecision => ({
  ok: false,
  reason,
  detail
})

/** Build `authorizeCredentialedCacheRead`: no cred GET without its success, which is `resolveRef` for the reading agent. */
export function createCredentialedCacheReadAuthorizer(
  deps: CredentialedCacheReadAuthorizerDeps
): AuthorizeCredentialedCacheRead {
  const modules = deps.modules ?? codeHostRepository
  return async function authorizeCredentialedCacheRead(agent) {
    const workspace = agent.workspace
    // An anonymous workspace reads only `anon`, which needs no resolution (§7).
    const provider = workspace.mode === 'git-repo' ? credentialProviderOf(workspace.gitCredential) : undefined
    if (provider === undefined || !workspace.gitRepo) return refuse('anonymous', 'no_credential')
    const module = modules(provider)
    const credentials = codeHostCredentials(provider)
    if (!module || !credentials) return refuse('unavailable', 'unsupported_provider')

    const spec = specHostsOf(agent)
    if (!originOnManagedHost(workspace.gitRepo, credentials.managedHost(spec))) {
      return refuse('unavailable', 'identity_unknown')
    }
    const path = workspaceRepositoryPath(credentials, spec, workspace.gitRepo)
    if (path === undefined) return refuse('unavailable', 'identity_unknown')

    const ref = `refs/heads/${workspace.gitBranch}`
    try {
      assertBranchRef(ref)
    } catch {
      return refuse('unavailable', 'invalid_ref')
    }

    // The spec's numeric id when it carries one, else the id the CP echoed on the grant.
    const specId = credentials.workspaceRepoId(workspace)
    let echoed: string | undefined
    try {
      echoed = (
        await deps.tokens.get(agent.id, module.readTokenAsk(specId !== undefined ? { externalId: specId } : {}))
      ).externalRepoId
    } catch (error) {
      const failure = tokenFailureOf(error)
      return refuse(failure.reason, failure.detail)
    }
    if (specId !== undefined && echoed !== undefined && specId !== echoed) return refuse('replaced', 'id_mismatch')
    const externalId = specId ?? echoed
    if (externalId === undefined) return refuse('unavailable', 'identity_unknown')

    const result = await deps.resolver.resolveRef({
      agentId: agent.id,
      repository: { provider, externalId, cloneUrl: workspace.gitRepo, path },
      ref,
      hosts: spec
    })
    if (!result.ok) return refuse(result.reason, result.detail)
    return {
      ok: true,
      repository: { provider, externalId },
      credRepoId: credRepoId(provider, externalId),
      ref,
      commit: result.commit,
      checkedAt: result.checkedAt
    }
  }
}
