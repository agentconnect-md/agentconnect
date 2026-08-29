import {
  client as createClientApp,
  methods,
  ndJsonStream,
  type ClientConnection,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionUpdate,
  type StopReason,
  type Usage
} from '@agentclientprotocol/sdk'
import {
  HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED,
  HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED,
  type McpTransportCapabilities
} from '@agentconnect.md/protocol'
import type { RuntimeDef } from '../config/config-schema.js'
import {
  augmentClaudeEfforts,
  claudeInnerSandboxSettings,
  CLAUDE_DISALLOWED_BUILTIN_TOOLS,
  isClaudeRuntimeDef,
  type ClaudeInnerSandboxSettings,
  type ClaudeProtectedSettings,
  ULTRACODE_EFFORT
} from '../runtime-defs/claude-runtime.js'
import {
  LocalDriver,
  type AcpSandboxLaunch,
  type SpawnDriver,
  type SpawnFile,
  type SpawnedRuntime
} from './spawn-driver.js'
import type { Logger } from '../log.js'
import { accountAppIsolation } from './account-apps.js'

// The raw session config-option shapes (from the ACP SDK), re-exported so
// sessionConfigOptions() consumers can type the option tree without importing
// the SDK directly.
export type { SessionConfigOption, SessionConfigSelectGroup, SessionConfigSelectOption } from '@agentclientprotocol/sdk'

const PROTOCOL_VERSION = 1

/** A session/load may replay the historical conversation stream. Keep that off
 *  platform transports, but preserve latest-wins metadata needed to converge the
 *  local/CP session projection after a restart. The command list is one of those:
 *  the adapter advertises it after the replay, and it is the only advertisement a
 *  resumed session ever makes. */
export function shouldForwardUpdateDuringLoad(update: SessionUpdate): boolean {
  return (
    update.sessionUpdate === 'session_info_update' ||
    update.sessionUpdate === 'usage_update' ||
    update.sessionUpdate === 'available_commands_update'
  )
}

/** A runtime's advertised model selector, distilled from ACP session config options. */
export interface ModelOptions {
  /** The model id currently selected for the session (the agent's default). */
  current?: string
  /** Selectable model ids (group structure flattened away). */
  models: string[]
}

/** A runtime's advertised reasoning-effort selector (ACP `thought_level`), distilled
 *  from session config options and augmented with the synthetic `ultracode`/`max`
 *  entries on Claude runtimes (they aren't `thought_level` select values — see
 *  {@link ULTRACODE_EFFORT} / {@link claudeSessionMeta}). */
export interface EffortOptions {
  /** The effort level currently selected on the session (per the `thought_level`
   *  select's currentValue) — note a `_meta`-driven `ultracode` won't appear here. */
  current?: string
  /** Selectable effort levels (group structure flattened; synthetic entries appended). */
  efforts: string[]
}

/** A runtime's advertised permission/approval mode selector (ACP `mode`). Values are
 *  runtime-owned (`default` / `plan` on Claude, `agent` / `read-only` on Codex). */
export interface PermissionModeOptions {
  /** The permission mode currently selected for the session. */
  current?: string
  /** Selectable permission mode values (group structure flattened away). */
  modes: string[]
}

export type AcpPermissionPolicyEvent =
  | { kind: 'requested' }
  | {
      kind: 'resolved'
      source: 'resolver' | 'fallback'
      fallbackReason?: 'no_resolver' | 'resolver_undefined' | 'resolver_error'
      response: RequestPermissionResponse
    }

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const key of Reflect.ownKeys(object)) deepFreeze(Reflect.get(object, key), seen)
  return Object.freeze(value)
}

function immutablePermissionSnapshot<T>(value: T): T | undefined {
  try {
    return deepFreeze(structuredClone(value))
  } catch {
    return undefined
  }
}

/** A runtime's advertised fast-mode toggle (ACP `model_config` on/off select). The
 *  option only exists once a fast-capable model is selected, so `null` means the
 *  current model offers no fast toggle. */
export interface FastModeOption {
  /** Whether fast mode is currently on (the select's currentValue === "on"). */
  current: boolean
}

/**
 * Desired per-session runtime config, applied through ACP session config
 * options (`session/set_config_option`) right after `session/new` /
 * `session/load`. This is the only channel a runtime like claude-acp accepts
 * for reasoning effort — there is no env var or spawn flag for it; the model
 * additionally has env fallbacks some runtimes read (see cp-overlay.ts).
 */
export interface SessionConfigPrefs {
  /** Model id, matched against the option tagged `category: "model"`. */
  model?: string
  /** Effort level, matched against the option tagged `category: "thought_level"`. */
  reasoningEffort?: string
  /** Fast mode, matched against the option tagged `category: "model_config"` —
   *  both claude-acp (id "fast") and codex-acp (id "fast-mode") advertise it
   *  there, as an on/off `select` (we don't opt into boolean config options).
   *  The option only exists when the selected model supports fast mode, so an
   *  unsupported combination degrades to a logged skip. undefined ⇒ don't touch. */
  fastMode?: boolean
  /** Runtime permission/approval mode, matched against the option tagged
   *  `category: "mode"`. Values are runtime-owned (`default` / `plan` on
   *  claude-acp, `agent` / `read-only` on codex-acp, etc.). */
  permissionMode?: string
  /** Optional host-level system-prompt seed, layered ahead of any per-session append
   *  on Claude runtimes (see {@link claudeSessionMeta}). Left unset by default: the
   *  agent's identity + description now travel per-session in the agent meta object
   *  (see SessionManager), which also carries the channel source. undefined ⇒ none. */
  systemPrompt?: string
}

// The launch shape lives with the driver that consumes it; re-exported here because
// this module is where callers have always imported it from.
export type { AcpSandboxLaunch, SpawnDriver, SpawnedRuntime } from './spawn-driver.js'

/** The `session/set_config_option` call that applies a desired value, or the reason none is needed. */
export type ConfigSelectionPlan = { configId: string; value: string } | { skip: string }

/**
 * Distill the human-actionable reason from a failed ACP request. Adapters wrap
 * their runtime's own message in a JSON-RPC error whose `message` is often just
 * the generic title — codex-acp reports quota exhaustion as code -32603
 * "Internal error" with the real text ("You've hit your usage limit. Visit … or
 * try again at 7:01 PM.") under `error.data.message` — so prefer that detail
 * over a bare title, and append it when a specific message carries extra data.
 * Non-RequestError failures fall back to the plain Error message.
 */
export function turnFailureReason(err: unknown): string {
  const e = err as { message?: unknown; data?: { message?: unknown } } | null | undefined
  const msg = typeof e?.message === 'string' && e.message.trim() ? e.message.trim() : String(err)
  const detail = typeof e?.data?.message === 'string' ? e.data.message.trim() : ''
  if (!detail || msg.includes(detail)) return msg
  // The SDK's generic titles (RequestError statics) add nothing over the
  // runtime's own text; any more specific message keeps both.
  const generic =
    /^(parse error|invalid request|invalid params|internal error|request cancelled|authentication required|resource not found)$/i
  return generic.test(msg) ? detail : `${msg}: ${detail}`
}

