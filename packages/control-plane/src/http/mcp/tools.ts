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
  /** The webchat conversation a delegated assertion speaks for. Server-supplied:
   *  the operation reads below are scoped to it, so no caller can name another. */
  delegatedConversationId?: string
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

/** These two reads are about a delegated conversation's own operations, and an
 *  external credential has none — a curated answer beats a confusing 404. */
const notDelegated = (): Promise<RestResult> =>
  Promise.resolve({
    statusCode: 400,
    body: JSON.stringify({
      error: 'Bad Request',
      statusCode: 400,
      message:
        'operations exist only for a webchat conversation whose writes need the owner’s approval; this connection has none'
    })
  })

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

/** Mirrors the REST `AgentWorkspaceInputBody` (git-workspace-model.md §5): the
 *  ADDRESS is the only repository input — provenance and the rename-proof numeric
 *  id are derived server-side, never supplied here. Kept FLAT rather than a
 *  discriminated union so every published inputSchema stays one `type: "object"`,
 *  and shared by `createAgent` and `setAgentWorkspace`, which take one shape. */
const workspaceShape = {
  mode: z.enum(['scratch', 'git']).describe('"git" checks a repository out; "scratch" is an empty working directory'),
  gitRepo: z
    .string()
    .min(1)
    .optional()
    .describe('Required for "git": a cloneable HTTPS or SSH address; bare `owner/repo` is github.com shorthand'),
  gitBranch: z.string().min(1).optional().describe('Branch to check out; omit for the repository default'),
  agentDir: z.string().min(1).optional().describe('Subdirectory of the repository to work in'),
  worktree: z.boolean().optional().describe('true gives every session its own isolated worktree'),
  access: z
    .enum(['read', 'write'])
    .optional()
    .describe(
      'read clones; write also lets the agent push and publish GitHub reviews and checks. Omit to take the highest tier the target can carry. The CALLER must hold the requested permission on the repository.'
    )
} as const

const GIT_ONLY_KEYS = ['gitRepo', 'gitBranch', 'agentDir', 'worktree', 'access'] as const

/** The mode gate the flat shape cannot express: an address is mandatory for a git
 *  workspace and meaningless for a scratch one. */
function checkWorkspaceMode(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  if (value.mode === 'git') {
    if (value.gitRepo === undefined) {
      ctx.addIssue({ code: 'custom', message: 'gitRepo is required when mode is "git"', path: ['gitRepo'] })
    }
    return
  }
  for (const key of GIT_ONLY_KEYS) {
    if (value[key] !== undefined) {
      ctx.addIssue({ code: 'custom', message: `${key} applies to mode "git" only`, path: [key] })
    }
  }
}

/** The `family:action` patterns a github trigger subscribes to — validated
 *  authoritatively by the route against the row's own family. */
