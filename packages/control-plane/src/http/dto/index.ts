/**
 * REST DTO schemas (design §2.1 `http/dto/`) — request/response zod schemas for
 * the C2 BFF. These are the **HTTP** contract (WebUI ⇄ CP), NOT the daemon wire
 * protocol (`@agentconnect.md/protocol`). Fencing `bigint`s are mapped to `number`
 * at this boundary so responses are plain JSON.
 */
import { z } from 'zod'
import { Cron } from 'croner'
import { RESERVED_AGENT_SLUGS } from '../../domain/reserved-agent-slugs.js'
import {
  AgentMemoryBinding,
  AgentPermissionRequestRecord,
  CanonicalMemoryRecord,
  FeishuRegion,
  MemoryFileHistoryEvent,
  MemoryPluginHistoryEvent,
  MemoryPluginOperation,
  RESERVED_MCP_SERVER_NAME,
  GitCloneUrlError,
  RepoSubdirError,
  SessionImageAttachment,
  MAX_WORKSPACE_EDIT_BYTES,
  MAX_GIT_REPO_LENGTH,
  normalizeGitCloneUrl,
  redactGitUrlSecrets,
  normalizeRepoSubdir
} from '@agentconnect.md/protocol'
import { HEX_COLOR_RE, AGENT_ICON_GLYPHS } from '../../agents/agent-icon.js'

// ── per-resource visibility / sharing (docs/designs/resource-visibility.md) ──
/** 'org' = visible to every org member (default); 'restricted' = creator + org
 *  owners + the `sharedWith` set. */
export const ResourceVisibilityEnum = z.enum(['org', 'restricted'])
/** `PUT /{agents|daemons|crons}/:id/sharing` — set a resource's visibility + share
 *  set. Gated exactly like a content edit (`canEdit`, decision §13.3). */
export const SetSharingBody = z
  .object({
    visibility: ResourceVisibilityEnum,
    // app_user.id set; ignored while `visibility === 'org'` (kept, restore-friendly).
    // The route intersects this with current org members before storing.
    sharedWith: z.array(z.string()).default([])
  })
  .strict()
export type SetSharingBodyT = z.infer<typeof SetSharingBody>

// ── Agent visibility UI / directional sub-agent call policy ──
export const AgentCallPolicyEnum = z.enum(['all', 'selected'])
export const SetAgentCallPolicyBody = z
  .object({
    callPolicy: AgentCallPolicyEnum,
    // agent.id set. The route intersects this with visible same-org peer agents
    // and always drops the target agent itself.
    allowedCallerAgentIds: z.array(z.string().uuid()).default([]),
    // Optional for compatibility with clients that predate outbound visibility.
    // When omitted, the route preserves the existing outbound half.
    outboundPolicy: AgentCallPolicyEnum.optional(),
    allowedTargetAgentIds: z.array(z.string().uuid()).optional()
  })
  .strict()
export type SetAgentCallPolicyBodyT = z.infer<typeof SetAgentCallPolicyBody>

// ── daemons (read model) ──────────────────────────────────────────────────
export const DaemonCapabilitiesDto = z.object({
  platforms: z.array(z.string()),
  runtimes: z.array(z.string()),
  acp: z.boolean(),
  features: z.array(z.string())
})
export const DaemonLoadDto = z.object({ cpu: z.number(), mem: z.number(), agents: z.number() })

/** One thought-level (reasoning-effort) choice a model offers — `value` is the
 *  wire vocabulary the runtime accepts; name/description are display metadata. */
export const EffortOptionDto = z.object({
  value: z.string(),
  name: z.string().optional(),
  description: z.string().optional()
})

/** One runtime permission-mode choice and its runtime-owned display metadata. */
export const PermissionModeOptionDto = z.object({
  value: z.string(),
  name: z.string().optional(),
  description: z.string().optional()
})

/** Per-model capability entry of a runtime's model catalog. `efforts: []` = the
 *  model has no effort selector; absent = not yet discovered. */
export const RuntimeModelCapabilityDto = z.object({
  id: z.string(), // model-selector value
  name: z.string().optional(), // display name (sent only when it differs from id)
  efforts: z.array(EffortOptionDto).optional(),
  defaultEffort: z.string().optional(),
  fastMode: z.boolean().optional()
})

/** A runtime's discovered model × config capability matrix — mirrors the
 *  protocol `RuntimeModelCatalog` (one shape shared by the wire, the CP JSONB
 *  column, and this DTO; runtime-model-catalog.md §5). */
export const RuntimeModelCatalogDto = z.object({
  models: z.array(RuntimeModelCapabilityDto),
  defaultModel: z.string().optional(), // resolved concrete model id (never the literal "default")
  permissionModes: z.array(PermissionModeOptionDto).optional(),
  // The runtime's own default permission mode (mode select currentValue on a
  // fresh probe session); absent ⇒ not observed.
  defaultPermissionMode: z.string().optional(),
  source: z.enum(['native', 'acp']), // native = catalog driver, acp = per-model enumeration / probe seed
  observedAt: z.string() // ISO-8601 — when the daemon discovered the catalog
})

/** Observed runtime capability (from `facts/runtime-profile`); `models` drives the console picker. */
export const RuntimeProfileDto = z.object({
  runtime: z.string(),
  version: z.string(),
  models: z.array(z.string()),
  contextWindow: z.number().int().nullable(),
  acpSupport: z.string(),
  acpProtocolVersion: z.number().int().nullable(),
  toolCalling: z.boolean(),
  // MCP transports advertised at ACP initialize; null ⇒ not probed / older
  // daemon (the console assumes stdio-only).
  mcpCapabilities: z.object({ http: z.boolean(), sse: z.boolean() }).nullable(),
  // Discovered model × config capability matrix; null ⇒ the daemon has no
  // catalog for this runtime (the console falls back to its static tables).
  modelCatalog: RuntimeModelCatalogDto.nullable(),
  // Provenance of `models[]`: 'cached' (hydrated last-good, permissive for
  // capability gates) | 'probed'; null ⇒ older daemon (probed semantics).
  modelsSource: z.string().nullable(),
  // The daemon's last probe was rejected with the ACP auth-required error: the
  // runtime is installed but needs a login on the daemon host. Drives the
  // console's per-runtime "Login required" warning.
  authRequired: z.boolean(),
  // ISO-8601 — when the daemon last reported this profile.
  observedAt: z.string().nullable()
})

/** One daemon-configured MCP server (`facts/daemon-runtimes.mcpServers`), name +
 *  transport only — derived from daemon config, not probed. Definitions
 *  (commands, URLs, headers) stay daemon-local. */
export const McpServerFactDto = z.object({
  name: z.string(), // config key; what an agent's mcpServers list references
  transport: z.enum(['stdio', 'http', 'sse'])
})

/** A CP-commanded daemon restart/upgrade (cli-daemon-split.md §7). Returned by the
 *  upgrade/restart POSTs so the console can track ITS command by `id`, and embedded in
 *  the fleet read model as each daemon's most-recent op. `status` is expiry-projected. */
export const DaemonLifecycleOpDto = z.object({
  id: z.string(),
  op: z.enum(['restart', 'upgrade']),
  status: z.enum(['pending', 'succeeded', 'failed']),
  /** The version an `upgrade` drives toward; null for restart. */
  targetVersion: z.string().nullable(),
  /** Short closure detail (decline reason / timeout); null while pending / on success. */
  outcome: z.string().nullable()
})

export const DaemonViewDto = z.object({
  daemonId: z.string(),
  host: z.string().nullable(),
  /** Human-assigned display name (console-set); null until named. */
  name: z.string().nullable(),
  agentVersion: z.string().nullable(),
  /** The deployment's daemon release channel (npm dist-tag, e.g. `latest`/`rc`) that
   *  `latestVersion` was resolved from. Same for every daemon in the deployment. */
  releaseChannel: z.string(),
  /** Latest daemon version published in `releaseChannel`; null when unresolved (npm
   *  unreachable / cold start). The console compares it against `agentVersion` to
   *  flag an available upgrade. */
  latestVersion: z.string().nullable(),
  /** Every version published behind a dist-tag (the upgrade picker's options),
   *  newest-first; empty when unresolved. Same for every daemon in the deployment. */
  availableVersions: z.array(z.string()),
  /** The most recent CP-commanded restart/upgrade op for THIS daemon (cli-daemon-split.md
   *  §7), or null when the daemon has never had one. `status` is expiry-projected — a
   *  still-`pending` op past its deadline reads `failed` here even before it's swept. The
   *  console tracks its OWN command by `id` and renders terminal state from `status`. */
  lifecycleOp: DaemonLifecycleOpDto.nullable(),
  /** Live connection status overlaid from the in-memory index (not the stale durable field). */
  status: z.string(),
  health: z.string(),
  capabilities: DaemonCapabilitiesDto,
  /** Observed runtime profiles (per installed runtime); empty until the daemon reports any. */
  runtimeProfiles: z.array(RuntimeProfileDto),
  /** Daemon-configured MCP servers (name + transport); empty until the daemon reports any. */
  mcpServers: z.array(McpServerFactDto),
  load: DaemonLoadDto.nullable(),
  sessionEpoch: z.number(),
  maxAgents: z.number().int(),
  activeSessions: z.number().int(),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(), // ISO-8601
  createdBy: z.string().nullable(), // creator's userId (web resolves to a name / "You"); null for CLI/self-registered
  lastModifiedAt: z.string(), // ISO-8601; last human edit, defaults to createdAt
  lastModifiedBy: z.string().nullable(), // editor's userId (web resolves to a name / "You"); null for system rows
  // ── visibility / sharing (docs/designs/resource-visibility.md) ──
  visibility: ResourceVisibilityEnum,
  sharedWith: z.array(z.string()), // app_user.id set (only meaningful when restricted)
  canManageSharing: z.boolean(), // whether the CALLER can edit this daemon (= canEdit); gates the sharing control
  /** Whether the CALLER may command restart/upgrade on this daemon (org OWNER only, §7).
   *  Gates the console's lifecycle controls so non-owners never see an action they'd 403 on. */
  canManageLifecycle: z.boolean()
})
export const DaemonListDto = z.array(DaemonViewDto)

/** `PATCH /daemons/:id` — assign a human-friendly display name. */
export const RenameDaemonBody = z.object({ name: z.string().trim().min(1).max(64) })

/** `POST /daemons/:id/upgrade` — the version the daemon should install + relaunch on. */
// The version is forwarded to the daemon, which spawns the CLI with it as the
// `--to` VALUE. Constrain it to a plain version token here, at the boundary where
// the untrusted value enters: a leading `-` would make it a second option rather
// than a value, and no real version needs anything outside this charset.
export const DaemonUpgradeBody = z.object({
  version: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, 'must be a plain version (no leading "-")')
})

// ── daemon onboarding (API key + copy-paste start command) ─────────────────
// The full `apiKey` plaintext is returned exactly once; `displayTail` is the
// non-secret label shown everywhere afterward.
export const DaemonConnectDto = z.object({
  daemonId: z.string(),
  apiKey: z.string(),
  displayTail: z.string(),
  command: z.string()
})

// ── api keys (per-daemon credential management) ─────────────────────────────
/** Console view of a key — never the secret or hash. */
export const ApiKeyDto = z.object({
  id: z.string(),
  displayTail: z.string(),
  name: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable()
})
export const ApiKeyListDto = z.array(ApiKeyDto)

/** Mint / regenerate response — the one-time key plaintext + a ready-to-run command. */
export const MintedKeyDto = z.object({
  apiKeyId: z.string(),
  apiKey: z.string(),
  displayTail: z.string(),
  command: z.string()
})

// ── agents ────────────────────────────────────────────────────────────────
/** Response-only git address codec. Historical rows stay readable even when
 * they predate clone-target validation; the total sanitizer only removes URL
 * secrets and never rejects an old value during response serialization. */
const GitRepoOutput = z.codec(z.string(), z.string(), {
  decode: redactGitUrlSecrets,
  encode: redactGitUrlSecrets
})

/** Where the agent runs (inline; path is daemon-generated). Mirrors protocol AgentWorkspace.
 *  Reused as the response shape inside `AgentDto` — new fields round-trip automatically. */
export const AgentWorkspaceBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('scratch') }),
  z.object({
    mode: z.literal('github'),
    gitRepo: GitRepoOutput,
    gitBranch: z.string().optional(),
    agentDir: z.string().optional(),
    // github-app credential mode: the GithubInstallation picked in the console
    // repo picker. Provenance hint (minting re-resolves live by repo owner);
    // absent ⇒ anonymous git (public repos, pre-github-app behavior).
    installationId: z.string().uuid().optional(),
    // Ceiling for minted tokens; only meaningful with installationId. Default 'write' —
    // coding agents push branches; the console offers a read-only toggle.
    gitAccess: z.enum(['read', 'write']).optional()
  })
])

function normalizeAgentDir(value: string, ctx: z.RefinementCtx): string | undefined {
  try {
    return normalizeRepoSubdir(value)
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof RepoSubdirError ? err.message : 'invalid working subdirectory'
    })
    return undefined
  }
}

function normalizeAgentGitRepo(value: string, ctx: z.RefinementCtx): string {
  try {
    return normalizeGitCloneUrl(value)
  } catch (err) {
    if (!(err instanceof GitCloneUrlError)) throw err
    // Deliberately do not include the supplied URL or the thrown message: URL
    // userinfo/query fields may contain a credential.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'gitRepo must be a credential-free HTTPS or SSH repository URL, or owner/repo shorthand'
    })
    return z.NEVER
  }
}

// `.max` before the transform: zod runs checks in order, so an oversized value is
// rejected without normalization ever scanning it.
const GitRepoInput = z.string().min(1).max(MAX_GIT_REPO_LENGTH).transform(normalizeAgentGitRepo)
const AgentDirCreateInput = z.string().transform(normalizeAgentDir)
const AgentDirPatchInput = z
  .union([z.string(), z.null()])
  .transform((value, ctx) => (value === null ? null : (normalizeAgentDir(value, ctx) ?? null)))

