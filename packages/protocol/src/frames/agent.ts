import { z } from 'zod'
import { CodeHostProviderString } from '../code-host.js'
import { AgentMemoryBinding } from './memory-connection.js'
import { IntegrationSpec } from './integration.js'
import { CronUpsert } from './cron.js'
import { normalizeGitHubSkillSource } from '../git-url.js'

/**
 * Agent lifecycle (protocol §4.4, §7.4, §8).
 *
 * There is no CP→daemon prompt-delivery frame: the daemon prompts an agent from
 * its own ingress (platform adapters or relay `rd/*` delivery), never the CP.
 * The old `agent/prompt` + per-agent `seq` machinery was reserved infrastructure
 * with no live caller and has been removed.
 */

// One repository of the agent's additional-repository allowlist (multi-repository-workspaces.md decision 2).
// `repoId` is the host's numeric repository/project id as a decimal string — rename-immune, the identity
// minting matches on. `provider` qualifies it (gitlab-com-integration.md §8.1): the hosts number their
// repositories independently, so the pair is the identity. Absent ⇒ `github`, which is what every row a
// pre-GitLab control plane projects means, so an older peer's list still decodes.
export const AgentAdditionalRepo = z.object({
  repoFullName: z.string(),
  repoId: z.string(),
  provider: CodeHostProviderString.default('github')
})
export type AgentAdditionalRepo = z.infer<typeof AgentAdditionalRepo>

/**
 * Where the agent runs. The **path is always daemon-generated** — never
 * specified by the caller (UX picks the mode, the machine owns the dir).
 *
 * - `scratch`: a fresh empty working dir on the machine, with no default repo.
 *   `gitCredential: github-app` enables credentials only for repositories that
 *   were explicitly authorized for the agent.
 * - `git`: the host-neutral repository workspace (git-workspace-model.md). The
 *   daemon clones `gitRepo` @ `branch` and runs the agent in `agentDir` (a
 *   subdir of the repo, repo-root if omitted). **Multiple agents may share one
 *   repo** — they differ by `agentDir`, so the repo is not an owned entity,
 *   just shared config on each agent. `credential` names who vouches for the
 *   repository; absent ⇒ anonymous clone.
 * - `github` / `gitlab`: the pre-`git` host-shaped arms, kept decodable for the
 *   rollout (git-workspace-model.md §8). The CP still projects them to daemons
 *   that do not advertise `workspace-git-v1`.
 *
 * Every mode carries `additionalRepos`: the agent's additional-repository
 * allowlist, projected by the CP so the daemon has the set before a session
 * starts. A later phase materializes them as secondary workspace roots; today
 * nothing on the daemon reads the list.
 */
// Who vouches for a `git` workspace's repository (git-workspace-model.md §3).
// Absent ⇒ anonymous clone; the daemon's operator-owned `workspaceGitAllowedOrigins`
// still gates the origin. `access` stays off the wire — the CP clamps minted tokens
// server-side. A new code host is a new variant here, never a new workspace mode.
export const AgentWorkspaceCredential = z.discriminatedUnion('provider', [
  // Minting re-resolves the live installation by owner, so no installationId travels.
  z.object({ provider: z.literal('github') }),
  // The rename-stable numeric project id — the gitcred v2 request identity.
  z.object({ provider: z.literal('gitlab'), projectId: z.string().regex(/^[1-9]\d*$/) })
])
export type AgentWorkspaceCredential = z.infer<typeof AgentWorkspaceCredential>

