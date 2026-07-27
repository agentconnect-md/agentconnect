import { z } from 'zod'
import { AgentMemoryBinding, AgentSkillEntry, FeishuRegion } from '@agentconnect.md/protocol'

export const BindMatchSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mention') }),
  z.object({ kind: z.literal('dm') }),
  z.object({ kind: z.literal('keyword'), value: z.string() }),
  z.object({ kind: z.literal('auto') })
])
export type BindMatch = z.infer<typeof BindMatchSchema>

export const BindRuleConfigSchema = z.object({
  channel: z.string().optional(), // absent = any channel
  thread: z.string().optional(),
  match: BindMatchSchema
})
export type BindRuleConfig = z.infer<typeof BindRuleConfigSchema>

export const SlackConfigSchema = z.object({
  // 'direct' (default, and the shape of every pre-shared-bot agent.json): the daemon
  // opens the Socket Mode connection itself. 'shared': the bot's inbound lives on a
  // relay, so the daemon holds xoxb ONLY (send path) and opens no socket — routing is
  // arbitrated in the relay and delivered pre-addressed. See shared-bot-relay.md §7.3.
  mode: z.enum(['direct', 'shared']).default('direct'),
  // Multi-agent opt-in (shared mode only): the bot backs many agents, so the status
  // bar exposes an in-thread "Switch agent" control. A non-shareable shared bot routes
  // through the relay the same way but has one agent, so the control is suppressed.
  shareable: z.boolean().default(false),
  botToken: z.string(),
  appToken: z.string().optional(), // direct only (Socket Mode); absent for shared
  appId: z.string().optional(), // public A… app id used for Slack permission-update links
  signingSecret: z.string().optional(),
  botUserId: z.string().optional(), // filled at connect via auth.test if absent; provided by CP for shared
  allowedUserIds: z.array(z.string()).default([]),
  bindRules: z.array(BindRuleConfigSchema).default([]),
  // Conversation gating (resource-visibility.md §14): fail-closed ingress — the CP
  // ships only conversation-scoped bindRules; explicitly-addressed unrouted
  // messages get a one-time notice and DM conversations are reported to the CP.
  gated: z.boolean().default(false)
})
export type SlackConfig = z.infer<typeof SlackConfigSchema>

export const TelegramConfigSchema = z.object({
  botToken: z.string(), // BotFather "123456:ABC…" (single token; no app token / signing secret)
  botUserId: z.string().optional(), // numeric bot id, filled at connect via getMe if absent
  botUsername: z.string().optional(), // @username without the '@', for mention detection; filled via getMe
  allowedUserIds: z.array(z.string()).default([]),
  bindRules: z.array(BindRuleConfigSchema).default([]),
  // Conversation gating (resource-visibility.md §14): fail-closed ingress — the CP
  // ships only conversation-scoped bindRules; explicitly-addressed unrouted
  // messages get a one-time notice and DM conversations are reported to the CP.
  gated: z.boolean().default(false)
})
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>

export const DiscordConfigSchema = z.object({
  botToken: z.string(), // Discord Gateway bot token (single token; no app token / signing secret)
  applicationId: z.string().optional(), // public client id for the invite URL (not used to connect)
  botUserId: z.string().optional(), // numeric bot user id, filled at connect via the ready event if absent
  allowedUserIds: z.array(z.string()).default([]),
  bindRules: z.array(BindRuleConfigSchema).default([]),
  // Conversation gating (resource-visibility.md §14): fail-closed ingress — the CP
  // ships only conversation-scoped bindRules; explicitly-addressed unrouted
  // messages get a one-time notice and DM conversations are reported to the CP.
  gated: z.boolean().default(false)
})
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>

export const FeishuConfigSchema = z.object({
  appId: z.string(), // cli_… app identifier (semi-public); needed to open the WSClient
  appSecret: z.string(), // app secret (single secret; no app token / signing secret)
  botOpenId: z.string().optional(), // bot's own open_id for mention detection; filled at connect via bot/info if absent
  region: FeishuRegion.default('feishu'), // open-platform gateway: feishu.cn (default) vs larksuite.com
  allowedUserIds: z.array(z.string()).default([]),
  bindRules: z.array(BindRuleConfigSchema).default([]),
  // Conversation gating (resource-visibility.md §14): fail-closed ingress — the CP
  // ships only conversation-scoped bindRules; explicitly-addressed unrouted
  // messages get a one-time notice and DM conversations are reported to the CP.
  gated: z.boolean().default(false)
})
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>