/** Input-only workspace shape. Responses stay lenient for historical agentDir rows. */
const AgentWorkspaceInputBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('scratch') }),
  z.object({
    mode: z.literal('github'),
    gitRepo: GitRepoInput,
    gitBranch: z.string().optional(),
    agentDir: AgentDirCreateInput.optional(),
    installationId: z.string().uuid().optional(),
    gitAccess: z.enum(['read', 'write']).optional()
  })
])

// Agent `name` is a slug: lowercase letters/digits/hyphens, no leading/trailing
// or consecutive hyphens (e.g. "acme-network-bot"). The console derives it
// from `displayName`; the CP only validates + dedups ((orgId, name) unique).
const AgentSlug = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'name must be a slug: lowercase letters, digits, and single hyphens')
  // Preset-agent slugs are not impersonable (preset-agents.md §3.3): provisioning
  // writes them through its own seam, never this DTO, and existing rows are
  // grandfathered (this validation is create-time only; the slug is immutable).
  .refine((s) => !RESERVED_AGENT_SLUGS.has(s), 'this name is reserved for AgentConnect built-in agents')

/** A legal environment-variable name — the daemon passes these to the spawned ACP child. */
const ENV_VAR_NAME = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid env var name')
/** Extra env injected into the runtime (AgentSpec.env), replaced wholesale. */
const AgentEnvBody = z.record(ENV_VAR_NAME, z.string())
/** Secret env vars, INITIAL set (create only). Values are write-only — the DTO
 *  returns only their key names. See {@link AgentSecretsPatchBody} for the edit shape. */
const AgentSecretsCreateBody = z.record(ENV_VAR_NAME, z.string())
/** Secret env vars, PATCH shape. Unlike `env` (replaced wholesale), secrets are
 *  merged key-by-key because the client never holds the existing values: a string
 *  sets/replaces that secret, `null` deletes it, and an omitted key is left as-is. */
const AgentSecretsPatchBody = z.record(ENV_VAR_NAME, z.string().nullable())
const McpServerNamesBody = z.array(
  z
    .string()
    .min(1)
    .refine((n) => n !== RESERVED_MCP_SERVER_NAME, { message: `"${RESERVED_MCP_SERVER_NAME}" is reserved` })
)
// A skills-source name: the org-unique reference key AND the prefix of the
// "<source>/<skill>" enable-ref, so it must be slash-free (a "/" would corrupt
// parseSkillRef) and free of whitespace/wildcards.
const SKILL_SOURCE_NAME = /^[A-Za-z0-9._-]+$/
const SkillSourceName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(SKILL_SOURCE_NAME, { message: 'name may contain only letters, digits, dot, underscore, or hyphen' })

// A skill name that becomes a `-s <name>` argument to `npx skills`. It must NOT
// start with "-" (that would be read as a flag rather than a value), so the first
// char is constrained to letters/digits/dot/underscore.
const SkillFilterName = z
  .string()
  .regex(/^[A-Za-z0-9._][A-Za-z0-9._-]*$/, { message: 'skill name may not start with "-"' })

// A source string that becomes a positional argument to `npx skills add`. Reject
// option-looking values for the same reason.
//
// Also reject secret carriers. A skill source is org metadata: it travels inline on
// every referring AgentSpec and is shown next to the agents that install it (see
// shared-skills.md), so it must never hold a credential — a private repo needs a
// real grant, which this release does not have, and create already rejects a
// confirmed private repo. Two forms are refused:
//
//   - userinfo — `https://<token>@host/repo`, `https://user:pw@host/repo`. The
//     authority match is greedy so `user:p@ss@host` is caught by its LAST `@`. The
//     scp-like `git@github.com:owner/repo` form has no `://` and is unaffected;
//     `ssh://git@host/repo` names a ROLE, so colon-free userinfo stays allowed there.
//   - query/fragment — `?access_token=…`, `#…`. `npx skills` has no use for either,
//     and both are places a token hides in plain sight.
const SkillSourceArg = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !s.startsWith('-'), { message: 'source must not start with "-"' })
  .refine((s) => !s.includes('?') && !s.includes('#'), {
    message: 'source must not carry a query or fragment; they can hide a credential'
  })
  .refine(
    (s) => {
      const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/]*)@/.exec(s)
      if (!m) return true
      return !s.toLowerCase().startsWith('http') && !m[1]!.includes(':')
    },
    { message: 'source must not embed credentials; use a public repository' }
  )

// Enabled shared-skills (docs/designs/shared-skills.md): each entry is
// "<sourceName>/<skillName>", "<sourceName>/*" (the whole source), or a bare
// "<sourceName>". The source segment mirrors SkillSourceName; the skill segment
// forbids a leading "-" (SkillFilterName grammar) so it can't inject a CLI flag.
const SkillEnableBody = z.array(
  z.string().regex(/^[A-Za-z0-9._-]+(\/([A-Za-z0-9._][A-Za-z0-9._-]*|\*))?$/, {
    message: 'must be "<source>", "<source>/<skill>", or "<source>/*" (skill may not start with "-")'
  })
)
// Memory backend selection (design: docs/designs/memory-evolution.md). External
// carries only a connection reference + product policy; credentials and plugin
// transport stay on the daemon-private connection data plane.
const MemoryConfigBody = AgentMemoryBinding

// Console avatar (docs: the "Agent Avatar" picker), INPUT shape (create/update body).
// Only `runtime` and `glyph` are settable via a JSON body — the glyph color is
// validated `#rrggbb` here because it is inlined into SVG `fill=` at the icon
// endpoint. `image` is NOT accepted: an uploaded avatar is set exclusively by the
// icon upload route (it carries bytes), so a body can never assert `{kind:'image'}`.
export const AgentIconBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runtime') }),
  z.object({ kind: z.literal('glyph'), glyph: z.enum(AGENT_ICON_GLYPHS), color: z.string().regex(HEX_COLOR_RE) })
])

// The OUTPUT shape a stored icon can take — adds `image` (an uploaded avatar whose
// bytes live in the object store; the display URL is the sibling DTO `iconUrl`).
export const AgentIconDto = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runtime') }),
  z.object({ kind: z.literal('glyph'), glyph: z.enum(AGENT_ICON_GLYPHS), color: z.string().regex(HEX_COLOR_RE) }),
  z.object({ kind: z.literal('image') })
])

export const CreateAgentBody = z.object({
  name: AgentSlug,
  displayName: z.string().min(1).optional(),
  icon: AgentIconBody.optional(), // absent ⇒ the CP assigns a random glyph+color
  description: z.string().optional(),
  runtime: z.string().min(1),
  model: z.string().optional(),
  reasoningEffort: z.string().min(1).optional(),
  outputMode: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(), // platform output verbosity ('none' = session-only)
  showFooter: z.boolean().optional(), // attribution/session footer (absent ⇒ default true)
  fastMode: z.boolean().optional(), // runtime fast mode toggle
  permissionMode: z.string().min(1).optional(), // runtime permission/approval mode
  allowRuntimeChangesInChat: z.boolean().optional(), // explicit opt-in; absent ⇒ false
  pause: z.boolean().optional(), // operational message-processing toggle (#288)
  introduceOnJoin: z.boolean().optional(), // #536: self-introduce to peers on a genuine channel join
  restrictFileAccess: z.boolean().optional(), // #642: request an OS sandbox (absent ⇒ default false)
  env: AgentEnvBody.optional(),
  secrets: AgentSecretsCreateBody.optional(), // write-only secret env vars (values never returned)
  // Names of daemon-configured MCP servers to attach at session/new; the daemon
  // resolves them to definitions locally. Absent/empty ⇒ none. The bridge name
  // is rejected here so a misconfiguration fails at the API, not as a daemon warn.
  mcpServers: McpServerNamesBody.optional(),
  skills: SkillEnableBody.optional(),
  memory: MemoryConfigBody.optional(), // memory backend; absent ⇒ managed default
  daemonId: z.string().optional(), // the owning daemon, if chosen at create
  workspace: AgentWorkspaceInputBody.optional(), // absent ⇒ scratch; the cold editor can replace either mode later
  capabilities: z.array(z.string()).default([]),
  // Initial visibility (absent ⇒ 'org', visible to all members); `sharedWith` is
  // intersected with current org members in the route. Lets a create be restricted
  // in one call instead of create-then-share.
  visibility: ResourceVisibilityEnum.optional(),
  sharedWith: z.array(z.string()).optional(),
  // Initial agent-call policy (absent ⇒ 'all'); `allowedCallerAgentIds` is
  // intersected with visible same-org peers in the route (same rule as the
  // dedicated call-policy PUT). Lets a create restrict callers in one request.
  callPolicy: AgentCallPolicyEnum.optional(),
  allowedCallerAgentIds: z.array(z.string().uuid()).optional(),
  // Outbound half of the same policy (absent ⇒ 'all'), intersected the same way.
  outboundPolicy: AgentCallPolicyEnum.optional(),
  allowedTargetAgentIds: z.array(z.string().uuid()).optional()
})

/** `PATCH /agents/:id` — edit the spec; pushes `agent/upsert` if the daemon is connected.
 *  `name` (the slug) is IMMUTABLE — it is not accepted here; `.strict()` rejects it (and
 *  any other unknown field) with 400. Workspace conversion is a separate cold action. */
export const UpdateAgentBody = z
  .object({
    displayName: z.string().min(1).nullable().optional(),
    icon: AgentIconBody.nullable().optional(), // null clears back to the runtime-mark default
    description: z.string().nullable().optional(),
    runtime: z.string().min(1).optional(),
    capabilities: z.array(z.string()).optional(),
    model: z.string().nullable().optional(),
    reasoningEffort: z.string().min(1).nullable().optional(),
    outputMode: z.enum(['none', 'minimal', 'low', 'medium', 'high']).nullable().optional(),
    showFooter: z.boolean().optional(),
    fastMode: z.boolean().nullable().optional(),
    permissionMode: z.string().min(1).nullable().optional(),
    allowRuntimeChangesInChat: z.boolean().optional(),
    pause: z.boolean().nullable().optional(), // operational toggle (#288); null clears
    introduceOnJoin: z.boolean().optional(), // #536: self-introduce to peers on a genuine channel join
    restrictFileAccess: z.boolean().optional(), // #642: request an OS sandbox for this agent
    // Same-repository capability widening only. Workspace identity/conversion
    // stays on the dedicated cold action, and downgrades are deliberately not
    // exposed here because enabled review hooks may depend on write access.
    gitAccess: z.literal('write').optional(),
    agentDir: AgentDirPatchInput.optional(), // GitHub-only ACP cwd; null/root sentinel clears to repo root
    env: AgentEnvBody.nullable().optional(), // replaced wholesale; null clears
    // Merged key-by-key (NOT wholesale): string sets/replaces a secret, null deletes
    // it, an omitted key is left untouched — the client never holds existing values.
    secrets: AgentSecretsPatchBody.optional(),
    mcpServers: McpServerNamesBody.nullable().optional(), // replaced wholesale; null clears
    skills: SkillEnableBody.nullable().optional(), // enabled skills; replaced wholesale; null clears
    memory: MemoryConfigBody.nullable().optional() // memory backend; null clears (revert to managed)
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'no fields to update' })

/** Explicit cold placement move. Kept separate from spec PATCH because it
 * drains one daemon, reprovisions another, and does not migrate local state. */
export const SetAgentDaemonBody = z.object({ daemonId: z.string().uuid() }).strict()

/** Full desired workspace definition for the acknowledged cold edit path. */
export const SetAgentWorkspaceBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('scratch') }).strict(),
  z
    .object({
      mode: z.literal('github'),
      repoFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repoFullName must be owner/repo'),
      gitBranch: z.string().min(1).optional(),
      agentDir: AgentDirCreateInput.optional(),
      gitAccess: z.enum(['read', 'write']).default('read')
    })
    .strict()
])