export const AgentWorkspace = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('scratch'),
    // Workspace isolation is runtime-owned rather than a filesystem path. The
    // console exposes this as the simpler Worktree on/off choice for Git repos.
    isolation: z.enum(['shared', 'session']).default('shared'),
    // Scratch has no implicit/default repository. The credential helper still
    // lets git/gh request explicitly authorized repositories by name.
    gitCredential: z.enum(['github-app']).optional(),
    additionalRepos: z.array(AgentAdditionalRepo).default([])
  }),
  // The host-neutral repository workspace (git-workspace-model.md §3): `mode`
  // answers "is there a repository", `credential` answers "who vouches for it".
  // FRAME-FATAL on an older daemon — the CP only projects this arm to daemons
  // advertising `workspace-git-v1` and dual-encodes the legacy arms to the rest.
  z.object({
    mode: z.literal('git'),
    isolation: z.enum(['shared', 'session']).default('shared'),
    gitRepo: z.string(), // FULL cloneable https/ssh address (normalizeGitCloneUrl)
    branch: z.string().default('main'),
    agentDir: z.string().optional(), // subdir within the repo; omitted ⇒ repo root
    credential: AgentWorkspaceCredential.optional(),
    additionalRepos: z.array(AgentAdditionalRepo).default([])
  }),
  z.object({
    mode: z.literal('github'),
    isolation: z.enum(['shared', 'session']).default('shared'),
    gitRepo: z.string(), // FULL cloneable address, e.g. https://github.com/acme/infra (normalizeGitUrl)
    branch: z.string().default('main'),
    agentDir: z.string().optional(), // subdir within the repo; omitted ⇒ repo root
    // Credential mode for remote git ops. Absent ⇒ anonymous (public repos,
    // the pre-github-app behavior). 'github-app' ⇒ the daemon pulls short-lived
    // CP-minted installation tokens over gitcred/request and injects them via
    // the local credential helper — no durable git credential on the host.
    gitCredential: z.enum(['github-app']).optional(),
    additionalRepos: z.array(AgentAdditionalRepo).default([])
  }),
  // gitlab-com-integration.md M4: a managed GitLab project binding is the
  // workspace. FRAME-FATAL on a pre-GitLab daemon (§17.3): the CP never
  // projects this arm to a daemon that has not advertised gitlab-com-v1 —
  // reconcile withholds it and AgentDelivery/placement gate on the same
  // predicate. Credentials are implied managed (binding PATs over gitcred v2);
  // there is no anonymous gitlab mode.
  z.object({
    mode: z.literal('gitlab'),
    isolation: z.enum(['shared', 'session']).default('shared'),
    gitRepo: z.string(), // https://gitlab.com/<full/namespaced/path> (subgroups preserved)
    branch: z.string().default('main'),
    agentDir: z.string().optional(),
    // The rename-stable numeric project id — the gitcred v2 request identity.
    projectId: z.string().regex(/^[1-9]\d*$/),
    additionalRepos: z.array(AgentAdditionalRepo).default([])
  })
])
export type AgentWorkspace = z.infer<typeof AgentWorkspace>

/**
 * MCP-server name reserved for the daemon's own injected stdio bridge (its
 * platform tools). A config-defined or agent-enabled server under this name
 * would collide with the bridge entry at ACP `session/new`, so the daemon
 * strips it and the CP rejects it in `AgentSpec.mcpServers` at the API edge.
 */
export const RESERVED_MCP_SERVER_NAME = 'agentconnect'

/**
 * The curated Lucide glyph set a `glyph` icon may use — the single source of
 * truth for the picker, the DTO validation, and the CP icon-endpoint renderer.
 * `glyph` is constrained to this set so an API/CLI-created icon can't persist a
 * name the console `<Icon>` and the PNG endpoint don't both render. The web
 * picker mirrors this list (it does not import this package) — keep in sync.
 */
export const AGENT_ICON_GLYPHS = [
  // The AgentConnect brand diamond — the fixed identity of the built-in preset
  // agents (preset-agents.md §3.1). Renderers special-case it: a multi-color
  // brand mark (not a Lucide stroke glyph) drawn plateless — the native logo,
  // its `color` field inert. The web picker deliberately does NOT offer it in
  // its grid, though a stored value renders everywhere.
  'agentconnect',
  'bot',
  'cpu',
  'terminal',
  'code',
  'rocket',
  'zap',
  'bug',
  'git-branch',
  'message-square',
  'sparkles',
  'brain',
  'wrench',
  'ship',
  'box',
  'hexagon',
  'compass',
  'atom',
  'flame',
  'star',
  'heart',
  'globe',
  'database',
  'shield',
  'feather'
] as const

