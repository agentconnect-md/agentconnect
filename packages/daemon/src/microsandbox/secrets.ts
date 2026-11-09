import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import type { RuntimeDef } from '../config/config-schema.js'
import { TLS_TRUST_ENV } from '../config/tls-trust-env.js'
import { isDeepSeekRuntime } from '../runtimes/model-provider-config.js'
import { hostKeyEndpoint, PROVIDER_DEFAULT_ENDPOINTS, RUNTIME_KEY_VARIABLES } from '../runtimes/provider-endpoints.js'
import { runtimeStateLocations } from '../runtimes/probe.js'
import { prepareSharedRuntimeCredentials, type SharedRuntimeCredentialAccess } from '../runtimes/runtime-credentials.js'
import { prepareRuntimeHome, projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { MAX_SEED_FILE_BYTES, parseDshCredentialDocument } from '../runtimes/runtime-seeded-credentials.js'
import { prepareOpenCodeSecrets } from './opencode-secrets.js'
import {
  prepareAntigravityEnvSecret,
  prepareClaudeApiSecret,
  prepareClaudeEnvSecret,
  prepareCodexApiSecret,
  prepareCodexEnvSecret,
  prepareCopilotEnvSecret
} from './native-api-secrets.js'
import { prepareClineSecrets } from './cline-secrets.js'
import { preparePiSecrets } from './pi-secrets.js'
import { prepareGrokSecrets } from './grok-secrets.js'
import { prepareQwenSecrets } from './qwen-secrets.js'
import { prepareOmpSecrets } from './omp-secrets.js'
import { prepareAmpSecrets } from './amp-secrets.js'
import { prepareKimiSecrets } from './kimi-secrets.js'
import {
  microsandboxPlaceholder,
  replaceEnvironmentSecrets,
  type SecretPlaceholder,
  type SecretSources
} from './secret-values.js'
export {
  microsandboxPlaceholder,
  type SecretBinding,
  type SecretPlaceholder,
  type SecretSources
} from './secret-values.js'
import { sharedCredentialProfile } from '../runtimes/runtime-credential-sources.js'

export interface MicrosandboxSecret {
  env: string
  placeholder: string
  host: string | string[]
  // The value stays host-side and cannot enter serialized launch metadata.
  readValue: () => string
}

export interface MicrosandboxCredentials {
  secrets: MicrosandboxSecret[]
  replacements: ReadonlyMap<string, string>
  sources: string[]
  seedExclusions: string[]
  shareNativeCredentials?: boolean
  tlsTrustEnv?: readonly string[]
  preparePrivateHome: (home: string) => void
  /** Points the guest's own config at the bound variables, after they hold their placeholders. */
  prepareEnv?: (env: Record<string, string>) => void
}

type PrepareCredentials = (
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>,
  placeholder?: SecretPlaceholder,
  sources?: SecretSources
) => MicrosandboxCredentials | undefined

interface CredentialPreparer {
  prepare: PrepareCredentials
  /** The launch variables it recognizes: the runtime's own for the key it protects, and those it binds a key to. */
  env: RegExp
}

const hashed = (prefix: string): RegExp => new RegExp(`^${prefix}_[0-9A-F]{16}$`)

/** A runtime's sign-in file key and its own key variable, each under its own binding. */
const withEnvKey =
  (files: PrepareCredentials, variable: PrepareCredentials): PrepareCredentials =>
  (...args) =>
    mergeCredentials(files(...args), variable(...args))

const CREDENTIAL_PREPARERS = new Map<string, CredentialPreparer>([
  ['dsh-acp', { prepare: prepareDeepSeekSecret, env: /^DEEPSEEK_API_KEY$/ }],
  ['opencode', { prepare: prepareOpenCodeSecrets, env: hashed('OPENCODE_API') }],
  ['pi-acp', { prepare: preparePiSecrets, env: hashed('PI_API') }],
  [
    'claude-acp',
    {
      prepare: withEnvKey(prepareClaudeApiSecret, prepareClaudeEnvSecret),
      env: /^(?:ANTHROPIC_API_KEY|AC_CLAUDE_API_KEY)$/
    }
  ],
  [
    'codex-acp',
    {
      prepare: withEnvKey(prepareCodexApiSecret, prepareCodexEnvSecret),
      env: /^(?:OPENAI_API_KEY|AC_CODEX_API_KEY)$/
    }
  ],
  ['grok-build', { prepare: prepareGrokSecrets, env: hashed('AC_GROK_API') }],
  ['qwen-code', { prepare: prepareQwenSecrets, env: hashed('AC_QWEN_API') }],
  ['omp', { prepare: prepareOmpSecrets, env: hashed('AC_OMP_API') }],
  ['amp-acp', { prepare: prepareAmpSecrets, env: hashed('AC_AMP_API') }],
  ['kimi', { prepare: prepareKimiSecrets, env: hashed('AC_KIMI_API') }],
  ['cline', { prepare: prepareClineSecrets, env: hashed('AC_CLINE_API') }],
  ['github-copilot-cli', { prepare: prepareCopilotEnvSecret, env: /^COPILOT_PROVIDER_API_KEY$/ }],
  ['antigravity-acp', { prepare: prepareAntigravityEnvSecret, env: /^GEMINI_API_KEY$/ }]
])

function preparerFor(runtimeId: string, runtime: RuntimeDef | undefined): CredentialPreparer | undefined {
  return CREDENTIAL_PREPARERS.get(isDeepSeekRuntime(runtimeId, runtime) ? 'dsh-acp' : runtimeId)
}

/** The runtime whose preparer an srt launch protects the host's keys with, known by its id or the adapter it launches. */
export function ambientCredentialRuntime(runtimeId: string, runtime: RuntimeDef | undefined): string | undefined {
  const profile = sharedCredentialProfile(runtimeId, runtime)
  const id = isDeepSeekRuntime(runtimeId, runtime)
    ? 'dsh-acp'
    : profile === 'claude'
      ? 'claude-acp'
      : profile === 'codex'
        ? 'codex-acp'
        : runtimeId
  return CREDENTIAL_PREPARERS.has(id) ? id : undefined
}

/** The host's keys an srt launch of this runtime would hand it, each behind the factory's placeholder; undefined when it has none or no such preparer. */
export function prepareAmbientCredentials(
  runtimeId: string,
  runtime: RuntimeDef | undefined,
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>,
  placeholder: SecretPlaceholder,
  sources: SecretSources = {}
): MicrosandboxCredentials | undefined {
  const id = ambientCredentialRuntime(runtimeId, runtime)
  const preparer = id === undefined ? undefined : CREDENTIAL_PREPARERS.get(id)
  if (!preparer) return undefined
  return preparer.prepare(hostEnv, explicitEnv, placeholder, { ...sources, hostRuntime: true })
}

/** A runtime's sign-in file credentials with its key variable's beside them; the file's sharing choice stands, and either side's trust variables are refused. */
function mergeCredentials(
  files: MicrosandboxCredentials | undefined,
  variable: MicrosandboxCredentials | undefined
): MicrosandboxCredentials | undefined {
  if (!files || !variable) return files ?? variable
  return {
    ...files,
    secrets: [...files.secrets, ...variable.secrets],
    replacements: new Map([...files.replacements, ...variable.replacements]),
    sources: [...files.sources, ...variable.sources],
    seedExclusions: [...files.seedExclusions, ...variable.seedExclusions],
    tlsTrustEnv: [...new Set([...(files.tlsTrustEnv ?? []), ...(variable.tlsTrustEnv ?? [])])]
  }
}

export function prepareMicrosandboxCredentials(
  runtimeId: string,
  runtime: RuntimeDef | undefined,
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string> = {}
): MicrosandboxCredentials | undefined {
  return preparerFor(runtimeId, runtime)?.prepare(hostEnv, explicitEnv)
}

/** Whether a launch variable is a provider credential this runtime's preparer recognizes, which is an executor's own and never travels (session-executors.md §8). */
export function isRecognizedCredentialEnv(runtimeId: string, runtime: RuntimeDef | undefined, name: string): boolean {
  return preparerFor(runtimeId, runtime)?.env.test(name) === true
}

/** A runtime definition's own env, which a local launch merges above the process env. */
export function definitionEnv(runtime: RuntimeDef | undefined): Record<string, string> {
  return Object.fromEntries((runtime?.env ?? []).map(({ name, value }) => [name, value]))
}

/** This machine's own values of those variables, its runtime definition's over its process env as a local launch takes them: what an executor fills in for a placed session in place of the holder's (§8). */
export function ownCredentialEnv(
  runtimeId: string,
  runtime: RuntimeDef | undefined,
  hostEnv: NodeJS.ProcessEnv
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...hostEnv, ...definitionEnv(runtime) }).filter(
      (entry): entry is [string, string] =>
        Boolean(entry[1]?.trim()) && isRecognizedCredentialEnv(runtimeId, runtime, entry[0])
    )
  )
}

