import { z } from 'zod'
import {
  DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS,
  normalizeWorkspaceGitOrigin,
  RelayRosterEntry
} from '@agentconnect.md/protocol'

/** The `{name, value}[]` shape shared by runtime env, MCP env, and MCP headers. */
const NameValueList = z.array(z.object({ name: z.string(), value: z.string() })).default([])

export const RuntimeDefSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: NameValueList
})
export type RuntimeDef = z.infer<typeof RuntimeDefSchema>

// A daemon-configured MCP server, keyed by name in `config.mcpServers`. The name
// is what an agent's `mcpServers` list references, and what the daemon reports
// to the CP — definitions (command/url/headers) never leave the daemon.
// The name "agentconnect" is reserved for the daemon's own injected bridge entry.
export const McpServerDefSchema = z
  .object({
    transport: z.enum(['stdio', 'http', 'sse']).default('stdio'),
    // stdio transport: the executable to spawn (required for stdio).
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: NameValueList,
    // http/sse transports: the server endpoint (required for http/sse).
    url: z.string().optional(),
    headers: NameValueList
  })
  .superRefine((def, ctx) => {
    if (def.transport === 'stdio' && !def.command)
      ctx.addIssue({ code: 'custom', path: ['command'], message: 'a stdio MCP server requires "command"' })
    if (def.transport !== 'stdio' && !def.url)
      ctx.addIssue({ code: 'custom', path: ['url'], message: `a ${def.transport} MCP server requires "url"` })
  })
export type McpServerDef = z.infer<typeof McpServerDefSchema>

const EnvironmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid environment variable name')
const MemoryPluginCommandRef = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'invalid memory plugin commandRef')
const ProcessValue = z
  .string()
  .max(16 * 1024)
  .refine((value) => !value.includes('\0'), 'process value contains NUL')
const WorkspaceGitOrigin = z.string().transform((value, ctx) => {
  try {
    return normalizeWorkspaceGitOrigin(value)
  } catch {
    ctx.addIssue({
      code: 'custom',
      message: 'workspace Git origins must be exact credential-free HTTPS or SSH origins without a path'
    })
    return z.NEVER
  }
})

/** Operator-owned local memory-plugin allowlist. A tenant/CP sends only the map
 * key (`commandRef`); command, args, static env, and logical-secret→env mapping
 * never cross the control plane. */
export const StdioMemoryPluginDefSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes('\0'), 'command contains NUL'),
    args: z.array(ProcessValue).max(128).default([]),
    env: z
      .array(z.object({ name: EnvironmentName, value: ProcessValue }).strict())
      .max(128)
      .default([]),
    secretEnv: z.record(z.string().min(1).max(128), EnvironmentName).default({})
  })
  .strict()
  .superRefine((def, ctx) => {
    const staticNames = def.env.map((entry) => entry.name)
    if (new Set(staticNames).size !== staticNames.length) {
      ctx.addIssue({ code: 'custom', path: ['env'], message: 'stdio memory plugin env names must be unique' })
    }
    const secretTargets = Object.values(def.secretEnv)
    if (new Set(secretTargets).size !== secretTargets.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['secretEnv'],
        message: 'stdio memory plugin secret env targets must be unique'
      })
    }
    if (secretTargets.some((name) => staticNames.includes(name))) {
      ctx.addIssue({ code: 'custom', path: ['secretEnv'], message: 'secret env must not overwrite static env' })
    }
  })
export type StdioMemoryPluginDef = z.infer<typeof StdioMemoryPluginDefSchema>