/**
 * An agent's display icon (docs: the Console "Agent Avatar" picker). A
 * discriminated union on `kind`:
 *  - `runtime` — derive the mark from the agent's runtime (Claude/Codex/…), the
 *    legacy behavior; also the meaning of a null/absent icon.
 *  - `glyph`   — a curated Lucide glyph (see {@link AGENT_ICON_GLYPHS}) on a solid
 *    color plate (the create-time random default is a `glyph`). An unknown glyph
 *    fails to parse and degrades to the runtime mark on every surface.
 *  - `image`   — a user-uploaded avatar. The bytes live in the CP's configured
 *    object store (S3-compatible; see docs/designs/icon-uploads.md), NOT in this
 *    descriptor. Its optional opaque generation distinguishes successive writes
 *    to the stable object key; legacy rows omit it. The display/serve URL is
 *    resolved separately (the object store's public URL for the owner's key),
 *    surfaced as the DTO `iconUrl` / `AgentSpec.iconUrl`. Set only via the upload
 *    route; never via a create/update body.
 * This descriptor is CP-owned + stored on the agent and surfaced to the web
 * console. The daemon never receives it — it gets only the resolved public
 * `AgentSpec.iconUrl` (for the Slack per-message avatar), so it needs no renderer.
 */
export const AgentIcon = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runtime') }),
  z.object({ kind: z.literal('glyph'), glyph: z.enum(AGENT_ICON_GLYPHS), color: z.string() }),
  z.object({ kind: z.literal('image'), generation: z.string().min(1).max(128).optional() })
])
export type AgentIcon = z.infer<typeof AgentIcon>

/**
 * A self-contained Git skill definition the daemon acquires into a private
 * snapshot and installs through its exact `skills` dependency after the
 * workspace is ready and before the ACP host spawns (shared-skills.md §4/§6).
 * The source definition rides INLINE on the AgentSpec (and lands in agent.json,
 * like mcpServers) — there is no separate skillsource frame or daemon-side def
 * cache. The CP resolves each agent's enabled org-level `SkillSource` rows into
 * these entries when it builds the spec.
 */
// Skill selections become `-s` arguments to the isolated CLI, while the source
// is parsed by the Git acquisition boundary. Reject option-looking values at
// the wire boundary — the daemon validates again in depth.
const SkillSelectionArg = z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9_])?$/, {
  message: 'must be a canonical lowercase skills CLI name without a trailing dot or hyphen'
})

const SkillRef = z
  .string()
  .max(256)
  .refine((s) => s.length > 0 && !/[\0\r\n]/.test(s), { message: 'must be a non-empty single-line ref' })

const SkillSubDir = z
  .string()
  .max(1_024)
  .refine(
    (s) =>
      s.length > 0 &&
      !s.startsWith('/') &&
      !s.includes('\\') &&
      !/[\0\r\n]/.test(s) &&
      s.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'),
    { message: 'must be a safe relative subdirectory' }
  )

const GitHubRepositoryId = z
  .string()
  .regex(/^[1-9]\d{0,19}$/, { message: 'must be a canonical positive GitHub repository id' })

export const AgentSkillEntry = z.object({
  // Display/log label — the org-level source name. NOT passed to the CLI.
  name: z.string().min(1).max(64),
  // Credential-free Git acquisition input (owner/repo, clone URL, or a
  // tree/<ref>/<subdir> path). The CLI sees only the resulting local snapshot.
  source: z
    .string()
    .min(1)
    .max(512)
    .refine((s) => !s.startsWith('-'), { message: 'must not start with "-"' })
    .refine(
      (s) => {
        try {
          normalizeGitHubSkillSource(s)
          return true
        } catch {
          return false
        }
      },
      { message: 'must be a bounded GitHub repository source' }
    ),
  // Rename-proof GitHub identity. Current CP projections must carry this exact
  // decimal id; the daemon verifies it through the numeric endpoint before any
  // name-based fetch.
  githubRepoId: GitHubRepositoryId,
  // Optional branch/tag/commit. The daemon composes it into the source when set;
  // a tag/commit pins content, a branch/absent tracks the head (design §5).
  ref: SkillRef.optional(),
  // Optional repo-relative install directory.
  subDir: SkillSubDir.optional(),
  // Which skills from the source to install (passed as repeated `-s`). Empty ⇒
  // install every skill the source exposes (no `-s`).
  skills: z
    .array(SkillSelectionArg)
    .max(64)
    .refine((skills) => new Set(skills).size === skills.length, { message: 'skill selections must be unique' })
    .default([])
})
export type AgentSkillEntry = z.infer<typeof AgentSkillEntry>

