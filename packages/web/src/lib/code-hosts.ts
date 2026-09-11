import { CODE_HOST_PROVIDERS, type CodeHostProvider } from '@agentconnect.md/protocol/code-host'

/**
 * The console's HOST PROJECTION over the code-host axis — what a provider is
 * CALLED, where its hosted instance lives, and the word it uses for a repository.
 * Code hosts are deliberately not platform modules
 * (integration-plugin-architecture.md §2), so the chassis projects them itself,
 * the way `platforms/host-projections.ts` projects the platform axis.
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
  gitlab: { label: 'GitLab', publicHost: 'gitlab.com', repoNoun: 'project', repoNounShort: 'project' },
  gitea: { label: 'Gitea', publicHost: 'gitea.com', repoNoun: 'repository', repoNounShort: 'repo' }
}

/**
 * Whether the console has the complete surface a PICKER tile promises — the connect card, the
 * repository picker, the settings panes behind it.
 *
 * A provider is known to the wire before its console surface exists (gitea-integration.md §16: G1
 * makes `gitea` a code host, G6 gives it a card), and a tile that opens nothing is worse than no
 * tile. Total over the providers rather than a list of exclusions, so the step that adds the surface
 * flips one value here.
 */
const CODE_HOST_CONSOLE_READY: Record<CodeHostProvider, boolean> = { github: true, gitlab: true, gitea: false }

/** The hosts the console OFFERS. Every `Record<CodeHostProvider, …>` above stays total regardless:
 *  a row, a label and a mark are needed wherever an existing hook or grant names the host. */
export const PICKABLE_CODE_HOST_PROVIDERS: readonly CodeHostProvider[] = CODE_HOST_PROVIDERS.filter(
  (provider) => CODE_HOST_CONSOLE_READY[provider]
)

/** Project every provider onto one value — a total table without a second list of which hosts exist. */
export function codeHostRecord<T>(of: (provider: CodeHostProvider) => T): Record<CodeHostProvider, T> {
  return Object.fromEntries(CODE_HOST_PROVIDERS.map((provider) => [provider, of(provider)])) as Record<
    CodeHostProvider,
    T
  >
}
