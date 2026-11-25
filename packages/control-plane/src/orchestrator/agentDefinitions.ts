/**
 * `agentDefinitions` — the ONE answer to "which MCP proxy defs and which
 * external-memory connection defs does this set of agents need".
 *
 * An `AgentSpec` only NAMES its MCP servers and its memory connection; the
 * definitions travel separately. They used to be resolved by placement
 * (`activeForDaemon(daemonId)` on either repo), so a duty holder that is not the
 * agent's placement installed an agent referencing tools and a memory backend it
 * had no definitions for — its tools and its memory silently did not work.
 *
 * Both readers are therefore keyed on AGENTS, never on a daemon: the reconnect
 * snapshot passes the roster union (`pinned-to-me ∪ agents in the duties I hold`)
 * and `duty/fetch` passes the single agent it just authorized. One projector, so
 * a member's install bundle and its reconnect snapshot cannot disagree.
 *
 * SECURITY: every output is token-bearing (an MCP def carries the relay proxy url
 * plus the plaintext grant key; a memory def carries the grant and the resolved
 * secret leases). NEVER log these arrays. Scoping them to the referencing agents
 * is what keeps "who can obtain a definition" equal to "who serves an agent that
 * references it".
 */
import {
  MCP_AGENT_DEFS_V1_FEATURE,
  RESERVED_MCP_SERVER_NAME,
  type McpServerSpec,
  type MemoryConnectionSpec,
  type RelayRosterEntry
} from '@agentconnect.md/protocol'
import type {
  AgentMcpToolPolicyRepo,
  AgentRecord,
  ExternalMemoryConnectionRepo,
  ExternalMemoryConnectionSecretStore,
  ExternalMemoryGrantRepo,
  McpGrantRepo,
  McpProviderRepo,
  McpToolCatalogRepo,
  MemoryPluginInstallationRepo
} from '../persistence/ports.js'
import { OrgId } from '../domain/ids.js'
import { currentMcpGrant, mcpAgentDef, mcpProxyDef, relayHttpOrigin } from './mcpProvider.js'
import { grantCustodyFor, type McpAgentGrantMinter } from './mcpAgentGrants.js'
import { memoryConnectionSpec, stdioMemoryConnectionSpec } from './memoryConnection.js'

/** Minimal relay-roster view both projectors pick a proxy base from. */
export interface RelayRosterView {
  entries(): Promise<RelayRosterEntry[]>
}

/** All a projector reads off an agent — its id, the enable-list and the memory binding. */
export type AgentDefinitionRef = Pick<AgentRecord, 'id' | 'orgId' | 'mcpServers' | 'memory'>

/** MCP-proxy projection inputs (centralized-tool-management.md §7). */
export interface McpDefinitionDeps {
  providers: McpProviderRepo
  grants: McpGrantRepo
  relayRoster: RelayRosterView
  /** Per-agent tool policies (mcp-tool-permissions.md §5.4); absent ⇒ every agent has Full access. */
  policies?: Pick<AgentMcpToolPolicyRepo, 'listForOrg'>
  /** Catalog snapshots, for the Blocked names a definition lists; absent ⇒ none. */
  catalogs?: Pick<McpToolCatalogRepo, 'get'>
  /** Mints a restricted agent's missing grant of the receiving daemon's custody (§5.6); absent ⇒ such an agent gets no definition. */
  mintAgentGrant?: McpAgentGrantMinter
}

/** The features for a bundle no daemon receives as projected; it mints nothing, and a bundle that is sent is projected for its peer instead. */
export const MCP_DEFS_ANY_PEER: readonly string[] = [MCP_AGENT_DEFS_V1_FEATURE]

/** The definitions one daemon may receive: agent-scoped ones only where it advertises `mcp-agent-defs-v1` (§8). */
export function mcpDefsForPeer(
  specs: readonly McpServerSpec[],
  features: readonly string[] | undefined
): McpServerSpec[] {
  return features?.includes(MCP_AGENT_DEFS_V1_FEATURE) ? [...specs] : specs.filter((spec) => spec.agentId === undefined)
}

/** External-memory projection inputs (agent-memory.md). */
export interface MemoryDefinitionDeps {
  connections: ExternalMemoryConnectionRepo
  installations: MemoryPluginInstallationRepo
  secrets: ExternalMemoryConnectionSecretStore
  grants: ExternalMemoryGrantRepo
  relayRoster: RelayRosterView
}

export interface DefinitionLog {
  warn(obj: object, msg: string): void
}

/** orgId → the referenced names/ids in that org. Grouping by org is what stops a
 *  provider name shared across two orgs from bleeding between them. */
function groupByOrg(refs: Iterable<readonly [string, string]>): Map<string, Set<string>> {
  const byOrg = new Map<string, Set<string>>()
  for (const [orgId, value] of refs) {
    const bucket = byOrg.get(orgId) ?? new Set<string>()
    bucket.add(value)
    byOrg.set(orgId, bucket)
  }
  return byOrg
}

