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
  RESERVED_MCP_SERVER_NAME,
  type McpServerSpec,
  type MemoryConnectionSpec,
  type RelayRosterEntry
} from '@agentconnect.md/protocol'
import type {
  AgentRecord,
  ExternalMemoryConnectionRepo,
  ExternalMemoryConnectionSecretStore,
  ExternalMemoryGrantRepo,
  McpGrantRepo,
  McpProviderRepo,
  MemoryPluginInstallationRepo
} from '../persistence/ports.js'
import { OrgId } from '../domain/ids.js'
import { currentMcpGrant, mcpProxyDef, relayHttpOrigin } from './mcpProvider.js'
import { memoryConnectionSpec, stdioMemoryConnectionSpec } from './memoryConnection.js'

/** Minimal relay-roster view both projectors pick a proxy base from. */
export interface RelayRosterView {
  entries(): Promise<RelayRosterEntry[]>
}

/** All a projector reads off an agent — the enable-list and the memory binding. */
export type AgentDefinitionRef = Pick<AgentRecord, 'orgId' | 'mcpServers' | 'memory'>

/** MCP-proxy projection inputs (centralized-tool-management.md §7). */
export interface McpDefinitionDeps {
  providers: McpProviderRepo
  grants: McpGrantRepo
  relayRoster: RelayRosterView
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

/**
 * The relay-proxied `http` MCP defs these agents enable by name: the RELAY proxy
 * url plus the provider's active plaintext grant key — never the upstream url or
 * its secret. The reserved name is excluded (the daemon injects its own
 * `agentconnect` server). No relay live ⇒ none, and the next register once a
 * relay appears is the backstop.
 */
export async function mcpDefsForAgents(
  agents: readonly AgentDefinitionRef[],
  deps: McpDefinitionDeps | undefined,
  log?: DefinitionLog,
  logCtx: object = {}
): Promise<McpServerSpec[]> {
  if (!deps) return []
  const wanted = groupByOrg(
    agents.flatMap((agent) =>
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
  const specs: McpServerSpec[] = []
  for (const [orgId, names] of wanted) {
    const providers = (await deps.providers.listForOrg(OrgId(orgId))).filter((provider) => names.has(provider.name))
    for (const provider of providers) {
      // The NEWEST active grant, through the one shared selector: a rotation
      // overlaps old+new until the fresh key is distributed, and a bundle
      // projected inside that window must never carry the retiring one.
      const grant = currentMcpGrant(await deps.grants.activeForProvider(provider.orgId, provider.id))
      if (grant) specs.push(mcpProxyDef(provider, grant, relayBaseUrl))
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
