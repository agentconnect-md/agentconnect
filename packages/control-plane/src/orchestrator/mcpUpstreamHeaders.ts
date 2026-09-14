/**
 * The headers the relay injects for one provider — the single place the two auth modes
 * differ, so neither the live push nor the replay has to know about OAuth at all.
 *
 * `headers` providers project the operator's own credential verbatim, exactly as before.
 * `oauth2` providers project the CP's CURRENT access token, which is why the binding's
 * credential changes on every refresh while the agent's proxy url and grant key never do.
 *
 * `allowNetwork: false` is not an optimization, it is a correctness requirement for relay
 * replay: `replayMcpTo` is awaited inside relay registration, so resolving with the network
 * enabled would turn one relay reconnect into N serial round-trips to third-party
 * authorization servers, coupling relay convergence to their availability. Replay pushes
 * whatever is stored and leaves renewal to the refresher sweep.
 *
 * A provider with nothing callable resolves to null and is SKIPPED rather than bound with
 * an empty credential — the same arm `replayMcpTo` already takes for a provider with no
 * active grant.
 *
 * SECURITY: the return value is the upstream credential. NEVER log it.
 */
import type { McpHeader, McpProviderRecord, McpProviderSecretStore } from '../persistence/ports.js'
import type { OrgId } from '../domain/ids.js'
import type { TokenResolution } from '../mcp-oauth/token-service.js'

/** The token custody slice this resolver needs. Absent ⇒ oauth2 providers never bind. */
export interface McpTokenResolver {
  resolve(orgId: OrgId, providerId: string, opts?: { allowNetwork?: boolean }): Promise<TokenResolution>
}

export interface McpUpstreamHeaderDeps {
  secrets: McpProviderSecretStore
  tokens?: McpTokenResolver
}

export async function resolveUpstreamHeaders(
  deps: McpUpstreamHeaderDeps,
  provider: Pick<McpProviderRecord, 'id' | 'auth'>,
  orgId: OrgId,
  opts: { allowNetwork?: boolean } = {}
): Promise<McpHeader[] | null> {
  if (provider.auth !== 'oauth2') return (await deps.secrets.get(orgId, provider.id)) ?? []
  if (deps.tokens === undefined) return null
  const resolved = await deps.tokens.resolve(orgId, provider.id, opts)
  if (!resolved.ok) return null
  return [{ name: 'Authorization', value: `Bearer ${resolved.accessToken}` }]
}
