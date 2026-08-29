import { z } from 'zod'
import {
  AgentMemoryBinding,
  CompatibleAgentSkillEntry,
  IntegrationCoreEnvelope,
  IntegrationDiscordConfig,
  IntegrationFeishuConfig,
  IntegrationSlackConfig,
  IntegrationTelegramConfig,
  ManagedSkillEntry
} from '@agentconnect.md/protocol'

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

/**
 * Per-platform `config` payloads (§6.4): the daemon-side module schemas are the
 * WIRE schemas (one contract, both ends import it from the protocol package)
 * plus the daemon-local optional extras a hand-authored file may pre-seed.
 * Routing knobs and the ingress mode are NOT here — they live in the shared
 * `core` envelope, the only representation the daemon reads.
 */
export const SlackConfigSchema = IntegrationSlackConfig
export type SlackConfig = z.infer<typeof SlackConfigSchema>

export const TelegramConfigSchema = IntegrationTelegramConfig.extend({
  botUserId: z.string().optional() // numeric bot id; pre-seed for mention routing before getMe resolves it
})
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>

export const DiscordConfigSchema = IntegrationDiscordConfig.extend({
  botUserId: z.string().optional() // numeric bot user id; pre-seed for mention routing before `ready` resolves it
})
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>

export const FeishuConfigSchema = IntegrationFeishuConfig
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>

/**
 * One integration entry — §6.4 FINAL SHAPE, migrated together with the protocol
 * `IntegrationSpec` (they are the same envelope): an OPEN `platform` id, the
 * core routing envelope, and an opaque per-platform `config` that only the
 * platform's own module schema understands
 * (`platforms/integration-config.ts`). The pre-S3 nested shape — the platform
 * id repeated as a key holding the block — is RETIRED: an old entry still
 * parses (the nested block is an unknown key, stripped), but it carries no
 * `config`, so every consumer skips it with a warning until it is rewritten —
 * the file itself is never touched.
 *
 * `core` is defaulted (unlike the wire, where its absence is fail-closed):
 * a hand-authored entry that omits it gets exactly the empty-rule defaults the
 * old nested schemas defaulted to, and the config-less skip above already
 * covers the stale-shape case loudly.
 */
