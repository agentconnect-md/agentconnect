import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import type { RuntimeDef } from '../config/config-schema.js'
import { isDeepSeekRuntime } from '../runtimes/model-provider-config.js'
import { runtimeStateLocations } from '../runtimes/probe.js'
import { projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { MAX_SEED_FILE_BYTES, parseDshCredentialDocument } from '../runtimes/runtime-seeded-credentials.js'
import { prepareOpenCodeSecrets } from './opencode-secrets.js'
import { prepareClaudeApiSecret, prepareCodexApiSecret } from './native-api-secrets.js'
import { preparePiSecrets } from './pi-secrets.js'

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

const CREDENTIAL_PREPARERS = new Map<
  string,
  (hostEnv: NodeJS.ProcessEnv, explicitEnv: Record<string, string>) => MicrosandboxCredentials | undefined
>([
  ['dsh-acp', prepareDeepSeekSecret],
  ['opencode', prepareOpenCodeSecrets],
  ['pi-acp', preparePiSecrets],
  ['claude-acp', prepareClaudeApiSecret],
  ['codex-acp', prepareCodexApiSecret]
])

export function prepareMicrosandboxCredentials(
  runtimeId: string,
  runtime: RuntimeDef | undefined,
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string> = {}
): MicrosandboxCredentials | undefined {
  const id = isDeepSeekRuntime(runtimeId, runtime) ? 'dsh-acp' : runtimeId
  return CREDENTIAL_PREPARERS.get(id)?.(hostEnv, explicitEnv)
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
