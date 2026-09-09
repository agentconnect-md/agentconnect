import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { RuntimeDef } from '../config/config-schema.js'

export type SharedCredentialProfile = 'claude' | 'codex' | 'qoder' | 'qoder-cn'

export interface RuntimeCredentialDiscovery {
  paths: string[]
  providers: string[]
}

function signature(runtime: RuntimeDef | undefined, pattern: RegExp): boolean {
  return runtime ? [runtime.command, ...runtime.args].some((part) => pattern.test(part.toLowerCase())) : false
}

export function sharedCredentialProfile(runtimeId: string, runtime?: RuntimeDef): SharedCredentialProfile | undefined {
  if (runtimeId === 'claude-acp' || signature(runtime, /(?:^|[\\/@])claude(?:-[a-z-]+)?(?:@[^\\/]*)?$/)) return 'claude'
  if (runtimeId === 'codex-acp' || signature(runtime, /(?:^|[\\/])codex-acp(?:@[^\\/]*)?$/)) return 'codex'
  if (runtimeId === 'qoder-cli-cn' || signature(runtime, /(?:^|[\\/@])qoderclicn(?:@[^\\/]*)?$/)) return 'qoder-cn'
  if (runtimeId === 'qoder-cli' || signature(runtime, /(?:^|[\\/@])qodercli(?:@[^\\/]*)?$/)) return 'qoder'
  return undefined
}

function hostHome(env: NodeJS.ProcessEnv): string {
  return (process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME) || homedir()
}

function absoluteConfiguredPath(raw: string, env: NodeJS.ProcessEnv, label: string): string {
  const expanded = raw === '~' ? hostHome(env) : raw.startsWith('~/') ? join(hostHome(env), raw.slice(2)) : raw
  if (!isAbsolute(expanded) || resolve(expanded) === sep) throw new Error(`unsafe ${label}: ${raw}`)
  return resolve(expanded)
}

export function resolveClaudeConfigSources(env: NodeJS.ProcessEnv): {
  configDir: string
  globalConfigFile: string
} {
  const configDir = absoluteConfiguredPath(
    env.CLAUDE_CONFIG_DIR || join(hostHome(env), '.claude'),
    env,
    'host CLAUDE_CONFIG_DIR'
  )
  const legacyConfig = join(configDir, '.config.json')
  return {
    configDir,
    globalConfigFile: existsSync(legacyConfig)
      ? legacyConfig
      : join(env.CLAUDE_CONFIG_DIR ? configDir : hostHome(env), '.claude.json')
  }
}

/** Resolve only; discovery must not create directories or migrate an operator's login. */
export function resolveClaudeCredentialSources(env: NodeJS.ProcessEnv): {
  configDir: string
  credentialDir: string
  credentialFile: string
  globalConfigFile: string
} {
  const config = resolveClaudeConfigSources(env)
  const { configDir } = config
  let configuredSecureDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  if (!configuredSecureDir) {
    const settingsPath = join(configDir, 'settings.json')
    const settings = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown) : {}
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(`Claude settings must contain a JSON object: ${settingsPath}`)
    }
    const rawSettingsEnv = (settings as Record<string, unknown>).env
    if (
      rawSettingsEnv !== undefined &&
      (!rawSettingsEnv || typeof rawSettingsEnv !== 'object' || Array.isArray(rawSettingsEnv))
    ) {
      throw new Error(`Claude settings.env must contain a JSON object: ${settingsPath}`)
    }
    const setting = (rawSettingsEnv as Record<string, unknown> | undefined)?.CLAUDE_SECURESTORAGE_CONFIG_DIR
    if (setting !== undefined && typeof setting !== 'string') {
      throw new Error(`Claude settings env.CLAUDE_SECURESTORAGE_CONFIG_DIR must be a string: ${settingsPath}`)
    }
    configuredSecureDir = setting
  }
  const credentialDir = absoluteConfiguredPath(
    configuredSecureDir || configDir,
    env,
    'Claude secure credential directory'
  )
  return {
    ...config,
    credentialDir,
    credentialFile: join(credentialDir, '.credentials.json')
  }
}