/** Current-CP projection boundary. Kept separate from the rolling-compatible
 * wire decoder below: a new daemon may briefly receive an old CP's previously
 * legal rows, and one such row must not reject the entire register snapshot. */
export const InstallableAgentSkills = z
  .array(AgentSkillEntry)
  .max(64)
  .refine((entries) => new Set(entries.map((entry) => entry.name)).size === entries.length, {
    message: 'skill source names must be unique'
  })

const LegacySkillArg = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith('-'), { message: 'must not start with "-"' })

export const CompatibleAgentSkillEntry = z.object({
  name: z.string(),
  source: LegacySkillArg,
  // Optional only for CP-first rolling upgrades and previously persisted
  // agent.json files. Strict daemon admission drops unbound legacy entries.
  githubRepoId: z.string().optional(),
  ref: z.string().optional(),
  subDir: z.string().optional(),
  skills: z.array(LegacySkillArg).default([])
})

/** One centrally accepted, immutable Agent Skills bundle enabled for an agent.
 * Content is fetched separately in bounded chunks; AgentSpec carries metadata
 * only so register/agent-upsert frames stay small. */
export const ManagedSkillEntry = z
  .object({
    id: z.string().uuid(),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    revision: z.number().int().positive(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  })
  .strict()
export type ManagedSkillEntry = z.infer<typeof ManagedSkillEntry>

/**
 * The editable agent definition the CP owns and the daemon needs to run it:
 * prompt + runtime selection. The launch protocol carries this config and the
 * daemon synthesizes the system prompt locally; `description` IS the prompt.
 */
export const AgentSpec = z.object({
  // Owning tenant. Optional only for CP/daemon rolling compatibility; a current CP always sends it.
  orgId: z.string().min(1).max(64).optional(),
  name: z.string(),
  // Human-readable bot name. CP snapshots/upserts always ship value or null so
  // clearing it removes a stale daemon-local display name; absent remains
  // available to hand-authored/partial specs as "leave unchanged".
  displayName: z.string().nullable().optional(),
  // Absolute, publicly-fetchable avatar URL the CP resolves from the agent's icon
  // (agent.icon → the CP icon endpoint for runtime/glyph, or the image URL directly).
  // The daemon uses it as the Slack per-message `icon_url` (chat:write.customize) —
  // the sibling of displayName→username (PR #539). CP ships value or null so clearing
  // the icon drops the override; null/absent ⇒ Slack keeps the app's default avatar.
  iconUrl: z.string().url().nullable().optional(),
  // The system prompt seed; appended to the daemon's standing prompt. The CP always
  // ships it as a string — a cleared description replicates as "" so the daemon
  // overwrites a stale seed; an absent key means "leave unchanged" (hand-authored/
  // partial specs). Deliberately NOT nullable: older daemons parse this as a plain
  // string and would reject a null register/ok roster entry, failing the whole
  // handshake. An empty prompt seed and "no description" are equivalent, so the ""
  // collapse is lossless.
  description: z.string().optional(),
  runtime: z.string().optional(), // which ACP runtime to run, e.g. "claude" / "codex"
  // Per-runtime override vocabularies (model / effort / permission mode). Switching
  // runtime invalidates them, so the CP must be able to CLEAR them, not just set them:
  //   absent ⇒ leave the on-disk value alone (hand-authored agent.json / partial spec)
  //   null   ⇒ clear the override (revert to the runtime's own default)
  //   string ⇒ set it
  // The CP's agentRecordToSpec always ships these (value or null) so a clear replicates.
  model: z.string().nullable().optional(), // runtime model, e.g. "opus"
  reasoningEffort: z.string().nullable().optional(),
  executionMode: z.string().optional(), // e.g. "byoc"
  outputMode: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(), // platform output verbosity → agent.json output.mode ('none' = session-only, nothing to the IM)
  showFooter: z.boolean().optional(), // render platform attribution/session footers; absent ⇒ leave agent.json unchanged
  showStatusBar: z.boolean().optional(), // render Slack's persistent session status row; absent ⇒ leave agent.json unchanged
  fastMode: z.boolean().optional(), // runtime fast mode (ACP `model_config` toggle); absent ⇒ leave runtime default
  permissionMode: z.string().nullable().optional(), // runtime permission/approval mode (ACP `mode` selector); absent ⇒ leave alone, null ⇒ clear
  // Explicit opt-in: when false, conversation participants cannot change runtime
  // settings (model, effort, permission mode, fast mode) or answer approval
  // requests. Agent editors decide pending requests from the console instead.
  allowRuntimeChangesInChat: z.boolean().optional(),
  // Operational message-processing toggle (orthogonal to placement). When true the
  // agent stays placed/connected but the daemon skips ALL turn dispatch (platform,
  // webchat, cron). Optional (not defaulted) so an absent value leaves the on-disk
  // agent.json pause untouched — same contract as fastMode/permissionMode.
  pause: z.boolean().optional(),
  workspace: AgentWorkspace.optional(), // where it runs; absent ⇒ daemon defaults to scratch
  // The GitLab instance every GitLab consumer on this spec addresses (§24.4). The daemon
  // needs the host BEFORE the agent spawns — the credential git-config block, the helper
  // table, and the session export are all established there — and a GitLab consumer is not
  // always the workspace: an additional-repository authorization rides on a scratch or
  // github workspace, and a hook can reach an already-running session. So the CP sets this
  // whenever the assembled spec has ANY GitLab consumer (gitlab workspace, gitlab
  // additional repository, or an enabled gitlab hook), and absent means GitLab.com, which
  // is what every spec an older CP projects means. One field rather than a per-consumer
  // table is the one-instance axiom (§24.1) made wire-visible.
  gitlabHost: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(), // extra env injected into the runtime
  // Write-only secret env vars: same injection as `env` (merged into the spawned
  // child's environment, secrets winning on a key collision), but their VALUES never
  // travel back out — the CP DTO exposes only the key names, and the console masks
  // them. Plaintext at rest (like `env`) and shipped over the TLS WS; "secret" here
  // means write-only from the API/UI, not KMS-sealed. Always shipped (even {}) so a
  // removed secret replicates, same contract as `env` below.
  secrets: z.record(z.string(), z.string()).optional(),
  // Which memory backend the agent uses (design: docs/designs/memory-evolution.md):
  //   managed  — our <agent-root>/memory/ directory (default)
  //   native   — the runtime's own memory (Claude auto-memory / Codex memories),
  //              redirected under the agent root for per-agent isolation
  //   external — an outside service (mem0); not yet implemented
  //   none     — disable both daemon-managed and runtime-native persistent memory
  // Optional (absent ⇒ leave the on-disk agent.json value alone — same contract as
  // fastMode/pause). A brand-new agent with no value defaults to managed daemon-side.
  memory: AgentMemoryBinding.optional(),
  // Names of daemon-configured MCP servers (daemon config `mcpServers`, reported
  // via `facts/daemon-runtimes`) to attach at `session/new`. Empty/absent ⇒ none.
  mcpServers: z.array(z.string()).default([]),
  // Skill sources to install into the workspace before the ACP host spawns
  // (design: shared-skills.md). Unlike mcpServers (names resolved daemon-side),
  // these are SELF-CONTAINED entries — the daemon needs nothing but agent.json to
  // acquire bounded snapshots and invoke its bundled CLI. Always shipped (even
  // []) so removing the last skill replicates.
  // Decode the previous wire vocabulary during CP-first rolling upgrades. The
  // current CP projects only `InstallableAgentSkills`; the daemon independently
  // applies the same strict acquisition/size admission before any host starts.
  skills: z.array(CompatibleAgentSkillEntry).default([]),
  // Centrally accepted `.skill` ZIP revisions. Unlike Git source entries above,
  // these are digest-addressed metadata; the daemon downloads/cache-verifies the
  // bundle through managed-skill/read before session start.
  managedSkills: z
    .array(ManagedSkillEntry)
    .max(64)
    .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, {
      message: 'managed skill ids must be unique'
    })
    .default([]),
  // Agent→agent call authorization (design §2.5). `callPolicy` gates who may wake
  // this agent via the `messageAgent` tool: 'all' ⇒ any peer in the org, 'selected'
  // ⇒ only agents in `allowedCallerAgentIds`. Replicated CP→daemon so the daemon can
  // enforce the policy LOCALLY on same-daemon delivery (no CP hop on the hot path).
  // Optional (absent ⇒ leave the on-disk agent.json value alone — same contract as
  // pause/memory); `allowedCallerAgentIds` always ships (even []) so removing the last
  // allowed caller replicates.
  callPolicy: z.enum(['all', 'selected']).optional(),
  allowedCallerAgentIds: z.array(z.string()).default([]),
  // Outbound half of agent→agent authorization. `selected` means this agent may
  // discover/message only peers in `allowedTargetAgentIds`. The target's inbound
  // policy must also allow this agent; effective authorization is the intersection.
  // Both fields remain optional when decoding an older CP payload so a mixed-version
  // update cannot retain an on-disk `selected` mode while silently clearing its list.
  // A current CP always ships both fields, including [] to clear the final member.
  outboundPolicy: z.enum(['all', 'selected']).optional(),
  allowedTargetAgentIds: z.array(z.string()).optional(),
  // Self-introduce-on-join (issue #536): when true, on a genuine new channel join the
  // agent proactively introduces itself to the peers already there (via listAgents
  // → messageAgent) so they can record it in memory. Replicated CP→daemon. Optional
  // (absent ⇒ leave the on-disk agent.json value alone — same contract as pause/fastMode).
  introduceOnJoin: z.boolean().optional(),
  // Per-agent OS sandbox preference (issue #642). It is effective only when the
  // host has bwrap/sandbox-exec; daemon `security.requireSandbox` forces it on and
  // prevents daemon startup when no mechanism exists. Optional means leave the
  // on-disk agent.json value alone; a brand-new agent defaults to false.
  runInSandbox: z.boolean().optional(),
  // True when this agent is an org built-in preset (preset-agents.md §3.1): a
  // `preset_agent` row references it. Replicated so the daemon can gate preset-only
  // behavior locally, including attaching `agentconnect-admin` only when the CP
  // supplies the conversation entitlement. Optional so an older CP's spec leaves
  // the on-disk value alone; a current CP always ships it.
  builtin: z.boolean().optional(),
  // Monotonic revision of this agent's fully resolved CP-owned configuration
  // (organization-secrets-and-variables.md §7). `env`/`secrets` are FULL maps, so
  // an out-of-order snapshot would reinstate a rotated or deleted value; the
  // daemon persists the greatest revision it applied and refuses an older one.
  // Not environment-specific — every CP-side mutation that can change a field
  // assembled into this spec bumps it through the same writer, giving one
  // ordering domain per agent.
  //
  // Encoded as a DECIMAL STRING, not a number: the CP column is a bigint and a
  // JSON number would silently lose precision past 2^53 on either side.
  // Optional for rolling upgrades (an older CP omits it, an older daemon ignores
  // it), but a bound agent may only be placed on a daemon advertising
  // `agent-config-revision-v1` — the feature never relies on lenient decoding.
  configRevision: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .optional()
})
export type AgentSpec = z.infer<typeof AgentSpec>

