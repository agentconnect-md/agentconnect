/**
 * Pure logic for the open-connector integration (docs: connectors). No I/O — the
 * network client lives in `client.ts`. Ported from the web's former
 * `lib/open-connector.ts` so the same catalog filter is now CP-owned.
 */
import { createHash } from 'node:crypto'

/** How the CP namespaces a connection as an open-connector profile, and the header
 *  that selects it when the relay calls open-connector's runtime API. */
export const CONNECTOR_ALIAS_HEADER = 'x-oomol-connector-alias'
/** The open-connector `service` a connection is bound to, carried to the relay so its
 *  synthesized MCP proxy lists/calls that service's actions. Not a secret. */
export const CONNECTOR_SERVICE_HEADER = 'x-oomol-connector-service'
/** Base36 width of each hashed id in the profile prefix — 64 digest bits at fixed width,
 *  so `<org>--<user>--<name>` peaks at 62 of open-connector's 64 connection-name chars. */
export const PROFILE_HASH_LEN = 13

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

function parseServiceIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** `'*'` (the default) or unset ⇒ null (no restriction); else a set of `service` ids. */
export function parseWhitelist(raw: string | undefined): Set<string> | null {
  const trimmed = raw?.trim()
  if (!trimmed || trimmed === '*') return null
  const entries = parseServiceIds(trimmed)
  return entries.length > 0 ? new Set(entries) : null
}

/** Unset/blank ⇒ no exclusions; else the exact `service` ids to omit. */
export function parseBlocklist(raw: string | undefined): Set<string> {
  return new Set(parseServiceIds(raw))
}

/**
 * Keep the providers the console should surface, and prune un-connectable auth methods
 * from each. A method is connectable when it's api-key / custom / no-auth (the user just
 * fills it in) OR it's OAuth whose client secret is configured upstream. Concretely:
 *
 * - whitelist-allowed and not blocklisted;
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
  whitelist: Set<string> | null,
  blocklist: Set<string>
): OcProvider[] {
  const configuredOAuth = new Set(oauthConfigs.filter((c) => c.configured).map((c) => c.service))
  const kept: OcProvider[] = []
  for (const p of providers) {
    if (blocklist.has(p.service) || (whitelist !== null && !whitelist.has(p.service))) continue
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

/** 64 sha256 bits as fixed-width base36 — `[0-9a-z]` only, so a composed profile stays
 *  inside open-connector's charset and always starts alphanumeric. Domain-separated so an
 *  id appearing in both roles doesn't hash to the same segment twice. */
function hashIdSegment(domain: string, id: string): string {
  const digest = createHash('sha256').update(`${domain}\0${id}`, 'utf8').digest()
  return digest.readBigUInt64BE(0).toString(36).padStart(PROFILE_HASH_LEN, '0')
}

/**
 * The open-connector connection PROFILE name for an org+user+connection:
 * `<hash(orgId)>--<hash(userId)>--<connectionName>`.
 *
 * HASHED, not truncated: `@@unique([orgId, name])` gives per-org row uniqueness but not
 * cross-org PROFILE uniqueness, and an 8-char cuid prefix (`c` + base36 ms) only resolved
 * creation time to ~36ms buckets. Two orgs sharing a bucket, whose creating users also
 * shared one, and using a common connection name ("gmail") composed the SAME profile — and
 * a shared profile means one org's `saveConnection` overwrites the other's stored
 * credential, after which its agents run actions as that other org. 64 digest bits per id
 * make that collision negligible.
 *
 * Only the create route composes a profile. It is then persisted as the connection's
 * `x-oomol-connector-alias` binding marker and read back from there by reconnect and by
 * relay-binding replay, so connections provisioned under the older scheme keep resolving
 * under their stored name — changing this function renames nothing that already exists.
 */
export function composeProfileName(orgId: string, userId: string, connectionName: string): string {
  return `${hashIdSegment('org', orgId)}--${hashIdSegment('user', userId)}--${connectionName}`
}