export const AgentDto = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  displayName: z.string().nullable(),
  /** True for a built-in preset agent (preset-agents.md §3): the console shows a
   *  "builtin" label and the CP refuses to delete it. */
  builtin: z.boolean(),
  icon: AgentIconDto.nullable(), // console avatar; null ⇒ legacy default (runtime mark)
  // Resolved absolute URL for an uploaded `image` icon (object-store public URL,
  // cache-busted). Null for glyph/runtime (the console renders those locally) and
  // when no object store is configured. Distinct from the daemon-facing AgentSpec.iconUrl.
  iconUrl: z.string().nullable(),
  description: z.string().nullable(),
  /** Null ⇒ deferred exec config (an unplaced preset, preset-agents.md §3.2):
   *  the console renders "—" and choosing a runtime happens at placement. */
  runtime: z.string().nullable(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  outputMode: z.string().nullable(),
  showFooter: z.boolean(),
  fastMode: z.boolean().nullable(), // null ⇒ never set (runtime default)
  permissionMode: z.string().nullable(), // null ⇒ never set (runtime default)
  allowRuntimeChangesInChat: z.boolean(),
  pause: z.boolean().nullable(), // null ⇒ not paused (#288)
  env: z.record(z.string(), z.string()),
  // Names of the agent's write-only secret env vars, sorted. Values are NEVER
  // returned — set/replace them via the PATCH `secrets` body; the console masks them.
  secretKeys: z.array(z.string()),
  mcpServers: z.array(z.string()), // enabled daemon-configured MCP server names ([] ⇒ none)
  skills: z.array(z.string()), // enabled shared-skills "<source>/<skill>" / "<source>/*" ([] ⇒ none)
  memory: MemoryConfigBody.nullable(), // memory backend (null ⇒ managed default)
  status: z.string(),
  daemonId: z.string().nullable(),
  workspace: AgentWorkspaceBody,
  /** Rename-proof numeric identity of the GitHub workspace repository. Null
   * for scratch/anonymous or legacy rows that have not been repaired yet. */
  workspaceRepoId: z.string().nullable(),
  capabilities: z.array(z.string()),
  createdAt: z.string(), // ISO-8601
  createdBy: z.string().nullable(), // creator's userId (web resolves to a name / "You"); null for daemon/CLI-created
  lastModifiedAt: z.string(), // ISO-8601; last human edit, defaults to createdAt
  lastModifiedBy: z.string().nullable(), // editor's userId (web resolves to a name / "You"); null for daemon/CLI-created
  // ── visibility / sharing (docs/designs/resource-visibility.md) ──
  visibility: ResourceVisibilityEnum,
  sharedWith: z.array(z.string()), // app_user.id set (only meaningful when restricted)
  canManageSharing: z.boolean(), // whether the CALLER can edit this agent (= canEdit); gates sharing and call-policy controls
  callPolicy: AgentCallPolicyEnum, // which peer agents may call this agent as a sub-agent
  allowedCallerAgentIds: z.array(z.string()), // agent.id set, meaningful when callPolicy='selected'
  outboundPolicy: AgentCallPolicyEnum, // which peer agents this agent may discover/call
  allowedTargetAgentIds: z.array(z.string()), // agent.id set, meaningful when outboundPolicy='selected'
  introduceOnJoin: z.boolean(), // #536: self-introduce to peers on a genuine channel join
  restrictFileAccess: z.boolean(), // #642: persisted per-agent sandbox preference (default false)
  // #642: whether the placed daemon can enforce the preference. false ⇒ the
  // console renders Run in sandbox unavailable and the effective value is false.
  sandboxSupported: z.boolean(),
  // #642: daemon policy forces the effective value true and makes it immutable.
  sandboxRequired: z.boolean(),
  // Distinct kinds of ENABLED inbound triggers (hooks) on this agent — the list
  // view's integrations cell renders a mark per kind (github repo subscriptions,
  // generic webhooks) without an org-wide hook list existing anywhere.
  hookKinds: z.array(z.enum(['webhook', 'github']))
})
export const AgentListDto = z.array(AgentDto)

/** Live, daemon-owned approval queue exposed only to editors of the Agent. */
export const AgentPermissionRequestDto = AgentPermissionRequestRecord
export const AgentPermissionRequestPageDto = z.object({ requests: z.array(AgentPermissionRequestDto) })
export const AgentPermissionDecisionBody = z.object({ decision: z.enum(['allow', 'deny']) }).strict()

/** Agent-create response; includes a daemon `connect` block when `?connect=true`. */
export const AgentCreatedDto = AgentDto.extend({
  connect: DaemonConnectDto.optional()
})

// ── bots + integrations ─────────────────────────────────────────────────────
/**
 * `POST /integrations` — install a bot on an agent. Two shapes for the bot
 * identity: reuse an existing free bot (`botId`), or register a new one from
 * pasted Slack tokens (`slack`). Tokens go in, never come back.
 */