export const AgentLaunch = z.object({
  // C→D, carries ControlExt(epoch)
  agentId: z.string().uuid(),
  runtime: z.string(), // must be in RegisterReq.capabilities.runtimes
  workspaceId: z.string().uuid(),
  capabilities: z.array(z.string()), // the active-capability pin (§8.1)
  spec: AgentSpec, // prompt/model/env — arrives at start, no separate CRUD needed
  mode: z.enum(['long_lived', 'per_turn']).default('long_lived'), // 🅰️ decision #2 knob
  // Web API launch provenance (session-visibility.md §4.4): CP-minted when the
  // launch was requested by a console user, echoed back by the daemon on the
  // resulting session's `event/session` so ingest can classify it `private`
  // with that user as owner. Optional — CLI/orchestration launches and older
  // CPs omit it. NOT the launchId fence (which is per-launch, not per-user).
  launchCorrelationId: z.string().uuid().optional()
})
export type AgentLaunch = z.infer<typeof AgentLaunch>

/**
 * Live agent CRUD (C→D): the console edited an agent's spec; push it so a
 * running daemon reloads without waiting for the next launch. `agent/remove`
 * tears the agent down. Deleting an agent never relaunches it.
 */
export const AgentUpsert = z.object({
  agentId: z.string().uuid(),
  spec: AgentSpec
})
export type AgentUpsert = z.infer<typeof AgentUpsert>

