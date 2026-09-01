import type { RuntimeDef } from '../config/config-schema.js'

/**
 * Account-app / connector isolation for ACP runtimes.
 *
 * A signed-in ACP runtime can implicitly inherit connectors from the user's
 * cloud account (ChatGPT "apps", claude.ai connectors, xAI managed connectors,
 * …) — Gmail/Slack/Drive-style tools that act through the *user's* identity.
 * AgentConnect should expose only explicitly-configured runtime capabilities
 * plus its own explicit MCP servers (attached via ACP `session/new`); it must
 * NOT inherit account-bound cloud apps implicitly.
 *
 * The threat is specifically **cross-machine identity inheritance**: the connector
 * authorization lives on the cloud *account* (server-side), so a fresh, clean
 * machine that merely authenticates as that identity immediately gains the
 * connectors — the "clean machine" assumption that AgentConnect otherwise relies
 * on does not help. That is the discriminator used below:
 *   - If auth on a clean machine alone surfaces account-bound connectors → disable them.
 *   - If connectors only ever come from LOCAL config (auth grants model access only) →
 *     a clean machine inherits nothing, so there is nothing to do (`not-applicable`).
 *
 * This module maps each known runtime to the *verified* spawn-time switch that
 * disables ONLY those account-bound connectors, while leaving three things
 * untouched: (1) the runtime's local, project, and system MCP config; (2) the
 * MCP servers AgentConnect injects over ACP; (3) the account sign-in itself
 * (we disable the connectors, not the login / model access).
 *
 * Each switch below is confirmed against the runtime's shipped code or official
 * docs (July 2026). The cardinal rule is **never guess a switch**: a broad
 * "disable MCP" flag would also strip AgentConnect's own injected servers, so a
 * runtime that inherits account connectors on a clean machine but has no verified
 * narrow switch is reported as a gap (`no-switch`) rather than silently mishandled.
 */

export type AccountAppStatus =
  /** We actively disabled the runtime's account-bound connectors. */
  | 'disabled'
  /** The runtime has no account-connector concept (local-config MCP only). */
  | 'not-applicable'
  /** The runtime can inherit account connectors but exposes no safe switch. */
  | 'no-switch'
  /** Unrecognized runtime — connector behavior not verified. */
  | 'unknown'

export interface AccountAppIsolation {
  /** The runtime id we classified (echoes the input id, or the raw command). */
  runtime: string
  status: AccountAppStatus
  /** Env vars to merge into the spawn env (may be empty). */
  env: Record<string, string>
  /** Extra CLI args to append to the spawn command (may be empty). */
  appendArgs: string[]
  /** Operator-facing warning — a `no-switch` gap, or a discarded unsafe config. */
  warning?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Preserve every caller-supplied Codex config field while forcing account apps
 * off. `CODEX_CONFIG` (a JSON object the codex-acp adapter merges into the Codex
 * session config) may already carry unrelated fields (model, features, …); we
 * keep them and only set `features.apps=false`, which drops the built-in
 * `codex_apps` connector server without touching `mcp_servers`.
 */
export function codexConfigWithAccountAppsDisabled(raw: string | undefined): string {
  let config: Record<string, unknown> = {}
  if (raw?.trim()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('CODEX_CONFIG must be a valid JSON object before AgentConnect can disable account apps')
    }
    if (!isObject(parsed)) {
      throw new Error('CODEX_CONFIG must be a JSON object before AgentConnect can disable account apps')
    }
    config = parsed
  }

  const features = config.features
  if (features !== undefined && !isObject(features)) {
    throw new Error('CODEX_CONFIG.features must be a JSON object before AgentConnect can disable account apps')
  }

  return JSON.stringify({
    ...config,
    features: { ...(features ?? {}), apps: false }
  })
}

/**
 * Runtimes whose signed-in cloud account can inject connectors, WITH a verified
 * narrow switch. `apply` returns the env/args that disable ONLY the account-bound
 * servers. `sig` is a command/args fallback so a runtime that launches a known
 * adapter under a non-standard id (or after an ACP-registry id rename) is still
 * caught — the security-relevant direction.
 */
