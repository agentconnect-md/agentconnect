/**
 * Runtime-native memory capability registry.
 *
 * AgentConnect's providers are runtime-independent, but `managed` and `none`
 * must suppress a harness's OWN cross-session memory, while `native` must both
 * relocate that memory under the agent root and expose its files to the console.
 * Those levers are harness-specific and security-sensitive, so they live in one
 * explicit registry rather than being scattered across provider branches.
 *
 * Convention for adding a supported harness:
 *  1. classify its persistent-memory behavior against official docs / shipped code;
 *  2. add a policy with a verified disable switch (or a verified no-op when the
 *     harness has no native persistent memory at all);
 *  3. add `native` env/read-root only when both isolation and file surfacing are
 *     verified; and
 *  4. declare the expected providers in the curated ACP matrix. Its contract test
 *     makes an omitted or drifting classification fail CI.
 *
 * Unknown runtimes keep `managed` available (our store still works) but cannot
 * claim the stronger `none` or `native` semantics: those fail closed upstream.
 */
import { join } from 'node:path'
import type { RuntimeDef } from '../../config/config-schema.js'

export interface RuntimeMemoryCapabilities {
  managed: true
  none: boolean
  native: boolean
}

/** The native provider's verified redirect + console read root. */
export interface NativeRuntimeMemorySpec {
  env: (agentRoot: string) => Record<string, string>
  readRoot: (agentRoot: string) => string
}

interface RuntimeMemoryPolicy {
  /** ACP registry/config id used as the authoritative match when present. */
  id: string
  /** Command/args fallback for aliases and user-defined runtime ids. */
  sig: RegExp
  /** Verified way to turn the harness's own persistent memory off. */
  disabledEnv: (effectiveEnv: NodeJS.ProcessEnv) => Record<string, string>
  /** Present only when native storage isolation + console surfacing are verified. */
  native?: NativeRuntimeMemorySpec
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Preserve unrelated Codex config while forcing only the memories feature. */
function codexConfigWithMemories(raw: string | undefined, enabled: boolean): string {
  let config: Record<string, unknown> = {}
  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('effective CODEX_CONFIG must be a valid JSON object')
    }
    if (!isObject(parsed)) throw new Error('effective CODEX_CONFIG must be a valid JSON object')
    config = parsed
  }
  const features = config.features
  if (features !== undefined && !isObject(features)) {
    throw new Error('CODEX_CONFIG.features must be a JSON object')
  }
  return JSON.stringify({
    ...config,
    features: { ...(features ?? {}), memories: enabled }
  })
}

/**
 * One source of truth for both suppression (`managed` / `none`) and native
 * redirection. Every switch below was verified against official docs or shipped
 * code; never guess a flag for an unregistered harness.
 */
const RUNTIME_MEMORY_POLICIES: RuntimeMemoryPolicy[] = [
  {
    // NousResearch/hermes-agent@30c7913617a63773c15a11900d24ac362b7609c8:
    // ACP does not forward skip_memory. The actual off-switch is a sanitized
    // private config written by launch/compose.ts.
    id: 'hermes-agent',
    sig: /(?:^|[\\/])hermes(?:@[^\\/]*)?$/,
    disabledEnv: () => ({})
  },
  {
    // OpenInterpreter/open-interpreter@a5fddab44f8aa3a26865c990ecf04a644d2948e7:
    // compose.ts appends the global `--disable memories` override.
    id: 'open-interpreter',
    sig: /(?:^|[\\/])interpreter(?:@[^\\/]*)?$/,
    disabledEnv: () => ({})
  },
  {
    // https://kiro.dev/docs/cli/acp/ and /reference/settings/, reviewed
    // 2026-07-17: no automatic cross-session personal-memory provider.
    id: 'kiro-cli',
    sig: /(?:^|[\\/])kiro-cli(?:@[^\\/]*)?$/,
    disabledEnv: () => ({})
  },
  {
    // zeroclaw-labs/zeroclaw@0528f98936d1bda925d7ef930995bd285a252243:
    // ACP chat mode already sets exclude_memory=true.
    id: 'zeroclaw',
    sig: /(?:^|[\\/])zeroclaw(?:@[^\\/]*)?$/,
    disabledEnv: () => ({})
  },
  {
    // can1357/oh-my-pi@b0d04e517335ada4e00ef8dc93aad9f4d1be8d21:
    // compose.ts appends a trusted memory.backend=off config overlay.
    id: 'omp',
    sig: /(?:^|[\\/])omp(?:@[^\\/]*)?$/,
    disabledEnv: () => ({})
  },
  {
    id: 'claude-acp',
    sig: /(?:^|[\\/@])claude(?:-[a-z-]+)?(?:@[^\\/]*)?$/,
    disabledEnv: () => ({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }),
    native: {
      env: (root) => ({ CLAUDE_CONFIG_DIR: join(root, '.claude') }),
      // Claude keys auto-memory by a cwd-derived project subdirectory.
      readRoot: (root) => join(root, '.claude', 'projects')
    }
  },
  {
    id: 'codex-acp',
    sig: /(?:^|[\\/])codex(?:-acp)?(?:@[^\\/]*)?$/,
    disabledEnv: (env) => ({ CODEX_CONFIG: codexConfigWithMemories(env.CODEX_CONFIG, false) }),
    native: {
      env: (root) => ({ CODEX_HOME: join(root, '.codex') }),
      readRoot: (root) => join(root, '.codex', 'memories')
    }
  },
  {
    // xAI Grok Build: GROK_MEMORY is the documented cross-session-memory master
    // switch (0=off). `native` is deliberately absent: GROK_HOME also owns auth,
    // sessions, config, skills, and logs, so redirect/file-surfacing needs a
    // separate isolation design before it can be offered safely.
    id: 'grok-build',
    sig: /(?:^|[\\/])grok(?:@[^\\/]*)?$|xai-official[\\/]grok/,
    disabledEnv: () => ({ GROK_MEMORY: '0' })
  }
]