/** Machine-stable classification for a failed ACP turn. Keep the default conservative:
 * callers only relax reporting for a provider limit or revoked credential that
 * we can identify from a structured adapter code or narrow provider-authored
 * message. In particular, an ordinary transient `rate_limit_error` or generic
 * "sign in again" text remains `turn_failed`.
 */
export type TurnFailureCode =
  typeof HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED | typeof HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED | 'turn_failed'

const PROVIDER_QUOTA_CODES = new Set([
  'billinghardlimitreached',
  'creditbalancetoolow',
  'creditsexhausted',
  'insufficientquota',
  'nocreditsremaining',
  'outofcredits',
  'planlimitreached',
  'quotaexhausted',
  'usagelimitexceeded',
  'usagelimitreached'
])

const PROVIDER_QUOTA_MESSAGES = [
  // A spend limit is a quota, not a transient rate limit, however the provider phrases the
  // possessive in between: "You've hit your org's monthly spend limit".
  /\b(?:you(?:'|’)ve|you have) hit your\b[\s\S]{0,60}\b(?:usage|spend) limit\b/i,
  /\b(?:usage|spend) limit (?:has been )?(?:reached|exceeded)\b/i,
  /\b(?:you(?:'|’)ve|you have) hit your limit\b[\s\S]{0,120}\bresets?\b/i,
  /\b(?:credit|credits) balance (?:is )?(?:too low|depleted|exhausted)\b/i,
  /\b(?:insufficient|not enough|no) (?:api )?credits?(?: (?:remaining|available))?\b/i,
  /\b(?:out of|exhausted) (?:api )?credits?\b/i,
  /\bexceeded your current quota\b/i,
  /\b(?:billing|plan|account) quota (?:has been )?(?:reached|exceeded|exhausted)\b/i
]

/**
 * Provider auth error TYPES and CODES, as the providers themselves emit them.
 *
 * Deliberately not HTTP status numbers. An earlier revision matched a nested numeric 401/403
 * and that was wrong in a way worth remembering: `K8sApiError` and `GithubHttpError` both
 * carry a numeric `status`, and `turnFailureCode` sees failures from far beyond the model
 * call — so a Kubernetes RBAC denial would have told the user their provider credentials
 * needed attention. A type like `authentication_error` cannot arrive from an unrelated layer,
 * so it identifies the provider without needing to prove provenance separately.
 *
 * `permissionerror` and `unauthenticated` are deliberately absent for the same reason the
 * status numbers are: this repository's own shim rejection reason IS `unauthenticated`, and
 * `failureSignals` collects `reason` — so including it would classify our own handshake
 * refusal as a provider credential problem. Only codes a provider alone emits belong here.
 */
const PROVIDER_AUTH_CODES = new Set(['authenticationerror', 'invalidapikey', 'apikeyinvalid', 'invalidauthentication'])

const PROVIDER_AUTH_MESSAGES = [
  /\brefresh token was revoked\b/i,
  /\baccess token could not be refreshed\b[\s\S]{0,160}\b(?:log out|sign out) and sign in again\b/i,
  // claude-agent-acp with an expired-but-present OAuth credential: the SDK fails
  // the refresh and the adapter surfaces it as a -32603 internal error with this
  // exact wording (a FRESH logged-out credential rejects -32000 instead).
  /\boauth session expired and could not be refreshed\b/i,
  // Anthropic and OpenAI both say this verbatim when the key itself is rejected.
  /\binvalid x-api-key\b/i,
  /\bincorrect api key provided\b/i,
  /\b(?:invalid|missing) (?:api )?(?:key|credentials)\b/i,
  /\bno auth credentials found\b/i,
  // Gemini's documented envelope: the message is phrased the other way round from every
  // other provider's, and its reason lives in a `details` array.
  /\bapi key not valid\b/i
]

/** Collect the small family of fields ACP adapters and provider SDKs use to
 * wrap an upstream error. The depth/seen guards tolerate nested `error.data`
 * and `cause` shapes without recursively inspecting an arbitrary request body.
 */
function failureSignals(value: unknown, depth = 0, seen = new Set<object>()): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (!value || typeof value !== 'object' || depth >= 5 || seen.has(value)) return []
  seen.add(value)
  const out: string[] = []
  // Providers put structured error detail in arrays — Gemini's `details[].reason` among them —
  // so an array must be walked rather than treated as a leaf object.
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 20)) out.push(...failureSignals(entry, depth + 1, seen))
    return out
  }
  for (const key of [
    'message',
    'code',
    'type',
    'reason',
    'codexErrorInfo',
    'errorInfo',
    'errorType',
    'error_type',
    'error',
    'data',
    'details',
    'cause'
  ]) {
    try {
      out.push(...failureSignals(Reflect.get(value, key), depth + 1, seen))
    } catch {
      // A hostile/custom error getter must not replace the original turn error.
    }
  }
  return out
}

export function turnFailureCode(err: unknown): TurnFailureCode {
  const signals = failureSignals(err)
  if (signals.some((signal) => PROVIDER_QUOTA_CODES.has(signal.toLowerCase().replace(/[^a-z0-9]/g, '')))) {
    return HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED
  }
  if (signals.some((signal) => PROVIDER_AUTH_CODES.has(signal.toLowerCase().replace(/[^a-z0-9]/g, '')))) {
    return HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED
  }
  const message = signals.join('\n')
  if (PROVIDER_AUTH_MESSAGES.some((pattern) => pattern.test(message))) {
    return HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED
  }
  return PROVIDER_QUOTA_MESSAGES.some((pattern) => pattern.test(message))
    ? HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED
    : 'turn_failed'
}

/**
 * Resolve how to apply `desired` to the select config option tagged `category`.
 * `{skip}` (with the reason) means nothing should be sent: the runtime
 * advertises no such selector, doesn't offer the value, or already has it set.
 */
export function planConfigSelection(
  configOptions: SessionConfigOption[] | null | undefined,
  category: string,
  desired: string
): ConfigSelectionPlan {
  const opt = configOptions?.find((o) => o.category === category && o.type === 'select')
  if (!opt || opt.type !== 'select') return { skip: `runtime advertises no ${category} selector` }
  const values = opt.options.flatMap((o) => ('group' in o ? o.options : [o])).map((o) => o.value)
  if (!values.includes(desired)) {
    return { skip: `value "${desired}" not offered (available: ${values.join(', ')})` }
  }
  if (opt.currentValue === desired) return { skip: `already "${desired}"` }
  return { configId: opt.id, value: desired }
}

