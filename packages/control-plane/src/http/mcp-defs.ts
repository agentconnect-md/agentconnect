// Live convergence of one MCP provider's daemon definitions: shared and agent-scoped (mcp-tool-permissions.md §5.4, §8).
import { MCP_AGENT_DEFS_V1_FEATURE } from '@agentconnect.md/protocol'
import type { AgentRecord, McpAgentGrantRecord, McpGrantCustody, McpProviderRecord } from '../persistence/ports.js'
import { OrgId } from '../domain/ids.js'
import type { HttpDeps } from './deps.js'
import { NoConnection } from '../orchestrator/outbound.js'
import {
  currentMcpGrant,
  mcpAgentDef,
  mcpProxyDef,
  relayHttpOrigin,
  type GrantView
} from '../orchestrator/mcpProvider.js'
import { grantCustodyFor } from '../orchestrator/mcpAgentGrants.js'

export interface McpDefConvergeOptions {
  /** The daemons to converge; absent ⇒ every daemon serving an agent that enables the provider. */
  daemonIds?: readonly string[]
  /** Agents whose own definition each target drops unless that agent still needs it there. */
  retireAgentIds?: readonly string[]
  /** The shared grant to project, when the caller just minted it. */
  sharedGrant?: GrantView
  /** Only drop what the targets no longer need, for a caller whose targets already hold the rest. */
  pruneOnly?: boolean
}

export interface McpDefSync {
  /** Give each target what its served agents need: the shared definition for an unrestricted agent, an agent-scoped one for a restricted agent where it reads them; drop the rest. */
  converge(orgId: OrgId, provider: McpProviderRecord, opts?: McpDefConvergeOptions): Promise<void>
}

type Log = { warn(obj: object, msg: string): void }

export function makeMcpDefSync(deps: HttpDeps, log?: Log): McpDefSync {
  const relayBaseUrl = async (): Promise<string | null> => {
    const alive = await deps.repos.relay.listAlive(new Date(Date.now() - (deps.config.RELAY_STALE_MS ?? 0)))
    const url = alive[0]?.daemonUrl
    return url ? relayHttpOrigin(url) : null
  }
  // One daemon's send; offline converges on its next register, and an error is never logged with its grant-bearing payload.
  const send = async (daemonId: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      if (!(err instanceof NoConnection)) log?.warn({ daemonId }, 'mcp def send failed (reconcile will converge)')
    }
  }

  return {
    async converge(orgId, provider, opts = {}) {
      const enablers = (await deps.repos.agent.list(orgId)).filter((a) => a.mcpServers.includes(provider.name))
      const policies = new Map(
        (await deps.repos.agentMcpToolPolicy.listForProvider(orgId, provider.id)).map((p) => [p.agentId, p])
      )
      const shared = new Set<string>()
      const restricted = new Map<string, AgentRecord[]>()
      for (const agent of enablers) {
        for (const daemonId of await deps.agentDelivery.daemonsFor(agent)) {
          if (!policies.has(agent.id)) shared.add(daemonId)
          else restricted.set(daemonId, [...(restricted.get(daemonId) ?? []), agent])
        }
      }
      const targets = opts.daemonIds ?? [...new Set([...shared, ...restricted.keys()])]
      if (targets.length === 0) return
      const base = opts.pruneOnly ? null : await relayBaseUrl()
      const sharedGrant =
        opts.sharedGrant ??
        (base && targets.some((d) => shared.has(d))
          ? currentMcpGrant(await deps.repos.mcpGrant.activeForProvider(orgId, provider.id))
          : undefined)
      const catalog =
        base && restricted.size > 0 ? ((await deps.repos.mcpToolCatalog.get(orgId, provider.id))?.tools ?? []) : []
      // Converge never mints: its callers hold the provider chain, and the policy write mints what serving daemons need.
      const agentGrants = new Map<string, McpAgentGrantRecord[]>()
      const agentGrantOf = async (agentId: string, custody: McpGrantCustody) => {
        if (!agentGrants.has(agentId))
          agentGrants.set(agentId, await deps.repos.mcpGrant.activeForAgent(orgId, provider.id, agentId))
        return currentMcpGrant(agentGrants.get(agentId)!.filter((g) => g.custody === custody))
      }
      for (const daemonId of targets) {
        const features = deps.control.daemonFeatures(daemonId)
        const capable = features?.includes(MCP_AGENT_DEFS_V1_FEATURE) === true
        const custody = grantCustodyFor(features)
        const here = restricted.get(daemonId) ?? []
        if (base && sharedGrant && shared.has(daemonId)) {
          const spec = mcpProxyDef(provider, sharedGrant, base)
          await send(daemonId, () => deps.control.mcpServerUpsert(daemonId, spec))
        }
        if (capable) {
          for (const agent of here) {
            const grant = base ? await agentGrantOf(agent.id, custody) : undefined
            if (!base || !grant) continue
            const spec = mcpAgentDef(provider, grant, base, agent.id, policies.get(agent.id)!, catalog)
            await send(daemonId, () => deps.control.mcpServerUpsert(daemonId, spec))
          }
          // An older daemon would read an agent-scoped removal as the shared definition's, so only a capable one gets it.
          for (const agentId of opts.retireAgentIds ?? []) {
            if (here.some((agent) => agent.id === agentId)) continue
            await send(daemonId, () => deps.control.mcpServerRemove(daemonId, orgId, provider.name, agentId))
          }
        }
        if (!shared.has(daemonId)) {
          await send(daemonId, () => deps.control.mcpServerRemove(daemonId, orgId, provider.name))
        }
      }
    }
  }
}

/** The registry providers among these names; a name with no row is a daemon-local definition, never pushed or removed. */
export async function registryProvidersOf(
  deps: Pick<HttpDeps, 'repos'>,
  orgId: string,
  names: readonly string[]
): Promise<McpProviderRecord[]> {
  const wanted = new Set(names)
  const rows = wanted.size === 0 ? [] : await deps.repos.mcpProvider.listForOrg(OrgId(orgId))
  return rows.filter((p) => wanted.has(p.name))
}
