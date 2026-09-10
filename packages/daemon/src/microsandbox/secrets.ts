import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeDef } from '../config/config-schema.js'
import { isDeepSeekRuntime } from '../runtimes/model-provider-config.js'
import { runtimeStateLocations } from '../runtimes/probe.js'
import { MAX_SEED_FILE_BYTES, parseDshCredentialDocument } from '../runtimes/runtime-seeded-credentials.js'

export interface MicrosandboxSecret {
  env: string
  placeholder: string
  host: string
  // The value stays host-side and cannot enter serialized launch metadata.
  readValue: () => string
}

export function prepareDeepSeekSecret(
  runtimeId: string,
  runtime: RuntimeDef | undefined,
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string> = {}
) {
  if (!isDeepSeekRuntime(runtimeId, runtime)) return undefined
  const env = 'DEEPSEEK_API_KEY'
  const files = runtimeStateLocations('dsh-acp', hostEnv).flatMap((location) =>
    (location.credentialFiles ?? []).map((file) => ({
      source: join(location.source, file.path),
      destination: join(location.destination, file.path),
      format: file.format
    }))
  )
  let key = explicitEnv[env] ?? hostEnv[env]
  for (const file of files) {
    if (file.format !== 'dsh' && file.format !== 'dsh-env') continue
    try {
      const stat = lstatSync(file.source)
      if (!stat.isFile() || stat.size > MAX_SEED_FILE_BYTES) continue
      const { refs } = parseDshCredentialDocument(readFileSync(file.source, 'utf8'), file.format)
      key ||= refs[env]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      // YAML parser errors can quote a line containing the key.
      throw new Error('Cannot read the host DeepSeek credential file')
    }
  }
  const value = key?.trim()
  const secret: MicrosandboxSecret | undefined = value
    ? { env, placeholder: 'msb-secret-DEEPSEEK_API_KEY', host: 'api.deepseek.com', readValue: () => value }
    : undefined
  if (secret) {
    const endpoint = new URL(explicitEnv.DEEPSEEK_BASE_URL ?? hostEnv.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com')
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.hostname !== secret.host ||
      endpoint.port ||
      endpoint.username ||
      endpoint.password
    )
      throw new Error('DeepSeek credential protection requires https://api.deepseek.com')
  }
  return {
    secret,
    sources: files.map((file) => file.source),
    seedExclusions: [...new Set(files.map((file) => file.destination))]
  }
}