// ULTRACODE_EFFORT now lives in claude-runtime.ts (with the shared Claude predicate
// and effort augmentation); re-exported here so existing importers keep working.
export { ULTRACODE_EFFORT }

/** The session `_meta` sent to a Claude runtime on session/new and session/load
 *  (`_meta.claudeCode.options` is spread into the SDK `query()` options layer), or
 *  undefined off Claude runtimes. Five things ride on it:
 *
 *  - `thinking`: recent models default `thinking.display` to "omitted" — thinking
 *    blocks stream signature-only with empty text, so the ACP wrapper never emits
 *    `agent_thought_chunk` and the transcript loses its reasoning rows. Request
 *    "summarized" (the fullest display the API offers) so thoughts reach the stream.
 *  - `settings`: for a sandboxed parent, the SDK's highest-precedence flag tier
 *    reasserts protected Anthropic profile selection after workspace settings merge;
 *    effort "ultracode" additionally carries the session-scoped flags the effort
 *    select can't reach. The adapter's CLAUDE_MODEL_CONFIG fallback is preserved in
 *    the protected settings because supplying `options.settings` replaces it.
 *  - `options.sandbox` (only when the ACP runtime already has an outer
 *    AgentConnect sandbox): enables Claude's native Bash sandbox fail-closed and
 *    denies its sandboxed commands the provider credentials the parent can read.
 *  - `disallowedTools`: suppresses Claude Code's built-in agent-teams `SendMessage`,
 *    which collides with `mcp__agentconnect__sendMessage` (#800) and can DELIVER
 *    session-private content to unrelated co-located sessions (#998). Sent on every
 *    Claude session — AgentConnect owns all inter-session messaging for its sessions.
 *  - `systemPrompt` (top-level, sibling of `claudeCode`): the agent's system-prompt
 *    seed PLUS, on a fresh session, the agent's memory index (standing context, not a
 *    user turn — see SessionManager). We send it as `{ append }` so it layers ON TOP
 *    of claude-acp's `claude_code` preset (keeping the coding scaffolding) rather than
 *    replacing it. Honored by claude-agent-acp #91; older runtimes ignore the unknown
 *    `_meta` key. This is the only channel for the system prompt — ACP session/new has
 *    no such field, and other runtimes have no equivalent yet (see cp-overlay.ts). */
/** The Claude SDK lifecycle subtypes the daemon's background-task lease needs, as
 *  `SDKMessageFilter`s for claude-agent-acp's `emitRawSDKMessages` (matched by
 *  `type`+`subtype`). Deliberately NOT `true`: the unfiltered feed is a firehose
 *  (every stream_event / assistant chunk / hook). Requested on every Claude session
 *  via {@link claudeSessionMeta}; adapters < 0.59.0 ignore the unknown `_meta` field. */
export const SDK_LIFECYCLE_FILTERS = [
  { type: 'system', subtype: 'session_state_changed' },
  { type: 'system', subtype: 'background_tasks_changed' },
  { type: 'system', subtype: 'task_started' },
  { type: 'system', subtype: 'task_updated' },
  { type: 'system', subtype: 'task_notification' }
] as const

interface ClaudeSessionSettings {
  env?: ClaudeProtectedSettings['env']
  modelOverrides?: unknown
  availableModels?: unknown
  ultracode?: true
  enableWorkflows?: true
}

export function claudeSessionMeta(
  reasoningEffort: string | undefined,
  isClaudeRuntime: boolean,
  systemPrompt?: string,
  memoryAppend?: string,
  protectedCredentialRoots?: readonly string[],
  protectedSettings?: ClaudeProtectedSettings,
  allowModelToolUnixSockets = false
):
  | {
      claudeCode: {
        options: {
          thinking: { type: 'adaptive'; display: 'summarized' }
          disallowedTools: readonly string[]
          settings?: ClaudeSessionSettings
          sandbox?: ClaudeInnerSandboxSettings
        }
        emitRawSDKMessages: ReadonlyArray<{ type: string; subtype: string }>
      }
      systemPrompt?: { append: string }
    }
  | undefined {
  if (!isClaudeRuntime) return undefined
  // The seed and the memory index ride the SAME append (seed first, blank line, then
  // memory). Either/both/neither — an empty result omits `systemPrompt` entirely.
  const append = [systemPrompt, memoryAppend].filter(Boolean).join('\n\n')
  const ultracode = reasoningEffort === ULTRACODE_EFFORT
  const settings: ClaudeSessionSettings = {
    ...(protectedSettings ?? {}),
    ...(ultracode ? { ultracode: true, enableWorkflows: true } : {})
  }
  return {
    claudeCode: {
      options: {
        thinking: { type: 'adaptive', display: 'summarized' },
        // #998: the built-in agent-teams SendMessage is a live misdelivery channel;
        // adapters spread this into SDK query() options (older ones ignore it).
        disallowedTools: CLAUDE_DISALLOWED_BUILTIN_TOOLS,
        ...(protectedCredentialRoots
          ? { sandbox: claudeInnerSandboxSettings(protectedCredentialRoots, allowModelToolUnixSockets) }
          : {}),
        ...(protectedSettings || ultracode ? { settings } : {})
      },
      emitRawSDKMessages: SDK_LIFECYCLE_FILTERS
    },
    ...(append ? { systemPrompt: { append } } : {})
  }
}

/**
 * Extract the model selector from a session's `configOptions`. ACP models are an
 * (experimental) session config option tagged `category: "model"`, `type:
 * "select"`; the selectable values (optionally grouped) are the model list.
 * Returns null when the agent advertises no model selector.
 */
export function modelOptionsFrom(configOptions: SessionConfigOption[] | null | undefined): ModelOptions | null {
  const model = configOptions?.find((o) => o.category === 'model' && o.type === 'select')
  if (!model || model.type !== 'select') return null
  // `options` is either a flat SelectOption[] or a SelectGroup[]; flatten groups.
  const models = model.options.flatMap((o) => ('group' in o ? o.options : [o])).map((o) => o.value)
  return { current: model.currentValue, models }
}

/**
 * Extract the reasoning-effort selector from a session's `configOptions` (ACP
 * `category: "thought_level"`, `type: "select"`). Effort support is per-model: a runtime
 * only advertises this select for models that support effort (e.g. Opus/Sonnet, not
 * Haiku), so a missing/empty selector means the CURRENT model has no effort → returns
 * null and the picker is hidden. When the model DOES support effort, Claude runtimes get
 * the synthetic `max`/`ultracode` entries appended if not already offered (see
 * {@link ULTRACODE_EFFORT}) — never fabricated for a model that lacks effort entirely.
 */