export function resolveCodexCredentialSources(env: NodeJS.ProcessEnv): { configDir: string; credentialFile: string } {
  const configDir = absoluteConfiguredPath(env.CODEX_HOME || join(hostHome(env), '.codex'), env, 'host CODEX_HOME')
  return { configDir, credentialFile: join(configDir, 'auth.json') }
}

export function resolveOmpCredentialSource(env: NodeJS.ProcessEnv): string {
  return join(env.PI_CODING_AGENT_DIR || join(hostHome(env), '.omp', 'agent'), 'agent.db')
}

export function resolveQoderCredentialSources(
  profile: 'qoder' | 'qoder-cn',
  env: NodeJS.ProcessEnv
): {
  configDir: string
  credentialDir: string
  credentialFile: string
} {
  const cn = profile === 'qoder-cn'
  const configured = cn ? env.QODERCN_CONFIG_DIR : env.QODER_CONFIG_DIR
  const base = (cn ? env.QODERCN_CLI_HOME : env.QODER_CLI_HOME) || env.GEMINI_CLI_HOME
  const name = (
    (cn ? env.QODERCN_CONFIG_DIR_NAME : env.QODER_CONFIG_DIR_NAME) || (cn ? '.qoder-cn' : '.qoder')
  ).normalize('NFC')
  const configDir = absoluteConfiguredPath(configured || join(base || hostHome(env), name), env, `${profile} config`)
  const credentialDir = join(configDir, '.auth')
  return { configDir, credentialDir, credentialFile: join(credentialDir, 'user') }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function credentialFilePresent(path: string, followSymlinks = true): boolean {
  try {
    const stat = followSymlinks ? statSync(path) : lstatSync(path)
    return stat.isFile() && stat.size > 0 && stat.size <= 2 * 1024 * 1024
  } catch {
    return false
  }
}

function credentialObject(path: string, followSymlinks = true): Record<string, unknown> {
  try {
    return credentialFilePresent(path, followSymlinks) ? object(JSON.parse(readFileSync(path, 'utf8'))) : {}
  } catch {
    return {}
  }
}

/** Report stored credential records without checking expiration or returning their contents. */
export function discoverSharedRuntimeCredentials(
  profile: SharedCredentialProfile,
  env: NodeJS.ProcessEnv
): RuntimeCredentialDiscovery {
  const paths: string[] = []
  const providers: string[] = []
  try {
    if (profile === 'claude') {
      const source = resolveClaudeCredentialSources(env)
      const oauth = object(credentialObject(source.credentialFile).claudeAiOauth)
      if (hasText(oauth.accessToken) || hasText(oauth.refreshToken)) paths.push(source.credentialFile)
      if (hasText(credentialObject(source.globalConfigFile, false).primaryApiKey)) paths.push(source.globalConfigFile)
      if (paths.length > 0) providers.push('anthropic')
    } else if (profile === 'codex') {
      const source = resolveCodexCredentialSources(env)
      const auth = credentialObject(source.credentialFile)
      const tokens = object(auth.tokens)
      const identity = object(auth.agent_identity)
      if (
        hasText(auth.OPENAI_API_KEY) ||
        hasText(tokens.access_token) ||
        hasText(tokens.refresh_token) ||
        hasText(auth.personal_access_token) ||
        hasText(auth.agent_identity) ||
        (hasText(identity.agent_runtime_id) && hasText(identity.agent_private_key))
      )
        providers.push('openai')
      const bedrock = object(auth.bedrock_access_keys)
      if (
        hasText(object(auth.bedrock_api_key).api_key) ||
        (hasText(bedrock.access_key_id) && hasText(bedrock.secret_access_key))
      )
        providers.push('amazon-bedrock')
      if (providers.length > 0) paths.push(source.credentialFile)
    } else {
      const source = resolveQoderCredentialSources(profile, env)
      if (credentialFilePresent(source.credentialFile)) {
        paths.push(source.credentialFile)
        providers.push(profile)
      }
    }
  } catch {
    // An unreadable or malformed source is not evidence of a stored login.
  }
  return { paths, providers }
}
