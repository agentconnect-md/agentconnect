/**
 * MCP binding replay to a (re)registering relay (centralized-tool-management.md §5.2).
 *
 * `rc/mcp-assign` bindings live in relay memory and are only BROADCAST at provider
 * mutation time — so a relay that connects or reconnects later holds nothing, yet the
 * daemon's relay roster can still pick it (`desiredMcpServers`), and requests through it
 * would 401. On every relay (re)register we replay the full persisted set to just that
 * relay — the exact analog of `HookService.replayTo` / `RelayIngressManager.replayTo`.
 *
 * The frame carries the upstream credential (headers) — NEVER logged. Per-provider
 * failures are swallowed + logged so one bad row can't starve the rest of the pool.
 */
import type { McpProviderRepo, McpProviderSecretStore, McpGrantRepo } from '../persistence/ports.js'
import type { RelayChannel } from '../ws/relay-registry.js'
import { mcpRcAssign } from './mcpProvider.js'

export interface McpReplayDeps {
  providers: McpProviderRepo
  secrets: McpProviderSecretStore
  grants: McpGrantRepo
  log?: { warn(obj: object, msg: string): void }
}

/** Full replay of every provider's binding to ONE relay that just (re)registered. */
export async function replayMcpTo(ch: RelayChannel, deps: McpReplayDeps): Promise<void> {
  for (const p of await deps.providers.listAll()) {
    try {
      const keys = (await deps.grants.activeForProvider(p.id)).map((g) => g.key)
      if (keys.length === 0) continue // no active grant ⇒ nothing callable to bind
      const headers = (await deps.secrets.get(p.id)) ?? []
      ch.send('rc/mcp-assign', mcpRcAssign(p, headers, keys))
    } catch (err) {
      deps.log?.warn({ providerId: p.id, err }, 'mcp replay: send failed — skipped')
    }
  }
}
