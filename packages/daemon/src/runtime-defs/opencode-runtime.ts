import { RESERVED_MCP_SERVER_NAME } from '../mcp/resolve-servers.js'
import { objectFromJson, record } from '../runtimes/codex-config.js'
import type { RuntimeDef } from '../config/config-schema.js'
import type { ModelProviderTarget } from '../runtimes/model-provider-config.js'

/** Whether a runtime is OpenCode: the registry id, or a launch that names its binary or package. */
export function isOpenCodeRuntime(runtimeId: string | undefined, runtime?: RuntimeDef): boolean {
  if (runtimeId === 'opencode') return true
  return [runtime?.command ?? '', ...(runtime?.args ?? [])].some((part) =>
    /(?:^|[\/@])opencode(?:\/cli)?(?:@[^\/]*)?$/.test(part.toLowerCase())
  )
}

/** Adds CLAUDE.md to OpenCode's instruction files, which are otherwise AGENTS.md alone, unless the launch already lists its own. */
export function openCodeConfigWithClaudeInstructions(raw: string | undefined): string {
  const config = objectFromJson(raw, 'OPENCODE_CONFIG_CONTENT')
  if (config.instructions !== undefined) return JSON.stringify(config)
  // Files load by resolved path, so an AGENTS.md linked to CLAUDE.md is read once.
  return JSON.stringify({ ...config, instructions: ['CLAUDE.md'] })
}

/** The OpenCode agent the daemon authors for its own extraction passes, advertised as the ACP `read-only` mode. */
export const OPENCODE_READ_ONLY_MODE = 'read-only'

// OpenCode's `plan` keeps bash allowed and tells the model to change nothing, so `writeMemory` is never called under it.
// An allow-list instead, in precedence order (last match wins): future tools are denied, the daemon's bridge tools stay callable.
export const OPENCODE_READ_ONLY_PERMISSION = {
  '*': 'deny',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  [`${RESERVED_MCP_SERVER_NAME}_*`]: 'allow'
} as const

/** Merge the read-only agent into `OPENCODE_CONFIG_CONTENT`, keeping what the provider layer already wrote there. */
export function applyOpenCodeReadOnlyMode(
  target: Pick<ModelProviderTarget, 'runtime'> | undefined,
  env: Record<string, string>,
  // The daemon's own OPENCODE_CONFIG_CONTENT, which a non-pod launch inherits under its explicit env.
  inherited?: string
): void {
  if (target?.runtime !== 'opencode') return
  // Overlay the value the child would otherwise see: an explicit entry wins, else the inherited one.
  const config = objectFromJson(env.OPENCODE_CONFIG_CONTENT ?? inherited, 'OPENCODE_CONFIG_CONTENT')
  const agents = record(config.agent, 'OPENCODE_CONFIG_CONTENT.agent')
  // The daemon's definition replaces a same-named operator agent: on this host the name is a contract.
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...config,
    agent: {
      ...agents,
      [OPENCODE_READ_ONLY_MODE]: {
        mode: 'primary',
        description:
          'AgentConnect memory extraction: reads its working directory and calls the AgentConnect tools only.',
        permission: OPENCODE_READ_ONLY_PERMISSION
      }
    }
  })
}