export const AgentRemove = z.object({
  agentId: z.string().uuid()
})
export type AgentRemove = z.infer<typeof AgentRemove>

/** Hard cap on one existence query; a sweep with more candidates chunks. */
export const AGENT_EXISTS_MAX = 1000

/**
 * D→C REQ (reply: `agent/exists/ok`) — which of these agents the control plane still knows.
 * Install-wide: a pool member's orphan reconciler reads agent ids off cluster objects that
 * span every org it serves and asks in one round trip. Existence only, no spec: the answer
 * decides whether a leaked sandbox object may be collected, nothing more.
 */
export const AgentExists = z.object({
  agentIds: z.array(z.string().uuid()).min(1).max(AGENT_EXISTS_MAX)
})
export type AgentExists = z.infer<typeof AgentExists>

/** C→D REP to `agent/exists`: the subset of the asked ids that exist. An id absent here is gone. */
export const AgentExistsOk = z.object({
  existing: z.array(z.string().uuid()).max(AGENT_EXISTS_MAX)
})
export type AgentExistsOk = z.infer<typeof AgentExistsOk>

/**
 * Safe move lifecycle (C→D REQ → generic `ack`). `agent/detach` fences the
 * source or stages the target and archives any daemon-local root;
 * `agent/activate` atomically applies the authoritative spec/integration/cron
 * bundle, restores and exact-prunes an archive when present, then makes the
 * agent servable.
 */
