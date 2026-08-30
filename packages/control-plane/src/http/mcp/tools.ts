/**
 * `http/mcp/tools.ts` — the AgentConnect MCP tool registry (docs/designs/
 * agent-assistant.md §6.2: P0 read-only tools + P1 write tools).
 *
 * Each tool is a thin, curated adapter over the existing REST surface: it
 * validates its arguments (zod), builds a versioned REST path, and the route
 * layer executes it via `app.inject` with the caller's own credential — so
 * RBAC, per-resource visibility, org scoping, and DTO shapes are inherited
 * from the routes verbatim. Tools NEVER re-implement authorization.
 *
 * Write tools (`write: true`) are the §6.2 ✎ set — deliberately curated:
 * credential, member, org, access-control, and bot operations stay OUT of the
 * catalog (§6.3; the REST guards remain the hard boundary). Destructive tools
 * (`destructive: true`, §6.4 🔥) additionally carry a required `confirm`
 * argument that must byte-equal the live resource's name — compared HERE, at
 * the execution layer: a mechanism, not a prompt convention.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CP_PLATFORM_IDS } from '../../platforms/ids.js'

/** The day presets `getUsage` accepts, which it converts to an explicit window. */
type UsageToolRange = 'd1' | 'd7' | 'd30' | 'd90'

/** What a tool needs to execute: the caller's org and credentialed requests
 *  against the versioned REST surface (`/api/v1`-relative paths). */
export interface McpToolCtx {
  orgId: string
  /** Present only for a webchat assertion; its host agent may not mutate itself. */
  delegatedAgentId?: string
  get(path: string, query?: Record<string, string | number | undefined>): Promise<RestResult>
  /** Mutating request with an optional JSON body — only `write: true` tools may use it. */
  send(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: Record<string, unknown>): Promise<RestResult>
}

export interface RestResult {
  statusCode: number
  body: string
}

export interface McpToolDef {
  name: string
  description: string
  /** Argument contract — published to clients as JSON Schema via {@link toolDescriptor}. */
  schema: z.ZodType<Record<string, unknown>>
  /** §6.2 ✎ — mutating: requires `mcp:write` on scope-confined credentials and
   *  draws from the write rate budget (§6.5). Absent ⇒ read-only. */
  write?: true
  /** §6.4 🔥 — irreversible: the schema carries a required `confirm` argument,
   *  compared against the live resource name before the call goes out. */
  destructive?: true
  /** Server-owned effect classification for `write` tools
   *  (webchat-preset-agentconnect-mcp.md §8): `'cp_db'` — the tool's ENTIRE
   *  side effect is a mutation inside the CP database, so a delegated approval
   *  commits it atomically with the operation's terminal transition (no
   *  ambiguous window). Anything that also pushes to a daemon, requires a live
   *  WS round-trip, or touches external state MUST stay `'external'` (the
   *  default) and keep the fail-closed at-most-once/ambiguous contract. */
  effect?: 'cp_db' | 'external'
  call(ctx: McpToolCtx, args: Record<string, unknown>): Promise<RestResult>
}

/** Path-segment-safe interpolation — a crafted id must not traverse into a
 *  sibling route (`"x/../../me/keys"` stays one opaque segment). */
const seg = (v: unknown): string => encodeURIComponent(String(v))

const org = (ctx: McpToolCtx, sub: string): string => `/orgs/${seg(ctx.orgId)}${sub}`

const NoArgs = z.object({}).strict()

/** Validated args minus the routing-only keys — write bodies must carry ONLY the
 *  fields the caller actually provided (`UpdateAgentBody` is strict about absent
 *  vs present, and PATCH semantics hinge on the difference). */
function bodyOf(args: Record<string, unknown>, ...routingKeys: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && !routingKeys.includes(k)) body[k] = v
  }
  return body
}

/** §6.4 — the confirm gate's refusal. Deliberately does NOT echo the expected
 *  value: the caller is told to look the name up and put it to the user. */
function confirmMismatch(expected: string): RestResult {
  return {
    statusCode: 412,
    body: JSON.stringify({
      error: 'Precondition Failed',
      statusCode: 412,
      message:
        `confirmation mismatch — \`confirm\` must exactly equal ${expected}. ` +
        'Look it up, restate it to the user, and only retry after they explicitly approve.'
    })
  }
}

const notFound = (what: string): RestResult => ({
  statusCode: 404,
  body: JSON.stringify({ error: 'Not Found', statusCode: 404, message: `${what} not found` })
})