export const ConfigSchema = z.object({
  version: z.literal(1),
  daemonId: z.string().optional(),
  // Base URL of the Web App console; used to build the §9.1 "details" deep link
  // (`<webAppUrl>/sessions/<sessionId>`). Unset ⇒ the daemon adopts the URL the CP sends
  // down on `auth/ok` (the CP is authoritative for its own console origin); only truly
  // absent when neither is set. A local config value wins over the CP-provided one.
  webAppUrl: z.string().optional(),
  controlPlane: z
    .object({
      enabled: z.boolean().default(true),
      url: z.string().optional(),
      key: z.string().optional(), // CP API key (opaque); sent as `apiKey` on the auth frame
      heartbeatMs: z.number().int().default(15000)
    })
    .default({ enabled: false, heartbeatMs: 15000 }),
  agentsDir: z.string().optional(), // resolved against root if absent
  runtimes: z.record(z.string(), RuntimeDefSchema).optional(),
  // MCP servers this daemon can attach to agent sessions (reported to the CP as
  // facts by name + transport; agents opt in by name via their `mcpServers` list).
  mcpServers: z.record(z.string(), McpServerDefSchema).optional(),
  // Local memory plugins are daemon-private, operator-installed extensions.
  // Agent/tenant configuration can reference a key but can never supply a
  // command, path, args, or secret environment target.
  memoryPlugins: z.record(MemoryPluginCommandRef, StdioMemoryPluginDefSchema).optional(),
  security: z
    .object({
      // Prevent ACP runtimes from implicitly inheriting apps/connectors attached
      // to the signed-in cloud account. Explicit local and daemon-injected MCP
      // servers remain available. Set false only to opt this daemon out.
      isolateAccountApps: z.boolean().default(true),
      // Daemon-wide sandbox policy (issue #312). When true, startup fails unless
      // Linux SRT/bwrap is available and every agent runs sandboxed; the
      // console locks the per-agent option on. false leaves it agent-selectable.
      requireSandbox: z.boolean().default(false),
      // Operator-owned remote-origin policy for daemon-managed workspace clone/pull.
      // Exact scheme + host + port only; [] disables remote Git workspaces.
      workspaceGitAllowedOrigins: z.array(WorkspaceGitOrigin).default([...DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS])
    })
    .default({
      isolateAccountApps: true,
      requireSandbox: false,
      workspaceGitAllowedOrigins: [...DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS]
    }),
  // Relay roster the CP last published (shared-bot-relay.md §5). Persisted whole so
  // the daemon can re-dial its relays at boot while the CP is unreachable (graceful
  // degradation); the CP's register/ok snapshot re-converges it authoritatively once
  // connected. CP-owned — overwritten on every roster converge, not hand-edited.
  relays: z.array(RelayRosterEntry).default([]),
  logging: z
    .object({ level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info') })
    .default({ level: 'info' }),
  limits: z
    .object({
      maxAgents: z.number().int().default(32),
      maxConcurrentSessions: z.number().int().default(32),
      // Idle window before the sweep TTL-closes a session (§7.3) AND reaps its
      // agent's ACP host back to `provisioned` (§7.2). Background work is protected
      // by the SDK-lifecycle lease (a session with live background tasks or a running
      // SDK cycle is not reclaimed regardless of this window — see
      // docs/designs/background-task-aware-reclaim.md), so this no longer has to be
      // stretched to "long enough that background jobs finish first". 15min: reclaim
      // genuinely-idle hosts promptly (freeing runtime child RSS); the lease, not this
      // window, is what keeps background work alive. (Was widened to 2h by bb328c01 as
      // an interim workaround before the lease existed; now dialed back.)
      agentIdleTimeoutMs: z.number().int().default(900_000),
      // Absolute host lifetime ceiling (from host start). The background-task lease
      // defers idle reclaim while work is in flight; this bounds that deferral so a
      // wedged / never-ending background task (a hung build, a long-lived dev server)
      // can't pin an otherwise-idle host forever. Past this, the sweep force-reclaims
      // even with live background work (logged at warn). Must exceed agentIdleTimeoutMs
      // to have any effect. 6h.
      agentMaxLifetimeMs: z.number().int().default(21_600_000),
      // How often the idle sweep runs: reaps idle ACP adapter children back to
      // `provisioned` (§7.2) and TTL-closes idle sessions (§7.3). Keep well below
      // agentIdleTimeoutMs so a host lingers at most one interval past its window.
      idleSweepMs: z.number().int().default(60_000),
      // Quiet window before the sweep removes an agent's materialized config-file
      // secrets (agents/config-file-env.ts) — much shorter than the host TTL: the
      // files are re-written before the next turn is dispatched, so a warm host
      // stays fully usable and this only bounds how long the secret material
      // rests on disk while no turn or background task is running.
      configFilesIdleMs: z.number().int().default(60_000),
      // SIGTERM/daemon-drain grace window: in-flight turns get this long to finish
      // before the daemon cancels stragglers and tears children down (§2.5/§5.3).
      shutdownDrainMs: z.number().int().default(25_000),
      // §7.3 force-cancel backstop: after `!stop` we send session/cancel and wait
      // this long; if the turn still hasn't yielded, we force-stop the host.
      cancelBackstopMs: z.number().int().default(30_000),
      // How many times to (re)try launching an agent's ACP host — spawn + the
      // `initialize` handshake — before giving up and surfacing the failure to the
      // session. Covers transient failures (a resource race, a slow cold start). A
      // deterministic failure (missing binary) just burns all attempts then reports.
      agentStartAttempts: z.number().int().min(1).default(3),
      // Fixed backoff between agent-start attempts.
      agentStartBackoffMs: z.number().int().min(0).default(500),
      // Cap (bytes) for inlining an inbound attachment into the ACP prompt.
      // Files larger than this are passed as a resource_link pointer, never
      // downloaded/base64'd — bounds daemon RSS and the prompt frame size.
      maxAttachmentBytes: z
        .number()
        .int()
        .default(8 * 1024 * 1024)
    })
    .default({
      maxAgents: 32,
      maxConcurrentSessions: 32,
      agentIdleTimeoutMs: 900_000,
      agentMaxLifetimeMs: 21_600_000,
      idleSweepMs: 60_000,
      configFilesIdleMs: 60_000,
      shutdownDrainMs: 25_000,
      cancelBackstopMs: 30_000,
      agentStartAttempts: 3,
      agentStartBackoffMs: 500,
      maxAttachmentBytes: 8 * 1024 * 1024
    })
})
export type Config = z.infer<typeof ConfigSchema>