export function effortOptionsFrom(
  configOptions: SessionConfigOption[] | null | undefined,
  isClaudeRuntime: boolean
): EffortOptions | null {
  const opt = configOptions?.find((o) => o.category === 'thought_level' && o.type === 'select')
  if (!opt || opt.type !== 'select') return null
  const advertised = opt.options.flatMap((o) => ('group' in o ? o.options : [o])).map((o) => o.value)
  if (advertised.length === 0) return null
  // The current model supports effort — Claude additionally allows `max` (session-only)
  // and `ultracode` (xhigh + workflow orchestration), which aren't `thought_level` values.
  const efforts = isClaudeRuntime ? augmentClaudeEfforts(advertised) : advertised
  return { current: opt.currentValue, efforts }
}

/**
 * Extract the permission/approval mode selector from a session's `configOptions` (ACP
 * `category: "mode"`, `type: "select"`). Returns null when the runtime exposes no mode
 * selector.
 */
export function permissionModeOptionsFrom(
  configOptions: SessionConfigOption[] | null | undefined
): PermissionModeOptions | null {
  const opt = configOptions?.find((o) => o.category === 'mode' && o.type === 'select')
  if (!opt || opt.type !== 'select') return null
  const modes = opt.options.flatMap((o) => ('group' in o ? o.options : [o])).map((o) => o.value)
  return { current: opt.currentValue, modes }
}

/**
 * Extract the fast-mode toggle from a session's `configOptions` (ACP `category:
 * "model_config"`, `type: "select"` with on/off values). Returns null when the current
 * model advertises no fast toggle.
 */
export function fastOptionFrom(configOptions: SessionConfigOption[] | null | undefined): FastModeOption | null {
  const opt = configOptions?.find((o) => o.category === 'model_config' && o.type === 'select')
  if (!opt || opt.type !== 'select') return null
  return { current: opt.currentValue === 'on' }
}

export class AcpHost {
  private spawned?: SpawnedRuntime
  private conn?: ClientConnection
  // acpSessionIds this process created (or loaded). ACP sessions are in-memory in
  // the subprocess, so an id persisted across a daemon restart / host eviction is
  // unknown to a fresh process and must be re-created or re-loaded.
  private live = new Set<string>()
  // sessionIds currently mid-load: `session/load` makes the agent REPLAY its whole
  // history via session/update, which we must NOT forward to the platform (it would
  // re-post the entire conversation). Cleared when the load resolves.
  private loadingSessions = new Set<string>()
  // whether the agent advertised the `loadSession` capability at initialize.
  private canLoad = false
  // whether the agent accepts repository roots in addition to the session cwd.
  // This is capability-gated because older ACP adapters reject the field.
  private canUseAdditionalDirectories = false
  private canDelete = false
  // prompt content-block variants the agent opted into at initialize. text +
  // resource_link are always baseline; image/audio/embeddedContext are gated.
  private promptCaps: { image?: boolean; audio?: boolean; embeddedContext?: boolean } = {}
  // Selectors from the most recent session/new|load|set, distilled from the reconciled
  // config options. Populated by refreshOptionCaches(); read via modelOptions() /
  // effortOptions() / fastModeOption(). null ⇒ the runtime advertised no such selector.
  private lastModelOptions: ModelOptions | null = null
  private lastEffortOptions: EffortOptions | null = null
  private lastPermissionModeOptions: PermissionModeOptions | null = null
  private lastFastOption: FastModeOption | null = null
  // The most recent reconciled config-option set per live session, cached so a
  // mid-session `set_config_option` (e.g. setSessionModel) can plan against the
  // current options without a round-trip. Updated on new/load and each set.
  private sessionConfigs = new Map<string, SessionConfigOption[] | null | undefined>()
  // ACP protocol version the agent negotiated at initialize (it echoes the version
  // we requested if supported, else downgrades to its own latest). Read via
  // acpProtocolVersion(); undefined until start() completes the handshake.
  private negotiatedProtocolVersion?: number
  // Optional MCP transports the agent opted into at initialize (stdio is the ACP
  // baseline and always accepted). null until the handshake completes; the
  // unstable `acp` transport flag is deliberately ignored. Read via mcpCapabilities().
  private mcpCaps: McpTransportCapabilities | null = null
  // The ACP agent's self-reported identity from the `initialize` response
  // (`agentInfo`: name/title/version) — the ACTUAL running adapter version (e.g.
  // claude-agent-acp 0.59.0), as opposed to the registry's declared version.
  // undefined until the handshake completes or if the agent reports none. Read via
  // acpAgentInfo().
  private agentInfo?: { name: string; title?: string; version?: string }

  constructor(
    private runtime: RuntimeDef,
    private opts: {
      onUpdate: (sessionId: string, update: SessionUpdate) => void
      /**
       * Interactive permission policy for ACP `session/request_permission`. When set,
       * the daemon renders the options to the user (e.g. a Slack card) and resolves
       * with their choice. Omitted (or throwing / returning undefined) falls back to
       * the non-interactive auto-allow below — so a platform with no interactive
       * surface, or a resolver that fails, never hangs the turn.
       */
      onPermission?: (
        sessionId: string,
        params: RequestPermissionRequest
      ) => Promise<RequestPermissionResponse | undefined>
      /** Metadata-only observer for the actual permission-policy result. It receives
       *  immutable snapshots; failures/mutation attempts cannot change the policy. */
      onPermissionEvent?: (sessionId: string, params: RequestPermissionRequest, event: AcpPermissionPolicyEvent) => void
      /**
       * Structured-input policy for ACP `elicitation/create` (form mode). When set, the
       * daemon renders the form to the user (e.g. a Slack select/buttons card) and
       * resolves with their choice. Omitted / throwing / returning undefined falls back
       * to declining the elicitation — the spec has agents handle `decline` — so a
       * platform with no interactive surface, or an unrenderable form, never hangs.
       */
      onElicit?: (sessionId: string, params: CreateElicitationRequest) => Promise<CreateElicitationResponse | undefined>
      /**
       * Raw Claude SDK lifecycle messages, forwarded by claude-agent-acp ≥ 0.59.0 as
       * the `_claude/sdkMessage` ext-notification (opt-in via `emitRawSDKMessages`, see
       * {@link SDK_LIFECYCLE_FILTERS}). Feeds the daemon's background-task lease so an
       * idle host with in-flight background work is not reclaimed. `message` is passed
       * through untyped — the consumer parses defensively (unknown shapes are ignored),
       * so a future event-shape change degrades to the plain-TTL behavior rather than
       * breaking. Never fires for non-Claude runtimes or adapters that don't forward it.
       */
      onSdkLifecycle?: (sessionId: string, message: unknown) => void
      env?: Record<string, string>
      /** Files `env` points at, written by the driver in the runtime's own filesystem before start. */
      files?: SpawnFile[]
      /** Disposable compatibility probes suppress raw child stderr so a harness
       * cannot print credential material or host paths outside our sanitizer. */
      suppressChildStderr?: boolean
      /** Defaults to true. Runtime-home launches pass a complete, sanitized env so
       *  AcpHost must not merge the daemon's HOME/XDG/cache paths back into it. */
      inheritProcessEnv?: boolean
      configPrefs?: SessionConfigPrefs
      /** ACP-registry / config id of this runtime, used to isolate account-bound
       *  connectors at spawn (see account-apps.ts). Omitted ⇒ command/args fallback. */
      runtimeId?: string
      /** Whether to suppress account-bound cloud apps/connectors at spawn. Defaults
       *  to true; daemon config may explicitly opt out for all runtimes on the host. */
      isolateAccountApps?: boolean
      /** OS sandbox for the agent process (issue #312). Set by ensureHost when the
       *  the agent's effective Run in sandbox policy is on. `writable` is
       *  the workspace, private runtime HOME, and managed memory; SRT supplies
       *  private temporary storage.
       *  Absent ⇒ run unconfined (fail-open). */
      sandbox?: AcpSandboxLaunch
      /** Called once when the owned adapter process reaches terminal exit. The
       *  delegated host manager uses this to tear down its fenced cell. */
      onTerminal?: () => void
      /** Where the runtime runs. Defaults to a child process of this daemon; a
       *  cluster driver launches it in a sandbox pod and carries ACP over the
       *  network, leaving everything below this line unchanged. */
      driver?: SpawnDriver
      log?: Logger
    }
  ) {}