const delegatedSelfMutationDenied = (): RestResult => ({
  statusCode: 403,
  body: JSON.stringify({
    error: 'Forbidden',
    statusCode: 403,
    message: 'a delegated webchat invocation cannot update or delete its host agent'
  })
})

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CanonicalUuid = z.string().regex(UUID_TEXT, 'must be a canonical UUID')

function canonicalUuid(value: unknown): string | null {
  const parsed = CanonicalUuid.safeParse(value)
  return parsed.success ? parsed.data.toLowerCase() : null
}

/** PostgreSQL's uuid type is case-insensitive; mirror that semantic identity
 * before dispatch so a differently-cased path cannot bypass the host guard. */
function sameUuid(left: string | undefined, right: unknown): boolean {
  const canonicalLeft = canonicalUuid(left)
  const canonicalRight = canonicalUuid(right)
  return canonicalLeft !== null && canonicalLeft === canonicalRight
}

const invalidAgentId = (): RestResult => ({
  statusCode: 400,
  body: JSON.stringify({
    error: 'Bad Request',
    statusCode: 400,
    message: 'agentId must be a canonical UUID'
  })
})

/** Mirrors the REST `AgentSlug` shape (dto) — re-validated authoritatively by the route. */
const AgentSlug = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and single hyphens')

