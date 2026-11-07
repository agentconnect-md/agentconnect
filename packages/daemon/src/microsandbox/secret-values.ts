import type { MicrosandboxSecret } from './secrets.js'

/** One protected key as a placeholder factory sees it: its variable, its provider, the hosts it may reach, and the provider's own API host. */
export interface SecretBinding {
  env: string
  provider: string
  hosts: readonly string[]
  defaultHost?: string
}

/** What a protected key's variable and files hold in its place. */
export type SecretPlaceholder = (binding: SecretBinding) => string

/** Where a preparer reads keys a command prints, and how an srt launch differs from a VM's. */
export interface SecretSources {
  /** An srt resolution passes the export it already awaited. */
  openCodeAuthExport?: (env: NodeJS.ProcessEnv) => string
  /** An srt launch runs the host's own runtime, not a VM image's pinned one, so a Codex key beside OPENAI_BASE_URL has no known endpoint. */
  hostRuntime?: boolean
}

/** The provider a preparer's key belongs to, and that provider's own API host where it has one. */
export interface KeyOwner {
  provider: string
  defaultHost?: string
}

/** Give each key its placeholder once every binding has added its hosts, then map each value standing for a key to that placeholder, in order. */
export function placeSecrets(
  owners: ReadonlyMap<MicrosandboxSecret, KeyOwner>,
  values: Iterable<readonly [string, MicrosandboxSecret]>,
  placeholder: SecretPlaceholder
): Map<string, string> {
  for (const [secret, owner] of owners) {
    const hosts = Array.isArray(secret.host) ? secret.host : [secret.host]
    secret.placeholder = placeholder({ env: secret.env, ...owner, hosts })
  }
  return new Map([...values].map(([value, secret]) => [value, secret.placeholder]))
}

/** The placeholder a key in a private copy gets: a retained copy's bound key is protected and an unbound one left as it is; a fresh copy must hold the host key, else `refusal` is thrown. */
export function protectedCopyValue(
  value: string,
  binding: MicrosandboxSecret | undefined,
  retained: boolean,
  refusal: string
): string | undefined {
  if (retained) return binding?.placeholder
  if (!binding || value !== binding.readValue()) throw new Error(refusal)
  return binding.placeholder
}

/** The host name of an endpoint the preparer knows, for a binding's `defaultHost`. */
export function endpointHost(endpoint: unknown): string | undefined {
  return typeof endpoint === 'string' ? new URL(endpoint).hostname : undefined
}

/** A VM's placeholder, which its own proxy swaps on the binding's hosts. */
export const microsandboxPlaceholder: SecretPlaceholder = ({ env }) => `msb-secret-${env}`

export function replaceSecretValue(value: string, replacements: ReadonlyMap<string, string>): string {
  const replacement = replacements.get(value)
  if (replacement !== undefined) return replacement
  const bearer = /^(Bearer\s+)(.+)$/i.exec(value)
  return bearer ? `${bearer[1]}${replacements.get(bearer[2]!) ?? bearer[2]}` : value
}

export function replaceEnvironmentSecrets(
  env: Record<string, string>,
  replacements: ReadonlyMap<string, string>
): void {
  for (const [name, value] of Object.entries(env)) {
    const replacement = replaceSecretValue(value, replacements)
    if (replacement !== value) {
      env[name] = replacement
      continue
    }
    try {
      let changed = false
      const projected = JSON.stringify(JSON.parse(value), (_key, entry: unknown) => {
        const result = typeof entry === 'string' ? replaceSecretValue(entry, replacements) : entry
        changed ||= result !== entry
        return result
      })
      if (changed) env[name] = projected
    } catch {
      // Ordinary environment values are not JSON configuration.
    }
  }
}