export const AgentDetach = z.object({
  agentId: z.string().uuid(),
  /** Fences late lifecycle retries from a superseded move operation. */
  moveId: z.string().uuid(),
  /** Source-side hard cutover. Cancel already-admitted turns instead of waiting
   *  for them to drain; their sessions remain daemon-local and are not replayed
   *  after activation on the target. */
  discardActiveTurns: z.boolean().optional(),
  /** Scratch→GitHub conversion guard. The daemon drains the agent first, then
   *  ACKs only when the live scratch working directory is still empty. */
  requireEmptyWorkspace: z.boolean().optional()
})
export type AgentDetach = z.infer<typeof AgentDetach>

export const AgentActivate = z.object({
  agentId: z.string().uuid(),
  /** Absent ⇒ authoritative unstage: release any fence held, and start no host unless the duty is held. */
  moveId: z.string().uuid().optional(),
  /**
   * One authoritative, acknowledged bootstrap bundle. Unlike the live CRUD
   * EVTs, these definitions are synchronously persisted under the staging gate
   * before activation can ACK, so a same-id stale secret/spec cannot survive.
   */
  spec: AgentSpec,
  integrations: z.array(IntegrationSpec),
  crons: z.array(CronUpsert),
  /** Prove the requested workspace can be materialized before activation ACK.
   *  Used by scratch→GitHub conversion so a failed clone can be rolled back. */
  prepareWorkspace: z.boolean().optional(),
  /** Reconcile the daemon-local workspace to the authoritative mode/repo/branch.
   *  The daemon preserves the checkout when that materialization is unchanged,
   *  and replaces its contents when it changed. */
  reconcileWorkspace: z.boolean().optional()
})
export type AgentActivate = z.infer<typeof AgentActivate>

