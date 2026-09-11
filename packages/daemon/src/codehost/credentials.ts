/**
 * The daemon's code-host credential contract (gitlab-com-integration.md §13.2, §24.4).
 *
 * Where a managed credential reaches, how its host is addressed, and where an authorized repository
 * lands on disk are provider knowledge; core asks this seam for them and never compares a provider
 * name. Every member below exists because BOTH hosts implement it today. What genuinely diverges
 * stays inside the implementing module — GitHub mints an App installation token for a repository it
 * already covers, GitLab resolves a per-project grant and carries its own instance — and so does the
 * spec's host field, which is one axis per provider by design, not a table of hosts.
 *
 * The credential helper cannot read this registry: it ships in the runtime image and may import
 * nothing but node builtins, so the path grammars live in the `gitcred/repo-path.ts` leaf and each
 * entry points at its own.
 */
import { CODE_HOST_PROVIDERS, isCodeHostProvider, type CodeHostProvider } from '@agentconnect.md/protocol'
import { IMPLICIT_CREDENTIAL_PROVIDER, type ManagedCredentialHost } from '../gitcred/managed-hosts.js'
import type { CredentialRepoPathParser } from '../gitcred/repo-path.js'
import type { ManagedCredentialScope } from '../workspace/git-injection.js'
import { githubCredentials } from '../github/credentials.js'
import { gitlabCredentials } from '../gitlab/credentials.js'
import { giteaCredentials } from '../gitea/credentials.js'

/** The provider a credential request carries only when it is not the implicit one (the empty cache-key segment). */
export type QualifiedCodeHostProvider = Exclude<CodeHostProvider, typeof IMPLICIT_CREDENTIAL_PROVIDER>

/** The host-carrying fields of one replicated agent spec — one axis per provider (§24.4). */
export interface CodeHostSpecHosts {
  /** The GitLab instance this spec's GitLab consumers address; absent ⇒ GitLab.com. */
  gitlabHost?: string
  /** The Gitea instance this spec's Gitea consumers address; absent ⇒ gitea.com (gitea-integration.md §11). */
  giteaHost?: string
}

/** Where one authorized additional repository's subtree hangs under `repos/` (multi-repository-workspaces.md). */
export interface SecondaryRootPlacement {
  provider: CodeHostProvider
  repoFullName: string
  subtreeName: string
}

/** One code host's credential and placement behavior behind the seam. */
export interface CodeHostCredentialModule {
  readonly provider: CodeHostProvider
  /** The spec's `gitCredential` value that names this host's managed credential. */
  readonly specGitCredential: string
  /** True when the instance comes off the spec rather than being this host's one fixed address (§24.4). */
  readonly hostFromSpec: boolean
  /** The host this provider's consumers address for one spec. */
  managedHost(spec: CodeHostSpecHosts): ManagedCredentialHost
  /** git's credential `path` as this host's repository path — the leaf grammar both ends share. */
  readonly credentialRepoPath: CredentialRepoPathParser
  /** An already-normalized clone URL under this host's own address conventions. */
  canonicalCloneUrl(normalized: string): string
  /** The clone address a MANAGED remote resolves to from the spec's repository label. */
  managedRemoteUrl(repository: string): string
  /** Credential purposes this host re-resolves live, so a refusal is never durable (§14.1, §14.2). */
  readonly liveCredentialPurposes: readonly string[]
  /** Where one additional repository lands, or undefined when the row is not a placeable name. */
  placeSecondaryRoot(row: { repoFullName: string; repoId: string }): SecondaryRootPlacement | undefined
  /** The authorized clone URL of one additional repository on this host. */
  secondaryCloneUrl(repoFullName: string, spec: CodeHostSpecHosts): string
  /** The credential scope one additional repository on this host rides. */
  secondaryCredentialScope(spec: CodeHostSpecHosts): ManagedCredentialScope
}

/** Adding a code host is adding one entry; the record over the provider union makes a missing one a compile error. */
const MODULES: { readonly [P in CodeHostProvider]: CodeHostCredentialModule } = {
  github: githubCredentials,
  gitlab: gitlabCredentials,
  gitea: giteaCredentials
}

/** The module owning one provider — undefined for an anonymous remote and for a name this build does not carry. */
export function codeHostCredentials(provider: string | undefined): CodeHostCredentialModule | undefined {
  return provider !== undefined && isCodeHostProvider(provider) ? MODULES[provider] : undefined
}

/** Every module, in the provider order the injected host table and its env encoding are written in. */
const MODULE_LIST: readonly CodeHostCredentialModule[] = CODE_HOST_PROVIDERS.map((provider) => MODULES[provider])

export function codeHostCredentialModules(): readonly CodeHostCredentialModule[] {
  return MODULE_LIST
}

/** The host table one agent's git classifies against: one entry per provider, resolved from the spec (§24.4). */
export function managedHostTable(spec: CodeHostSpecHosts): ManagedCredentialHost[] {
  return MODULE_LIST.map((module) => module.managedHost(spec))
}

/** The provider a spec's `gitCredential` names, whatever the workspace mode; undefined ⇒ anonymous. */
export function credentialProviderOf(gitCredential: string | undefined): CodeHostProvider | undefined {
  if (gitCredential === undefined) return undefined
  return MODULE_LIST.find((module) => module.specGitCredential === gitCredential)?.provider
}

const SPEC_HOST_MODULES: readonly CodeHostCredentialModule[] = MODULE_LIST.filter((module) => module.hostFromSpec)

/** The hosts whose instance a spec carries — the only ones an anonymous remote can be attributed to. */
export function specHostCodeHosts(): readonly CodeHostCredentialModule[] {
  return SPEC_HOST_MODULES
}

/** Every purpose whose credential is re-resolved live, so its refusal is never cached as durable. */
const LIVE_CREDENTIAL_PURPOSES: ReadonlySet<string> = new Set(
  MODULE_LIST.flatMap((module) => [...module.liveCredentialPurposes])
)

/** True when a refusal of this purpose must not outlive the call that discovered it. */
export function isLiveCredentialPurpose(purpose: string | undefined): boolean {
  return purpose !== undefined && LIVE_CREDENTIAL_PURPOSES.has(purpose)
}