/** One runtime's credentials for a VM, as a local launch and a hosted VM both take them (session-executors.md §11 step 2). */
export interface MicrosandboxCredentialStep {
  protectedCredentials?: MicrosandboxCredentials
  credentials?: SharedRuntimeCredentialAccess
  /** Seed `runtimeHome` without the raw files either one projects, then project them; `excluded` adds files other runtimes protect. */
  seedHome(scopeDir: string, runtimeHome: string, excluded?: readonly string[]): string
  /** The guest's env: host values replaced, each binding at its placeholder, and the proxy's CA trusted. */
  protectEnv(env: Record<string, string>): void
}

/** The protected preparers, the shared sign-in unless they replace it, and no custom trust beside the proxy's CA; reads only, until `seedHome`. */
export function microsandboxCredentialStep(
  runtimeId: string,
  runtime: RuntimeDef | undefined,
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string> = {},
  inheritRuntimeCredentials = true
): MicrosandboxCredentialStep {
  const protectedCredentials = inheritRuntimeCredentials
    ? prepareMicrosandboxCredentials(runtimeId, runtime, hostEnv, explicitEnv)
    : undefined
  const credentials =
    !inheritRuntimeCredentials || protectedCredentials?.shareNativeCredentials === false
      ? undefined
      : prepareSharedRuntimeCredentials({ runtimeId, runtime, hostEnv })
  if (
    protectedCredentials?.secrets.length &&
    [...TLS_TRUST_ENV, ...(protectedCredentials.tlsTrustEnv ?? []), 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'].some(
      (name) => (explicitEnv[name] ?? hostEnv[name])?.trim()
    )
  ) {
    throw new Error(
      'Runtime launch refused: microsandbox credential protection does not yet support custom TLS trust bundles; use SRT for this configuration'
    )
  }
  return {
    protectedCredentials,
    credentials,
    seedHome(scopeDir, runtimeHome, excluded = []) {
      const home = prepareRuntimeHome(
        runtimeId,
        scopeDir,
        hostEnv,
        runtimeHome,
        [...(credentials?.seedExclusions ?? []), ...(protectedCredentials?.seedExclusions ?? []), ...excluded],
        inheritRuntimeCredentials
      )
      protectedCredentials?.preparePrivateHome(home)
      credentials?.preparePrivateHome(home)
      return home
    },
    protectEnv(env) {
      if (!protectedCredentials) return
      replaceEnvironmentSecrets(env, protectedCredentials.replacements)
      for (const secret of protectedCredentials.secrets) env[secret.env] = secret.placeholder
      protectedCredentials.prepareEnv?.(env)
      if (!protectedCredentials.secrets.length) return
      env.NODE_EXTRA_CA_CERTS = '/.msb/tls/ca.pem'
      env.SSL_CERT_FILE = env.REQUESTS_CA_BUNDLE = env.CURL_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'
    }
  }
}