export const AgentLaunched = z.object({
  // D→C, REP/EVT
  agentId: z.string().uuid(),
  launchId: z.string().uuid(), // new fence value
  acpSessionId: z.string().optional(), // 🅰️ present iff long-lived ACP session (default)
  startedAt: z.string().datetime(),
  runtime: z.string() // e.g. "claude" / "codex"
})
export type AgentLaunched = z.infer<typeof AgentLaunched>

export const AgentStop = z.object({
  agentId: z.string().uuid(),
  launchId: z.string().uuid(),
  reason: z.string()
})
export type AgentStop = z.infer<typeof AgentStop>

export const AgentActivity = z.object({
  // D→C, EVT — activity-probe (§7.4)
  agentId: z.string().uuid(),
  launchId: z.string().uuid(),
  state: z.enum(['thinking', 'tool_call', 'awaiting_permission', 'idle']),
  ts: z.string().datetime()
})
export type AgentActivity = z.infer<typeof AgentActivity>

export const AgentScopeDenied = z.object({
  // D→C, EVT — capability-scope audit (§8.1)
  agentId: z.string().uuid(),
  launchId: z.string().uuid(),
  capability: z.string()
})
export type AgentScopeDenied = z.infer<typeof AgentScopeDenied>

/** Editor approval queue. The daemon owns the live resolver and durable local
 * history; the Control Plane only proxies this bounded, secret-masked summary. */
export const AgentPermissionRequestRecord = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  // The owning session, by its outward id (session-concept.md §1.1) — the console scopes
  // approvals to the session it is showing, by the id it routed on. Optional for rolling
  // compatibility with daemons that predate session-scoped approval rendering.
  sessionId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  requesterId: z.string().nullable(),
  requesterName: z.string().nullable(),
  command: z.string().max(240),
  status: z.enum(['pending', 'allowed', 'denied', 'expired']),
  resolvedAt: z.string().datetime().nullable(),
  // Who decided (slack-approval-dm.md §6.1): `user:<id>` for console decisions,
  // `slack:<teamId>:<userId>` for card decisions. Optional for rolling compatibility.
  resolvedBy: z.string().nullable().optional(),
  resolvedByName: z.string().nullable().optional()
})
export type AgentPermissionRequestRecord = z.infer<typeof AgentPermissionRequestRecord>

export const AgentPermissionRequestList = z.object({
  agentId: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(50)
})
export type AgentPermissionRequestList = z.infer<typeof AgentPermissionRequestList>

export const AgentPermissionRequestPage = z.object({
  agentId: z.string().uuid(),
  requests: z.array(AgentPermissionRequestRecord)
})
export type AgentPermissionRequestPage = z.infer<typeof AgentPermissionRequestPage>

export const AgentPermissionDecision = z.object({
  agentId: z.string().uuid(),
  requestId: z.string().uuid(),
  decision: z.enum(['allow', 'deny']),
  // CP-stamped decider (slack-approval-dm.md §6.2) — never client-supplied.
  decidedBy: z.string().min(1).optional(),
  decidedByName: z.string().min(1).optional()
})
export type AgentPermissionDecision = z.infer<typeof AgentPermissionDecision>

// `agent/wake` (C→D REQ → `agent/wake/ok`): bring a cluster agent's sandbox to Running WITHOUT a turn.
// The daemon claims the agent's duty on receipt like any trigger, so a set agent with no holder is
// served by whichever member the wake reached; it answers with what it observed, never a promise.
export const AgentWakeReq = z.object({ agentId: z.string().min(1) })
export type AgentWakeReq = z.infer<typeof AgentWakeReq>

// `running` = the sandbox channel is bound; `starting` = the resume is in flight and the next read may
// still refuse; `unsupported` = this daemon runs no sandboxes, so there is nothing to wake.
export const AgentWakeState = z.enum(['running', 'starting', 'unsupported'])
export type AgentWakeState = z.infer<typeof AgentWakeState>

export const AgentWakeOk = z.object({ agentId: z.string().min(1), state: AgentWakeState })
export type AgentWakeOk = z.infer<typeof AgentWakeOk>
