import { resolve } from 'node:path'
import type { RuntimeDef } from '../config/config-schema.js'

/** Effort sentinel `'ultracode'` (matching Claude Code's own `ultracode` settings
 *  key) meaning xhigh reasoning PLUS standing dynamic-workflow orchestration. It is
 *  deliberately NOT a `thought_level` select value: the claude-acp runtime rejects
 *  effort="ultracode" ("Invalid value"). See `claudeSessionMeta` in acp-host.ts. */
export const ULTRACODE_EFFORT = 'ultracode'

/** Provider credential files that the trusted Claude parent may read but its
 * native sandbox must hide from model-authored Bash. */
const CLAUDE_PROVIDER_CREDENTIAL_FILE_ENV = [
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS'
] as const

/** Anthropic profile selectors from operator/agent input are unsupported for
 * sandboxed Claude launches. The spawn environment drops both before the config
 * root is replaced with a daemon-owned empty directory; per-session flag settings
 * then reassert that root and a fixed profile after user/project settings merge. */
export const CLAUDE_PROFILE_ENV = ['ANTHROPIC_CONFIG_DIR', 'ANTHROPIC_PROFILE'] as const
export const CLAUDE_DISABLED_PROFILE = 'agentconnect-disabled'

export interface ClaudeProtectedSettings {
  env: Record<(typeof CLAUDE_PROFILE_ENV)[number], string>
  modelOverrides?: unknown
  availableModels?: unknown
}

/** Build the highest-precedence SDK flag settings that pin Anthropic profile
 * discovery after Claude has merged user/project/local settings. Supplying any
 * `options.settings` makes claude-agent-acp skip its CLAUDE_MODEL_CONFIG fallback,
 * so preserve the two fields that fallback would otherwise contribute. */
export function claudeProtectedSettings(env: NodeJS.ProcessEnv): ClaudeProtectedSettings {
  const configDir = env.ANTHROPIC_CONFIG_DIR
  if (!configDir) throw new Error('sandboxed Claude launch is missing its protected Anthropic config root')

  const modelConfig: Pick<ClaudeProtectedSettings, 'modelOverrides' | 'availableModels'> = {}
  if (env.CLAUDE_MODEL_CONFIG) {
    const parsed = JSON.parse(env.CLAUDE_MODEL_CONFIG) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('CLAUDE_MODEL_CONFIG must be a JSON object')
    }
    const value = parsed as Record<string, unknown>
    if (value.modelOverrides !== undefined) modelConfig.modelOverrides = value.modelOverrides
    if (value.availableModels !== undefined) modelConfig.availableModels = value.availableModels
  }

  return {
    ...modelConfig,
    env: {
      ANTHROPIC_CONFIG_DIR: configDir,
      ANTHROPIC_PROFILE: CLAUDE_DISABLED_PROFILE
    }
  }
}

/** Claude provider credentials the parent runtime may consume but the native
 * sandbox removes from sandboxed Bash commands. Shared-login credentials normally
 * live in a file; these cover explicit API/gateway configurations as well. */
const CLAUDE_PROVIDER_CREDENTIAL_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  ...CLAUDE_PROFILE_ENV,
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS'
] as const

type ClaudeCredentialPathEnv = (typeof CLAUDE_PROVIDER_CREDENTIAL_FILE_ENV)[number]

/** Discover direct provider credential file pointers from the trusted runtime
 * environment. Profile JSON is deliberately not inspected: agent-writable input
 * must never generate an outer-sandbox exception. */
export function claudeProviderCredentialFiles(
  env: NodeJS.ProcessEnv,
  cwd: string
): Array<{ envName: ClaudeCredentialPathEnv; path: string }> {
  return CLAUDE_PROVIDER_CREDENTIAL_FILE_ENV.flatMap((name) => {
    const path = env[name]?.trim()
    return path ? [{ envName: name, path: resolve(cwd, path) }] : []
  })
}

export interface ClaudeInnerSandboxSettings {
  enabled: true
  failIfUnavailable: true
  autoAllowBashIfSandboxed: true
  allowUnsandboxedCommands: false
  network: {
    allowAllUnixSockets: boolean
  }
  filesystem: {
    denyRead: string[]
    denyWrite: string[]
  }
  credentials: {
    files: Array<{ path: string; mode: 'deny' }>
    envVars: Array<{ name: (typeof CLAUDE_PROVIDER_CREDENTIAL_ENV)[number]; mode: 'deny' }>
  }
}

/** Build the SDK-native policy passed through claude-agent-acp's
 * `_meta.claudeCode.options.sandbox`. The outer AgentConnect SRT remains the host
 * boundary; this nested sandbox confines model-authored Bash and its descendants,
 * while the parent Claude process retains shared-login access. */
export function claudeInnerSandboxSettings(
  protectedCredentialRoots: readonly string[],
  allowAllUnixSockets = false
): ClaudeInnerSandboxSettings {
  const roots = [...new Set(protectedCredentialRoots)]
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    // Linux SRT cannot filter AF_UNIX by pathname. Block it unless this launch
    // deliberately exposes the Git credential channel to model-authored Git;
    // the outer mount/network namespace remains that channel's host boundary.
    network: {
      allowAllUnixSockets
    },
    filesystem: {
      denyRead: roots,
      denyWrite: roots
    },
    credentials: {
      files: roots.map((path) => ({ path, mode: 'deny' as const })),
      envVars: CLAUDE_PROVIDER_CREDENTIAL_ENV.map((name) => ({ name, mode: 'deny' as const }))
    }
  }
}

/** Claude Code built-in tools suppressed on every AgentConnect-managed session via
 * `_meta.claudeCode.options.disallowedTools` (spread into SDK `query()` options).
 * The agent-teams `SendMessage` collides with `mcp__agentconnect__sendMessage` (#800)
 * and is a WORKING delivery channel to unrelated co-located sessions — a mis-picked
 * call exfiltrates session-private content with no audit trail (#998). AgentConnect
 * owns all inter-session messaging for its sessions, so the built-in is always wrong. */
export const CLAUDE_DISALLOWED_BUILTIN_TOOLS = ['SendMessage'] as const

/** A Claude Code runtime (its command/args reference `claude`) — these embed the
 *  @anthropic-ai/claude-agent-sdk, which needs a Claude Code executable. The ONE
 *  Claude predicate: AcpHost and the model-catalog path both delegate here, matching
 *  on the launch command line rather than the runtime id (which aliases between
 *  `claude` and `claude-acp`). */
export function isClaudeRuntimeDef(rt: RuntimeDef): boolean {
  return [rt.command, ...rt.args].join(' ').toLowerCase().includes('claude')
}

/** Append the synthetic Claude effort levels — `max` (session-only) and `ultracode`
 *  (xhigh + workflow orchestration), which aren't `thought_level` select values — to
 *  a model's advertised levels, skipping any it already offers. An empty input is
 *  returned as-is: a model with no effort selector must never gain synthetic levels.
 *  Shared by the live-session accessor path (effortOptionsFrom) and the catalog
 *  report path (the cache stores raw efforts; augmentation happens at report time). */
export function augmentClaudeEfforts(efforts: string[]): string[] {
  if (efforts.length === 0) return efforts
  const augmented = [...efforts]
  for (const extra of ['max', ULTRACODE_EFFORT]) if (!augmented.includes(extra)) augmented.push(extra)
  return augmented
}
