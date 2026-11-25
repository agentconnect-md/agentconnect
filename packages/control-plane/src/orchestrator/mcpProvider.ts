/**
 * Pure mappers + grant-key mint for the centralized MCP-provider registry
 * (docs/designs/centralized-tool-management.md §5–§7). Sibling of placement.ts's
 * `integrationToSpec`/`agentRecordToSpec` — transport-free, Prisma-free.
 *
 * MCP-PROXY MODEL: a provider is pushed to daemons as a proxied `http` MCP def
 * whose `url` is a RELAY proxy URL and whose header is a short-lived PLAINTEXT
 * grant key (`Authorization: Bearer …`) — NEVER the upstream endpoint or its real
 * credential. The upstream url + secret headers go only to relays via rc/mcp-assign,
 * which carries sha256(grantKey), never the plaintext.
 *
 * SECURITY: the grant key (plaintext) and upstream headers are secrets — the outputs
 * of `mcpProxyDef`/`mcpRcAssign` are token-bearing frames; NEVER log them.
 */
import { createHash, randomBytes } from 'node:crypto'
import net from 'node:net'
import {
  MCP_TOOL_APPROVAL_V1_FEATURE,
  MCP_TOOL_POLICY_V1_FEATURE,
  type McpServerSpec,
  type McpToolPolicy,
  type RcMcpAssign
} from '@agentconnect.md/protocol'
import { privateV4, privateV6 } from '../net/private-address.js'
import type { AgentMcpToolPolicyRecord, McpGrantCustody } from '../persistence/ports.js'
import { definitionToolDecisions, type CatalogToolView } from './mcpToolPolicy.js'

/** The provider fields the mappers read (structural subset of the McpProvider row). */
interface ProviderView {
  id: string
  orgId: string
  name: string
  url: string
  /** Daemon-hosted (MCP Apps, webchat-mcp-apps.md §4). Carried through to the pushed definition so
   *  the owning daemon connects to the proxy itself instead of handing it to the runtime. */
  ui?: boolean
}

/**
 * Fast-fail SSRF gate for a user-supplied upstream MCP url (§5.3). Returns a reason
 * string when the url must be REJECTED at write time, or null when it may be stored.
 * The relay does the authoritative DNS-time guard on every outbound call; this only
 * bounces an obviously-bad url or a literal private/loopback/link-local/metadata IP.
 * ponytail: literal-IP + protocol check only; DNS-rebinding is the relay's job.
 */
export function blockedUpstreamUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'url must be a valid absolute URL'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'url must use http or https'
  if (u.username || u.password) return 'url must not contain credentials'
  let host = u.hostname
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1) // IPv6 literal
  if (host.toLowerCase() === 'localhost') return 'url host resolves to a private/loopback address'
  const fam = net.isIP(host)
  if ((fam === 4 && privateV4(host)) || (fam === 6 && privateV6(host))) {
    return 'url host is a private, loopback, link-local, or metadata IP'
  }
  return null
}

/** A fresh opaque bearer grant key. `oct_` prefix + 24 random bytes (base64url). */
export function mintGrantKey(): string {
  return 'oct_' + randomBytes(24).toString('base64url')
}

/** sha256 hex of a grant key — what the relay stores/matches (never the plaintext). */
export function grantKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * The relay's public HTTP(S) origin for the MCP proxy, derived from the roster's
 * per-instance rd/* dial URL. The relay serves `/mcp/:id` over HTTP on the SAME
 * server/port it accepts the daemon WS on, so only the scheme differs: ws→http,
 * wss→https; any path is dropped. Without this the daemon def would advertise
 * `transport:'http'` against a `wss://…` URL and MCP clients wouldn't connect.
 */
export function relayHttpOrigin(relayUrl: string): string {
  const u = new URL(relayUrl)
  if (u.protocol === 'wss:') u.protocol = 'https:'
  else if (u.protocol === 'ws:') u.protocol = 'http:'
  return u.origin
}

/** The grant fields every projection needs: the key it ships and the instant that
 *  orders it. Taken together off ONE row so the two can never disagree. */
export interface GrantView {
  key: string
  createdAt: Date
}

/**
 * The current grant of a provider's active set — the ONE selector, because
 * rotation deliberately leaves the retiring and the fresh grant both active until
 * the fresh one is distributed. `activeForProvider` orders by `createdAt` ascending,
 * so the newest is last; taking `[0]` inside that window projects the key the CP is
 * about to revoke. The same discipline (and the same reason) as the external-memory
 * projector's `activeForConnection(...).at(-1)`.
 */