export const CreateIntegrationBody = z
  .object({
    // Optional — the app already has a name; when omitted the CP derives it from the
    // platform (Slack auth.test / Telegram getMe), falling back to the owning agent's
    // name. Ignored when reusing an existing bot (the bot keeps its name).
    name: z.string().min(1).optional(),
    platform: z.enum(['slack', 'telegram', 'discord', 'feishu']),
    agentId: z.string().min(1), // owner ⇒ delivery daemon; must be placed on a daemon
    /** Reuse an existing bot. A CLASSIC bot must be free; a SHAREABLE bot may
     *  already serve other agents (this adds one more, shared-bot-relay.md §4.1). */
    botId: z.string().min(1).optional(),
    /** Opt the (new or reused) bot into multi-agent shared mode (default false).
     *  Requires `transport: 'http'` (a socket bot is single-agent). */
    shareable: z.boolean().optional(),
    /** Slack inbound transport (slack-http-mode): 'socket' ⇒ daemon-owned Socket
     *  Mode (needs appToken); 'http' ⇒ relay-pool Events API ingress (needs
     *  signingSecret). Default 'socket'. */
    transport: z.enum(['socket', 'http']).optional(),
    /** Register a new Slack bot from its tokens. Socket transport needs the
     *  app-level token (Socket Mode); http transport needs the signing secret
     *  (Events API request verification). */
    slack: z
      .object({
        botToken: z.string().min(1),
        appToken: z.string().min(1).optional(),
        signingSecret: z.string().min(1).optional()
      })
      .optional(),
    /** Register a new Telegram bot from its BotFather token (single token). */
    telegram: z
      .object({
        botToken: z.string().min(1)
      })
      .optional(),
    /** Register a new Discord bot from its Gateway bot token (single token). The
     *  optional applicationId is the public client id for the invite URL. */
    discord: z
      .object({
        botToken: z.string().min(1),
        applicationId: z.string().min(1).optional()
      })
      .optional(),
    /** Register a new Feishu / Lark self-built app from its appId + appSecret pair.
     *  `region` picks the open-platform gateway (feishu.cn vs larksuite.com); it
     *  defaults to international Lark for new create requests. */
    feishu: z
      .object({
        appId: z.string().min(1),
        appSecret: z.string().min(1),
        region: FeishuRegion.default('lark')
      })
      .optional()
  })
  .superRefine((b, ctx) => {
    // The credential object for the chosen platform (else reuse an existing bot).
    const creds =
      b.platform === 'slack'
        ? b.slack
        : b.platform === 'telegram'
          ? b.telegram
          : b.platform === 'discord'
            ? b.discord
            : b.feishu
    if ((b.botId !== undefined) === (creds !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `exactly one of botId or ${b.platform} must be provided`
      })
    }
    // Guard against a mismatched credential block (e.g. platform:'telegram' + slack:{…}).
    const wrong: Array<'slack' | 'telegram' | 'discord' | 'feishu'> = (
      ['slack', 'telegram', 'discord', 'feishu'] as const
    ).filter((p) => p !== b.platform && b[p] !== undefined)
    for (const p of wrong)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${p} credentials given for a ${b.platform} integration` })
    // `shareable` is an http-only sub-flag, but it degrades gracefully rather than
    // erroring: the console hides the toggle for socket, and `installNewSlackBot`
    // coerces it off for a non-http bot (so a socket bot can never become shareable).
    // No validation needed here.
    // Per-transport Slack credential requirements (only when registering a NEW bot).
    if (b.platform === 'slack' && b.botId === undefined && b.slack) {
      if (b.transport === 'http') {
        if (!b.slack.signingSecret)
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'http transport requires slack.signingSecret' })
      } else if (!b.slack.appToken) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'socket transport requires slack.appToken' })
      }
    }
  })

/** One conversation the integration's bot is in + how it activates there.
 *  `off` = conversation gating (resource-visibility.md §14): the agent does not
 *  activate there — the default for every conversation of a restricted agent.
 *  `kind: 'im'` rows are DM conversations and `kind: 'mpim'` rows are Slack group
 *  DMs (both gated integrations only — neither is ever enumerated). */
export const IntegrationChannelDto = z.object({
  channelId: z.string(),
  name: z.string().nullable(), // "#deploys" without the hash (or DM counterpart); null if lookup failed
  /** Enclosing space (Discord server) — one bot spans several servers, each with its
   *  own "#general". `spaceId` is the identity the console groups on (two servers may
   *  share a name); `space` is the label. Null on single-container platforms, on DMs,
   *  and until resolved. */
  spaceId: z.string().nullable(),
  space: z.string().nullable(),
  isPrivate: z.boolean(),
  kind: z.enum(['channel', 'im', 'mpim']),
  trigger: z.enum(['off', 'mention', 'any']),
  /** Effective per-channel owner for a shared bot (§10.1); null before convergence
   *  or when ownership does not apply. */
  agentId: z.string().nullable()
})

/** Console view of an integration — metadata only, NEVER the tokens. */
export const IntegrationDto = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  agentId: z.string(),
  botId: z.string(),
  status: z.string(),
  region: FeishuRegion.optional(), // feishu integrations only: 'feishu' | 'lark' gateway
  createdAt: z.string(), // ISO-8601
  channels: z.array(IntegrationChannelDto)
})
export const IntegrationListDto = z.array(IntegrationDto)

// ── MCP providers (centralized-tool-management.md §4-§7) ─────────────────────
/** One upstream auth header the CP injects on the relay's outbound call. The VALUE
 *  is a secret (apikey etc.) — it goes in on create/update and NEVER comes back
 *  (the DTO exposes only the header names).
 *
 *  The `x-oomol-connector-*` names are RESERVED: they mark an open_connector binding at
 *  the relay (which selects the synthesized-MCP + open-connector-egress path from headers
 *  alone), so a `custom` provider must not be able to carry them — otherwise it could
 *  impersonate an open_connector binding and reach that path with an attacker-chosen
 *  service/profile. The connectors route sets them server-side; this edge rejects them. */
const McpHeaderBody = z.object({
  name: z
    .string()
    .min(1)
    .max(256)
    .refine((n) => !/^x-oomol-connector-/i.test(n), { message: 'header name "x-oomol-connector-*" is reserved' }),
  value: z.string().min(1)
})

/** `POST /mcp-providers` — register an org-level upstream MCP server. v1 accepts
 *  `transport:'http'` and `visibility:'org'` only (the route 400s anything else);
 *  the `url` passes a static SSRF gate. Header values go in, never come back. */
export const CreateMcpProviderBody = z
  .object({
    // Reject the reserved bridge name here too (symmetry with the agent enable-list),
    // so a provider that could never be enabled/pushed can't be created either.
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((n) => n !== RESERVED_MCP_SERVER_NAME, { message: `"${RESERVED_MCP_SERVER_NAME}" is reserved` }),
    url: z.string().min(1),
    transport: z.enum(['http', 'sse']).optional(), // v1: http only (route rejects sse)
    // Initial console visibility (absent ⇒ 'org', visible to all members); `sharedWith`
    // is intersected with current org members and only meaningful when 'restricted'.
    visibility: ResourceVisibilityEnum.optional(),
    sharedWith: z.array(z.string()).optional(),
    headers: z.array(McpHeaderBody).max(50).default([])
  })
  .strict()

/** `PATCH /mcp-providers/:id` — edit url / upstream headers. At least one field.
 *  `headers` REPLACES the stored set wholesale. Name, transport, and visibility are
 *  immutable through this surface: agents bind a provider by NAME and there is no
 *  atomic rename (it would orphan every agent's stored selection + the pushed daemon
 *  def), so v1 fixes the name at create — recreate under a new name to change it. */
export const UpdateMcpProviderBody = z
  .object({
    url: z.string().min(1).optional(),
    headers: z.array(McpHeaderBody).max(50).optional()
  })
  .strict()
  .refine((b) => b.url !== undefined || b.headers !== undefined, {
    message: 'no fields to update'
  })

/** Console view of an MCP provider — metadata + the upstream header NAMES only.
 *  NEVER the header values and NEVER the grant key. */
export const McpProviderDto = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(), // 'custom' | 'open_connector'
  transport: z.string(),
  url: z.string(),
  // Open-connector service slug (e.g. "stripe") for kind='open_connector' — the
  // non-secret binding marker, surfaced so the console can show the provider's icon.
  service: z.string().optional(),
  visibility: z.string(), // 'org' | 'restricted'
  sharedWith: z.array(z.string()), // app_user.id set (only meaningful when restricted)
  createdBy: z.string().nullable(), // creator userId (pins the non-removable share chip); null when unknown
  canManageSharing: z.boolean(), // whether THIS caller may change the provider's sharing
  headerNames: z.array(z.string()), // upstream auth header keys; values are secret and never returned
  createdAt: z.string() // ISO-8601
})
export const McpProviderListDto = z.array(McpProviderDto)
export type McpProviderDtoT = z.infer<typeof McpProviderDto>

/** `POST /mcp-providers` response — the provider plus its freshly-minted grant key,
 *  returned EXACTLY ONCE (like a personal API key). Never retrievable on later reads. */
export const McpProviderCreatedDto = McpProviderDto.extend({
  grantKey: z.string()
})

// ── shared-skills sources (docs/designs/shared-skills.md) ────────────────────

/** `POST /skill-sources` — register an org-level skills source. `source` is the
 *  string handed to `npx skills add` (owner/repo | git URL | tree/<ref>/<subdir>).
 *  `skills` empty ⇒ install every skill the source exposes. */
export const CreateSkillSourceBody = z
  .object({
    name: SkillSourceName,
    source: SkillSourceArg,
    githubRepoId: z.string().optional(), // numeric id as string (BigInt on the wire)
    ref: z.string().trim().optional(),
    subDir: z.string().trim().optional(),
    skills: z.array(SkillFilterName).default([]),
    visibility: ResourceVisibilityEnum.optional(),
    sharedWith: z.array(z.string()).optional()
  })
  .strict()

/** `PATCH /skill-sources/:id` — edit source/ref/subDir/skill filter. At least one
 *  field. `skills` REPLACES the stored filter wholesale. Name is immutable (agents
 *  bind by name); recreate under a new name to rename. */
export const UpdateSkillSourceBody = z
  .object({
    source: SkillSourceArg.optional(),
    githubRepoId: z.string().nullable().optional(),
    ref: z.string().trim().nullable().optional(),
    subDir: z.string().trim().nullable().optional(),
    skills: z.array(SkillFilterName).optional()
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no fields to update' })

/** `POST /skill-sources/preview` — best-effort GitHub scan for the import dialog.
 *  Takes an installation + repo (same shape as the branches picker) and returns the
 *  ref choices + the SKILL.md manifest. Scan failure ⇒ empty skills (install all). */
export const PreviewSkillSourceBody = z
  .object({
    installationId: z.string(),
    owner: z.string().min(1),
    repo: z.string().min(1),
    ref: z.string().optional()
  })
  .strict()

export const SkillSourcePreviewDto = z.object({
  branches: z.array(z.string()),
  tags: z.array(z.string()),
  skills: z.array(z.object({ name: z.string(), dirPath: z.string() }))
})

/** `GET /skill-sources/:id/skills` — the source's discovered SKILL.md manifest for
 *  the agent editor's per-skill picker. Best-effort: `resolvable:false` (empty
 *  skills) when the source isn't a scannable GitHub repo or no installation covers
 *  it, so the UI falls back to whole-source enablement. */
export const SkillSourceSkillsDto = z.object({
  resolvable: z.boolean(),
  skills: z.array(z.object({ name: z.string(), dirPath: z.string() }))
})

/** Console view of a skills source — pure metadata (nothing secret). */
export const SkillSourceDto = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  githubRepoId: z.string().nullable(), // BigInt rendered as string
  ref: z.string().nullable(),
  subDir: z.string().nullable(),
  skills: z.array(z.string()), // the source's own skill filter ([] ⇒ all)
  visibility: z.string(), // 'org' | 'restricted'
  sharedWith: z.array(z.string()),
  createdBy: z.string().nullable(),
  canManageSharing: z.boolean(),
  createdAt: z.string() // ISO-8601
})
export const SkillSourceListDto = z.array(SkillSourceDto)
export type SkillSourceDtoT = z.infer<typeof SkillSourceDto>

/** `GET /agents/:id/skill-sources` — the registry rows this agent's enable-list
 *  actually references, resolved for anyone who can view the AGENT rather than the
 *  source. What an agent already installs is part of the agent (the definition
 *  rides inline on its AgentSpec either way), so a source restricted away from the
 *  caller still resolves here — otherwise the console can only show a bare name.
 *  Slimmer than {@link SkillSourceDto}: no visibility/share fields, since seeing an
 *  agent does not entitle the caller to the source's own share set. */
export const AgentSkillSourceDto = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  ref: z.string().nullable(),
  subDir: z.string().nullable(),
  skills: z.array(z.string()) // the source's own skill filter ([] ⇒ all)
})
export const AgentSkillSourceListDto = z.array(AgentSkillSourceDto)

// ── open-connector connectors (docs: connectors integration) ─────────────────
/** Whether the open-connector integration is configured on this CP (drives the
 *  console's "Add connectors" menu item). */
export const ConnectorsConfigDto = z.object({ enabled: z.boolean() })

/** One browsable open-connector provider. `auth` is passed through verbatim (the
 *  console's new-connection form reads its per-method credential-field shape), and
 *  `actions` are stripped upstream to keep the (potentially ~1k-entry) catalog lean. */
export const ConnectorProviderDto = z.object({
  service: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  categories: z.array(z.string()),
  authTypes: z.array(z.string()),
  auth: z.array(z.unknown()),
  homepageUrl: z.string().optional(),
  iconUrl: z.string().optional()
})
export const ConnectorCatalogDto = z.object({ providers: z.array(ConnectorProviderDto) })

/** `POST /connectors/connections` — create a new open-connector connection. The CP
 *  namespaces it as an open-connector connection PROFILE and records it as an
 *  `open_connector` MCP provider named `connectionName` (org-unique). */
export const CreateConnectorConnectionBody = z
  .object({
    service: z.string().min(1),
    // The org-unique connection name — also the MCP provider `name`. Restricted so the
    // composed open-connector profile `<org8>--<user8>--<name>` fits its 64-char limit.
    connectionName: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'letters, digits, _ or - only; must start alphanumeric'),
    authType: z.enum(['oauth2', 'api_key', 'custom_credential', 'no_auth']),
    values: z.record(z.string(), z.string()).optional(),
    // Initial console visibility of the recorded open_connector provider (absent ⇒ 'org');
    // `sharedWith` is intersected with current org members and only bites when 'restricted'.
    visibility: ResourceVisibilityEnum.optional(),
    sharedWith: z.array(z.string()).optional()
  })
  .strict()

/** `POST /connectors/connections` response — the created MCP provider (+ grant key
 *  once), plus an `authorizationUrl` to open in a popup when authType is oauth2. */
export const ConnectorConnectionCreatedDto = McpProviderCreatedDto.extend({
  authorizationUrl: z.string().optional()
})

/** `POST /connectors/connections/:id/reconnect` — re-run authorization / re-save
 *  credentials for an EXISTING open_connector connection (its OAuth token expired or
 *  was revoked, or the api-key rotated upstream). Only the upstream credential is
 *  refreshed; the provider row, grant key, and relay binding are untouched — so unlike
 *  create there is no connectionName/visibility here. `values` is required for the
 *  credential auth types and ignored for oauth2/no_auth. */
export const ReconnectConnectorConnectionBody = z
  .object({
    authType: z.enum(['oauth2', 'api_key', 'custom_credential', 'no_auth']),
    values: z.record(z.string(), z.string()).optional()
  })
  .strict()

/** `POST /connectors/connections/:id/reconnect` response — an `authorizationUrl` to
 *  open in a popup when authType is oauth2; empty for the credential auth types. */
export const ReconnectConnectorConnectionDto = z.object({
  authorizationUrl: z.string().optional()
})

// ── External-memory plugin control plane (memory-evolution M-5A) ──

export const MemoryPluginSecretHeaderBody = z
  .object({
    name: z.string().min(1).max(128),
    header: z.string().min(1).max(128),
    required: z.boolean().default(true)
  })
  .strict()

export const CreateMemoryPluginInstallationBody = z
  .object({
    pluginId: z
      .string()
      .max(255)
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/, 'pluginId must be reverse-DNS-like'),
    transport: z.enum(['streamable-http', 'stdio']).default('streamable-http'),
    endpoint: z.string().max(2048).url().optional(),
    commandRef: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'commandRef must be an operator allowlist key')
      .optional(),
    pinnedProfileMajor: z.literal(1).default(1),
    expectedManifestDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    secretHeaders: z.array(MemoryPluginSecretHeaderBody).max(64).default([])
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.transport === 'streamable-http' && !body.endpoint) {
      ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'a remote installation requires endpoint' })
    }
    if (body.transport === 'streamable-http' && body.commandRef) {
      ctx.addIssue({ code: 'custom', path: ['commandRef'], message: 'a remote installation cannot set commandRef' })
    }
    if (body.transport === 'stdio' && !body.commandRef) {
      ctx.addIssue({ code: 'custom', path: ['commandRef'], message: 'a stdio installation requires commandRef' })
    }
    if (body.transport === 'stdio' && body.endpoint) {
      ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'a stdio installation cannot set endpoint' })
    }
  })

export const MemoryPluginInstallationDto = z.object({
  id: z.string().uuid(),
  pluginId: z.string(),
  transport: z.enum(['streamable-http', 'stdio']),
  endpoint: z.string().nullable(),
  commandRef: z.string().nullable(),
  pinnedProfileMajor: z.literal(1),
  expectedManifestDigest: z.string().nullable(),
  secretHeaders: z.array(MemoryPluginSecretHeaderBody),
  createdBy: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})
export const MemoryPluginInstallationListDto = z.array(MemoryPluginInstallationDto)
export type MemoryPluginInstallationDtoT = z.infer<typeof MemoryPluginInstallationDto>

const ExternalMemorySecretsBody = z.record(
  z.string().min(1).max(128),
  z
    .string()
    .min(1)
    .max(16 * 1024)
)

export const CreateExternalMemoryConnectionBody = z
  .object({
    installationId: z.string().uuid(),
    config: z.record(z.string(), z.unknown()).default({}),
    secrets: ExternalMemorySecretsBody.default({})
  })
  .strict()

export const UpdateExternalMemoryConnectionBody = z
  .object({
    config: z.record(z.string(), z.unknown()).optional(),
    // Replaces the complete logical secret set; omitted leaves it unchanged.
    secrets: ExternalMemorySecretsBody.optional()
  })
  .strict()
  .refine((body) => body.config !== undefined || body.secrets !== undefined, { message: 'no fields to update' })

export const ExternalMemoryConnectionDto = z.object({
  id: z.string().uuid(),
  installationId: z.string().uuid(),
  config: z.record(z.string(), z.unknown()),
  secretKeys: z.array(z.string()),
  status: z.enum(['probing', 'ready', 'degraded', 'invalid']),
  revision: z.number().int().positive(),
  probedRevision: z.number().int().positive().nullable(),
  pluginVersion: z.string().nullable(),
  profile: z.string().nullable(),
  manifestDigest: z.string().nullable(),
  capabilities: z.record(z.string(), z.unknown()).nullable(),
  declaredEgressHosts: z.array(z.string()),
  reasonCode: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})
export const ExternalMemoryConnectionListDto = z.array(ExternalMemoryConnectionDto)
export type ExternalMemoryConnectionDtoT = z.infer<typeof ExternalMemoryConnectionDto>

// ── Slack config-token auto-install funnel (docs/designs/slack-install-smoothing.md §Tier B) ──

/** `POST /integrations/slack/app` — start the auto-install: the CP creates the app
 *  from a manifest using the ORG's stored App Configuration token (Settings). */
export const SlackAppStartBody = z.object({
  agentId: z.string().min(1), // install target; must be placed on a daemon
  name: z.string().min(1).optional(), // app name; when omitted, derived at finalize
  /** Slack inbound transport (slack-http-mode). 'http' ⇒ the CP builds an Events-API
   *  manifest and captures the signing secret from apps.manifest.create, so finalize
   *  needs no manual paste; 'socket' ⇒ classic Socket Mode (finalize pastes the xapp).
   *  Default 'socket'. (The `shareable` choice rides the finalize body, not this one.) */
  transport: z.enum(['socket', 'http']).optional()
})

/** `PUT /slack/config` — store (or replace) the CALLER's Slack App Configuration token.
 *  The access (config) token (`xoxe.xoxp-…`) is required and enough on its own for
 *  installs while it is fresh (~12h). The refresh token (`xoxe-…`) is OPTIONAL: when
 *  provided the pair auto-rotates so it never expires; when omitted the caller re-enters
 *  the access token once it lapses. */
export const SlackConfigBody = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional()
})

/** `GET /slack/config` — whether the CALLER has stored their own config token, and
 *  whether this deployment can auto-install at all (funnel enabled). NEVER returns
 *  the tokens. Per-user: the status reflects the signed-in caller, not the org. */
export const SlackConfigDto = z.object({
  configured: z.boolean(), // the caller has stored their own token
  /** A refresh token is stored ⇒ the pair auto-rotates and never needs re-entry. When
   *  false, the stored token is access-only and lapses at `accessExpiresAt`. */
  durable: z.boolean(),
  funnelEnabled: z.boolean(), // deployment supports auto-install (public callback)
  /** funnelEnabled AND the stored token is usable right now (durable, or the access
   *  token is still fresh) — drives the modal's forced auto/manual mode. */
  autoAvailable: z.boolean(),
  /** ISO-8601 expiry of the stored access token; drives the "expires / expired" copy
   *  on the config card. Null when unconfigured. (Meaningful mainly when !durable.) */
  accessExpiresAt: z.string().nullable(),
  /** Slack HTTP mode is offerable here: PUBLIC_RELAY_URL is set AND ≥1 relay is
   *  connected to receive the Events API POSTs (slack-http-mode). */
  relayAvailable: z.boolean(),
  /** The relay pool's public HTTPS base (PUBLIC_RELAY_URL, ws→http normalized) —
   *  the console shows the Events API request_url to paste into Slack. Null when
   *  PUBLIC_RELAY_URL is unset. */
  relayPublicUrl: z.string().nullable(),
  /** The platform-published "Add to Slack" app is installable here: SLACK_PLATFORM_*
   *  + PUBLIC_CP_URL are configured AND the relay precondition above holds
   *  (preset-agents.md §5.3). Drives the console's one-click Slack entry. */
  platformInstallAvailable: z.boolean(),
  updatedAt: z.string().nullable() // ISO-8601 of the caller's last save/rotate; null when unconfigured
})

/** Response to a started funnel — the new app id + the browser install link. NEVER tokens. */
export const SlackAppStartDto = z.object({
  installId: z.string(), // opaque pending-session id (doubles as the OAuth state)
  appId: z.string(), // A… — for the app-level-token deep link
  installUrl: z.string(), // Slack OAuth authorize URL the user clicks "Allow" on
  // The transport the app was CREATED as — the console pins its later steps to this
  // (not to a still-editable selector), so a post-start switch can't drive the wrong path.
  transport: z.enum(['socket', 'http'])
})

/** `POST /integrations/slack/platform-install` (preset-agents.md §5.3) — mint a
 *  pending install of the PLATFORM-published Slack app. The target defaults to
 *  the org's `agentconnect` preset agent; an unplaced target is fine (http
 *  delivery converges at placement). */
export const SlackPlatformInstallStartBody = z.object({
  agentId: z.string().uuid().optional()
})

/** The pending platform install: its state id + the slack.com authorize URL. */
export const SlackPlatformInstallStartDto = z.object({
  id: z.string(), // opaque pending-install id (doubles as the OAuth state)
  installUrl: z.string() // https://slack.com/oauth/v2/authorize?… the console opens
})

/**
 * `GET /integrations/slack/platform-install/:id` — the console's completion
 * poll while the Slack authorize tab is open. The row's own terminal state is
 * the signal: a successful RE-authorization of a workspace the agent already
 * has rotates the token WITHOUT creating an integration, so watching the
 * integration list for growth would hang forever on that (common) path.
 */
export const SlackPlatformInstallStatusDto = z.object({
  id: z.string(),
  status: z.enum(['pending', 'completed', 'failed']),
  /** Short code identifying the failure ('denied' | 'expired' | 'workspace_taken' |
   *  'error') — the console renders a message from it. Null unless `failed`. */
  failureReason: z.string().nullable(),
  /** The workspace's bot once completed (console deep-link); null otherwise. */
  botId: z.string().nullable()
})

/** `GET /integrations/slack/app/:installId` — funnel progress poll. NEVER tokens. */
export const SlackAppStatusDto = z.object({
  installId: z.string(),
  appId: z.string(),
  // awaiting_oauth ⇒ user hasn't approved yet; bot_ready ⇒ bot token in hand. For socket
  // the console then pastes the app-level token; for http it finalizes with no paste.
  status: z.enum(['awaiting_oauth', 'bot_ready']),
  transport: z.enum(['socket', 'http'])
})

/** `POST /integrations/slack/app/:installId/finalize`. For SOCKET the CP combines the
 *  operator-pasted app-level token with the OAuth bot token; for HTTP the signing secret
 *  was captured at app-create so `appToken` is not required. `shareable` (http multi-agent)
 *  is re-sent here rather than persisted on the pending row (it isn't secret). */
export const SlackAppFinalizeBody = z.object({
  appToken: z.string().min(1).optional(), // xapp-… — required for socket transport only
  shareable: z.boolean().optional() // http multi-agent opt-in; coerced off for socket
})

/** `PATCH /integrations/:id/channels/:channelId` — per-conversation trigger
 *  ('off' disables the conversation, §14) and/or the shared-bot default agent.
 *  At least one field; an active shared channel always has an owner. */
export const UpdateIntegrationChannelBody = z
  .object({
    trigger: z.enum(['off', 'mention', 'any']).optional(),
    agentId: z.string().min(1).optional()
  })
  .refine((b) => b.trigger !== undefined || b.agentId !== undefined, {
    message: 'provide trigger and/or agentId'
  })

/** `PATCH /bots/:id` — flip the shared-bot opt-in (shared-bot-relay.md §4.1). */
export const UpdateBotBody = z.object({
  shareable: z.boolean()
})

/** Console view of a bot identity — metadata only, NEVER the tokens. */
export const BotDto = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  prebuilt: z.boolean(),
  /** Slack app id (A…) — deep-links "manage / delete the app on Slack" to api.slack.com/apps/{id}. */
  slackAppId: z.string().nullable(),
  /** Discord application (client) id — lets the console build a ready-made "Add to Discord" invite URL. */
  discordAppId: z.string().nullable(),
  createdBy: z.string().nullable(), // creator's userId (web resolves to a name / "You"); null for prebuilt/CLI
  /** Shared-bot (multi-agent) opt-in (§4.1): when true the bot may serve many agents
   *  at once. Only meaningful for `transport: 'http'`. */
  shareable: z.boolean(),
  /** Slack inbound transport (slack-http-mode): 'http' ⇒ relay-pool Events API
   *  ingress; 'socket' ⇒ classic daemon Socket Mode. Immutable post-create. */
  transport: z.enum(['socket', 'http']),
  /** Classic-bot occupancy: the single agent holding it, or null (free). ALWAYS
   *  null for a shareable bot — sharing lifts the 1-install cap. */
  inUseByAgentId: z.string().nullable(),
  /** Every agent currently installed on the bot (a shareable bot may have many). */
  agentIds: z.array(z.string()),
  /** Stamped when the bot was last freed ("last used 12d ago"); null ⇒ never used. */
  lastUsedAt: z.string().nullable(), // ISO-8601
  /** Agent the bot was last freed from ("freed from support-bot"). */
  freedFromAgent: z.string().nullable(),
  /** Slack workspace id (T…) — set for platform-app installs (preset-agents.md §5.3). */
  teamId: z.string().nullable(),
  /** The workspace uninstalled the app / revoked its tokens (`rc/bot-revoked`);
   *  a platform-app re-install clears it. ISO-8601, null ⇒ live. */
  revokedAt: z.string().nullable(),
  createdAt: z.string() // ISO-8601
})
export const BotListDto = z.array(BotDto)

/** `POST /bots/:id/slack/refresh` — outcome of syncing the current AgentConnect
 * manifest into an existing Slack app and checking the workspace installation's
 * actually granted bot scopes. URLs are public Slack settings deep links only. */
export const SlackBotRefreshDto = z.object({
  manifest: z.enum(['synced', 'manual_update_required', 'unknown']),
  authorization: z.enum(['current', 'reinstall_required', 'invalid', 'app_mismatch', 'unknown']),
  missingScopes: z.array(z.string()),
  settingsUrl: z.string(),
  manifestUrl: z.string(),
  /** Slack's OAuth & Permissions editor for changing requested scopes. */
  permissionsUrl: z.string(),
  /** Slack's direct install/reinstall flow for the app. */
  reinstallUrl: z.string()
})

// ── github app (github-app workspaces) ────────────────────────────────────
/** Deployment GitHub App status + the org-bound install deep link. NEVER key material. */
export const GithubAppDto = z.object({
  enabled: z.boolean(),
  /** github.com/apps/<slug>; null when the feature is disabled. */
  slug: z.string().nullable(),
  /** `https://github.com/apps/<slug>/installations/new?state=…` — one-shot, org-bound. */
  installUrl: z.string().nullable()
})

