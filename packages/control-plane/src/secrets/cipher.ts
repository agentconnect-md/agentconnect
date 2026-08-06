/**
 * `SecretCipher` — the single at-rest transform every persisted tenant-secret
 * VALUE passes through (docs/designs/secret-store-seams.md §4).
 *
 * Every secret store seam (`BotSecretStore`, `AgentSecretStore`, `HookSecretStore`,
 * `McpProviderSecretStore`, `McpGrantRepo`, `SlackInstallStore`,
 * `SlackUserConfigStore`) transforms values through ONE configured cipher before
 * they reach Postgres and opens them on the way out. `SECRET_CIPHER=none` is an
 * identity transform and therefore stores plaintext; an encrypting provider such
 * as Vault Transit stores ciphertext. The composition root selects one provider,
 * so every store switches together.
 *
 * Every call carries a {@link SecretScope} naming WHOSE key to use — the
 * deployment's, or one organization's (docs/designs/per-org-secret-encryption.md).
 * The scope comes from the caller, never from the stored value.
 *
 * Contract for an encrypting implementation (e.g. Vault Transit):
 * - `seal` returns a self-describing value carrying the envelope version
 *   (`acv1:` + Transit's own `vault:v1:…`).
 * - `open` MUST pass through values it did not seal (no envelope tag ⇒ return
 *   as-is): existing plaintext rows keep working, and re-sealing on the next
 *   write migrates them lazily — the flip is online, no backfill required. It
 *   must NOT pass through a value that is sealed but unreadable (a pre-scoping
 *   `vault:vN:`, or a newer envelope version) — that has to throw, since
 *   returning ciphertext as plaintext would be shipped onward as a credential.
 * - A value sealed under one scope MUST NOT open under another. Failing closed
 *   there is the point of passing the scope in.
 * - Neither side ever logs its argument.
 *
 * This is NOT the C5 `SecretsProvider` lease broker (`providers/provider.ts`),
 * which brokers daemon-resolved Vault refs and never touches material. The
 * cipher is the CP-side at-rest seam for secrets the CP itself must hold and
 * replicate to daemons over the TLS WS.
 */
import { VaultTransitSecretCipher } from './vault-transit.js'
import { effectiveOrgKeyPrefix, type SecretScope } from './scope.js'

export { DEPLOYMENT_SCOPE, orgScope, type SecretScope } from './scope.js'

export interface SecretCipher {
  /** Plaintext → the string persisted at rest, sealed under `scope`'s key. */
  seal(plaintext: string, scope: SecretScope): Promise<string>
  /** Persisted string → plaintext. Must pass through values it did not seal. */
  open(stored: string, scope: SecretScope): Promise<string>
}

/**
 * The identity cipher used by `SECRET_CIPHER=none`: persisted values remain
 * plaintext. It is the default unless an encrypting provider is configured.
 */
export class PlaintextSecretCipher implements SecretCipher {
  seal(plaintext: string): Promise<string> {
    return Promise.resolve(plaintext)
  }

  open(stored: string): Promise<string> {
    return Promise.resolve(stored)
  }
}

/** The `SECRET_CIPHER` slice of AppConfig the factory needs. */
export interface SecretCipherConfig {
  SECRET_CIPHER: 'none' | 'vault-transit'
  VAULT_ADDR?: string | undefined
  VAULT_TRANSIT_KEY: string
  VAULT_TRANSIT_ORG_KEY_PREFIX?: string | undefined
  VAULT_TRANSIT_MOUNT: string
  VAULT_NAMESPACE?: string | undefined
  VAULT_TOKEN?: string | undefined
  VAULT_JWT_ROLE?: string | undefined
  VAULT_JWT_PATH: string
  VAULT_AUTH_MOUNT: string
}

/**
 * Select the cipher for a config (mirrors `makeSecretsProvider`). `loadConfig`'s
 * cross-field validation guarantees the vault fields at boot; the throws here
 * fail-fast hand-built configs (tests) the same way.
 */
export function makeSecretCipher(config: SecretCipherConfig): SecretCipher {
  if (config.SECRET_CIPHER === 'none') return new PlaintextSecretCipher()
  if (!config.VAULT_ADDR) throw new Error('SECRET_CIPHER=vault-transit requires VAULT_ADDR')
  const auth = config.VAULT_JWT_ROLE
    ? {
        method: 'jwt' as const,
        role: config.VAULT_JWT_ROLE,
        jwtPath: config.VAULT_JWT_PATH,
        authMount: config.VAULT_AUTH_MOUNT
      }
    : config.VAULT_TOKEN
      ? { method: 'token' as const, token: config.VAULT_TOKEN }
      : undefined
  if (!auth) throw new Error('SECRET_CIPHER=vault-transit requires exactly one of VAULT_TOKEN or VAULT_JWT_ROLE')
  return new VaultTransitSecretCipher({
    addr: config.VAULT_ADDR,
    key: config.VAULT_TRANSIT_KEY,
    orgKeyPrefix: effectiveOrgKeyPrefix(config.VAULT_TRANSIT_KEY, config.VAULT_TRANSIT_ORG_KEY_PREFIX),
    mount: config.VAULT_TRANSIT_MOUNT,
    ...(config.VAULT_NAMESPACE ? { namespace: config.VAULT_NAMESPACE } : {}),
    auth
  })
}