  /** A Claude Code runtime (its command/args reference `claude`) — these embed the
   *  @anthropic-ai/claude-agent-sdk, which needs a Claude Code executable. The one
   *  predicate lives in claude-runtime.ts, shared with the model-catalog path. */
  private isClaudeRuntime(): boolean {
    return isClaudeRuntimeDef(this.runtime)
  }

  /** codex-acp accepts CODEX_PATH to reuse the operator-installed Codex CLI instead of its bundled fallback. */
  private isCodexRuntime(): boolean {
    return [this.runtime.command, ...this.runtime.args].some((part) =>
      /(?:^|[\\/@])codex-acp(?:@[^\\/]*)?$/i.test(part)
    )
  }

  async start(): Promise<void> {
    if (this.spawned) throw new Error('AcpHost: already started')
    const env: NodeJS.ProcessEnv = {
      ...(this.opts.inheritProcessEnv === false ? {} : process.env),
      ...Object.fromEntries(this.runtime.env.map((e) => [e.name, e.value])),
      ...(this.opts.env ?? {})
    }
    // Account-app isolation defaults on even for direct AcpHost callers. When on,
    // apply the overrides AFTER all caller env is merged so nothing can accidentally
    // re-enable them. A daemon-level opt-out deliberately leaves env/argv untouched.
    const appIsolation = accountAppIsolation(this.opts.runtimeId, this.runtime, env)
    const isolateAccountApps = this.opts.isolateAccountApps !== false
    if (isolateAccountApps) {
      Object.assign(env, appIsolation.env)
      if (appIsolation.warning) this.opts.log?.warn(appIsolation.warning)
      if (appIsolation.status === 'disabled')
        this.opts.log?.info(`acp: disabled account-bound apps/connectors for ${appIsolation.runtime}`)
    } else if (appIsolation.status === 'disabled' || appIsolation.status === 'no-switch') {
      const detail =
        appIsolation.status === 'no-switch' && appIsolation.warning
          ? ` — ${appIsolation.warning.replace(/^acp: /, '')}`
          : ''
      this.opts.log?.warn(
        `acp: account-app isolation disabled by daemon config for ${appIsolation.runtime}; ` +
          `signed-in account apps/connectors may be inherited${detail}`
      )
    }
    // NOTE: the memory-backend env (disable the runtime's own memory for `managed`,
    // or redirect it under the private runtime HOME for `native`) is assembled by the daemon
    // in ensureHost via memoryProviderFor(agent).runtimeEnv() and passed in through
    // `opts.env` — it is NOT set here, so it stays per-agent-configurable. The
    // runtime prober / chat CLI construct AcpHost without that env and therefore get
    // the runtime's default memory behavior.
    // appendArgs carries any account-app-isolation flags (e.g. Copilot's
    // --disable-builtin-mcps) that must reach the adapter as CLI args.
    const spawnArgs = [...this.runtime.args, ...(isolateAccountApps ? appIsolation.appendArgs : [])]
    const driver = this.opts.driver ?? new LocalDriver({ log: this.opts.log })
    const hints = [
      ...(this.isClaudeRuntime() ? [{ envVar: 'CLAUDE_CODE_EXECUTABLE', command: 'claude' }] : []),
      ...(this.isCodexRuntime() ? [{ envVar: 'CODEX_PATH', command: 'codex' }] : [])
    ]
    const spawned = await driver.launch({
      command: this.runtime.command,
      args: spawnArgs,
      env: env as Record<string, string>,
      // The claude-agent-sdk resolves the Claude Code binary from its own bundled
      // native package (an OPTIONAL npm dep, often missing under npx / --omit=optional)
      // OR from `CLAUDE_CODE_EXECUTABLE`. If nothing set it but a `claude` CLI is on
      // PATH, point at it so an out-of-the-box Claude Code install just works. The
      // lookup belongs to the driver: only it knows the filesystem the runtime sees.
      ...(hints.length > 0 ? { hints } : {}),
      ...(this.opts.files?.length ? { files: this.opts.files } : {}),
      ...(this.opts.suppressChildStderr !== undefined ? { suppressChildStderr: this.opts.suppressChildStderr } : {}),
      ...(this.opts.sandbox ? { sandbox: this.opts.sandbox } : {})
    })
    this.spawned = spawned
    spawned.onExit(() => {
      // Clearing the handle lets stop() early-return instead of waiting on an exit
      // that already fired.
      if (this.spawned === spawned) this.spawned = undefined
      try {
        this.opts.onTerminal?.()
      } catch (err) {
        this.opts.log?.debug(`acp: terminal observer failed: ${(err as Error).message}`)
      }
    })
    const stream = ndJsonStream(spawned.toAgent, spawned.fromAgent)

    const self = this
    // fs read/write handlers are intentionally omitted (we advertise fs:false);
    // the SDK auto-replies method-not-found if the agent ever calls them.
    this.conn = createClientApp({ name: 'agentconnect' })
      .onNotification(methods.client.session.update, (ctx) => {
        // Drop historical conversation/tool chunks replayed by session/load, but
        // keep metadata such as restored titles and usage snapshots.
        if (self.loadingSessions.has(ctx.params.sessionId) && !shouldForwardUpdateDuringLoad(ctx.params.update)) return
        self.opts.onUpdate(ctx.params.sessionId, ctx.params.update)
      })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        const observedParams = self.opts.onPermissionEvent ? immutablePermissionSnapshot(ctx.params) : undefined
        const policyParams = observedParams ?? ctx.params
        const observe = (event: AcpPermissionPolicyEvent): void => {
          if (!observedParams || !self.opts.onPermissionEvent) return
          const snapshot = immutablePermissionSnapshot(event)
          if (!snapshot) return
          try {
            self.opts.onPermissionEvent(ctx.params.sessionId, observedParams, snapshot)
          } catch (err) {
            self.opts.log?.debug(`acp: onPermissionEvent(${event.kind}) failed: ${(err as Error).message}`)
          }
        }
        observe({ kind: 'requested' })
        // Interactive policy first: ask the user via the platform (Slack card, …).
        // Any failure — no resolver, an unsupported surface, a thrown error, or an
        // undefined result — falls through to the auto-allow default so the turn can
        // never hang on a permission prompt.
        let fallbackReason: 'no_resolver' | 'resolver_undefined' | 'resolver_error' = 'no_resolver'
        if (self.opts.onPermission) {
          try {
            const res = await self.opts.onPermission(ctx.params.sessionId, policyParams)
            if (res) {
              observe({ kind: 'resolved', source: 'resolver', response: res })
              return res
            }
            fallbackReason = 'resolver_undefined'
          } catch (err) {
            fallbackReason = 'resolver_error'
            self.opts.log?.debug(`acp: onPermission failed, auto-allowing: ${(err as Error).message}`)
          }
        }
        // Fallback: auto-allow the first allow option (no interactive resolution).
        const allow = policyParams.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
        const optionId = (allow ?? policyParams.options[0])?.optionId
        const response: RequestPermissionResponse = {
          outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
        }
        observe({ kind: 'resolved', source: 'fallback', fallbackReason, response })
        return response
      })
      .onRequest(methods.client.elicitation.create, async (ctx) => {
        // Structured input (choice/boolean forms). Delegate to the platform policy; on
        // any failure — no resolver, unsupported surface/form, or a thrown error — decline
        // so the agent's turn never hangs (agents are expected to handle `decline`).
        // Only session-scoped elicitations map to a live turn; request-scoped ones
        // (auth/config phase, no session) have no sessionId — decline those.
        const sessionId = (ctx.params as { sessionId?: string }).sessionId
        if (self.opts.onElicit && sessionId) {
          try {
            const res = await self.opts.onElicit(sessionId, ctx.params)
            if (res) return res
          } catch (err) {
            self.opts.log?.debug(`acp: onElicit failed, declining: ${(err as Error).message}`)
          }
        }
        return { action: 'decline' }
      })
      // Claude SDK lifecycle feed (claude-agent-acp ≥ 0.59.0). Params are
      // `{ sessionId, message }`; the message is passed through untyped and parsed
      // defensively by the consumer. Parser is a passthrough — validation lives in
      // onSdkLifecycle so an unexpected shape degrades gracefully, never throws here.
      .onNotification(
        '_claude/sdkMessage',
        { parse: (p: unknown) => p as { sessionId?: string; message?: unknown } },
        (ctx) => {
          const sessionId = ctx.params?.sessionId
          if (sessionId && self.opts.onSdkLifecycle) self.opts.onSdkLifecycle(sessionId, ctx.params.message)
        }
      )
      .connect(stream)

    const init = await this.conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        // Advertise form-based elicitation so runtimes may ask structured questions
        // (choice/boolean). Unrenderable forms / non-interactive platforms are declined
        // gracefully by the onElicit fallback above.
        elicitation: { form: {} }
      }
    })
    this.negotiatedProtocolVersion = init.protocolVersion
    this.canLoad = init.agentCapabilities?.loadSession ?? false
    this.canUseAdditionalDirectories = init.agentCapabilities?.sessionCapabilities?.additionalDirectories != null
    this.canDelete = init.agentCapabilities?.sessionCapabilities?.delete != null
    this.promptCaps = init.agentCapabilities?.promptCapabilities ?? {}
    const mcp = init.agentCapabilities?.mcpCapabilities
    this.mcpCaps = {
      http: mcp?.http ?? false,
      sse: mcp?.sse ?? false
    }
    // agentInfo is optional per the ACP spec; keep only the fields we surface.
    this.agentInfo = init.agentInfo
      ? {
          name: init.agentInfo.name,
          title: init.agentInfo.title ?? undefined,
          version: init.agentInfo.version ?? undefined
        }
      : undefined
    this.opts.log?.debug(
      `acp: agent initialized (${this.agentInfo?.name ?? 'agent'}${this.agentInfo?.version ? ` v${this.agentInfo.version}` : ''}, loadSession=${this.canLoad}, additionalDirectories=${this.canUseAdditionalDirectories}, prompt caps: image=${!!this.promptCaps.image} audio=${!!this.promptCaps.audio} embeddedContext=${!!this.promptCaps.embeddedContext}, mcp: http=${this.mcpCaps.http} sse=${this.mcpCaps.sse})`
    )
  }

  /** Whether the agent advertised support for a gated prompt content-block kind.
   *  `text` and `resource_link` are baseline and always return true. */
  promptSupports(kind: 'image' | 'audio' | 'embeddedContext'): boolean {
    return Boolean(this.promptCaps[kind])
  }

  /** Whether this runtime carries the system prompt (and the fresh-session memory
   *  index) via `_meta.systemPrompt` — true for Claude, which gets them there rather
   *  than as a leading inline block. Lets SessionManager route memory correctly:
   *  Claude → `_meta` (via newSession's memoryAppend); others → an inline block. */
  usesMetaSystemPrompt(): boolean {
    return this.isClaudeRuntime()
  }

  /** Create a fresh ACP session. `effortOverride` (the sticky per-session effort choice,
   *  when set) takes the place of the agent default in the Claude `_meta` — the only
   *  channel `ultracode` can ride (the `thought_level` select rejects it); select-based
   *  effort/model/fast overrides are layered on afterward by the daemon at turn start.
   *  `systemAppend` (the agent meta object + the agent's memory index, for a FRESH
   *  session) rides the Claude `_meta.systemPrompt` append — standing context, never a
   *  user turn (see #398). `additionalDirectories` expands the runtime workspace
   *  without changing the configured working-subdirectory `cwd`. */
  /**
   * @param announce Called with the runtime's brand-new id at the raw `session/new` response —
   *   BEFORE the session becomes reachable. Anything the daemon must know before an update can
   *   arrive belongs here: `live.add()` makes the session ownable, and the configuration round
   *   trips that follow are awaited, so a runtime may advertise from inside this call.
   *   SYNCHRONOUS on purpose: a runtime can emit the instant it has answered, and anything awaited
   *   here would widen the response-to-ownership gap into a window where that update is dropped.
   */
  async newSession(
    cwd: string,
    mcpServers: McpServer[] = [],
    effortOverride?: string,
    systemAppend?: string,
    additionalDirectories: string[] = [],
    announce?: (sessionId: string) => void
  ): Promise<string> {
    const _meta = claudeSessionMeta(
      effortOverride ?? this.opts.configPrefs?.reasoningEffort,
      this.isClaudeRuntime(),
      this.opts.configPrefs?.systemPrompt,
      systemAppend,
      this.opts.sandbox ? (this.opts.sandbox.protectedCredentialRoots ?? []) : undefined,
      this.opts.sandbox?.claudeProtectedSettings,
      this.opts.sandbox?.allowModelToolUnixSockets
    )
    const activeAdditionalDirectories = this.canUseAdditionalDirectories ? additionalDirectories : []
    const res = await this.conn!.agent.request(methods.agent.session.new, {
      cwd,
      ...(activeAdditionalDirectories.length > 0 ? { additionalDirectories: activeAdditionalDirectories } : {}),
      mcpServers,
      ...(_meta ? { _meta } : {})
    })
    announce?.(res.sessionId)
    this.live.add(res.sessionId)
    const configOptions = await this.applySessionConfig(res.sessionId, res.configOptions)
    this.refreshOptionCaches(configOptions)
    this.sessionConfigs.set(res.sessionId, configOptions)
    return res.sessionId
  }

  /**
   * Apply the desired session preferences to a fresh or restored session via ACP
   * `session/set_config_option`. Model first — the effort and fast-mode vocabularies
   * depend on the selected model, and each response returns the reconciled option set
   * the next step plans against. Best-effort by design: a runtime without the selector,
   * an unoffered value, or a failed request logs and moves on — the session still runs
   * on the runtime's defaults. Returns the final option set.
   */
  private async applySessionConfig(
    sessionId: string,
    initial: SessionConfigOption[] | null | undefined
  ): Promise<SessionConfigOption[] | null | undefined> {
    let options = initial
    // ultracode rides `_meta` on session/new|load (see claudeSessionMeta), not the
    // thought_level select — the runtime rejects effort="ultracode". When it's
    // requested, skip thought_level entirely (it would only `{skip}` anyway, and
    // ultracode already forces effort to xhigh).
    const ultracode = this.isClaudeRuntime() && this.opts.configPrefs?.reasoningEffort === ULTRACODE_EFFORT
    const fastMode = this.opts.configPrefs?.fastMode
    const prefs: Array<[category: string, desired: string | undefined]> = [
      ['model', this.opts.configPrefs?.model],
      ['mode', this.opts.configPrefs?.permissionMode],
      ['thought_level', ultracode ? undefined : this.opts.configPrefs?.reasoningEffort],
      // Fast mode comes AFTER model: the option is only advertised (and the
      // reconciled option set only carries it) once a fast-capable model is set.
      ['model_config', fastMode === undefined ? undefined : fastMode ? 'on' : 'off']
    ]
    for (const [category, desired] of prefs) {
      if (!desired) continue
      const plan = planConfigSelection(options, category, desired)
      if ('skip' in plan) {
        this.opts.log?.debug(`acp: session config ${category}="${desired}" not applied — ${plan.skip}`)
        continue
      }
      try {
        const res = await this.conn!.agent.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId: plan.configId,
          value: plan.value
        })
        options = res.configOptions
        this.opts.log?.info(`acp: session config ${category} set to "${desired}"`)
      } catch (err) {
        this.opts.log?.warn(`acp: failed to set session config ${category}="${desired}": ${(err as Error).message}`)
      }
    }
    return options
  }

  /** Re-derive the model / effort / mode / fast selector caches from a reconciled option set. */
  private refreshOptionCaches(configOptions: SessionConfigOption[] | null | undefined): void {
    this.lastModelOptions = modelOptionsFrom(configOptions)
    this.lastEffortOptions = effortOptionsFrom(configOptions, this.isClaudeRuntime())
    this.lastPermissionModeOptions = permissionModeOptionsFrom(configOptions)
    this.lastFastOption = fastOptionFrom(configOptions)
  }

  /** The model selector for one live session, or the most recently reconciled
   *  selector when no session is supplied (runtime probing/backward compatibility). */
  modelOptions(sessionId?: string): ModelOptions | null {
    if (sessionId !== undefined) return modelOptionsFrom(this.sessionConfigs.get(sessionId))
    return this.lastModelOptions
  }

  /** The last reconciled RAW config options for one live session, exactly as the
   *  runtime advertised them — no synthetic augmentation, no filtering (the model
   *  catalog caches raw efforts; augmentation happens at report time). undefined
   *  when the session isn't known here or the runtime advertised no options. */
  sessionConfigOptions(sessionId: string): SessionConfigOption[] | undefined {
    return this.sessionConfigs.get(sessionId) ?? undefined
  }

  /** The reasoning-effort selector (incl. synthetic ultracode/max on Claude runtimes)
   *  from the most recent session/new|load, or null if none is offered. */
  effortOptions(): EffortOptions | null {
    return this.lastEffortOptions
  }

  /** The permission/approval mode selector for one live session, or the most recently
   *  reconciled selector when no session is supplied. */
  permissionModeOptions(sessionId?: string): PermissionModeOptions | null {
    if (sessionId !== undefined) return permissionModeOptionsFrom(this.sessionConfigs.get(sessionId))
    return this.lastPermissionModeOptions
  }

  /** The fast-mode toggle from the most recent session/new|load, or null if the current
   *  model offers no fast mode. */
  fastModeOption(): FastModeOption | null {
    return this.lastFastOption
  }

  /**
   * Apply one select config option to an ALREADY-RUNNING session via ACP
   * `session/set_config_option`, refreshing the cached option set + selector caches on
   * success. Returns true iff applied: false when the session isn't live here, the
   * runtime advertises no such selector, the value isn't offered, or it's already set.
   */
  private async setSessionConfig(sessionId: string, category: string, value: string): Promise<boolean> {
    if (!this.live.has(sessionId)) return false
    const plan = planConfigSelection(this.sessionConfigs.get(sessionId), category, value)
    if ('skip' in plan) {
      this.opts.log?.debug(`acp: set ${category}="${value}" on ${sessionId} not applied — ${plan.skip}`)
      return false
    }
    const res = await this.conn!.agent.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: plan.configId,
      value: plan.value
    })
    this.sessionConfigs.set(sessionId, res.configOptions)
    this.refreshOptionCaches(res.configOptions)
    this.opts.log?.info(`acp: session ${sessionId} ${category} set to "${value}"`)
    return true
  }

  /** Switch the model of an already-running session (ACP `model` select) — the
   *  mid-session counterpart of the model applied at new/load. */
  async setSessionModel(sessionId: string, model: string): Promise<boolean> {
    return this.setSessionConfig(sessionId, 'model', model)
  }

  /** Switch the reasoning effort of an already-running session (ACP `thought_level`
   *  select). Returns false for `ultracode` — it isn't a select value and can only ride
   *  session `_meta` at new/load, so the caller relies on the override being re-applied
   *  when the session is next (re)created or resumed. */
  async setSessionEffort(sessionId: string, effort: string): Promise<boolean> {
    if (effort === ULTRACODE_EFFORT) return false
    return this.setSessionConfig(sessionId, 'thought_level', effort)
  }

  /** Switch the permission/approval mode of an already-running session (ACP `mode`
   *  select). Values are runtime-owned and validated against the advertised options. */
  async setSessionPermissionMode(sessionId: string, mode: string): Promise<boolean> {
    return this.setSessionConfig(sessionId, 'mode', mode)
  }

  /** Toggle fast mode on an already-running session (ACP `model_config` on/off select).
   *  False when the current model offers no fast toggle. */
  async setSessionFastMode(sessionId: string, on: boolean): Promise<boolean> {
    return this.setSessionConfig(sessionId, 'model_config', on ? 'on' : 'off')
  }

  /** The ACP protocol version negotiated at initialize, or undefined before the
   *  handshake completed. Used by the runtime probe to report ACP coverage. */
  acpProtocolVersion(): number | undefined {
    return this.negotiatedProtocolVersion
  }

  /** The ACP agent's self-reported identity (`agentInfo` from `initialize`): the
   *  actual running adapter name/version (e.g. claude-agent-acp 0.59.0), not the
   *  registry's declared version. undefined before the handshake or if the agent
   *  reports none. */
  acpAgentInfo(): { name: string; title?: string; version?: string } | undefined {
    return this.agentInfo
  }

  /** The optional MCP transports the agent advertised at initialize (stdio is
   *  baseline and always accepted; the unstable `acp` flag is ignored). null
   *  before the handshake completed. Feeds the runtime probe's transport gating. */
  mcpCapabilities(): McpTransportCapabilities | null {
    return this.mcpCaps
  }

  /** True iff THIS agent process created or loaded `sessionId` in its current lifetime. */
  hasSession(sessionId: string): boolean {
    return this.live.has(sessionId)
  }

  /** True while a session/load is in flight — the session is this host's, but `live` does not hold it
   *  yet. A caller identifying "is this session mine" from an update must accept this window too, or
   *  it depends on whether the adapter emits before or after the load response. */
  isLoadingSession(sessionId: string): boolean {
    return this.loadingSessions.has(sessionId)
  }

  /** Force the next exact-session turn through session/load/new so a rotated
   * session-scoped MCP descriptor is installed before another prompt. */
  forgetSession(sessionId: string): void {
    this.live.delete(sessionId)
    this.loadingSessions.delete(sessionId)
    this.sessionConfigs.delete(sessionId)
  }

  /** Whether the agent advertised the `loadSession` capability (session/load is usable). */
  loadSupported(): boolean {
    return this.canLoad
  }

  /** Whether the agent advertised support for ACP session/delete. */
  deleteSupported(): boolean {
    return this.canDelete
  }

  /** Resume a previously-created session by id (ACP `session/load`). The agent
   *  restores its own history server-side; replayed conversation/tool output is
   *  suppressed while metadata updates still converge. `mcpServers` must be
   *  re-attached here — the agent doesn't persist them across processes. `systemAppend`
   *  (agent metadata plus standing collaboration/response rules) is re-asserted via
   *  `_meta.systemPrompt` so a session resumed in a fresh agent process keeps its system
   *  prompt. Throws if the agent can't load the id
   *  (caller falls back to newSession). */
  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: McpServer[] = [],
    effortOverride?: string,
    systemAppend?: string,
    additionalDirectories: string[] = []
  ): Promise<void> {
    this.loadingSessions.add(sessionId)
    try {
      const _meta = claudeSessionMeta(
        effortOverride ?? this.opts.configPrefs?.reasoningEffort,
        this.isClaudeRuntime(),
        systemAppend ?? this.opts.configPrefs?.systemPrompt,
        undefined,
        this.opts.sandbox ? (this.opts.sandbox.protectedCredentialRoots ?? []) : undefined,
        this.opts.sandbox?.claudeProtectedSettings,
        this.opts.sandbox?.allowModelToolUnixSockets
      )
      const activeAdditionalDirectories = this.canUseAdditionalDirectories ? additionalDirectories : []
      const res = await this.conn!.agent.request(methods.agent.session.load, {
        sessionId,
        cwd,
        ...(activeAdditionalDirectories.length > 0 ? { additionalDirectories: activeAdditionalDirectories } : {}),
        mcpServers,
        ...(_meta ? { _meta } : {})
      })
      this.live.add(sessionId)
      // Re-apply config prefs: ACP sessions restore their own last model/effort,
      // which may predate a CP-side agent edit.
      const configOptions = await this.applySessionConfig(sessionId, res.configOptions)
      // Refresh the selectors from the reconciled options — a resumed session must
      // report its own model/effort/fast, not stale ones from the last session/new (or
      // null if this process never created one). Mirrors newSession().
      this.refreshOptionCaches(configOptions)
      this.sessionConfigs.set(sessionId, configOptions)
      this.opts.log?.info(`acp: resumed session ${sessionId} via session/load`)
    } catch (err) {
      this.opts.log?.debug(`acp: session/load failed for ${sessionId} (${(err as Error).message}) — will recreate`)
      throw err
    } finally {
      this.loadingSessions.delete(sessionId)
    }
  }

  /** Drive one turn to completion. Returns the stop reason plus the agent's token
   *  `usage` when the runtime reports it. Usage semantics are adapter-defined;
   *  AgentConnect's managed Codex adapter returns one ACP-prompt delta. */
  async prompt(sessionId: string, blocks: ContentBlock[]): Promise<{ stopReason: StopReason; usage?: Usage }> {
    const res = await this.conn!.agent.request(methods.agent.session.prompt, { sessionId, prompt: blocks })
    return { stopReason: res.stopReason, usage: res.usage ?? undefined }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.conn!.agent.notify(methods.agent.session.cancel, { sessionId })
  }

  /** Delete persisted adapter state when supported, then release local ownership. */
  async deleteSession(sessionId: string): Promise<boolean> {
    if (!this.canDelete) return false
    await this.conn!.agent.request(methods.agent.session.delete, { sessionId })
    this.forgetSession(sessionId)
    return true
  }

  /** Forget a failed setup locally without deleting persisted adapter state. */
  discardSession(sessionId: string): void {
    this.live.delete(sessionId)
    this.sessionConfigs.delete(sessionId)
  }

  /** Stop the adapter child: stdin EOF + SIGTERM, then escalate to SIGKILL if it
   *  hasn't exited within `deadlineMs` (a buggy/hung agent must never block daemon
   *  shutdown or an idle reap). Signals target the child's process group (it is
   *  spawned detached) so they reach the real adapter behind an npx wrapper too.
   *  Idempotent — the child handle is cleared up front so a concurrent stop (drain
   *  + reconcile racing) is a no-op rather than a double-kill. */
  async stop(deadlineMs = 5000): Promise<void> {
    const spawned = this.spawned
    if (!spawned) return
    this.spawned = undefined
    await spawned.stop(deadlineMs)
  }
}