/** One installation of the deployment App, claimed by this org. Infrastructure-class
 *  in the visibility taxonomy (like bots): org-visible, never restricted. */
export const GithubInstallationDto = z.object({
  id: z.string(), // our row id — what an agent references as provenance
  installationId: z.number(), // GitHub-side id (~1e9; well within 2^53)
  accountLogin: z.string(),
  accountType: z.string(), // "Organization" | "User"
  repositorySelection: z.string(), // "all" | "selected"
  suspended: z.boolean(),
  /** GitHub's live verdict for whether this installation has accepted the
   *  App's latest permission set. `unknown` is a transient upstream failure. */
  permissionsStatus: z.enum(['current', 'outdated', 'unknown']),
  /** Installation-effective permission returned by GitHub, independent of the
   * App-level outdated probe. Legacy `{}` is unknown and fails closed. */
  pullRequestsPermission: z.enum(['read', 'write', 'missing', 'unknown']),
  checksPermission: z.enum(['write', 'missing', 'unknown']),
  /** Canonical GitHub installation settings page — GitHub itself enforces who
   *  may approve updated permissions or reinstall the App. */
  settingsUrl: z.string().url(),
  createdAt: z.string() // ISO-8601
})
export const GithubInstallationListDto = z.array(GithubInstallationDto)

/** Repo-picker row (`GET /installation/repositories` passthrough, trimmed). */
export const GithubRepoDto = z.object({
  repoId: z.string(), // GitHub numeric id as a lossless wire string
  fullName: z.string(), // owner/repo
  private: z.boolean(),
  /** Preselect this in the branch picker — never assume 'main'. */
  defaultBranch: z.string(),
  description: z.string().nullable(),
  /** Last push (falls back to updated_at) — the picker's "updated 3d ago" line. */
  updatedAt: z.string().nullable()
})
export const GithubRepoPageDto = z.object({
  repos: z.array(GithubRepoDto),
  /** Total the installation can reach (GitHub `total_count`) — drives pager UI. */
  totalCount: z.number()
})

export const GithubBranchListDto = z.array(z.object({ name: z.string() }))

/** The caller's own effective access to one repo (per-user authz preflight).
 *  Served only when the identity-assertion gate is configured — the console
 *  treats a 404 on this route as "no per-user gating on this deployment". */
export const GithubRepoAccessDto = z.object({
  permission: z.enum(['admin', 'write', 'read', 'none']),
  canRead: z.boolean(),
  canWrite: z.boolean()
})

export const GithubRepoPageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(100)
})

export const GithubOwnerRepoParam = z.object({ id: z.string(), owner: z.string(), repo: z.string() })

// ── agent repo authorizations (issue #457, agent-multi-repo-authorization.md) ─
/** Access tier of one grant: `comment` = contents:read + issues/PR:write (the
 *  hook write-back shape); `read`/`write` are uniform across capabilities. */
export const RepoAccessDto = z.enum(['read', 'comment', 'write'])

/** One explicit repo grant on an agent (the Repositories card). */
export const AgentRepoAuthDto = z.object({
  id: z.string(),
  repoId: z.string(), // rename-proof GitHub numeric id
  repoFullName: z.string(), // owner/repo as GitHub cases it (refreshed on rename)
  access: RepoAccessDto,
  createdBy: z.string().nullable(), // app_user id (member directory resolves display)
  createdAt: z.string() // ISO-8601
})
export const AgentRepoAuthListDto = z.array(AgentRepoAuthDto)
export type AgentRepoAuthDtoT = z.infer<typeof AgentRepoAuthDto>

/** `POST /agents/:agentId/repos` — repo named by full name; the server resolves
 *  the numeric id through an org installation (never client-supplied). */
export const CreateAgentRepoAuthBody = z.strictObject({
  repoFullName: z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/repo"'),
  access: RepoAccessDto.default('read')
})

/** `PATCH /agents/:agentId/repos/:repoAuthId` — raise an existing grant's tier. */
export const UpdateAgentRepoAuthBody = z.strictObject({ access: RepoAccessDto })

export const AgentRepoAuthParam = z.object({ agentId: z.string(), repoAuthId: z.string() })

// ── me (the caller's own profile) ────────────────────────────────────────
/** `GET /me` / `PATCH /me` — the signed-in user. */
export const MeDto = z.object({
  userId: z.string(),
  /** Immutable through this surface — the OIDC provider owns it. Null while
   *  only a synthetic placeholder is known. */
  email: z.string().nullable(),
  name: z.string().nullable(), // displayName
  /** Active avatar URL: a custom uploaded photo when present, otherwise the OIDC `picture` claim. */
  picture: z.string().nullable(),
  /** Whether the active preference is a user-uploaded photo (rather than the OIDC fallback). */
  pictureCustom: z.boolean(),
  /** Whether this deployment has the object store required to upload profile photos. */
  pictureUploadEnabled: z.boolean()
})

/** `PATCH /me` — display name only. STRICT on purpose: email (and any unknown
 * field) is not modifiable — a request carrying `email` must 400, not be silently
 * dropped. Profile-photo bytes have a dedicated raw-image route. */
export const UpdateMeBody = z.strictObject({
  name: z.string().trim().min(1).max(120)
})

// ── closed-beta admission (`/me/access`, `/waitlist*`) — waitlist-and-login.md ──
/** `GET /me/access` — the signed-in user's admission state. `status` drives the
 *  console's post-login routing (§5): `active` ⇒ enter the app; anything else ⇒
 *  `/waitlist`. When `waitlistMode` is false the status is always `active`. `email`
 *  is the user's VERIFIED address read from trusted persistence (null when only a
 *  synthetic placeholder is known); it is NEVER taken from a request header (§8). */
export const MeAccessDto = z.object({
  waitlistMode: z.boolean(),
  status: z.enum(['active', 'approved', 'pending', 'none']),
  activated: z.boolean(), // User.activatedAt != null
  orgCount: z.number().int(),
  email: z.string().nullable()
})

/** `POST /waitlist` applicant intake — self-submitted context stored as a note on the
 *  entry (waitlist-and-login.md §5). The email is NEVER taken from here — it always
 *  comes from the verified OIDC identity; these are just applicant metadata for the
 *  admin app. Name / company / team-size / at least one platform are REQUIRED (the
 *  console form gates them, and this contract mirrors that); only the use-case is
 *  optional. Unknown fields are stripped. Auth runs in `preValidation` so an
 *  unauthenticated caller is rejected BEFORE this schema validates (auth-first). */
export const WaitlistJoinBody = z.object({
  name: z.string().trim().min(1).max(120),
  company: z.string().trim().min(1).max(120),
  platform: z
    .array(z.enum(['slack', 'telegram', 'discord']))
    .min(1)
    .max(3),
  teamSize: z.string().trim().min(1).max(40),
  useCase: z.string().trim().max(2000).optional()
})
export type WaitlistJoinBodyT = z.infer<typeof WaitlistJoinBody>

/** `POST /waitlist` response — the entry status after adding the caller (their own
 *  verified email is used; the body is optional applicant metadata only). */
export const WaitlistJoinDto = z.object({
  status: z.enum(['pending', 'approved', 'rejected'])
})

/** `POST /waitlist/redeem` — the join-link plaintext token from the activation URL. */
export const WaitlistRedeemBody = z.object({
  token: z.string().min(1).max(200),
  /**
   * The OIDC subject the CLIENT believes it is redeeming as. Optional, and never a
   * credential — the identity still comes from the verified bearer. It exists because
   * a browser's token store is shared across tabs: another tab can sign in as a
   * different account between the moment the activation page established its identity
   * and the moment this request is sent, and a bearer (email-less) link would happily
   * activate that other account. When present and it disagrees with the token's `sub`,
   * the request is refused rather than redeemed as somebody else.
   */
  expectSubject: z.string().min(1).max(255).optional()
})

/** `POST /waitlist/redeem` success — the user is now a formal (activated) user. */
export const WaitlistRedeemDto = z.object({
  activated: z.literal(true)
})

// ── personal API keys (`/me/keys` — the caller's own credentials) ───────────
/** Console view of a personal key — never the secret/hash; carries the org it
 *  acts in (a user's keys span every org they belong to). */
export const UserApiKeyDto = z.object({
  id: z.string(),
  displayTail: z.string(),
  name: z.string().nullable(),
  orgId: z.string(),
  orgSlug: z.string(),
  orgName: z.string().nullable(), // null ⇒ the console falls back to the slug
  createdAt: z.string(), // ISO-8601
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable()
})
export const UserApiKeyListDto = z.array(UserApiKeyDto)

/** `POST /me/keys` response — the one-time plaintext (shown once, never retrievable). */
export const MintedUserKeyDto = z.object({
  apiKeyId: z.string(),
  apiKey: z.string(),
  displayTail: z.string()
})