function signatureMatches(runtime: RuntimeDef, sig: RegExp): boolean {
  return [runtime.command, ...runtime.args].some((part) => sig.test(part.toLowerCase()))
}

/** Exact known id wins; aliases/custom ids fall back to the command/args signature. */
function policyFor(runtime: RuntimeDef, runtimeId?: string): RuntimeMemoryPolicy | undefined {
  // The registry historically used `hermes` while the curated catalog uses
  // `hermes-agent`; both ids must receive the same verified sanitizer even when
  // a user wraps the executable with a command whose signature is unrecognizable.
  if (runtimeId === 'hermes') return RUNTIME_MEMORY_POLICIES.find((p) => p.id === 'hermes-agent')
  // Maki is an explicit managed-only classification, not an unknown alias. Do
  // not let a misleading command signature upgrade it to a verified off-switch.
  if (runtimeId === 'maki') return undefined
  const exact = runtimeId ? RUNTIME_MEMORY_POLICIES.find((p) => p.id === runtimeId) : undefined
  return exact ?? RUNTIME_MEMORY_POLICIES.find((p) => signatureMatches(runtime, p.sig))
}

/** Canonical policy id after exact-id/signature matching. Used by the launch
 * composer for policies whose verified switch is argv or a generated file. */
export function runtimeMemoryPolicyId(runtime: RuntimeDef, runtimeId?: string): string | undefined {
  return policyFor(runtime, runtimeId)?.id
}

/** Provider support for UI/facts/tests. Managed is universal; none/native are verified-only. */
export function runtimeMemoryCapabilities(runtime: RuntimeDef, runtimeId?: string): RuntimeMemoryCapabilities {
  const policy = policyFor(runtime, runtimeId)
  return { managed: true, none: policy !== undefined, native: policy?.native !== undefined }
}

/** Verified env that turns runtime-native memory off; undefined means unclassified. */
export function runtimeMemoryDisabledEnv(
  runtime: RuntimeDef,
  effectiveEnv: NodeJS.ProcessEnv = {},
  runtimeId?: string
): Record<string, string> | undefined {
  return policyFor(runtime, runtimeId)?.disabledEnv(effectiveEnv)
}

/** Native redirect/read-root policy, or undefined when native is unsupported. */
export function nativeRuntimeMemorySpecFor(
  runtime: RuntimeDef | undefined,
  runtimeId?: string
): NativeRuntimeMemorySpec | undefined {
  if (!runtime) return undefined
  return policyFor(runtime, runtimeId)?.native
}

/** Operator-facing runtime label that does not hide an npx/uvx package in args. */
export function describeRuntime(runtime: RuntimeDef, runtimeId?: string): string {
  const command = [runtime.command, ...runtime.args].join(' ')
  return runtimeId ? `${runtimeId} (${command})` : command
}