export const IntegrationSchema = z.discriminatedUnion('platform', [
  z.object({
    id: z.string(),
    // CP-pushed integrations are tagged so a reconnect snapshot can prune a
    // missed integration/remove without touching hand-authored local entries.
    origin: z.literal('cp').optional(),
    platform: z.literal('slack'),
    slack: SlackConfigSchema
  }),
  z.object({
    id: z.string(),
    origin: z.literal('cp').optional(),
    platform: z.literal('telegram'),
    telegram: TelegramConfigSchema
  }),
  z.object({
    id: z.string(),
    origin: z.literal('cp').optional(),
    platform: z.literal('discord'),
    discord: DiscordConfigSchema
  }),
  z.object({
    id: z.string(),
    origin: z.literal('cp').optional(),
    platform: z.literal('feishu'),
    feishu: FeishuConfigSchema
  })
])
export type Integration = z.infer<typeof IntegrationSchema>

/** A scheduled trigger for THIS agent: every `schedule` tick, prompt the agent
 *  with `trigger`. `target` is optional output routing — when present the daemon
 *  posts the trigger into that channel and the session replies in its thread;
 *  absent ⇒ headless fire (no platform output). `origin:"cp"` marks CP-pushed
 *  entries (written by cron/upsert, pruned by drop.crons); hand-authored entries
 *  have no origin and are never touched by the CP. */
export const CronDefSchema = z.object({
  id: z.string(),
  schedule: z.string(),
  // CP-owned entries always include an IANA timezone. Hand-authored local
  // entries may omit it to retain daemon-local scheduling.
  timezone: z.string().min(1).optional(),
  // integrationId picks which of the agent's integrations posts the anchor;
  // absent (legacy defs) ⇒ the agent's first integration.
  target: z
    .object({
      platform: z.enum(['slack', 'telegram', 'discord', 'feishu']),
      channel: z.string(),
      integrationId: z.string().optional()
    })
    .optional(),
  trigger: z.string(),
  enabled: z.boolean().default(true),
  origin: z.literal('cp').optional()
})
export type CronDef = z.infer<typeof CronDefSchema>