/** `POST /me/keys` body — mint a personal key in ONE of the caller's orgs. The
 *  key then acts as the caller, with their role, in that org. */
export const CreateUserKeyBody = z.object({
  orgId: z.string().min(1), // must be an org the caller is a member of (verified in the route)
  name: z.string().trim().min(1).max(120).optional(),
  // Bounded fixed lifetime, or `null` for a non-expiring key. The UI defaults to 90.
  expiresInDays: z.number().int().min(1).max(365).nullable().default(90)
})

// ── members + orgs (Settings page, org picker) ───────────────────────────
/** Membership role (Prisma `OrgRole`): owner | collaborator | viewer (§3.2). */
export const MemberRole = z.enum(['owner', 'collaborator', 'viewer'])

/** One org member — the membership joined with its user. Never `oidcSubject`. */
export const MemberDto = z.object({
  userId: z.string(),
  email: z.string().nullable(), // real email; null while only a synthetic placeholder is known
  name: z.string().nullable(), // displayName
  picture: z.string().nullable(), // OIDC `picture` avatar URL; null until they've signed in with one
  role: MemberRole,
  joinedAt: z.string() // ISO-8601 (user createdAt — memberships carry no timestamps)
})
export const MemberListDto = z.array(MemberDto)

/** `PATCH /members/:id` — change a member's role (owner-only; multiple owners OK). */
export const UpdateMemberBody = z.object({
  role: MemberRole
})

/** `POST /members` — add a member directly by email (owner-only; no email sent).
 *  An unknown address becomes an invited user row, claimed on first SSO sign-in. */
export const AddMemberBody = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: MemberRole.default('collaborator')
})

// One fixed-policy link per org: collaborator, seven days, unlimited users.
export const OrgInviteLinkDto = z.object({
  id: z.string(),
  displayTail: z.string(),
  status: z.enum(['active', 'expired', 'revoked']),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  createdAt: z.string()
})

/** `POST /invite-links` reveals the token exactly once. */
export const CreatedOrgInviteLinkDto = OrgInviteLinkDto.extend({ token: z.string() })

/** No policy knobs: role and seven-day lifetime are deliberately server-fixed. */
export const CreateOrgInviteLinkBody = z.object({}).strict()

/** Root-scoped accept body; token stays out of the request URL/access log. */
export const AcceptOrgInviteLinkBody = z.object({ token: z.string().min(1).max(256) }).strict()

export const AcceptedOrgInviteLinkDto = z.object({
  status: z.enum(['accepted', 'already_member']),
  org: z.object({ id: z.string(), slug: z.string(), name: z.string().nullable() })
})

/** First path segments the console itself owns — an org slug must never
 *  shadow them (`/{slug}/…` shares the segment with these). Grows with every
 *  new top-level console page. The default org's `-` is safe by regex. */
const RESERVED_SLUGS = new Set([
  'agents',
  'sessions',
  'daemons',
  'crons',
  'knowledge',
  'usage',
  'settings',
  'profile',
  'login',
  'join',
  'auth',
  'api',
  'orgs',
  'health',
  'stream',
  'assets'
])

/** Lowercase letters, digits and hyphens — the org-slug shape shown in URLs. */
export const OrgSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'lowercase letters, digits and hyphens')
  .refine((s) => !RESERVED_SLUGS.has(s), 'this name is reserved')

/** An org's display name — optional; a blank value is normalized to null (the
 *  console then falls back to the slug for display). */
export const OrgName = z
  .string()
  .trim()
  .max(80)
  .transform((s) => s || null)

/** One org from the caller's perspective (`GET /orgs`, the console picker). */
export const OrgDto = z.object({
  id: z.string(),
  /** null ⇒ the console shows `slug` instead. */
  name: z.string().nullable(),
  slug: z.string(),
  /** Console avatar descriptor; null ⇒ generated default (rendered by the org icon endpoint). */
  icon: AgentIconDto.nullable(),
  /** Resolved URL for an uploaded `image` org icon (object-store public URL); null for
   *  glyph/default (the console renders those locally) or when no store is configured. */
  iconUrl: z.string().nullable(),
  /** Whether the object store is configured — the console shows the Upload control only when true. */
  iconUploadEnabled: z.boolean(),
  /** The CALLER's role in this org. */
  role: MemberRole,
  memberCount: z.number().int(),
  createdAt: z.string() // ISO-8601
})
export const OrgListDto = z.array(OrgDto)

/** `POST /orgs` — create an org; the caller becomes its first owner. The
 *  display name is optional — omit it (or send blank) to fall back to the slug. */
export const CreateOrgBody = z.object({
  name: OrgName.optional(),
  slug: OrgSlug
})

/** `PATCH /orgs/:id` — rename / re-slug (owner-only). At least one field.
 *  A blank `name` clears the display name (back to the slug fallback). */
export const UpdateOrgBody = z
  .object({
    name: OrgName.optional(),
    slug: OrgSlug.optional(),
    // Glyph/runtime icon via JSON (the picker's non-upload path); an uploaded `image`
    // icon goes through PUT /orgs/:id/icon, so it is not accepted here. null ⇒ default.
    icon: AgentIconBody.nullable().optional()
  })
  .refine((b) => b.name !== undefined || b.slug !== undefined || b.icon !== undefined, {
    message: 'nothing to update'
  })

// ── crons ────────────────────────────────────────────────────────────────
export const Platform = z.enum(['slack', 'telegram', 'discord', 'feishu'])

/** `schedule` must parse as a croner expression — the documented field contract
 *  (§3.11 "croner expr"). Rejecting here keeps a def no daemon could ever
 *  schedule out of C6 (it would error the `cron/upsert` REP forever). */
const cronerSchedule = z
  .string()
  .min(1)
  .refine(
    (s) => {
      try {
        new Cron(s, { paused: true }).stop()
        return true
      } catch {
        return false
      }
    },
    { message: 'not a valid croner schedule expression' }
  )

const ianaTimezone = z
  .string()
  .min(1)
  .refine(
    (timezone) => {
      try {
        const canonical = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone
        // ECMA-402 also accepts fixed-offset identifiers such as "+01:00".
        // They are useful time zones, but they are not IANA names and do not
        // carry daylight-saving transitions.
        return !canonical.startsWith('+') && !canonical.startsWith('-')
      } catch {
        return false
      }
    },
    { message: 'not a valid IANA timezone' }
  )

export const UpsertCronBody = z.object({
  agentId: z.string().uuid(), // the agent this cron drives — required (§3.11)
  // Console display name ("weekly-deploy-report") — console metadata only,
  // never delivered to the daemon. Optional for API/legacy compatibility.
  name: z.string().trim().min(1).max(120).optional(),
  schedule: cronerSchedule,
  // Omitted on create ⇒ the CP process timezone; edits from the console always
  // resend the stored value so a non-default timezone is never reset silently.
  timezone: ianaTimezone.optional(),
  targetPlatform: Platform.default('slack'),
  // Optional output routing: post the trigger there and thread the agent's
  // replies under it. Absent/empty ⇒ headless fire.
  targetChannel: z.string().min(1).optional(),
  // The agent integration whose connection posts the anchor — must be one of
  // the cron's agent's integrations (validated in the route); the stored
  // platform is derived from it. Meaningful only with a targetChannel.
  targetIntegrationId: z.string().uuid().optional(),
  trigger: z.string().min(1),
  enabled: z.boolean().default(true),
  // Initial visibility — honored only on CREATE (a fresh cron id); on an EDIT it is
  // ignored (sharing changes go through PUT /crons/:id/sharing). `sharedWith` is
  // intersected with current org members in the route.
  visibility: ResourceVisibilityEnum.optional(),
  sharedWith: z.array(z.string()).optional()
})

export const CronDto = z.object({
  id: z.string(),
  orgId: z.string(),
  agentId: z.string().nullable(), // null ⇒ orphaned by agent delete (inert)
  name: z.string().nullable(), // console display name; null for legacy/CLI rows
  schedule: z.string(),
  timezone: z.string(),
  targetPlatform: Platform,
  targetChannel: z.string().nullable(),
  targetIntegrationId: z.string().nullable(), // null ⇒ legacy / integration uninstalled
  trigger: z.string(),
  enabled: z.boolean(),
  lastRunAt: z.string().nullable(),
  createdBy: z.string().nullable(), // creator's userId (web resolves to a name / "You"); null for CLI/legacy
  createdAt: z.string(),
  lastModifiedBy: z.string().nullable(), // editor's userId (web resolves to a name / "You"); null for CLI/legacy
  lastModifiedAt: z.string(),
  // ── visibility / sharing (docs/designs/resource-visibility.md) ──
  visibility: ResourceVisibilityEnum,
  sharedWith: z.array(z.string()), // app_user.id set (only meaningful when restricted)
  canManageSharing: z.boolean() // whether the CALLER can edit this cron (= canEdit); gates the sharing control
})

// One daemon-reported fire (console run history). `running` = fire report seen,
// completion not yet — or lost, in which case the CronRunReaper closes it to
// `failed` (orphaned) once it ages past CRON_RUN_TTL_SEC.
export const CronRunDto = z.object({
  id: z.string(),
  startedAt: z.string(),
  status: z.enum(['running', 'success', 'failed']),
  durationMs: z.number().int().nullable(),
  sessionId: z.string().nullable(), // ACP session id (console deep-link)
  reason: z.string().nullable()
})
export const CronRunListDto = z.array(CronRunDto)
export type CronRunDtoT = z.infer<typeof CronRunDto>
export const CronListDto = z.array(CronDto)

// ── hooks (inbound-webhook triggers; the relay pool is the ingress) ─────────
// webhook-triggers-and-github-events.md. Two kinds, discriminated on `kind`:
// the generic `webhook` (P1) and the GitHub event subscription (P2).

export const HookSessionModeEnum = z.enum(['perDelivery', 'perThread', 'shared'])

/** `event:action` with an `event:*` family wildcard; only the three subscribed
 *  families are accepted (the relay routes nothing else to the matcher). The
 *  action part is deliberately loose — a new GitHub action must not 400. */
export const HookEventPattern = /^(issues|pull_request|issue_comment|pull_request_review_comment|push):([a-z_]+|\*)$/
export const GithubCommentFamily = z.enum(['issues', 'pull_request'])
const GithubCommentFamilies = z.array(GithubCommentFamily).max(2)
export const HookReviewPolicyEnum = z.enum(['off', 'comment', 'request_changes', 'full'])
export const HookReportingModeEnum = z.enum(['off', 'check', 'status'])
export const HookGateModeEnum = z.enum(['informational', 'required'])

const HookBodyBase = z.object({
  agentId: z.string().uuid(), // the agent this hook fires — required
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  // Optional output anchoring (same trio as crons; absent ⇒ headless fire).
  targetPlatform: Platform.default('slack'),
  targetChannel: z.string().min(1).optional(),
  targetIntegrationId: z.string().uuid().optional()
  // No visibility: a hook is subordinate to its agent (like an Integration) and
  // inherits the agent's visibility — access is gated by the agent, not the hook.
})

export const CreateWebhookHookBody = HookBodyBase.extend({
  kind: z.literal('webhook'),
  // perThread is github-only (source-thread affinity needs a thread key).
  sessionMode: z.enum(['perDelivery', 'shared']).default('perDelivery'),
  // Mint a per-hook HMAC signing secret (X-AC-Signature); echoed EXACTLY ONCE in
  // the create response, never retrievable after.
  hmac: z.boolean().default(false)
})

export const CreateGithubHookBody = HookBodyBase.extend({
  kind: z.literal('github'),
  // No sessionMode: github is perThread by definition (same issue/PR continues
  // one session). No hmac: the App webhook secret signs deliveries pool-wide.
  // The repo must sit inside one of the org's App installations; the CP resolves
  // it to the numeric repoId (the rename-immune match key — never client-supplied).
  repoFullName: z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/repo"'),
  events: z.array(z.string().regex(HookEventPattern)).min(1).max(20),
  // GitHub emits one issue_comment family for both issue and PR conversations.
  // Empty preserves the published API's legacy repo-wide comment semantics.
  commentFamilies: GithubCommentFamilies.default([]),
  labelFilter: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  // P3 summon mode: every event's authored text must @-mention the assigned
  // agent or the App (comments also pass the relay's collaborator gate).
  mentionOnly: z.boolean().default(false),
  reviewPolicy: HookReviewPolicyEnum.default('off'),
  reportingMode: HookReportingModeEnum.default('off'),
  gateMode: HookGateModeEnum.default('informational')
})

export const CreateHookBody = z.discriminatedUnion('kind', [CreateWebhookHookBody, CreateGithubHookBody])

// PUT: `kind` discriminates the body but STAYS OPTIONAL for webhook updates —
// the P1-published contract had no `kind` on PUT, and a versioned surface must
// not 400 yesterday's valid body (a kind-less PUT can only be a webhook hook:
// no github hook predates this schema). Plain z.union: the github member wins
// on its `kind:'github'` literal, everything else falls to the webhook member,
// and the route still rejects a kind flip. Immutable through PUT: the ingress
// URL (urlToken) and signing secret — the capability URL must survive edits,
// secret rotation is a delete/re-create. The github repo IS re-targetable
// (repoId re-resolved).
export const UpdateHookBody = z.union([
  // mentionOnly OPTIONAL on update (unlike create's default-false): a pre-P3
  // client echoing a hook back must not silently downgrade mention mode — the
  // route falls back to the stored value when the key is absent.
  CreateGithubHookBody.extend({
    // Unlike create's default-true, omission on whole-definition UPDATE means
    // preserve the stored enablement state. Old web clients did not echo it.
    enabled: z.boolean().optional(),
    commentFamilies: GithubCommentFamilies.optional(),
    mentionOnly: z.boolean().optional(),
    // Whole-definition PUT remains backward-compatible: clients predating R1
    // omit these keys and the route preserves the stored policy.
    reviewPolicy: HookReviewPolicyEnum.optional(),
    reportingMode: HookReportingModeEnum.optional(),
    gateMode: HookGateModeEnum.optional()
  }),
  CreateWebhookHookBody.omit({ hmac: true }).extend({
    kind: z.literal('webhook').default('webhook'),
    enabled: z.boolean().optional()
  })
])