/** The relay-proxied MCP defs these agents enable, for a daemon advertising `features`: shared for unrestricted agents, agent-scoped for restricted ones where it reads them (mcp-tool-permissions.md §5.4, §8); none without a live relay. */
export async function mcpDefsForAgents(
  agents: readonly AgentDefinitionRef[],
  deps: McpDefinitionDeps | undefined,
  features: readonly string[] | undefined,
  log?: DefinitionLog,
  logCtx: object = {}
): Promise<McpServerSpec[]> {
  if (!deps) return []
  const enabling = agents.filter((agent) => agent.mcpServers.some((name) => name !== RESERVED_MCP_SERVER_NAME))
  const wanted = groupByOrg(
    enabling.flatMap((agent) =>
      agent.mcpServers.filter((name) => name !== RESERVED_MCP_SERVER_NAME).map((name) => [agent.orgId, name] as const)
    )
  )
  if (wanted.size === 0) return []
  const relay = (await deps.relayRoster.entries())[0]
  if (!relay) {
    log?.warn(logCtx, 'MCP providers enabled but no live relay — skipping MCP defs')
    return []
  }
  // The roster url is the relay's rd/* WS dial address; the MCP proxy is HTTP on the
  // same origin — normalize wss→https so the `http` def points at a reachable endpoint.
  const relayBaseUrl = relayHttpOrigin(relay.url)
  const agentDefs = features?.includes(MCP_AGENT_DEFS_V1_FEATURE) === true
  const specs: McpServerSpec[] = []
  for (const [orgId, names] of wanted) {
    const providers = (await deps.providers.listForOrg(OrgId(orgId))).filter((provider) => names.has(provider.name))
    const policies = (await deps.policies?.listForOrg(OrgId(orgId))) ?? []
    for (const provider of providers) {
      const enablers = enabling.filter((agent) => agent.orgId === orgId && agent.mcpServers.includes(provider.name))
      const policyOf = new Map(
        policies.filter((policy) => policy.mcpProviderId === provider.id).map((policy) => [policy.agentId, policy])
      )
      // The NEWEST active grant, through the one shared selector: a bundle projected inside a rotation's overlap must never carry the retiring one.
      if (enablers.some((agent) => !policyOf.has(agent.id))) {
        const grant = currentMcpGrant(await deps.grants.activeForProvider(provider.orgId, provider.id))
        if (grant) specs.push(mcpProxyDef(provider, grant, relayBaseUrl))
      }
      // A restricted agent never receives the shared definition; a daemon that cannot layer its own gets neither.
      const restricted = agentDefs ? enablers.filter((agent) => policyOf.has(agent.id)) : []
      if (restricted.length === 0) continue
      const catalog = (await deps.catalogs?.get(OrgId(orgId), provider.id))?.tools ?? []
      // The receiving daemon's custody picks the grant; a missing one is minted only for a real peer (§5.6).
      const custody = grantCustodyFor(features)
      const mint = features === MCP_DEFS_ANY_PEER ? undefined : deps.mintAgentGrant
      for (const agent of restricted) {
        const active = await deps.grants.activeForAgent(OrgId(orgId), provider.id, agent.id)
        const grant =
          currentMcpGrant(active.filter((g) => g.custody === custody)) ?? (await mint?.(provider, agent.id, custody))
        if (grant) specs.push(mcpAgentDef(provider, grant, relayBaseUrl, agent.id, policyOf.get(agent.id)!, catalog))
      }
    }
  }
  return specs
}

/** The external-memory connection defs these agents bind to. A stdio installation
 *  needs no relay; a remote one without a live relay is skipped and warned once. */
export async function memoryDefsForAgents(
  agents: readonly AgentDefinitionRef[],
  deps: MemoryDefinitionDeps | undefined,
  log?: DefinitionLog,
  logCtx: object = {}
): Promise<MemoryConnectionSpec[]> {
  if (!deps) return []
  const wanted = groupByOrg(
    agents.flatMap((agent) =>
      agent.memory?.provider === 'external' && agent.memory.connectionId
        ? [[agent.orgId, agent.memory.connectionId] as const]
        : []
    )
  )
  if (wanted.size === 0) return []
  const relay = (await deps.relayRoster.entries())[0]
  const relayBaseUrl = relay ? relayHttpOrigin(relay.url) : undefined
  const specs: MemoryConnectionSpec[] = []
  let skippedRemote = false
  for (const [orgId, connectionIds] of wanted) {
    for (const connectionId of connectionIds) {
      const connection = await deps.connections.get(OrgId(orgId), connectionId)
      if (!connection) continue
      const installation = await deps.installations.get(connection.installationId)
      if (!installation) continue
      if (installation.transport === 'stdio') {
        const secrets = (await deps.secrets.get(connection.orgId, connection.id)) ?? {}
        specs.push(stdioMemoryConnectionSpec(connection, installation, secrets))
        continue
      }
      if (!relayBaseUrl) {
        skippedRemote = true
        continue
      }
      const [grant, secretKeys] = await Promise.all([
        // Rotation overlaps old+new grants until every projection has the fresh
        // key. Prefer the newest active grant so a reconnect in that window does
        // not receive the key that is about to be retired.
        deps.grants.activeForConnection(connection.orgId, connection.id).then((rows) => rows.at(-1)),
        deps.secrets.keys(connection.orgId, connection.id)
      ])
      if (!grant) continue
      specs.push(memoryConnectionSpec(connection, installation, secretKeys, grant.key, relayBaseUrl))
    }
  }
  if (skippedRemote) {
    log?.warn(
      logCtx,
      'remote external memory connections have no live relay — local stdio definitions remain available'
    )
  }
  return specs
}
