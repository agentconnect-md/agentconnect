/**
 * The per-provider serialization chain, and the OAuth re-bind that has to enter it.
 *
 * Extracted from `routes/mcp-providers.ts` when the refresher became its second consumer:
 * a token refresh re-pushes a provider's relay binding, and a push that does not join this
 * chain can land AFTER a concurrent DELETE and resurrect a binding for a provider that no
 * longer exists — callable pool-wide, with a live grant hash, and with nothing left that
 * would ever unassign it.
 */
import type { HttpDeps } from './deps.js'
import type { OrgId } from '../domain/ids.js'
import { resolveUpstreamHeaders, type McpTokenResolver } from '../orchestrator/mcpUpstreamHeaders.js'
import type { McpPush } from './mcp-push.js'

/**
 * Serialize binding-mutating operations per provider. `rc/mcp-assign` ships the WHOLE
 * grant-hash allowlist (the relay replaces it), so any two ops that read the active grant
 * and push a binding can race: two rotations leave >1 active DB grant; a rotation racing a
 * PATCH/DELETE can republish the just-revoked key (or re-bind a torn-down provider), so the
 * relay ends up rejecting the key the caller was handed. Chaining every such op makes each
 * read-active→push a critical section, so the last push always reflects the current
 * active grant.
 *
 * Chains are keyed by (orgId, name) — the DURABLE binding key — not the provider row id:
 * agents store the NAME, so lifecycle events on different rows under the same name (drop
 * A, create B) must serialize with each other and with agent enable-list writes; an
 * id-keyed chain dies with its row and lets a same-name recreate slip into the window.
 * ponytail: in-process lock, sufficient because the CP is a single Fastify process; swap
 * to pg_advisory_xact_lock (see persistence/repositories/hook.repo.ts) if it goes
 * multi-instance.
 */
const providerChains = new Map<string, Promise<unknown>>()

const providerChainKey = (orgId: string, name: string) => `${orgId}\0${name}`

export function serializeByProvider<T>(orgId: string, name: string, run: () => Promise<T>): Promise<T> {
  const key = providerChainKey(orgId, name)
  const prev = providerChains.get(key) ?? Promise.resolve()
  const result = prev.then(run, run)
  const settled = result.then(
    () => undefined,
    () => undefined
  )
  providerChains.set(key, settled)
  void settled.finally(() => {
    if (providerChains.get(key) === settled) providerChains.delete(key)
  })
  return result
}

/**
 * Serialize one operation across SEVERAL provider-name chains — how an agent
 * enable-list write (routes/agents.ts) joins the chain of every name its submitted
 * list contains, so it cannot interleave with a DELETE between that delete's
 * reference check and its row drop, nor with a same-name provider create. Names are
 * chained whether or not they currently resolve to a registry row (the name IS the
 * durable key; a daemon-local name today may be a provider name in the same
 * breath). Chains are entered in sorted order so two multi-name writers can't
 * deadlock waiting on each other's tails.
 */
export function serializeByProviderNames<T>(
  orgId: string,
  names: readonly string[],
  run: () => Promise<T>
): Promise<T> {
  const sorted = [...new Set(names)].sort()
  return sorted.reduceRight<() => Promise<T>>((inner, n) => () => serializeByProvider(orgId, n, inner), run)()
}

/**
 * The refresher's re-bind. The network refresh already happened OUTSIDE the chain; this is
 * the part that must be inside it, and it re-reads everything it pushes rather than trusting
 * what the sweep saw. A provider that has since been deleted, converted away from OAuth, or
 * left without an active grant is skipped — never resurrected. Every active grant hash is
 * re-sent because `rc/mcp-assign` replaces the whole allowlist, and pushing only the current
 * grant would retire the other one inside a rotation's grace window.
 */
export function makeOauthRebind(
  deps: HttpDeps,
  push: McpPush,
  tokens: McpTokenResolver
): (orgId: OrgId, providerId: string, providerName: string) => Promise<void> {
  return (orgId, providerId, providerName) =>
    serializeByProvider(orgId, providerName, async () => {
      const provider = await deps.repos.mcpProvider.get(orgId, providerId)
      if (provider === null || provider.auth !== 'oauth2') return
      const keys = (await deps.repos.mcpGrant.activeForProvider(orgId, providerId)).map((g) => g.key)
      if (keys.length === 0) return
      // Cached-only: the sweep has just refreshed, and dialing again inside the chain would
      // put an upstream round-trip back on the critical section this exists to keep short.
      const headers = await resolveUpstreamHeaders({ secrets: deps.repos.mcpProviderSecret, tokens }, provider, orgId, {
        allowNetwork: false
      })
      if (headers === null) return
      push.pushBinding(provider, headers, keys)
    })
}
