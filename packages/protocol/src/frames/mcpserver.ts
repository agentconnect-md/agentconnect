import { z } from 'zod'

/**
 * Centralized MCP-provider distribution (C→D) — docs/designs/centralized-tool-management.md.
 *
 * The Control Plane owns MCP provider definitions and pushes them to the daemons
 * whose agents enable them (`mcpserver/upsert`, and the reconcile snapshot
 * `RegisterOk.mcpServers[]`). The daemon merges the spec into its `mcpServerDefs`
 * and attaches it at ACP `session/new` through the existing resolve path — a
 * pushed def is just an `http` MCP server.
 *
 * MCP-PROXY MODEL: in v1 the pushed `url` is a RELAY proxy URL and the injected
 * header is a short-lived **grant key** (`Authorization: Bearer …`) — never the
 * upstream endpoint or its real credential. Those stay on the CP + relay (§5).
 * SECURITY: `env`/`headers` may carry that bearer grant key — NEVER log this frame.
 */

/** The `{name, value}[]` shape shared by MCP env + headers (mirrors the daemon's local McpServerDef). */
const NameValueList = z.array(z.object({ name: z.string(), value: z.string() })).default([])

/**
 * One MCP server definition the CP pushes to a daemon. Shape mirrors the daemon's
 * local `McpServerDef` (daemon config-schema.ts) with `name` inlined (the daemon
 * config keys the map by name). Transport-agnostic on the wire; the CP restricts
 * what it emits (v1 pushes proxied `http` defs only — the `sse`/`stdio`-only
 * restriction is a CP-side policy, not a wire constraint).
 */
export const McpServerSpec = z
  .object({
    orgId: z.string().min(1).max(64).optional(),
    name: z.string(),
    transport: z.enum(['stdio', 'http', 'sse']).default('stdio'),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: NameValueList,
    url: z.string().optional(),
    headers: NameValueList
  })
  .superRefine((def, ctx) => {
    if (def.transport === 'stdio' && !def.command)
      ctx.addIssue({ code: 'custom', path: ['command'], message: 'a stdio MCP server requires "command"' })
    if (def.transport !== 'stdio' && !def.url)
      ctx.addIssue({ code: 'custom', path: ['url'], message: `a ${def.transport} MCP server requires "url"` })
  })
export type McpServerSpec = z.infer<typeof McpServerSpec>

/** C→D EVT (`mcpserver/upsert`) — add or replace a pushed MCP server def on the daemon. */
export const McpServerUpsert = McpServerSpec
export type McpServerUpsert = z.infer<typeof McpServerUpsert>

/** C→D EVT (`mcpserver/remove`) — drop a pushed MCP server def by name. */
export const McpServerRemove = z.object({ orgId: z.string().min(1).max(64).optional(), name: z.string() })
export type McpServerRemove = z.infer<typeof McpServerRemove>