function prepareDeepSeekSecret(
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string> = {},
  placeholder: SecretPlaceholder = microsandboxPlaceholder
) {
  const variables = RUNTIME_KEY_VARIABLES.deepseek.deepseek
  const env = variables.key
  const files = runtimeStateLocations('dsh-acp', hostEnv).flatMap((location) =>
    (location.credentialFiles ?? []).map((file) => ({
      source: join(location.source, file.path),
      destination: join(location.destination, file.path),
      format: file.format
    }))
  )
  let key = explicitEnv[env] ?? hostEnv[env]
  let baseUrl = explicitEnv[variables.base] ?? hostEnv[variables.base]
  for (const file of files) {
    if (file.format !== 'dsh' && file.format !== 'dsh-env') continue
    if (key && (baseUrl || file.format !== 'dsh-env')) continue
    try {
      const stat = lstatSync(file.source)
      if (!stat.isFile() || stat.size > MAX_SEED_FILE_BYTES) continue
      const { refs } = parseDshCredentialDocument(readFileSync(file.source, 'utf8'), file.format)
      key ||= refs[env]
      if (file.format === 'dsh-env') baseUrl ??= refs[variables.base]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      // YAML parser errors can quote a line containing the key.
      throw new Error('Cannot read the host DeepSeek credential file')
    }
  }
  const value = key?.trim()
  if (!value) return undefined
  const host = new URL(PROVIDER_DEFAULT_ENDPOINTS.deepseek!).hostname
  try {
    // A blank base names no endpoint, which is refused like any other.
    const endpoint = new URL(hostKeyEndpoint('deepseek', env, { [variables.base]: baseUrl })?.endpoint ?? '')
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.hostname !== host ||
      endpoint.port ||
      endpoint.username ||
      endpoint.password
    )
      throw new Error('unsupported endpoint')
  } catch {
    throw new Error('DeepSeek launch refused: credential protection requires https://api.deepseek.com')
  }
  const secret = {
    env,
    placeholder: placeholder({ env, provider: 'deepseek', hosts: [host], defaultHost: host }),
    host,
    readValue: () => value
  } satisfies MicrosandboxSecret
  return {
    secrets: [secret],
    replacements: new Map([[value, secret.placeholder]]),
    sources: files.map((file) => file.source),
    seedExclusions: [...new Set(files.map((file) => file.destination))],
    preparePrivateHome(home: string) {
      for (const file of files) {
        const format = file.format
        if (format !== 'dsh' && format !== 'dsh-env') continue
        projectRuntimeHomeSeedFile(home, file.destination, file.source, (text) => {
          try {
            const { data, refs } = parseDshCredentialDocument(text, format)
            if (format === 'dsh') {
              const target = data.version === 1 ? (data.refs as Record<string, unknown> | undefined) : data
              if (target && Object.hasOwn(target, env)) target[env] = secret.placeholder
              text = stringifyYaml(data)
            } else if (refs[env]) {
              if (!text.includes(refs[env])) return undefined
              text = text.replaceAll(refs[env], secret.placeholder)
            }
            return text.replaceAll(value, secret.placeholder)
          } catch {
            // Invalid host seeds are skipped; invalid retained credentials fail closed without quoting their content.
            return undefined
          }
        })
      }
    }
  }
}