interface DisableSpec {
  id: string
  /** Matches any part of [command, ...args], lower-cased. */
  sig: RegExp
  apply: (env: Record<string, string | undefined>) => {
    env?: Record<string, string>
    appendArgs?: string[]
    warning?: string
  }
}

const DISABLE: DisableSpec[] = [
  {
    // OpenInterpreter/open-interpreter@a5fddab44f8aa3a26865c990ecf04a644d2948e7
    // carries Codex Apps. The global feature override removes only `apps` and
    // preserves configured plus ACP-injected MCP servers.
    id: 'open-interpreter',
    sig: /(?:^|[\\/])interpreter(?:@[^\\/]*)?$/,
    apply: () => ({ appendArgs: ['--disable', 'apps'] })
  },
  {
    // OpenAI Codex — ChatGPT account "apps"/connectors. `features.apps=false`
    // (Feature::Apps, Stage::Stable) removes only the built-in `codex_apps`
    // MCP server; local config.toml + ACP-injected `mcp_servers` are untouched.
    id: 'codex-acp',
    sig: /(?:^|[\\/])codex-acp(?:@[^\\/]*)?$/,
    apply: (env) => {
      try {
        return { env: { CODEX_CONFIG: codexConfigWithAccountAppsDisabled(env.CODEX_CONFIG) } }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        // An unsafe inherited CODEX_CONFIG must not block startup — discard it
        // and continue with a minimal apps-off config, but tell the operator.
        return {
          env: { CODEX_CONFIG: codexConfigWithAccountAppsDisabled(undefined) },
          warning: `acp: ignoring unsafe inherited CODEX_CONFIG while disabling account apps — ${reason}`
        }
      }
    }
  },
  {
    // Anthropic Claude Code — claude.ai account connectors. Real env var added in
    // Claude Code v2.1.63; disables only claude.ai connectors, leaving explicit
    // (--mcp-config / ACP-injected) and local .mcp.json servers unaffected.
    // The signature matches the claude ACP adapter package / a `claude` binary —
    // NOT a bare "claude" substring, so an incidental `.claude/` path never trips it.
    id: 'claude-acp',
    sig: /(?:^|[\\/@])claude(?:-[a-z-]+)?(?:@[^\\/]*)?$/,
    apply: () => ({ env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } })
  },
  {
    // xAI Grok — managed MCP gateway auto-injects the account's connectors
    // (Slack/Linear/Sentry/Drive…) by default. The master switch disables the
    // fetch + auto-inject; local `grok mcp` servers and ACP plugin servers use
    // separate gates and stay intact.
    id: 'grok-build',
    sig: /(?:^|[\\/])grok(?:@[^\\/]*)?$|xai-official[\\/]grok/,
    apply: () => ({
      env: { GROK_MANAGED_MCPS_ENABLED: 'false', GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: 'false' }
    })
  },
  {
    // GitHub Copilot CLI — the built-in, remote GitHub MCP server acts through
    // the signed-in GitHub identity. This flag drops only the built-in server(s);
    // AgentConnect's servers (--additional-mcp-config / ACP) and the user's
    // ~/.copilot/mcp-config.json are unaffected.
    id: 'github-copilot-cli',
    sig: /(?:^|[\\/])copilot(?:@[^\\/]*)?$|@github[\\/]copilot/,
    apply: () => ({ appendArgs: ['--disable-builtin-mcps'] })
  }
]

/**
 * Runtimes a clean machine inherits NO account connectors from: every tool comes
 * from local config files (or explicitly-installed extensions) plus AgentConnect's
 * own ACP-injected servers. Sign-in grants model/provider access only. There is
 * nothing account-bound to disable, and any broad MCP-off switch would wrongly
 * strip the local/injected servers — so we deliberately do nothing.
 *
 * `cursor` and `opencode` DO have a server-side path, but only when signed into a
 * corporate Cursor team (behind a default-off server flag) or an opencode org —
 * never on a clean personal machine. AgentConnect assumes clean machines and does
 * not manage the enterprise/org case, so they live here (no per-spawn warning).
 */