export const HookDto = z.object({
  id: z.string(),
  orgId: z.string(),
  agentId: z.string().nullable(), // null ⇒ legacy inert row
  kind: z.enum(['webhook', 'github']),
  name: z.string(),
  sessionMode: HookSessionModeEnum,
  enabled: z.boolean(),
  // The full ingress URL (PUBLIC_RELAY_URL-based). A capability URL — surfaced
  // only to callers with edit rights (configuring senders needs it); null otherwise.
  // The full ingress URL (PUBLIC_RELAY_URL-based) — a capability URL, surfaced to
  // any caller who can reach the hook (which already means they can view/edit the
  // owning agent); null when the relay ingress isn't configured.
  url: z.string().nullable(),
  hmacConfigured: z.boolean(), // a signing secret exists (the secret itself is never returned)
  // ── github kind (P2; read-side seats) ──
  repoId: z.string().nullable(), // rename-proof GitHub numeric id; null for webhook kind
  repoFullName: z.string().nullable(),
  events: z.array(z.string()),
  commentFamilies: GithubCommentFamilies,
  labelFilter: z.array(z.string()),
  mentionOnly: z.boolean(),
  configRevision: z.string(),
  reviewPolicy: HookReviewPolicyEnum,
  reportingMode: HookReportingModeEnum,
  gateMode: HookGateModeEnum,
  // ── output anchoring ──
  targetPlatform: Platform,
  targetChannel: z.string().nullable(),
  targetIntegrationId: z.string().nullable(),
  lastFiredAt: z.string().nullable(),
  createdBy: z.string().nullable(), // creator's userId (web resolves to a name / "You")
  createdAt: z.string(),
  lastModifiedBy: z.string().nullable(),
  lastModifiedAt: z.string()
  // No visibility/sharedWith/canManageSharing: a hook has no visibility of its
  // own — it inherits the owning agent's (see CreateHookBody).
})
export const HookListDto = z.array(HookDto)
export type HookDtoT = z.infer<typeof HookDto>

/** Create response: the DTO plus the ONE-TIME signing-secret echo (null unless
 *  `hmac:true` was requested). Never appears on any other route. */
export const CreatedHookDto = HookDto.extend({ hmacSecret: z.string().nullable() })

// One delivery's run row. `running` = the relay accepted the dispatch, the
// daemon's completion report hasn't landed (or was lost — the HookRunReaper
// closes those to failed/orphaned).
export const HookRunDto = z.object({
  id: z.string(),
  deliveryKey: z.string(),
  event: z.string().nullable(), // 'issues:opened' etc (github kind); null for webhook kind
  startedAt: z.string(),
  status: z.enum(['running', 'success', 'failed']),
  durationMs: z.number().int().nullable(),
  sessionId: z.string().nullable(), // ACP session id (console deep-link)
  reason: z.string().nullable(),
  redeliveryAttempts: z.number().int().nonnegative(),
  redeliveryLastRequestedAt: z.string().nullable()
})
export const HookRunListDto = z.array(HookRunDto)
export type HookRunDtoT = z.infer<typeof HookRunDto>

// ── sessions (CP-stored metadata; transcript bodies remain daemon-local) ──
export const SessionKeyDto = z.object({
  platform: z.string(),
  channel: z.string(),
  thread: z.string().optional()
})
/** Per-session token accounting surfaced to the console (see protocol `SessionUsage`).
 *  Token counts are session-cumulative; context/cost are the latest snapshot. */
export const SessionUsageDto = z.object({
  reportedAt: z.string().optional(),
  totalTokens: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  thoughtTokens: z.number().optional(),
  cachedReadTokens: z.number().optional(),
  cachedWriteTokens: z.number().optional(),
  contextUsed: z.number().optional(),
  contextSize: z.number().optional(),
  costAmount: z.number().optional(),
  costCurrency: z.string().optional()
})
export const SessionDto = z.object({
  sessionId: z.string(),
  sessionKey: SessionKeyDto,
  agentId: z.string(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  usage: SessionUsageDto.nullable(),
  triggeredBy: z.string().nullable(),
  // Stable source kind for hook-triggered sessions. null for non-hook or a
  // deleted/legacy hook whose definition can no longer be resolved.
  hookKind: z.enum(['webhook', 'github']).nullable(),
  // Daemon-resolved display names (pure passthrough — the raw ids above stay
  // canonical; null when the daemon hasn't resolved them).
  channelName: z.string().nullable(),
  triggeredByName: z.string().nullable(),
  // Platform-native deep link back to the source thread (e.g. a Slack archives
  // permalink), built by the daemon; null when unavailable. Pure passthrough.
  threadUrl: z.string().nullable(),
  // Execution-config snapshot the session actually ran with (daemon-reported;
  // daemonId is CP-stamped from the reporting WS connection). null ⇒ never
  // reported (legacy row) — the console falls back to the owning agent's
  // current config. A null value on a reported row ⇒ the runtime's own default.
  runtime: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  fastMode: z.boolean().nullable(),
  permissionMode: z.string().nullable(),
  outputMode: z.string().nullable(),
  daemonId: z.string().nullable()
})
export const SessionListDto = z.array(SessionDto)
export const SessionFacetsDto = z.object({
  agents: z.array(z.string()),
  integrations: z.array(z.string()),
  channels: z.array(
    z.object({
      value: z.string(),
      platform: z.string(),
      integration: z.string(),
      name: z.string().nullable(),
      triggeredByName: z.string().nullable()
    })
  ),
  triggers: z.array(
    z.object({
      value: z.string(),
      integration: z.string(),
      name: z.string().nullable(),
      hookKind: z.enum(['webhook', 'github']).nullable(),
      githubRepoId: z.string().nullable()
    })
  )
})
export const SessionListPageDto = z.object({
  sessions: SessionListDto,
  // Counting is skipped on cursor pages; the first page remains authoritative.
  total: z.number().int().nonnegative().nullable(),
  nextCursor: z.string().nullable()
})

/** `GET /sessions/:id` — the deep-link detail view, served from CP-stored
 *  `SessionMeta` (synced via the `event/session` EVT). Metadata only. */
export const SessionRelationDto = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string().nullable()
})

export const SessionDetailDto = z.object({
  id: z.string(),
  parentSession: SessionRelationDto.nullable(),
  childSessions: z.array(SessionRelationDto),
  agentId: z.string(),
  launchId: z.string().nullable(),
  platform: z.string().nullable(),
  channel: z.string().nullable(),
  thread: z.string().nullable(),
  phase: z.string(),
  link: z.string().nullable(),
  summary: z.string().nullable(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  lastActivityAt: z.string(),
  usage: SessionUsageDto.nullable(),
  triggeredBy: z.string().nullable(),
  channelName: z.string().nullable(),
  triggeredByName: z.string().nullable(),
  threadUrl: z.string().nullable(),
  runtime: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  fastMode: z.boolean().nullable(),
  permissionMode: z.string().nullable(),
  outputMode: z.string().nullable(),
  daemonId: z.string().nullable(),
  activityState: z.string(),
  startedAt: z.string(), // ISO-8601
  endedAt: z.string().nullable()
})

/** One message page returned by `GET /sessions/:id/messages` (proxied from the daemon).
 *  The tool-body fields are optional (text/reasoning rows and old daemons omit them);
 *  they MUST be declared here or Fastify's response schema strips them before the browser. */
export const SessionMessageDto = z.object({
  seq: z.number(),
  sender: z.string(),
  senderName: z.string().optional(), // daemon-resolved display name; absent if unknown
  ts: z.string(),
  kind: z.string(),
  text: z.string(),
  attachments: z.array(SessionImageAttachment).max(1).optional(),
  // ── tool-body enrichment (mirrors protocol SessionMessage; tool rows only) ──
  toolCallId: z.string().optional(),
  toolStatus: z.string().optional(),
  toolKind: z.string().optional(),
  body: z.string().optional(), // JSON.stringify(ToolBody); may be a truncated-but-valid-JSON preview
  bodyTruncated: z.boolean().optional(), // preview shrunk for the frame; full body via /sessions/:id/tool-body
  bodyBytes: z.number().optional() // full (untruncated) body byte length
})
export const SessionHistoryDto = z.object({
  sessionId: z.string(),
  messages: z.array(SessionMessageDto),
  nextCursor: z.string().nullable(),
  liveCursor: z.string().nullable(),
  liveMore: z.boolean()
})

/** `GET /sessions/:id/tool-body` query — one byte slice of a tool call's full ToolBody JSON. */
export const SessionToolBodyQueryDto = z.object({
  toolCallId: z.string(),
  offset: z.coerce.number().int().nonnegative().optional() // byte offset into the full body JSON
})

/** One chunk returned by `GET /sessions/:id/tool-body` (mirrors protocol SessionToolBodyChunk).
 *  `nextOffset` is nullable in the HTTP shape (absent ⇒ null ⇒ last chunk). */
export const SessionToolBodyChunkDto = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  data: z.string(), // UTF-8-boundary-safe byte slice of the full ToolBody JSON
  totalBytes: z.number(),
  nextOffset: z.number().nullable() // null ⇒ this is the last chunk
})

// ── workspace files (pulled live from the owning daemon — the CP stores no bodies) ──
/** `GET /agents/:id/workspace/files` query — one page of a directory listing. */
export const WorkspaceFilesQueryDto = z.object({
  path: z.string().optional(), // workspace-relative POSIX path; absent/'' ⇒ workspace root
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional()
})

export const WorkspaceEntryDto = z.object({
  name: z.string(),
  type: z.enum(['dir', 'file', 'symlink', 'other']),
  size: z.number().nullable(), // regular files only
  mtime: z.string().nullable() // RFC3339
})
export const WorkspaceFilesDto = z.object({
  path: z.string(),
  exists: z.boolean(), // false ⇒ workspace root or the dir does not exist (data, not an error)
  entries: z.array(WorkspaceEntryDto),
  nextCursor: z.string().nullable()
})

/** `GET /agents/:id/workspace/file` query — one byte slice of a file. */
export const WorkspaceFileQueryDto = z.object({
  path: z.string().min(1), // workspace-relative POSIX path to a file
  offset: z.coerce.number().int().nonnegative().optional(), // byte offset
  limit: z.coerce.number().int().positive().max(65536).optional() // byte count per slice
})

export const WorkspaceFileDto = z.object({
  path: z.string(),
  exists: z.boolean(), // false ⇒ the file does not exist (data, not an error)
  size: z.number().nullable(),
  mtime: z.string().nullable(), // RFC3339
  encoding: z.enum(['utf8', 'none']).nullable(), // 'none' ⇒ binary detected, content omitted
  content: z.string().nullable(), // utf8 text slice
  offset: z.number().nullable(), // byte offset this slice starts at
  nextOffset: z.number().nullable(), // byte offset to request next; clients must NOT recompute from content
  truncated: z.boolean().nullable() // true ⇒ nextOffset < size (more bytes remain)
})

/** `PUT /agents/:id/workspace/file` query — one scratch-workspace file. */
export const PutWorkspaceFileQueryDto = z.object({
  path: z.string().min(1).max(4096)
})
/** Omit `ifMatchMtime` for exclusive create; provide it for optimistic replace.
 * Byte length is rechecked because zod counts characters, not encoded bytes. */
export const PutWorkspaceFileBody = z
  .object({
    content: z.string().max(MAX_WORKSPACE_EDIT_BYTES),
    ifMatchMtime: z.string().datetime().optional()
  })
  .strict()
export const WorkspaceFileWriteDto = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.string()
})

/** `DELETE /agents/:id/workspace/file` query — one unchanged scratch file. */
export const DeleteWorkspaceFileQueryDto = z.object({
  path: z.string().min(1).max(4096),
  ifMatchMtime: z.string().datetime()
})
export const WorkspaceFileDeleteDto = z.object({
  path: z.string()
})

// ── agent memory (a directory at the agent root: MEMORY.md index + topic files; proxied daemon-local) ──
/** One file in the memory dir. */
export const MemoryFileEntryDto = z.object({
  name: z.string(),
  size: z.number(),
  mtime: z.string() // RFC3339
})
/** `GET /agents/:id/memory/files` — the files in the memory dir (index + topics). */
export const MemoryFilesDto = z.object({
  exists: z.boolean(), // false ⇒ the memory dir does not exist yet
  files: z.array(MemoryFileEntryDto)
})
/** Query for reading one memory file: `path` (defaults to the MEMORY.md index) + slice. */
export const MemoryFileQueryDto = z.object({
  path: z.string().min(1).optional(), // memory-dir-relative file name; defaults to MEMORY.md
  offset: z.coerce.number().int().nonnegative().optional(), // byte offset
  limit: z.coerce.number().int().positive().max(65536).optional() // byte count per slice
})
/** `GET /agents/:id/memory[/file]` — one byte slice of a memory file. A
 *  not-yet-created file is data (`exists:false`), not an error. Always utf8 text. */