export const AgentSchema = z.object({
  id: z.string(),
  // Added when a CP spec is persisted. Absence continues to mean a genuinely
  // local agent (or a legacy replica, which the CP handles conservatively).
  origin: z.literal('cp').optional(),
  name: z.string(),
  // Optional human-facing bot name. `name` remains the stable agent identifier;
  // the CP may set or clear this field independently via AgentSpec.displayName.
  displayName: z.string().optional(),
  // CP-resolved public avatar URL (its icon endpoint, or a user image URL). Used
  // as the Slack per-message `icon_url` (chat:write.customize), the sibling of
  // displayName→username. Set/cleared by the CP via AgentSpec.iconUrl.
  iconUrl: z.string().optional(),
  status: z.enum(['active', 'inactive', 'paused']).default('active'),
  // Operational message-processing toggle, orthogonal to `status` (which gates
  // whether the agent is loaded/placed at all). When true the agent still loads and
  // connects its platform bot, but the daemon skips ALL turn dispatch (platform,
  // webchat, cron) — see Daemon.dispatch. Turning it on also cancels in-flight
  // turns and drops their queued follow-ups (including their durable inbox rows, so
  // restart cannot resurrect them), without tearing down the warm host or ACP sessions.
  // Silent: skipped turns are dropped, not recorded. A flip remains
  // a soft-only reconcile change (no host/session teardown).
  pause: z.boolean().default(false),
  runtime: z.string(),
  // System-prompt seed + runtime knobs. Settable in agent.json and overlaid by
  // the CP spec (agent/upsert + register/ok roster) — see cp/cp-agent-registry.ts.
  description: z.string().optional(),
  reasoningEffort: z.string().optional(),
  executionMode: z.string().optional(),
  // Runtime fast mode (ACP `model_config` toggle, claude/codex). Absent ⇒ leave
  // the runtime's own default; the daemon only pushes an explicit on/off.
  fastMode: z.boolean().optional(),
  // Runtime permission/approval mode (ACP `mode` selector). The values are
  // runtime-owned strings: claude-acp uses default/acceptEdits/auto/dontAsk/plan,
  // codex-acp uses read-only/agent/agent-full-access.
  permissionMode: z.string().default('default'),
  // Conversation participants are not authorization principals by default.
  // Editors may explicitly opt this agent back into chat-side runtime setting
  // changes (model, effort, permission mode, fast mode) and approval controls.
  allowRuntimeChangesInChat: z.boolean().default(false),
  runtimeOverrides: z
    .object({
      model: z.string().optional(),
      env: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
      // Write-only secret env vars (CP AgentSpec.secrets). Same {name,value}[] shape as
      // env; merged into the spawned child's environment (secrets win on a key clash).
      secrets: z.array(z.object({ name: z.string(), value: z.string() })).default([])
    })
    .optional(),
  // Names of daemon-configured MCP servers (daemon config `mcpServers`) to attach
  // at ACP session/new|load, after the daemon's own bridge entry. Empty ⇒ none;
  // unknown names are skipped with a warn (see mcp/resolve-servers.ts).
  mcpServers: z.array(z.string()).default([]),
  // Skill sources to install into the workspace via `npx skills` after clone and
  // before the ACP host spawns (design: docs/designs/shared-skills.md). CP-owned,
  // shipped inline on AgentSpec.skills — each entry is self-contained so the daemon
  // needs nothing but agent.json to install. Supersedes the deprecated
  // `workspace.skills` string list below (which is now an unused no-op).
  skills: z.array(AgentSkillEntry).default([]),
  // Agent→agent call authorization (design §2.5), replicated from the CP so the
  // daemon enforces it LOCALLY when another agent uses `messageAgent` to wake this
  // one. `all` (the default) ⇒ any org peer may call; `selected` ⇒ only agents in
  // `allowedCallerAgentIds`. Absent callPolicy ⇒ treated as `all` (backward-compat;
  // see §6.5 for the fail-closed alternative — noted as a P1 gap).
  callPolicy: z.enum(['all', 'selected']).default('all'),
  allowedCallerAgentIds: z.array(z.string()).default([]),
  // Caller-side half of collaboration authorization. Defaults preserve the
  // historical unrestricted behavior for existing agent.json files.
  outboundPolicy: z.enum(['all', 'selected']).default('all'),
  allowedTargetAgentIds: z.array(z.string()).default([]),
  // Opt-in (issue #536): when true, on a GENUINE new channel join the agent
  // proactively introduces itself to the other agents already there (via
  // listChannelAgents → messageAgent) so peers can record it in memory. Default
  // off — the daemon seeds each integration's channel baseline silently, so only
  // channels joined AFTER the baseline (never a restart/re-list) trigger an intro.
  introduceOnJoin: z.boolean().default(false),
  // Request an OS sandbox for this agent (issue #642). Daemon policy may force it
  // on; an unavailable optional sandbox is ineffective. New agents default off.
  restrictFileAccess: z.boolean().default(false),
  // Which memory backend this agent uses (see agents/memory-provider.ts). Absent ⇒
  // managed (the default). External keeps only connection id + bounded policy on
  // disk; endpoint/grant/config live in the daemon-private CP registry.
  memory: AgentMemoryBinding.optional(),
  workspace: z.object({
    mode: z.enum(['git-repo', 'from-scratch']),
    path: z.string(),
    gitRepo: z.string().optional(), // full cloneable address (e.g. https://github.com/acme/infra)
    gitBranch: z.string().default('main'),
    // Repository-relative ACP cwd. Kept lexically lenient here so a historical or
    // hand-authored value cannot break daemon discovery; prepareWorkspace validates it.
    agentDir: z.string().optional(),
    // Remote-git credential mode. Absent ⇒ anonymous (public repos). 'github-app' ⇒
    // clone/fetch/push authenticate via the local credential helper backed by
    // CP-minted short-lived installation tokens — nothing durable on this host.
    gitCredential: z.enum(['github-app']).optional(),
    pullOnNewSession: z.boolean().default(true),
    // DEPRECATED: superseded by the top-level `skills` field (AgentSkillEntry[]).
    // Kept so historical agent.json files still parse; nothing consumes it.
    skills: z.array(z.string()).default([])
  }),
  integrations: z.array(IntegrationSchema).default([]),
  // zod 4: nested .default({}) does not apply inner field defaults — use explicit full literal
  output: z
    .object({
      mode: z.enum(['none', 'minimal', 'low', 'medium', 'high']).default('low'),
      showFooter: z.boolean().default(true)
    })
    .default({ mode: 'low', showFooter: true }),
  permissions: z
    .object({ policy: z.enum(['ask', 'auto']).default('ask'), autoApprove: z.array(z.string()).default([]) })
    .default({ policy: 'ask', autoApprove: [] }),
  crons: z.array(CronDefSchema).default([])
})
export type Agent = z.infer<typeof AgentSchema>