const NOT_APPLICABLE = new Set<string>([
  'gemini', // @google/gemini-cli — MCP from settings.json only
  'qwen-code', // Gemini-CLI fork — MCP from settings.json only
  'goose', // Block goose — extensions from local config files only
  'amp-acp', // Sourcegraph Amp — amp.mcpServers from local settings only
  'cline', // Cline — cline_mcp_settings.json + ACP-injected only (enterprise remoteMCPServers schema is inert)
  'kimi', // Moonshot Kimi CLI — ~/.kimi/mcp.json only; login is model access
  'devin', // Cognition Devin CLI — local .devin config only (no account sync)
  'factory-droid', // Factory Droid — local mcp.json only; registry writes local
  'pi-acp', // pi adapter — BYO-key; doesn't even forward MCP to pi
  'hermes', // Nous Research — local ~/.hermes config only
  'hermes-agent', // Nous Research — local HERMES_HOME config only
  'kiro-cli', // local settings + explicitly configured MCP only
  'maki', // local Lua/configured MCP only
  'openclaw', // tools come from the machine-local Gateway's own config — no cloud-account connector sync
  'zeroclaw', // local config + ACP-supplied MCP only
  'omp', // local config + explicitly configured MCP only
  'cursor', // Team MCP only via enterprise dashboard (default-off flag) — not on a clean machine
  'opencode' // Org MCP only when signed into an opencode org — not on a clean machine
])

/**
 * Runtimes whose signed-in account injects connectors on ANY clean machine but
 * which expose NO safe spawn-time switch — only destructive levers that would also
 * break auth or strip the user's local / AgentConnect's injected MCP. We surface
 * the gap instead of guessing. Each string is the operator-facing warning.
 */
const NO_SWITCH: Record<string, string> = {
  auggie:
    'no narrow switch — the --acp path pulls account-connected native integrations and ' +
    'org/user registry MCP from the Augment backend; --no-cloud does not disable it'
}

/** True if any part of [command, ...args] (lower-cased) matches `sig`. */
function signatureMatches(runtime: RuntimeDef, sig: RegExp): boolean {
  return [runtime.command, ...runtime.args].some((part) => sig.test(part.toLowerCase()))
}

function applyDisable(spec: DisableSpec, env: Record<string, string | undefined>): AccountAppIsolation {
  const { env: e, appendArgs, warning } = spec.apply(env)
  return { runtime: spec.id, status: 'disabled', env: e ?? {}, appendArgs: appendArgs ?? [], warning }
}

/**
 * Compute the account-app isolation for a runtime. `runtimeId` is the ACP-registry
 * / config key and is AUTHORITATIVE: a recognized id is classified directly, never
 * overridden by an incidental command/args substring. Only when the id is unknown
 * do we fall back to a command/args signature — and only for the security-critical
 * disable set (a known adapter launched under a custom id, or after a registry id
 * rename). `env` backs Codex's CODEX_CONFIG merge. The returned env/args are applied
 * AFTER all caller env is merged, so nothing can accidentally re-enable connectors.
 */
export function accountAppIsolation(
  runtimeId: string | undefined,
  runtime: RuntimeDef,
  env: Record<string, string | undefined>
): AccountAppIsolation {
  const empty = { env: {}, appendArgs: [] as string[] }

  // 1. Authoritative: exact runtime-id classification.
  if (runtimeId) {
    const spec = DISABLE.find((s) => s.id === runtimeId)
    if (spec) return applyDisable(spec, env)
    if (NOT_APPLICABLE.has(runtimeId)) return { runtime: runtimeId, status: 'not-applicable', ...empty }
    if (runtimeId in NO_SWITCH) {
      return {
        runtime: runtimeId,
        status: 'no-switch',
        ...empty,
        warning: `acp: cannot isolate account-bound connectors for runtime "${runtimeId}" — ${NO_SWITCH[runtimeId]}`
      }
    }
  }

  // 2. Fallback (unknown id only): catch a known adapter launched under a custom id.
  for (const spec of DISABLE) {
    if (signatureMatches(runtime, spec.sig)) return applyDisable(spec, env)
  }

  // 3. Truly unrecognized — surface the gap rather than assume it's safe.
  const id = runtimeId ?? runtime.command
  return {
    runtime: id,
    status: 'unknown',
    ...empty,
    warning:
      `acp: account-connector isolation not verified for runtime "${id}" — ` +
      'no known account-app switch; ensure the runtime does not inherit account-bound connectors'
  }
}