export const AgentMemoryDto = z.object({
  path: z.string(),
  exists: z.boolean(),
  size: z.number().nullable(),
  mtime: z.string().nullable(), // RFC3339
  content: z.string().nullable(), // utf8 text slice
  offset: z.number().nullable(), // byte offset this slice starts at
  nextOffset: z.number().nullable(), // byte offset to request next; clients must NOT recompute from content
  truncated: z.boolean().nullable() // true ⇒ nextOffset < size (more bytes remain)
})
/** Write query: which memory file to replace (defaults to the MEMORY.md index). */
export const PutMemoryFileQueryDto = z.object({ path: z.string().min(1).optional() })
/** `PUT /agents/:id/memory[/file]` — replace the whole named memory file.
 *  `ifMatchMtime` (optional) is optimistic concurrency: the mtime the client last
 *  read; the write 409s if the file changed under it. */
export const PutAgentMemoryBody = z.object({ content: z.string(), ifMatchMtime: z.string().optional() }).strict()
/** The written state, so the console can refresh. */
export const AgentMemoryWriteDto = z.object({
  path: z.string(),
  size: z.number(),
  mtime: z.string() // RFC3339
})

/** `GET /agents/:id/memory/history` — newest-first provenance for one managed file. */
export const MemoryHistoryQueryDto = z.object({
  path: z.string().min(1).max(255),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(5).optional()
})
export const MemoryHistoryPageDto = z.object({
  events: z.array(MemoryFileHistoryEvent).max(5),
  nextCursor: z.string().uuid().nullable()
})

/** Provider-neutral external-memory administration. Surface discovery carries
 * no plugin/backend identity or connection detail; record responses retain only
 * the canonical profile's bounded provenance. */
export const MemorySurfaceDto = z.object({
  shape: z.enum(['files', 'records', 'none']),
  capabilities: z.array(MemoryPluginOperation)
})
export const MemoryRecordDto = CanonicalMemoryRecord
export const MemoryRecordPageDto = z.object({
  records: z.array(MemoryRecordDto),
  nextCursor: z.string().nullable()
})
export const MemoryRecordResultDto = z.object({ record: MemoryRecordDto })
export const MemoryRecordGetResultDto = z.object({ record: MemoryRecordDto.nullable() })
export const MemoryRecordDeleteResultDto = z.object({ id: z.string(), deleted: z.boolean() })
export const MemoryRecordHistoryPageDto = z.object({
  events: z.array(MemoryPluginHistoryEvent),
  nextCursor: z.string().nullable()
})
export const MemoryRecordSearchBodyDto = z.object({
  query: z.string().min(1).max(32768),
  topK: z.coerce.number().int().positive().max(20).optional(),
  maxBytes: z.coerce.number().int().positive().max(32768).optional()
})
export const MemoryRecordPageQueryDto = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(20).optional()
})
export const MemoryRecordParamDto = z.object({ id: z.string().uuid(), recordId: z.string().min(1).max(512) })
const MemoryRecordMetadataDto = z.record(z.string(), z.unknown()).superRefine((metadata, ctx) => {
  try {
    if (Buffer.byteLength(JSON.stringify(metadata)) <= 64 * 1024) return
  } catch {
    // HTTP JSON cannot contain cycles/BigInt, but keep the schema safe for
    // direct/internal callers too.
  }
  ctx.addIssue({ code: 'custom', message: 'metadata exceeds the 64 KiB encoded limit' })
})
const MemoryRecordTextDto = z
  .string()
  .min(1)
  .max(128 * 1024)
  .refine((text) => Buffer.byteLength(text) <= 128 * 1024, 'text exceeds the 128 KiB encoded limit')
export const CreateMemoryRecordBody = z
  .object({ text: MemoryRecordTextDto, metadata: MemoryRecordMetadataDto.optional() })
  .strict()
export const UpdateMemoryRecordBody = z
  .object({
    text: MemoryRecordTextDto,
    metadata: MemoryRecordMetadataDto.optional(),
    version: z.string().min(1).max(512).optional()
  })
  .strict()
export const DeleteMemoryRecordBody = z.object({ version: z.string().min(1).max(512).optional() }).strict()

// ── memory dreaming (docs/designs/memory-dreaming.md §10) — job metadata + staged review ──
/** One mined skill candidate's review state (D-3; present once skill mining ships). */
export const DreamSkillDto = z.object({
  name: z.string(),
  description: z.string(),
  state: z.enum(['proposed', 'accepted', 'dismissed'])
})
/** A dream job's metadata (never staged bodies). Mirrors protocol `DreamInfo`. */
export const DreamDto = z.object({
  dreamId: z.string(),
  agentId: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'canceled', 'adopted', 'discarded', 'superseded']),
  trigger: z.enum(['manual', 'schedule', 'auto']),
  sessionIds: z.array(z.string()),
  snapshotDigest: z.string(),
  executionSessionId: z.string().nullable(),
  runtime: z.string().nullable(),
  model: z.string().nullable(),
  stopReason: z.string().nullable(),
  instructions: z.string().nullable(),
  skills: z.array(DreamSkillDto).nullable(),
  usage: SessionUsageDto.extend({ inputBytes: z.number(), outputBytes: z.number() }).nullable(),
  error: z.object({ type: z.string(), message: z.string() }).nullable(),
  createdAt: z.string(), // RFC3339
  endedAt: z.string().nullable() // RFC3339
})
/** `GET …/dreams` — the agent's dream jobs, newest first. */
export const DreamListDto = z.object({ dreams: z.array(DreamDto) })
/** Body for starting a dream: per-run overrides of the agent's dreaming policy. */
export const StartDreamBody = z
  .object({
    sessionWindow: z.number().int().min(1).max(100).optional(),
    instructions: z.string().max(4096).optional()
  })
  .strict()
/** Body for adopting a dream: fenced by default; `force` overrides the snapshot fence. */
export const AdoptDreamBody = z.object({ force: z.boolean().optional() }).strict()
/** `GET …/dreams/:dreamId/files` — the staged output store's files (index + topics). */
export const DreamFilesDto = z.object({
  exists: z.boolean(), // false ⇒ nothing staged (yet)
  files: z.array(MemoryFileEntryDto)
})
/** `GET …/dreams/:dreamId/file` — one byte slice of a staged file (memory/read semantics). */
export const DreamFileDto = z.object({
  path: z.string(),
  exists: z.boolean(),
  size: z.number().nullable(),
  mtime: z.string().nullable(),
  content: z.string().nullable(),
  offset: z.number().nullable(),
  nextOffset: z.number().nullable(),
  truncated: z.boolean().nullable()
})
export const DreamSkillContentDto = z.object({
  name: z.string(),
  exists: z.boolean(),
  skill: z.string().nullable(),
  scripts: z.array(z.object({ path: z.string(), content: z.string() }))
})
export const DreamSkillParam = z.object({
  id: z.string().uuid(),
  dreamId: z.string().min(1).max(128),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
})
export const DreamIdParam = z.object({ id: z.string().uuid(), dreamId: z.string().min(1).max(128) })

export const WorkspaceGitFileDto = z.object({
  path: z.string(),
  index: z.string(), // staged (X) status char
  workingDir: z.string() // unstaged (Y) status char
})

export const WorkspaceGitCommitDto = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  committedAt: z.string() // RFC3339
})

/** `GET /agents/:id/workspace/gitstatus` — repo/branch/commit + is the tree clean?
 *  `repo`/`agentDir` come from the agent config (CP); the rest is live from the
 *  owning daemon's checkout. */
export const WorkspaceGitStatusDto = z.object({
  isRepo: z.boolean(), // false ⇒ from-scratch workspace (no .git); git ops are N/A
  clean: z.boolean(), // true ⇒ no staged / unstaged / untracked changes
  repo: z.string().nullable(), // full remote address (github mode); null ⇒ unknown
  agentDir: z.string().nullable(), // subdir within the repo the agent runs in
  branch: z.string().nullable(),
  tracking: z.string().nullable(), // upstream ref, if tracked
  ahead: z.number().nullable(),
  behind: z.number().nullable(),
  files: z.array(WorkspaceGitFileDto), // changed paths (bounded; see `truncated`)
  truncated: z.boolean(), // true ⇒ the `files` list was capped
  lastCommit: WorkspaceGitCommitDto.nullable(), // HEAD commit; null ⇒ no commits yet
  lastFetchAt: z.string().nullable() // RFC3339; when the checkout last fetched/pulled
})

/** `POST /agents/:id/workspace/gitpull` — outcome of a forced ff-only pull. A
 *  pull that can't fast-forward is `ok:false` (data), not an HTTP error. */
export const WorkspaceGitPullDto = z.object({
  isRepo: z.boolean(),
  ok: z.boolean(), // true ⇒ fast-forwarded or already up to date
  detail: z.string().nullable(), // human summary or failure reason
  changed: z.number().nullable(), // files changed by the pull
  insertions: z.number().nullable(),
  deletions: z.number().nullable()
})

// ── usage dashboard (aggregated from the persisted per-session usage store) ──
export const UsageRange = z.enum(['d1', 'd7', 'd30', 'd90'])
export const UsageQueryDto = z.object({
  range: UsageRange.default('d30'),
  // Client timezone offset in minutes, as `Date.prototype.getTimezoneOffset()`
  // reports it (UTC − local; e.g. UTC-8 ⇒ 480). Aligns the spend-over-time
  // buckets to the viewer's local day/hour instead of UTC. Defaults to 0 (UTC).
  tz: z.coerce.number().int().min(-900).max(900).default(0)
})

/** Per-agent rollup over the selected range (summed tokens/cost + session count). */
export const UsageAgentDto = z.object({
  agentId: z.string(),
  sessions: z.number(),
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  thoughtTokens: z.number(),
  cachedReadTokens: z.number(),
  cachedWriteTokens: z.number(),
  costAmount: z.number()
})
export const UsageDto = z.object({
  range: UsageRange,
  totals: z.object({
    sessions: z.number(),
    totalTokens: z.number(),
    costAmount: z.number(),
    costCurrency: z.string().nullable()
  }),
  agents: z.array(UsageAgentDto),
  // Spend-over-time chart: cost bucketed by hour (d1) or day (longer ranges),
  // empty buckets filled to 0. `start` is a UTC-aligned ISO instant.
  series: z.object({
    bucket: z.enum(['hour', 'day']),
    points: z.array(z.object({ start: z.string(), costAmount: z.number() }))
  })
})

// ── shared ────────────────────────────────────────────────────────────────
export const IdParam = z.object({ id: z.string() })
export const HealthDto = z.object({ status: z.literal('ok') })
/** Liveness (`/livez`): the process is up. Static — stays green through drain. */
export const LivezDto = z.object({ status: z.literal('ok') })
/** Readiness (`/readyz`): `ok` when serving; `shutting_down`/`db_unreachable`
 *  accompany a 503 so K8s drops the pod from the Service during a rolling update. */
export const ReadyzDto = z.object({ status: z.enum(['ok', 'shutting_down', 'db_unreachable']) })
export const ErrorDto = z.object({
  error: z.string(),
  statusCode: z.number(),
  message: z.string(),
  /** Machine-readable denial reason where the console branches on it (e.g.
   *  github user-authz: GITHUB_IDENTITY_REQUIRED vs USER_NO_ACCESS). */
  code: z.string().optional()
})

// Inferred response types — route handlers return these so the zod type provider
// type-checks the handler's payload against its declared response schema.
export type DaemonViewDtoT = z.infer<typeof DaemonViewDto>
export type ApiKeyDtoT = z.infer<typeof ApiKeyDto>
export type AgentDtoT = z.infer<typeof AgentDto>
export type IntegrationDtoT = z.infer<typeof IntegrationDto>
export type IntegrationChannelDtoT = z.infer<typeof IntegrationChannelDto>
export type BotDtoT = z.infer<typeof BotDto>
export type SlackBotRefreshDtoT = z.infer<typeof SlackBotRefreshDto>
export type MeDtoT = z.infer<typeof MeDto>
export type MeAccessDtoT = z.infer<typeof MeAccessDto>
export type UserApiKeyDtoT = z.infer<typeof UserApiKeyDto>
export type MemberDtoT = z.infer<typeof MemberDto>
export type OrgInviteLinkDtoT = z.infer<typeof OrgInviteLinkDto>
export type AcceptedOrgInviteLinkDtoT = z.infer<typeof AcceptedOrgInviteLinkDto>
export type OrgDtoT = z.infer<typeof OrgDto>
export type CronDtoT = z.infer<typeof CronDto>
export type SessionDtoT = z.infer<typeof SessionDto>
export type WorkspaceFilesDtoT = z.infer<typeof WorkspaceFilesDto>
export type WorkspaceFileDtoT = z.infer<typeof WorkspaceFileDto>
export type AgentMemoryDtoT = z.infer<typeof AgentMemoryDto>
export type AgentMemoryWriteDtoT = z.infer<typeof AgentMemoryWriteDto>
export type MemoryFilesDtoT = z.infer<typeof MemoryFilesDto>
export type MemoryHistoryPageDtoT = z.infer<typeof MemoryHistoryPageDto>
export type MemorySurfaceDtoT = z.infer<typeof MemorySurfaceDto>
export type MemoryRecordPageDtoT = z.infer<typeof MemoryRecordPageDto>
export type MemoryRecordResultDtoT = z.infer<typeof MemoryRecordResultDto>
export type MemoryRecordGetResultDtoT = z.infer<typeof MemoryRecordGetResultDto>
export type MemoryRecordDeleteResultDtoT = z.infer<typeof MemoryRecordDeleteResultDto>
export type MemoryRecordHistoryPageDtoT = z.infer<typeof MemoryRecordHistoryPageDto>
export type DreamDtoT = z.infer<typeof DreamDto>
export type DreamListDtoT = z.infer<typeof DreamListDto>
export type DreamFilesDtoT = z.infer<typeof DreamFilesDto>
export type DreamFileDtoT = z.infer<typeof DreamFileDto>
export type WorkspaceGitStatusDtoT = z.infer<typeof WorkspaceGitStatusDto>
export type WorkspaceGitPullDtoT = z.infer<typeof WorkspaceGitPullDto>
export type ErrorDtoT = z.infer<typeof ErrorDto>
