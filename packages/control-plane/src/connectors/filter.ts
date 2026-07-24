/**
 * Pure logic for the open-connector integration (docs: connectors). No I/O — the
 * network client lives in `client.ts`. Ported from the web's former
 * `lib/open-connector.ts` so the same catalog filter is now CP-owned.
 */

/** How the CP namespaces a connection as an open-connector profile, and the header
 *  that selects it when the relay calls open-connector's runtime API. */
export const CONNECTOR_ALIAS_HEADER = 'x-oomol-connector-alias'
/** The open-connector `service` a connection is bound to, carried to the relay so its
 *  synthesized MCP proxy lists/calls that service's actions. Not a secret. */
export const CONNECTOR_SERVICE_HEADER = 'x-oomol-connector-service'
/** Chars of the org/user id used in the profile prefix — kept short so the composed
 *  `<org>--<user>--<name>` fits open-connector's 64-char connection-name limit. */
export const PROFILE_ID_PREFIX_LEN = 8

// ── upstream shapes (subset we consume; mirrors open-connector web/src/model.ts) ──
export interface OcAuthDefinition {
  type: 'no_auth' | 'api_key' | 'custom_credential' | 'oauth2'
  [key: string]: unknown
}

export interface OcProvider {
  service: string
  displayName: string
  description?: string
  categories: string[]
  authTypes: string[]
  auth: OcAuthDefinition[]
  homepageUrl?: string
  iconUrl?: string
  actions?: unknown[]
}

export interface OcOAuthConfig {
  service: string
  configured: boolean
  clientId: string | null
}

/** `'*'` (the default) or unset ⇒ null (no restriction); else a set of `service` ids. */
export function parseWhitelist(raw: string | undefined): Set<string> | null {
  const trimmed = raw?.trim()
  if (!trimmed || trimmed === '*') return null
  const entries = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return entries.length > 0 ? new Set(entries) : null
}

/**
 * Keep the providers the console should surface, and prune un-connectable auth methods
 * from each. A method is connectable when it's api-key / custom / no-auth (the user just
 * fills it in) OR it's OAuth whose client secret is configured upstream. Concretely:
 *
 * - whitelist-allowed only;
 * - drop the `oauth2` method when its client secret ISN'T configured — but KEEP the
 *   provider if it still offers another method (e.g. a provider that does both OAuth and
 *   api-key shows just the api-key form while OAuth is unconfigured);
 * - drop the provider entirely only when nothing connectable remains (e.g. OAuth-only,
 *   unconfigured).
 *
 * `actions` are stripped so a broad ('*') catalog stays a lean payload.
 */
export function filterCatalog(
  providers: OcProvider[],
  oauthConfigs: OcOAuthConfig[],
  whitelist: Set<string> | null
): OcProvider[] {
  const configuredOAuth = new Set(oauthConfigs.filter((c) => c.configured).map((c) => c.service))
  const kept: OcProvider[] = []
  for (const p of providers) {
    if (whitelist !== null && !whitelist.has(p.service)) continue
    const { actions: _actions, ...rest } = p
    // Configured OAuth (or a provider with no OAuth to gate) passes through untouched.
    if (configuredOAuth.has(p.service)) {
      kept.push(rest)
      continue
    }
    // Otherwise strip the unconfigured oauth2 method from both projections.
    const auth = Array.isArray(rest.auth) ? rest.auth.filter((a) => a.type !== 'oauth2') : []
    const authTypes = Array.isArray(rest.authTypes) ? rest.authTypes.filter((t) => t !== 'oauth2') : []
    if (auth.length === 0 && authTypes.length === 0) continue // nothing connectable left
    kept.push({ ...rest, auth, authTypes })
  }
  return kept
}

/** open-connector's connection-name rule (connection-service.ts): ≤64 chars,
 *  `[A-Za-z0-9_-]`, must start alphanumeric. Our connection names are further
 *  restricted (≤32) at the API edge so the composed profile always fits. */
export function isValidConnectionName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name)
}

/**
 * The open-connector connection PROFILE name for an org+user+connection:
 * `<orgId[0..8]>--<userId[0..8]>--<connectionName>`. Truncated id prefixes keep it
 * within open-connector's 64-char limit.
 *
 * CAVEAT: `@@unique([orgId, name])` guarantees per-org provider-row uniqueness but does
 * NOT guarantee open-connector PROFILE uniqueness across orgs — two orgs whose 8-char id
 * prefixes AND user prefix AND connection name all coincide map to the same OC profile.
 * That's improbable (cuid prefixes are a `c` + truncated ms timestamp) and inert while OC
 * doesn't honor the alias at runtime; revisit with a hashed prefix if it ever bites.
 */
export function composeProfileName(orgId: string, userId: string, connectionName: string): string {
  const org = orgId.slice(0, PROFILE_ID_PREFIX_LEN)
  const user = userId.slice(0, PROFILE_ID_PREFIX_LEN)
  return `${org}--${user}--${connectionName}`
}
