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
  /** What this host calls a proposed change, as a copy selector: Gitea stores `merge_request` but says pull request. */
  readonly changeNoun: 'pull_request' | 'merge_request'
  /** The provider's setup page, relative to the docs root. */
  readonly docsPath: string
  /** Whether the host has inbound triggers (hooks), so trigger pickers offer it. */
  readonly hooks: boolean
}

export const CODE_HOST_PROJECTION: Record<CodeHostProvider, CodeHostProjection> = {
  github: {
    label: 'GitHub',
    publicHost: 'github.com',
    repoNoun: 'repository',
    repoNounShort: 'repo',
    changeNoun: 'pull_request',
    docsPath: 'connect-automate/triggers-automation/github',
    hooks: true
  },
  gitlab: {
    label: 'GitLab',
    publicHost: 'gitlab.com',
    repoNoun: 'project',
    repoNounShort: 'project',
    changeNoun: 'merge_request',
    docsPath: 'connect-automate/triggers-automation/gitlab',
    hooks: true
  },
  gitea: {
    label: 'Gitea',
    publicHost: 'gitea.com',
    repoNoun: 'repository',
    repoNounShort: 'repo',
    changeNoun: 'pull_request',
    docsPath: 'connect-automate/triggers-automation/gitea',
    hooks: true
  },
  'azure-devops': {
    label: 'Azure DevOps',
    publicHost: 'dev.azure.com',
    repoNoun: 'repository',
    repoNounShort: 'repo',
    changeNoun: 'pull_request',
    docsPath: 'connect-automate/triggers-automation/azure-devops',
    hooks: true
  }
}

/** Whether the console has the whole surface a picker tile promises. */
const CODE_HOST_CONSOLE_READY: Record<CodeHostProvider, boolean> = {
  github: true,
  gitlab: true,
  gitea: true,
  'azure-devops': true
}

/** The order the console lists hosts in; total by type, so a new provider must be placed. */
const CODE_HOST_DISPLAY_RANK: Record<CodeHostProvider, number> = {
  github: 0,
  gitlab: 1,
  'azure-devops': 2,
  gitea: 3
}

/** The hosts the console offers, in display order; every `Record<CodeHostProvider, …>` stays total regardless. */
export const PICKABLE_CODE_HOST_PROVIDERS: readonly CodeHostProvider[] = [...CODE_HOST_PROVIDERS]
  .sort((a, b) => CODE_HOST_DISPLAY_RANK[a] - CODE_HOST_DISPLAY_RANK[b])
  .filter((provider) => CODE_HOST_CONSOLE_READY[provider])

/** The hosts a trigger picker offers: pickable and with hooks of their own. */
export const TRIGGER_CODE_HOST_PROVIDERS: readonly CodeHostProvider[] = PICKABLE_CODE_HOST_PROVIDERS.filter(
  (provider) => CODE_HOST_PROJECTION[provider].hooks
)

/** Project every provider onto one value — a total table without a second list of which hosts exist. */
export function codeHostRecord<T>(of: (provider: CodeHostProvider) => T): Record<CodeHostProvider, T> {
  return Object.fromEntries(CODE_HOST_PROVIDERS.map((provider) => [provider, of(provider)])) as Record<
    CodeHostProvider,
    T
  >
}