export const IntegrationSchema = z.object({
  id: z.string(),
  // CP-pushed integrations are tagged so a reconnect snapshot can prune a
  // missed integration/remove without touching hand-authored local entries.
  origin: z.literal('cp').optional(),
  platform: z.string().min(1),
  core: IntegrationCoreEnvelope.default({ mode: 'direct', bindRules: [], mutedChannels: [], gated: false }),
  config: z.unknown().optional()
})
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
      // §6.8 open id; the daemon serves any platform it has a connection for.
      platform: z.string().min(1),
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
  // Added to the in-memory effective representation of a CP-managed agent.
  // A disk file carrying this legacy field is still treated as user-owned.
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
  // System-prompt seed + runtime knobs. Settable in a local agent.json or supplied
  // in memory by the CP (agent/upsert + register/ok roster).
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
  // Public GitHub skill sources to acquire as bounded local snapshots and install
  // with the bundled exact CLI after clone and before the ACP host spawns (design:
  // docs/designs/shared-skills.md). CP-owned, shipped inline on AgentSpec.skills —
  // each entry is self-contained so the daemon needs nothing but agent.json to
  // install. Supersedes the deprecated
  // `workspace.skills` string list below (which is now an unused no-op).
  skills: z.array(CompatibleAgentSkillEntry).default([]),
  // Centrally accepted immutable `.skill` revisions. Content stays in the
  // daemon-owned cache and is materialized into the workspace before session
  // creation; this metadata is the exact CP-authorized revision set.
  managedSkills: z.array(ManagedSkillEntry).default([]),
  // Agent→agent call authorization (design §2.5), replicated from the CP so the
  // daemon enforces it LOCALLY when another agent uses `messageAgent` to wake this
  // one. `all` (the default) ⇒ any org peer may call; `selected` ⇒ only agents in
  // `allowedCallerAgentIds`. Absent callPolicy ⇒ treated as `all` for backward
  // compatibility with existing agent.json files.
  callPolicy: z.enum(['all', 'selected']).default('all'),
  allowedCallerAgentIds: z.array(z.string()).default([]),
  // Caller-side half of collaboration authorization. Defaults preserve the
  // historical unrestricted behavior for existing agent.json files.
  outboundPolicy: z.enum(['all', 'selected']).default('all'),
  allowedTargetAgentIds: z.array(z.string()).default([]),
  // Opt-in (issue #536): when true, on a GENUINE new channel join the agent
  // proactively introduces itself to the other agents already there (via
  // listAgents → a sendMessage wake) so peers can record it in memory. Default
  // off — the daemon seeds each integration's channel baseline silently, so only
  // channels joined AFTER the baseline (never a restart/re-list) trigger an intro.
  introduceOnJoin: z.boolean().default(false),
  // Request an OS sandbox for this agent (issue #312). Daemon policy may force it
  // on; an unavailable optional sandbox is ineffective. New agents default off.
  runInSandbox: z.boolean().default(false),
  // Org built-in preset marker (preset-agents.md §3.1), replicated from the CP via
  // AgentSpec.builtin. Gates preset-only behavior locally — including attaching
  // `agentconnect-admin` when the CP supplies a webchat entitlement. Never set by
  // hand: the CP re-asserts it on every roster/upsert.
  builtin: z.boolean().default(false),
  // Which memory backend this agent uses (see memory/provider.ts). Absent ⇒
  // managed (the default). External keeps only connection id + bounded policy on
  // disk; endpoint/grant/config live in the daemon-private CP registry.
  memory: AgentMemoryBinding.optional(),
  // The instance every GitLab consumer here addresses (§24.4); absent ⇒ GitLab.com, the axis default.
  gitlabHost: z.string().optional(),
  workspace: z.object({
    mode: z.enum(['git-repo', 'from-scratch']),
    // Internal isolation policy. Product surfaces call the session mode
    // "Worktree"; keeping an enum here leaves room for other isolation modes.
    isolation: z.enum(['shared', 'session']).default('shared'),
    path: z.string(),
    gitRepo: z.string().optional(), // full cloneable address (e.g. https://github.com/acme/infra)
    gitBranch: z.string().default('main'),
    // Repository-relative ACP cwd. Kept lexically lenient here so a historical or
    // hand-authored value cannot break daemon discovery; prepareWorkspace validates it.
    agentDir: z.string().optional(),
    // Remote-git credential mode. Absent ⇒ anonymous (public repos). 'github-app' ⇒
    // clone/fetch/push authenticate via the local credential helper backed by
    // CP-minted short-lived installation tokens — nothing durable on this host.
    gitCredential: z.enum(['github-app', 'gitlab']).optional(),
    // gitlab mode: the v2 rename-stable numeric project id (gitlab-com-integration.md
    // §17.1) — the identity the credential consumer verifies against every grant echo.
    gitlabProjectId: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    // The agent's additional-repository allowlist, replicated from the CP
    // (multi-repository-workspaces.md decision 2). `repoId` is the host's numeric
    // repository/project id as a decimal string, so a rename cannot orphan an entry,
    // and `provider` qualifies it — the hosts number theirs independently
    // (gitlab-com-integration.md §8.1). Absent ⇒ github, what every entry a
    // pre-GitLab control plane replicated means.
    additionalRepos: z
      .array(
        z.object({
          repoFullName: z.string(),
          repoId: z.string(),
          provider: z.string().min(1).default('github')
        })
      )
      .default([]),
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
      showFooter: z.boolean().default(true),
      showStatusBar: z.boolean().default(false)
    })
    .default({ mode: 'low', showFooter: true, showStatusBar: false }),
  permissions: z
    .object({ policy: z.enum(['ask', 'auto']).default('ask'), autoApprove: z.array(z.string()).default([]) })
    .default({ policy: 'ask', autoApprove: [] }),
  crons: z.array(CronDefSchema).default([])
})
export type Agent = z.infer<typeof AgentSchema>