const GithubHookEvents = z.array(z.string().min(1)).min(1).max(20)

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
      'List the daemons (edge execution units) in the organization that are visible to you, with status and load. `pinnable: false` marks a member of the install-wide managed pool: it is a replaceable Pod, so never pass its id as createAgent’s daemonId — place the agent on the pool instead. This is the liveness view — what each daemon can RUN is listDaemonCapabilities, and one runtime’s model catalog is getDaemon.',
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
    // A delegated write does not execute in its own request (webchat-preset-
    // agentconnect-mcp.md §8): it returns an operationId, the conversation owner
    // approves in the browser, and THIS is how the outcome is read back. Without
    // it a caller could only re-send the identical JSON-RPC request, and a fresh
    // call would enqueue a SECOND operation rather than answer about the first.
    name: 'getOperation',
    description:
      'The state of one of your own side-effecting operations: `awaiting_confirmation` (the conversation owner has not decided yet), `executing`, or a terminal `completed` / `failed` / `denied` / `expired` / `ambiguous`, with the tool’s bounded result once it has one. Call this after a write tool answered with an operationId — never re-issue the write to find out, which would enqueue a second operation.',
    schema: z.object({ operationId: CanonicalUuid.describe('From the write tool’s answer') }).strict(),
    call: (ctx, a) =>
      ctx.delegatedConversationId === undefined || ctx.delegatedAgentId === undefined
        ? notDelegated()
        : ctx.get(
            org(
              ctx,
              `/agents/${seg(ctx.delegatedAgentId)}/webchat/${seg(ctx.delegatedConversationId)}/mcp-operations/${seg(a.operationId)}`
            )
          )
  },
  {
    name: 'listOperations',
    description:
      'Your side-effecting operations in this conversation that are still waiting for the owner’s decision. Use it to see what you are blocked on — a decided one is read with getOperation.',
    schema: NoArgs,
    call: (ctx) =>
      ctx.delegatedConversationId === undefined || ctx.delegatedAgentId === undefined
        ? notDelegated()
        : ctx.get(
            org(ctx, `/agents/${seg(ctx.delegatedAgentId)}/webchat/${seg(ctx.delegatedConversationId)}/mcp-operations`)
          )
  },
  {
    name: 'listGithubInstallations',
    description:
      'The organization’s live installations of the deployment GitHub App — the account (owner) each covers, whether it grants all repositories or a selected set, and the pull-request/checks permissions its repositories carry. A repository is reachable ONLY through an installation listed here, so check this before pointing a workspace or a trigger at one. An empty list means the App is not installed yet; 404 means this deployment has no GitHub App at all.',
    schema: NoArgs,
    call: (ctx) => ctx.get(org(ctx, '/github/installations'))
  },
  {
    name: 'listGithubRepositories',
    description:
      'The repositories one installation grants, each with the default branch a workspace should take unless the user names another. Paged (≤100 per page); private rows are filtered to those you can read on GitHub and `privateReposHidden` says some were withheld. GitHub offers no server-side search here — page and filter locally.',
    schema: z
      .object({
        installationId: z
          .string()
          .min(1)
          .describe('The installation’s `id` from listGithubInstallations (that row id, not GitHub’s numeric one)'),
        page: z.number().int().positive().optional().describe('1-based page (default 1)'),
        perPage: z.number().int().positive().max(100).optional().describe('Page size (default 100)')
      })
      .strict(),
    call: (ctx, a) =>
      ctx.get(org(ctx, `/github/installations/${seg(a.installationId)}/repositories`), {
        page: a.page as number | undefined,
        perPage: a.perPage as number | undefined
      })
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
    description:
      'List the triggers defined for an agent — inbound webhooks and code-host (GitHub / GitLab) subscriptions alike, with the repository and subject family each covers.',
    schema: z.object({ agentId: z.string().min(1).describe('The agent id (from listAgents)') }).strict(),
    call: (ctx, a) => ctx.get(org(ctx, `/agents/${seg(a.agentId)}/hooks`))
  },
  {
    name: 'listHookRuns',
    description: 'Delivery/run history for one trigger, newest first (metadata only).',
    schema: z.object({ hookId: z.string().min(1).describe('The hook id (from listAgentHooks)') }).strict(),
    call: (ctx, a) => ctx.get(org(ctx, `/hooks/${seg(a.hookId)}/runs`))
  },

  // ——— Write tools (§6.2 ✎) — curated; credentials/members/org/access-control stay out (§6.3) ———
  {
    name: 'createAgent',
    description:
      'Create a new agent, optionally with its Git workspace in the same call. Env vars, secrets, memory and sharing are configured in the console; triggers are their own tools (createGithubTrigger, upsertCron).',
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
        placementKind: z
          .enum(['daemon', 'pool', 'set'])
          .optional()
          .describe(
            'Where the agent runs: "pool" for the install-wide managed pool (needs no daemonId — use this on a Cloud install), "set" with setId, or "daemon" (the default) with daemonId. Omit all three to leave the agent unplaced.'
          ),
        setId: z.string().uuid().optional().describe('The member set to place on, for placementKind "set"'),
        daemonId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Pin to ONE daemon from listDaemons, for placementKind "daemon". Only a daemon whose `pinnable` is true may be named: a managed pool member is replaceable and is refused. Omit to leave unplaced.'
          ),
        pause: z.boolean().optional(),
        workspace: z
          .object(workspaceShape)
          .strict()
          .superRefine(checkWorkspaceMode)
          .optional()
          .describe(
            'Where the agent works. Omit for a scratch directory; pass mode "git" to check out a repository at creation instead of wiring it afterwards. An agent that reviews or edits one repository wants it here.'
          )
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
    // §6.4 🔥 not because a row disappears but because the daemon-local checkout
    // does: replacing the repository, the branch, or the mode discards whatever
    // was only ever on that disk. A caller with a personal key executes straight
    // through, so the confirmation has to live HERE, not in a delegated approval.
    name: 'setAgentWorkspace',
    description:
      'Replace an agent’s workspace: point it at a Git repository (mode "git") or back to a scratch directory. Who vouches for the repository is derived from the address — a github.com repository inside one of the organization’s App installations or a managed GitLab project earns managed credentials, a public repository elsewhere is cloned anonymously and stays read-only. Changing the repository, branch or mode PERMANENTLY DISCARDS the daemon-local checkout, including uncommitted work, and active work is drained first; `confirm` must exactly equal the agent’s `name` (slug), so restate what is being replaced and get the user’s explicit approval before calling. Use this for an existing agent; a new one takes its workspace in createAgent, where there is nothing to lose yet.',
    write: true,
    destructive: true,
    schema: z
      .object({
        agentId: CanonicalUuid.describe('The agent id (from listAgents)'),
        confirm: z.string().min(1).describe('The agent’s exact `name` (slug) — a deliberate re-type, not a copy'),
        ...workspaceShape
      })
      .strict()
      .superRefine(checkWorkspaceMode),
    call: async (ctx, a) => {
      const agentId = canonicalUuid(a.agentId)
      if (!agentId) return invalidAgentId()
      if (sameUuid(ctx.delegatedAgentId, agentId)) return delegatedSelfMutationDenied()
      const target = await ctx.get(org(ctx, `/agents/${seg(agentId)}`))
      if (target.statusCode !== 200) return target
      const name = (JSON.parse(target.body) as { name?: unknown }).name
      if (typeof name !== 'string' || name !== a.confirm) return confirmMismatch('the agent’s `name` (slug)')
      return ctx.send('PUT', org(ctx, `/agents/${seg(agentId)}/workspace`), bodyOf(a, 'agentId', 'confirm'))
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
    // Code-host triggers only: a `webhook` hook mints an ingress URL and an HMAC
    // secret, and that capability-minting kind stays out of the catalog (§6.3).
    name: 'createGithubTrigger',
    description:
      'Subscribe one GitHub repository to an agent — the trigger that starts a session when a pull request opens, an issue is filed, or a deployment reports. The repository must sit inside one of the organization’s App installations (listGithubInstallations). One trigger covers ONE subject `family`, so watching both pull requests and issues is two calls and a second trigger on the same family is a 409. Canonical event shapes: a family watched only from its opening is `["<family>:opened"]`; watched on every update it is `["<family>:*", "issue_comment:created"]` with `commentFamilies: ["<family>"]` (GitHub emits one issue_comment stream for both issue and PR threads, so a row that subscribes to it MUST scope it). Reviews and run reporting (`reviewPolicy`, `reportingMode`) exist on pull requests only and need the agent’s workspace repository at write access.',
    write: true,
    schema: z
      .object({
        agentId: z.string().uuid().describe('The agent this trigger fires (from listAgents)'),
        name: z.string().trim().min(1).max(120).describe('Display name shown in the console'),
        repoFullName: z
          .string()
          .trim()
          .regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/repo"')
          .describe('The repository, as owner/repo (from listGithubRepositories)'),
        family: z
          .enum(['pull_request', 'issues', 'push', 'deployment'])
          .describe('The subject this trigger covers — immutable after creation'),
        events: GithubHookEvents.describe('`family:action` patterns, or `family:*`; every one must belong to `family`'),
        commentFamilies: z
          .array(z.enum(['issues', 'pull_request']))
          .max(2)
          .optional()
          .describe('Which thread family an `issue_comment` subscription belongs to — this row’s own family'),
        labelFilter: z
          .array(z.string().trim().min(1).max(100))
          .max(20)
          .optional()
          .describe('Only run when the subject currently carries one of these labels'),
        mentionOnly: z.boolean().optional().describe('Run only when the event’s text @-mentions this agent or the App'),
        reviewPolicy: z
          .enum(['off', 'comment', 'request_changes', 'full'])
          .optional()
          .describe(
            'How the turn publishes on a pull request: off = an ordinary comment, comment/request_changes/full = a formal review with inline comments (pull_request family only)'
          ),
        reportingMode: z
          .enum(['off', 'check', 'status'])
          .optional()
          .describe('Publish the run as a GitHub Check (`check`) or a commit status (`status`)'),
        gateMode: z
          .enum(['informational', 'required'])
          .optional()
          .describe('Whether a published Check merely reports (default) or gates the merge'),
        enabled: z.boolean().optional(),
        targetPlatform: z.enum(CP_PLATFORM_IDS).optional().describe('Mirror the turn into a chat conversation'),
        targetChannel: z.string().min(1).optional(),
        targetIntegrationId: z
          .string()
          .uuid()
          .optional()
          .describe('Integration to mirror through (from listIntegrations)')
      })
      .strict(),
    call: (ctx, a) => ctx.send('POST', org(ctx, '/hooks'), { kind: 'github', ...bodyOf(a) })
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
