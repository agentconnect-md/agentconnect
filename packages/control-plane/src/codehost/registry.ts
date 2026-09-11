/**
 * The code-host provider set (`codehost/provider.ts`) — one entry per host, and
 * the ONE place a third host is registered.
 *
 * `container.ts` publishes this record on `HttpDeps`, and a route resolves it with
 * {@link codeHostsOf}. It is a module const rather than something the composition
 * root constructs because an entry is a stateless strategy object: it captures
 * nothing and takes its deployment's services as call-time arguments. So the pure
 * projections that no container reaches — the DTO and wire workspace arms, the
 * §17.3/§24.4 feature predicates evaluated at transmit time — read the same record
 * directly instead of growing a parameter through every transmit site.
 */
import type { CodeHostProviderRegistry } from './provider.js'
import { githubCodeHostProvider } from '../github/provider.js'
import { gitlabCodeHostProvider } from '../gitlab/provider.js'
import { giteaCodeHostProvider } from '../gitea/provider.js'

export const codeHostProviders: CodeHostProviderRegistry = Object.freeze({
  github: githubCodeHostProvider,
  gitlab: gitlabCodeHostProvider,
  gitea: giteaCodeHostProvider
})

/** The registry a consumer should read: the one the composition root published, else this record. */
export function codeHostsOf(deps: { codeHosts?: CodeHostProviderRegistry }): CodeHostProviderRegistry {
  return deps.codeHosts ?? codeHostProviders
}