const OutputMode = z.enum(['none', 'minimal', 'low', 'medium', 'high'])

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'whoami',
    description:
      'Who you are acting as: the authenticated user, the organization this connection is bound to, and your role in it. Call this first to ground every other tool.',
    schema: NoArgs,
    call: async (ctx) => {
      const [me, orgRes] = await Promise.all([ctx.get('/me'), ctx.get(org(ctx, ''))])
      if (me.statusCode !== 200) return me
      if (orgRes.statusCode !== 200) return orgRes
      return {
        statusCode: 200,
        body: JSON.stringify({ user: JSON.parse(me.body), organization: JSON.parse(orgRes.body) })
      }
    }
  },
  {
    name: 'listAgents',
    description: 'List the agents in the organization that are visible to you (id, name, status, runtime, placement).',
    schema: NoArgs,
    call: (ctx) => ctx.get(org(ctx, '/agents'))
  },
  {
    name: 'getAgent',
    description: 'Get one agent by id — full configuration and status.',
    schema: z.object({ agentId: z.string().min(1).describe('The agent id (from listAgents)') }).strict(),
    call: (ctx, a) => ctx.get(org(ctx, `/agents/${seg(a.agentId)}`))
  },
  // `getAgent` answers WHERE an agent works; these two answer what is in there.
  // Both proxy live from the owning daemon and the CP persists nothing.
  {
    name: 'listWorkspaceFiles',
    description:
      'List one directory of an agent’s workspace, proxied live from the owning daemon. A missing directory is data (exists:false), not an error; the answer pages through nextCursor. 503 while the agent is unplaced or its daemon is offline.',
    schema: z
      .object({
        agentId: z.string().min(1).describe('The agent id (from listAgents)'),
        path: z.string().optional().describe('Workspace-relative POSIX path; omit for the workspace root'),
        sessionId: z
          .string()
          .min(1)
          .optional()
          .describe('Browse an authorized isolated session worktree instead of the primary checkout'),
        repo: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe('owner/repo of one of the agent’s authorized additional repositories'),
        cursor: z.string().min(1).optional().describe('Continue a listing from a previous nextCursor'),
        limit: z.number().int().positive().max(500).optional().describe('Page size (default 200)')
      })
      .strict(),
    call: (ctx, a) =>
      ctx.get(org(ctx, `/agents/${seg(a.agentId)}/workspace/files`), {
        path: a.path as string | undefined,
        sessionId: a.sessionId as string | undefined,
        repo: a.repo as string | undefined,
        cursor: a.cursor as string | undefined,
        limit: a.limit as number | undefined
      })
  },
  {
    name: 'readWorkspaceFile',
    description:
      'Read one byte slice of a file in an agent’s workspace, proxied live from the owning daemon (64 KiB per call). Page by passing the answer’s nextOffset back as offset while truncated is true — never recompute it from the content. A missing file is data (exists:false); a binary file answers encoding:none with no content.',
    schema: z
      .object({
        agentId: z.string().min(1).describe('The agent id (from listAgents)'),
        path: z.string().min(1).describe('Workspace-relative POSIX path to a file (from listWorkspaceFiles)'),
        sessionId: z
          .string()
          .min(1)
          .optional()
          .describe('Read an authorized isolated session worktree instead of the primary checkout'),
        repo: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe('owner/repo of one of the agent’s authorized additional repositories'),
        offset: z.number().int().nonnegative().optional().describe('Byte offset to start at (default 0)'),
        limit: z.number().int().positive().max(65536).optional().describe('Bytes per slice (default 65536)')
      })
      .strict(),
    call: (ctx, a) =>
      ctx.get(org(ctx, `/agents/${seg(a.agentId)}/workspace/file`), {
        path: a.path as string,
        sessionId: a.sessionId as string | undefined,
        repo: a.repo as string | undefined,
        offset: a.offset as number | undefined,
        limit: a.limit as number | undefined
      })
  },
  {
    name: 'listDaemons',
    description:
      'List the daemons (edge execution units) in the organization that are visible to you, with status and load. This is the liveness view — what each daemon can RUN is listDaemonCapabilities, and one runtime’s model catalog is getDaemon.',
    schema: NoArgs,
    call: (ctx) => ctx.get(org(ctx, '/daemons'))
  },
  {
    name: 'listDaemonCapabilities',
    description:
      'What each daemon in the fleet can run: the platforms and features it supports, the runtimes installed on it with their available model ids, and its configured MCP servers. Use this to choose a placement — which daemon offers the runtime an agent needs. Per-model detail (efforts, permission modes) is not here; read one daemon with getDaemon for that.',
    schema: NoArgs,
    call: (ctx) => ctx.get(org(ctx, '/daemons/capabilities'))
  },
  {
    name: 'getDaemon',
    description:
      'One daemon in full: liveness, capabilities, and each installed runtime’s complete model catalog — the model ids it offers and, per model, the reasoning efforts and permission modes it accepts. This is the only read carrying that catalog, so consult it before setting an agent’s model, reasoningEffort or permissionMode, whose valid values are whatever the serving daemon reports.',
    schema: z.object({ daemonId: z.string().min(1).describe('The daemon id (from listDaemons)') }).strict(),
    call: (ctx, a) => ctx.get(org(ctx, `/daemons/${seg(a.daemonId)}`))
  },
  {
    name: 'listCrons',
    description: 'List the cron (scheduled task) definitions visible to you.',
    schema: NoArgs,
    call: (ctx) => ctx.get(org(ctx, '/crons'))
  },
  {
    name: 'getCron',
    description: 'Get one cron definition by id.',
    schema: z.object({ cronId: z.string().min(1).describe('The cron id (from listCrons)') }).strict(),
    call: (ctx, a) => ctx.get(org(ctx, `/crons/${seg(a.cronId)}`))
  },
  {
    name: 'listCronRuns',
    description: 'Run history for a cron, newest first (status, duration, session link).',
    schema: z.object({ cronId: z.string().min(1).describe('The cron id (from listCrons)') }).strict(),
    call: (ctx, a) => ctx.get(org(ctx, `/crons/${seg(a.cronId)}/runs`))
  },
  {
    name: 'listSessions',
    description:
      'List recent agent sessions (metadata only: title, status, channel, last activity, token usage). Filterable by agent and platform.',
    schema: z
      .object({
        agentId: z.string().min(1).optional().describe('Only sessions of this agent'),
        // Mirrors the `/sessions` route filter, which accepts the canonical
        // `Platform` set — keep the two in step (tools.test.ts guards it).
        platform: z.enum(['slack', 'telegram', 'webchat', 'discord', 'feishu', 'hook', 'dream']).optional(),
        channel: z.string().min(1).optional(),
        limit: z.number().int().positive().max(200).optional().describe('Page size (default 50)')
      })
      .strict(),
    call: (ctx, a) =>
      ctx.get(org(ctx, '/sessions'), {
        agentId: a.agentId as string | undefined,
        platform: a.platform as string | undefined,
        channel: a.channel as string | undefined,
        limit: a.limit as number | undefined
      })
  },
  {
    name: 'getSession',
    description: 'Get one session’s metadata by id (phase, link, summary — not the transcript).',
    schema: z.object({ sessionId: z.string().min(1).describe('The session id (from listSessions)') }).strict(),
    call: (ctx, a) => ctx.get(org(ctx, `/sessions/${seg(a.sessionId)}`))
  },
  {
    // The tool keeps asking in days because that is what an agent means by "this week",
    // and turns it into the route's explicit window. The HTTP surface takes `[from, to)`
    // so a billing period can be a caller's choice; a preset is this caller's.
    name: 'getUsage',
    description:
      'Token/cost usage aggregates over a time window, totals plus agent, model, and metering-source breakdowns.',
    schema: z
      .object({
        range: z.enum(['d1', 'd7', 'd30', 'd90']).optional().describe('Window: 1/7/30/90 days (default d7)'),
        source: z
          .enum(['daemon', 'gateway'])
          .optional()
          .describe('Only sessions metered by this ingress (default: both)')
      })
      .strict(),
    call: (ctx, a) => {
      const days = { d1: 1, d7: 7, d30: 30, d90: 90 }[(a.range as UsageToolRange | undefined) ?? 'd7']
      const to = new Date()
      const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
      return ctx.get(org(ctx, '/usage'), {
        from: from.toISOString(),
        to: to.toISOString(),
        ...(a.source ? { source: a.source as string } : {})
      })
    }
  },
  {
    name: 'listIntegrations',
    description: 'List platform integrations (bot ↔ agent bindings) with their conversation triggers.',
    schema: NoArgs,
    call: (ctx) => ctx.get(org(ctx, '/integrations'))
  },
  {
    name: 'listBots',
    description: 'List the durable bot identities of the organization (metadata only — never token material).',
    schema: NoArgs,
    call: (ctx) => ctx.get(org(ctx, '/bots'))
  },
  {
    name: 'listMembers',
    description: 'List the organization’s members and their roles.',
    schema: NoArgs,
    call: (ctx) => ctx.get(org(ctx, '/members'))
  },
  {
    name: 'listAgentHooks',
    description: 'List the inbound-webhook triggers defined for an agent.',
    schema: z.object({ agentId: z.string().min(1).describe('The agent id (from listAgents)') }).strict(),
    call: (ctx, a) => ctx.get(org(ctx, `/agents/${seg(a.agentId)}/hooks`))
  },
  {
    name: 'listHookRuns',
    description: 'Delivery/run history for an inbound-webhook trigger, newest first (metadata only).',
    schema: z.object({ hookId: z.string().min(1).describe('The hook id (from listAgentHooks)') }).strict(),
    call: (ctx, a) => ctx.get(org(ctx, `/hooks/${seg(a.hookId)}/runs`))
  },

  // ——— Write tools (§6.2 ✎) — curated; credentials/members/org/access-control stay out (§6.3) ———
  {
    name: 'createAgent',
    description:
      'Create a new agent. Only core configuration is exposed here — workspace, env vars, secrets, memory and sharing are configured in the console.',
    write: true,
    schema: z
      .object({
        name: AgentSlug.describe('Immutable slug identifier (lowercase letters, digits, hyphens)'),
        displayName: z.string().min(1).optional().describe('Human-friendly label shown in chat and the console'),
        description: z.string().optional(),
        runtime: z.string().min(1).describe('Runtime id — pick from the runtimes reported by listDaemonCapabilities'),
        model: z.string().min(1).optional(),
        reasoningEffort: z.string().min(1).optional(),
        outputMode: OutputMode.optional(),
        fastMode: z.boolean().optional(),
        permissionMode: z.string().min(1).optional(),
        daemonId: z.string().min(1).optional().describe('Pin to a daemon (from listDaemons); omit to leave unplaced'),
        pause: z.boolean().optional()
      })
      .strict(),
    call: (ctx, a) => ctx.send('POST', org(ctx, '/agents'), bodyOf(a))
  },
  {
    name: 'updateAgent',
    description:
      'Update an agent’s configuration (partial update — only the fields you pass change; pass null to clear a nullable field). The name slug is immutable.',
    write: true,
    schema: z
      .object({
        agentId: CanonicalUuid.describe('The agent id (from listAgents)'),
        displayName: z.string().min(1).nullable().optional(),
        description: z.string().nullable().optional(),
        runtime: z.string().min(1).optional(),
        model: z.string().min(1).nullable().optional().describe('null resets to the runtime default'),
        reasoningEffort: z.string().min(1).nullable().optional(),
        outputMode: OutputMode.nullable().optional(),
        fastMode: z.boolean().nullable().optional(),
        permissionMode: z.string().min(1).nullable().optional(),
        pause: z.boolean().optional().describe('true pauses the agent; false resumes it')
      })
      .strict(),
    call: async (ctx, a) => {
      const agentId = canonicalUuid(a.agentId)
      if (!agentId) return invalidAgentId()
      return sameUuid(ctx.delegatedAgentId, agentId)
        ? delegatedSelfMutationDenied()
        : ctx.send('PATCH', org(ctx, `/agents/${seg(agentId)}`), bodyOf(a, 'agentId'))
    }
  },
  {
    name: 'deleteAgent',
    description:
      'Permanently delete an agent and its triggers — IRREVERSIBLE. `confirm` must exactly equal the agent’s `name` (slug); restate it to the user and get their explicit approval before calling.',
    write: true,
    destructive: true,
    schema: z
      .object({
        agentId: CanonicalUuid.describe('The agent id (from listAgents)'),
        confirm: z.string().min(1).describe('The agent’s exact `name` (slug) — a deliberate re-type, not a copy')
      })
      .strict(),
    call: async (ctx, a) => {
      const agentId = canonicalUuid(a.agentId)
      if (!agentId) return invalidAgentId()
      if (sameUuid(ctx.delegatedAgentId, agentId)) return delegatedSelfMutationDenied()
      const target = await ctx.get(org(ctx, `/agents/${seg(agentId)}`))
      if (target.statusCode !== 200) return target
      const name = (JSON.parse(target.body) as { name?: unknown }).name
      if (typeof name !== 'string' || name !== a.confirm) return confirmMismatch('the agent’s `name` (slug)')
      return ctx.send('DELETE', org(ctx, `/agents/${seg(agentId)}`))
    }
  },
  {
    name: 'renameDaemon',
    description: 'Rename a daemon (its console display name — placement and identity are unaffected).',
    write: true,
    // PATCH /daemons/:id only rewrites the daemon row's display name — no
    // daemon push, no external state — so it qualifies for §8 atomic commit.
    effect: 'cp_db',
    schema: z
      .object({
        daemonId: z.string().min(1).describe('The daemon id (from listDaemons)'),
        name: z.string().trim().min(1).max(64)
      })
      .strict(),
    call: (ctx, a) => ctx.send('PATCH', org(ctx, `/daemons/${seg(a.daemonId)}`), { name: a.name })
  },
  {
    name: 'upsertCron',
    description:
      'Create a scheduled task (omit cronId) or edit an existing one (pass its id from listCrons). The trigger text is the prompt the agent receives on each firing.',
    write: true,
    schema: z
      .object({
        cronId: z.string().uuid().optional().describe('Existing cron id to edit; omit to create a new one'),
        agentId: z.string().uuid().describe('The agent this schedule drives (from listAgents)'),
        name: z.string().trim().min(1).max(120).optional().describe('Display name shown in the console'),
        schedule: z.string().min(1).describe('Cron expression, croner syntax (e.g. "0 9 * * MON-FRI")'),
        // Required, and deliberately so: the schedule fires by this, and a caller that omitted it used
        // to inherit whatever zone the control plane process happened to run in — UTC in a container.
        // "Every morning at 9" then meant 9am somewhere the user has never been.
        timezone: z
          .string()
          .min(1)
          .describe(
            'IANA timezone the schedule is interpreted in, e.g. "Asia/Shanghai". Use the timezone the person asking lives in — ask them if you do not know it. There is no default. When editing an existing schedule, pass back its current timezone (from getCron) unless the user is changing it: this is a full replace, so a guess here MOVES the schedule.'
          ),
        trigger: z.string().min(1).describe('The prompt sent to the agent on each firing'),
        // Same cron target vocabulary the REST body accepts (`dto/index.ts`
        // `Platform`), from the one registry declaration rather than a fourth copy.
        targetPlatform: z.enum(CP_PLATFORM_IDS).optional(),
        targetChannel: z.string().min(1).optional().describe('Channel to deliver into; omit for a headless run'),
        targetIntegrationId: z
          .string()
          .uuid()
          .optional()
          .describe('Integration to deliver through (from listIntegrations)'),
        enabled: z.boolean().optional()
      })
      .strict(),
    call: (ctx, a) => ctx.send('PUT', org(ctx, `/crons/${seg(a.cronId ?? randomUUID())}`), bodyOf(a, 'cronId'))
  },
  {
    name: 'runCron',
    description: 'Fire a scheduled task once, now (in addition to its schedule). The run is asynchronous.',
    write: true,
    schema: z.object({ cronId: z.string().min(1).describe('The cron id (from listCrons)') }).strict(),
    call: (ctx, a) => ctx.send('POST', org(ctx, `/crons/${seg(a.cronId)}/run`))
  },
  {
    name: 'deleteCron',
    description:
      'Permanently delete a scheduled task — IRREVERSIBLE. `confirm` must exactly equal the cron’s `name` (or its id when it has no name); get the user’s explicit approval before calling.',
    write: true,
    destructive: true,
    schema: z
      .object({
        cronId: z.string().min(1).describe('The cron id (from listCrons)'),
        confirm: z.string().min(1).describe('The cron’s exact `name` (its id when unnamed) — a deliberate re-type')
      })
      .strict(),
    call: async (ctx, a) => {
      const target = await ctx.get(org(ctx, `/crons/${seg(a.cronId)}`))
      if (target.statusCode !== 200) return target
      const cron = JSON.parse(target.body) as { name?: unknown }
      const expected = typeof cron.name === 'string' && cron.name.length > 0 ? cron.name : String(a.cronId)
      if (a.confirm !== expected) return confirmMismatch('the cron’s `name` (or its id when it has no name)')
      return ctx.send('DELETE', org(ctx, `/crons/${seg(a.cronId)}`))
    }
  },
  {
    name: 'setChannelTrigger',
    description:
      'Change how an integration behaves in one conversation: the trigger mode (off / mention-only / any message; off disables the conversation) and/or the conversation’s owning agent (null clears the override).',
    write: true,
    schema: z
      .object({
        integrationId: z.string().min(1).describe('The integration id (from listIntegrations)'),
        channelId: z.string().min(1).describe('The platform channel id (from listIntegrations channels)'),
        trigger: z.enum(['off', 'mention', 'any']).optional(),
        agentId: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe('Owning agent for this channel; null clears the override')
      })
      .strict(),
    call: (ctx, a) =>
      ctx.send(
        'PATCH',
        org(ctx, `/integrations/${seg(a.integrationId)}/channels/${seg(a.channelId)}`),
        bodyOf(a, 'integrationId', 'channelId')
      )
  },
  {
    name: 'removeIntegration',
    description:
      'Remove a platform integration (bot ↔ agent binding) — IRREVERSIBLE (the bot identity survives and can be re-linked, but channel wiring is lost). `confirm` must exactly equal the integration’s `name`; get the user’s explicit approval before calling.',
    write: true,
    destructive: true,
    schema: z
      .object({
        integrationId: z.string().min(1).describe('The integration id (from listIntegrations)'),
        confirm: z.string().min(1).describe('The integration’s exact `name` — a deliberate re-type')
      })
      .strict(),
    call: async (ctx, a) => {
      // No GET-by-id route exists for integrations — resolve the name via the list.
      const list = await ctx.get(org(ctx, '/integrations'))
      if (list.statusCode !== 200) return list
      const parsed = JSON.parse(list.body) as unknown
      const found = Array.isArray(parsed)
        ? (parsed as Array<{ id?: unknown; name?: unknown }>).find((i) => i.id === a.integrationId)
        : undefined
      if (!found) return notFound('integration')
      if (typeof found.name !== 'string' || found.name !== a.confirm) return confirmMismatch('the integration’s `name`')
      return ctx.send('DELETE', org(ctx, `/integrations/${seg(a.integrationId)}`))
    }
  }
]

/** The `tools/list` entry: name/description plus the zod schema rendered as JSON
 *  Schema (zod v4 native — the MCP SDK's own zod conversion is never used). Every tool
 *  schema is a ZodObject, so the rendered schema always has `type: 'object'`. The
 *  behavior annotations (MCP ToolAnnotations) derive from the §6.2 flags so clients
 *  can gate write/destructive tools behind their own approval UX. */
export function toolDescriptor(t: McpToolDef): {
  name: string
  description: string
  inputSchema: { type: 'object' } & Record<string, unknown>
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean }
} {
  const json = z.toJSONSchema(t.schema) as { type: 'object' } & Record<string, unknown>
  delete json.$schema
  return {
    name: t.name,
    description: t.description,
    inputSchema: json,
    annotations: t.write ? { readOnlyHint: false, destructiveHint: t.destructive === true } : { readOnlyHint: true }
  }
}

export function findTool(name: string): McpToolDef | undefined {
  return MCP_TOOLS.find((t) => t.name === name)
}
