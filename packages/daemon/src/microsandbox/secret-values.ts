/** One protected key as a placeholder factory sees it: its variable, its provider, the hosts it may reach, and the provider's own API host. */
export interface SecretBinding {
  env: string
  provider: string
  hosts: readonly string[]
  defaultHost?: string
}

/** What a protected key's variable and files hold in its place. */
export type SecretPlaceholder = (binding: SecretBinding) => string

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