export function currentMcpGrant<T extends GrantView>(active: readonly T[]): T | undefined {
  return active.at(-1)
}

/**
 * The daemon proxy def for a provider: an `http` MCP server pointing at the relay
 * proxy URL with the PLAINTEXT grant key as its bearer. NEVER carries the upstream
 * url or upstream secret headers. Takes the grant ROW, not a bare key, so the
 * ordering marker and the key it orders always come from the same grant.
 */
export function mcpProxyDef(provider: ProviderView, grant: GrantView, relayBaseUrl: string): McpServerSpec {
  return {
    orgId: provider.orgId,
    name: provider.name,
    issuedAt: grant.createdAt.getTime(),
    transport: 'http',
    url: `${relayBaseUrl}/mcp/${provider.id}`,
    headers: [{ name: 'Authorization', value: `Bearer ${grant.key}` }],
    args: [],
    env: [],
    // Emitted only when set, so a definition for an ordinary provider is byte-identical to what it
    // was before this flag existed and cannot re-order or re-version anything downstream.
    ...(provider.ui ? { ui: true } : {})
  }
}

/** An agent-scoped definition (§7.1): the agent's own grant and its decision table, layered over the shared definition on the daemon. */
export function mcpAgentDef(
  provider: ProviderView,
  grant: GrantView & { custody: McpGrantCustody },
  relayBaseUrl: string,
  agentId: string,
  policy: Pick<AgentMcpToolPolicyRecord, 'allowTools' | 'approvalTools' | 'askTools'>,
  catalog: readonly CatalogToolView[] = []
): McpServerSpec {
  return {
    ...mcpProxyDef(provider, grant, relayBaseUrl),
    agentId,
    toolDecisions: definitionToolDecisions(policy, grant.custody, catalog)
  }
}

/** One restricted agent grant in a binding: its key and the relay table its custody allows. */
export interface RestrictedGrantView {
  key: string
  policy: McpToolPolicy
}

/** A provider's relay binding before it is shaped for one relay; carries the upstream credential — NEVER log. */
export interface McpBinding {
  base: RcMcpAssign
  restricted: readonly RestrictedGrantView[]
}

/** The binding of a provider: upstream url and headers, the unrestricted grant keys, and the restricted agent grants. */
export function mcpBinding(
  provider: ProviderView,
  upstreamHeaders: { name: string; value: string }[],
  grantKeys: string[],
  restricted: readonly RestrictedGrantView[] = []
): McpBinding {
  return { base: mcpRcAssign(provider, upstreamHeaders, grantKeys), restricted }
}

/** The `rc/mcp-assign` one relay receives: restricted grants with deduplicated tables only where it advertises `mcp-tool-policy-v1`, approval-gated names only where it also advertises `mcp-tool-approval-v1` (§6.1, §8). */
export function mcpRcAssignFor(binding: McpBinding, relayFeatures: readonly string[] | undefined): RcMcpAssign {
  if (binding.restricted.length === 0 || relayFeatures?.includes(MCP_TOOL_POLICY_V1_FEATURE) !== true)
    return binding.base
  const approvals = relayFeatures.includes(MCP_TOOL_APPROVAL_V1_FEATURE)
  const toolPolicies: McpToolPolicy[] = []
  const indexOf = new Map<string, number>()
  const restrictedGrants = binding.restricted.map((grant) => {
    const table = approvals ? grant.policy : { allow: grant.policy.allow, approval: [], ask: [] }
    const signature = JSON.stringify([table.allow, table.approval, table.ask])
    let policy = indexOf.get(signature)
    if (policy === undefined) {
      policy = toolPolicies.push(table) - 1
      indexOf.set(signature, policy)
    }
    return { grantKeyHash: grantKeyHash(grant.key), policy }
  })
  return { ...binding.base, toolPolicies, restrictedGrants }
}

/** The unrestricted rc/mcp-assign: the provider's UPSTREAM url + secret headers and the sha256 of each shared grant key. */
export function mcpRcAssign(
  provider: ProviderView,
  upstreamHeaders: { name: string; value: string }[],
  grantKeys: string[]
): RcMcpAssign {
  return {
    providerId: provider.id,
    upstreamUrl: provider.url,
    headers: upstreamHeaders,
    grantKeyHashes: grantKeys.map(grantKeyHash)
  }
}
