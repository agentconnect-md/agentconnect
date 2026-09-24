import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import type { RuntimeDef } from '../config/config-schema.js'
import { TLS_TRUST_ENV } from '../config/tls-trust-env.js'
import { isDeepSeekRuntime } from '../runtimes/model-provider-config.js'
import { runtimeStateLocations } from '../runtimes/probe.js'
import { prepareSharedRuntimeCredentials, type SharedRuntimeCredentialAccess } from '../runtimes/runtime-credentials.js'
import { prepareRuntimeHome, projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { MAX_SEED_FILE_BYTES, parseDshCredentialDocument } from '../runtimes/runtime-seeded-credentials.js'
import { prepareOpenCodeSecrets } from './opencode-secrets.js'
import { prepareClaudeApiSecret, prepareCodexApiSecret } from './native-api-secrets.js'
import { preparePiSecrets } from './pi-secrets.js'
import { prepareGrokSecrets } from './grok-secrets.js'
import { prepareQwenSecrets } from './qwen-secrets.js'
import { prepareOmpSecrets } from './omp-secrets.js'
import { prepareAmpSecrets } from './amp-secrets.js'
import { replaceEnvironmentSecrets } from './secret-values.js'

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
}

interface CredentialPreparer {
  prepare: (hostEnv: NodeJS.ProcessEnv, explicitEnv: Record<string, string>) => MicrosandboxCredentials | undefined
  /** The launch variables it recognizes: the runtime's own for the key it protects, and those it binds a key to. */
  env: RegExp
}

const hashed = (prefix: string): RegExp => new RegExp(`^${prefix}_[0-9A-F]{16}$`)

const CREDENTIAL_PREPARERS = new Map<string, CredentialPreparer>([
  ['dsh-acp', { prepare: prepareDeepSeekSecret, env: /^DEEPSEEK_API_KEY$/ }],
  ['opencode', { prepare: prepareOpenCodeSecrets, env: hashed('OPENCODE_API') }],
  ['pi-acp', { prepare: preparePiSecrets, env: hashed('PI_API') }],
  ['claude-acp', { prepare: prepareClaudeApiSecret, env: /^(?:ANTHROPIC_API_KEY|AC_CLAUDE_API_KEY)$/ }],
  ['codex-acp', { prepare: prepareCodexApiSecret, env: /^(?:OPENAI_API_KEY|AC_CODEX_API_KEY)$/ }],
  ['grok-build', { prepare: prepareGrokSecrets, env: hashed('AC_GROK_API') }],
  ['qwen-code', { prepare: prepareQwenSecrets, env: hashed('AC_QWEN_API') }],
  ['omp', { prepare: prepareOmpSecrets, env: hashed('AC_OMP_API') }],
  ['amp-acp', { prepare: prepareAmpSecrets, env: hashed('AC_AMP_API') }]
])

function preparerFor(runtimeId: string, runtime: RuntimeDef | undefined): CredentialPreparer | undefined {
  return CREDENTIAL_PREPARERS.get(isDeepSeekRuntime(runtimeId, runtime) ? 'dsh-acp' : runtimeId)
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
  explicitEnv: Record<string, string> = {}
): MicrosandboxCredentialStep {
  const protectedCredentials = prepareMicrosandboxCredentials(runtimeId, runtime, hostEnv, explicitEnv)
  const credentials =
    protectedCredentials?.shareNativeCredentials === false
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
      const home = prepareRuntimeHome(runtimeId, scopeDir, hostEnv, runtimeHome, [
        ...(credentials?.seedExclusions ?? []),
        ...(protectedCredentials?.seedExclusions ?? []),
        ...excluded
      ])
      protectedCredentials?.preparePrivateHome(home)
      credentials?.preparePrivateHome(home)
      return home
    },
    protectEnv(env) {
      if (!protectedCredentials) return
      replaceEnvironmentSecrets(env, protectedCredentials.replacements)
      for (const secret of protectedCredentials.secrets) env[secret.env] = secret.placeholder
      if (!protectedCredentials.secrets.length) return
      env.NODE_EXTRA_CA_CERTS = '/.msb/tls/ca.pem'
      env.SSL_CERT_FILE = env.REQUESTS_CA_BUNDLE = env.CURL_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'
    }
  }
}

function prepareDeepSeekSecret(hostEnv: NodeJS.ProcessEnv, explicitEnv: Record<string, string> = {}) {
  const env = 'DEEPSEEK_API_KEY'
  const files = runtimeStateLocations('dsh-acp', hostEnv).flatMap((location) =>
    (location.credentialFiles ?? []).map((file) => ({
      source: join(location.source, file.path),
      destination: join(location.destination, file.path),
      format: file.format
    }))
  )
  let key = explicitEnv[env] ?? hostEnv[env]
  let baseUrl = explicitEnv.DEEPSEEK_BASE_URL ?? hostEnv.DEEPSEEK_BASE_URL
  for (const file of files) {
    if (file.format !== 'dsh' && file.format !== 'dsh-env') continue
    if (key && (baseUrl || file.format !== 'dsh-env')) continue
    try {
      const stat = lstatSync(file.source)
      if (!stat.isFile() || stat.size > MAX_SEED_FILE_BYTES) continue
      const { refs } = parseDshCredentialDocument(readFileSync(file.source, 'utf8'), file.format)
      key ||= refs[env]
      if (file.format === 'dsh-env') baseUrl ??= refs.DEEPSEEK_BASE_URL
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      // YAML parser errors can quote a line containing the key.
      throw new Error('Cannot read the host DeepSeek credential file')
    }
  }
  const value = key?.trim()
  if (!value) return undefined
  const secret = {
    env,
    placeholder: 'msb-secret-DEEPSEEK_API_KEY',
    host: 'api.deepseek.com',
    readValue: () => value
  } satisfies MicrosandboxSecret
  try {
    const endpoint = new URL(baseUrl ?? 'https://api.deepseek.com')
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.hostname !== secret.host ||
      endpoint.port ||
      endpoint.username ||
      endpoint.password
    )
      throw new Error('unsupported endpoint')
  } catch {
    throw new Error('DeepSeek launch refused: credential protection requires https://api.deepseek.com')
  }
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
