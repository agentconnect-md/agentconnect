import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { objectFromJson } from '../runtimes/codex-config.js'
import { runtimeStateLocations } from '../runtimes/probe.js'
import { projectRuntimeHomeSeedFile } from '../runtimes/runtime-home.js'
import { MAX_SEED_FILE_BYTES } from '../runtimes/runtime-seeded-credentials.js'
import {
  microsandboxPlaceholder,
  placeSecrets,
  replaceSecretValue,
  type KeyOwner,
  type SecretPlaceholder
} from './secret-values.js'
import type { MicrosandboxCredentials, MicrosandboxSecret } from './secrets.js'

// Cline's built-in providers whose default endpoint takes a key in a header; others need an HTTPS baseUrl in the host file.
const DEFAULT_HOSTS: Record<string, string> = {
  anthropic: 'api.anthropic.com',
  'openai-native': 'api.openai.com',
  deepseek: 'api.deepseek.com',
  gemini: 'generativelanguage.googleapis.com',
  xai: 'api.x.ai',
  openrouter: 'openrouter.ai',
  groq: 'api.groq.com',
  mistral: 'api.mistral.ai'
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function allowedHost(endpoint: unknown): string[] {
  try {
    if (typeof endpoint !== 'string') return []
    const url = new URL(endpoint)
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && /^[a-z0-9.-]+$/.test(url.hostname))
      return [url.hostname]
  } catch {
    // Unresolved endpoints never authorize key injection.
  }
  return []
}

/** Each API key field of a stored provider entry, by the path a projection writes it back to. */
function apiKeyFields(settings: Record<string, unknown>): { field: 'apiKey' | 'auth'; value: string }[] {
  return [
    ...(nonempty(settings.apiKey) ? [{ field: 'apiKey' as const, value: settings.apiKey }] : []),
    ...(nonempty(object(settings.auth).apiKey)
      ? [{ field: 'auth' as const, value: object(settings.auth).apiKey as string }]
      : [])
  ]
}

function document(text: string): Record<string, unknown> {
  return objectFromJson(text.replace(/^﻿/, ''), 'Cline provider settings file')
}

export function prepareClineSecrets(
  hostEnv: NodeJS.ProcessEnv,
  _explicitEnv: Record<string, string> = {},
  placeholder: SecretPlaceholder = microsandboxPlaceholder
): MicrosandboxCredentials | undefined {
  const file = runtimeStateLocations('cline', hostEnv).find((location) =>
    location.credentialFiles?.some((credential) => credential.format === 'cline')
  )!
  let data: Record<string, unknown>
  try {
    const stat = lstatSync(file.source)
    if (stat.isSymbolicLink()) return undefined
    if (!stat.isFile() || stat.size > MAX_SEED_FILE_BYTES) throw new Error('invalid credential source')
    data = document(readFileSync(file.source, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Cannot read the host Cline provider settings file')
  }
  if (data.version !== 1) return undefined
  // One binding per distinct key, reaching every host a provider entry sends it to.
  const sharedKeys = new Map<string, MicrosandboxSecret>()
  const bindings = new Map<string, MicrosandboxSecret>()
  const owners = new Map<MicrosandboxSecret, KeyOwner>()
  const values: [string, MicrosandboxSecret][] = []
  for (const [id, raw] of Object.entries(object(data.providers)).sort(([a], [b]) => a.localeCompare(b))) {
    const settings = object(object(raw).settings)
    // An OAuth sign-in's access token wins over any key beside it, and sign-ins are shared as they are.
    if (nonempty(object(settings.auth).accessToken)) continue
    const provider = nonempty(settings.provider) ? settings.provider : id
    const defaultHost = Object.hasOwn(DEFAULT_HOSTS, provider) ? DEFAULT_HOSTS[provider] : undefined
    const hosts = allowedHost(settings.baseUrl ?? (defaultHost && `https://${defaultHost}`))
    for (const { field, value } of apiKeyFields(settings)) {
      const env = `AC_CLINE_API_${createHash('sha256').update(`${id}:${field}`).digest('hex').slice(0, 16).toUpperCase()}`
      const known = sharedKeys.get(value)
      const secret = known ?? { env, placeholder: '', host: [], readValue: () => value }
      if (!known) owners.set(secret, { provider, defaultHost })
      secret.host = [...new Set([secret.host, hosts].flat())].sort()
      sharedKeys.set(value, secret)
      bindings.set(`${id}:${field}`, secret)
      values.push([value, secret])
    }
  }
  if (!sharedKeys.size) return undefined
  const replacements = placeSecrets(owners, values, placeholder)
  return {
    secrets: [...sharedKeys.values()].filter((secret) => secret.host.length > 0),
    replacements,
    sources: [file.source],
    seedExclusions: [file.destination],
    preparePrivateHome(home) {
      projectRuntimeHomeSeedFile(home, file.destination, file.source, (text) => {
        const projected = document(text)
        // Each bound field holds its placeholder, so a retained copy's older key there does not stay in the clear.
        for (const [id, raw] of Object.entries(object(projected.providers))) {
          const settings = object(object(raw).settings)
          for (const { field } of apiKeyFields(settings)) {
            const binding = bindings.get(`${id}:${field}`)
            if (!binding) continue
            if (field === 'apiKey') settings.apiKey = binding.placeholder
            else object(settings.auth).apiKey = binding.placeholder
          }
        }
        return `${JSON.stringify(projected, (_key, item: unknown) =>
          typeof item === 'string' ? replaceSecretValue(item, replacements) : item
        )}\n`
      })
    }
  }
}
