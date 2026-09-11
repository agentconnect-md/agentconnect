import { CODE_HOST_PROVIDERS, type CodeHostProvider } from '@agentconnect.md/protocol/code-host'

/**
 * The console's HOST PROJECTION over the code-host axis — what a provider is
 * CALLED, where its hosted instance lives, and the word it uses for a
 * repository. Code hosts are not platform modules (`platforms/host-projections.ts`
 * §2 of the integration-plugin design), so the chassis projects them itself, and
 * this table is the one place it does.
 *
 * Total by type: a new provider in `CODE_HOST_PROVIDERS` stops every
 * `Record<CodeHostProvider, …>` below from compiling until it is given an entry,
 * which is what keeps a third host from inheriting the first one's name, host or
 * vocabulary through a two-way ternary.
 */
export interface CodeHostProjection {
  /** Product name, as a tile label, a tooltip host name and a trigger-group heading. */
  readonly label: string
  /** Hostname of the provider's hosted instance — the display host a repository falls back to. */
  readonly publicHost: string
  /** What this host calls a repository, for copy that names the object ("repository", "project"). */
  readonly repoNoun: string
  /** The same object in the console's short register ("repo", "project"). */
  readonly repoNounShort: string
}

export const CODE_HOST_PROJECTION: Record<CodeHostProvider, CodeHostProjection> = {
  github: { label: 'GitHub', publicHost: 'github.com', repoNoun: 'repository', repoNounShort: 'repo' },
  gitlab: { label: 'GitLab', publicHost: 'gitlab.com', repoNoun: 'project', repoNounShort: 'project' }
}

/** Project every provider onto one value — a total table without a second list of which hosts exist. */
export function codeHostRecord<T>(of: (provider: CodeHostProvider) => T): Record<CodeHostProvider, T> {
  return Object.fromEntries(CODE_HOST_PROVIDERS.map((provider) => [provider, of(provider)])) as Record<
    CodeHostProvider,
    T
  >
}
