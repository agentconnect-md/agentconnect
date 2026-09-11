/**
 * The injected host→provider table (gitlab-com-integration.md §24.4) and the parsing both ends of
 * the credential channel share.
 *
 * A leaf with NO imports on purpose: the credential helper and the `glab` token entry are bundled
 * for the sandbox image and may pull in nothing but node builtins, while the daemon writes the same
 * table at injection time. Each entry carries the FULL normalized base URL — scheme, host,
 * non-default port, and any path prefix — because with `useHttpPath` a prefixed install hands git a
 * credential `path` that starts with that prefix, and a bare hostname could not strip it.
 */

/**
 * Wire form for the provider a table entry names: an OPEN string, like protocol's
 * `CodeHostProviderString`. The table is INJECTED, so an entry for a provider this build knows
 * nothing about must degrade per value rather than make the whole table undecodable; the daemon's
 * code-host credential registry and the helper's parser table are where a provider is narrowed, and
 * each fails closed on a name it does not carry. The narrowed union cannot live here: both ends of
 * the channel share this leaf, and the in-sandbox bundle may import nothing but node builtins.
 */
export type ManagedCredentialProvider = string

/** The provider every v1 credential request means implicitly — the only one never named on the wire. */
export const IMPLICIT_CREDENTIAL_PROVIDER = 'github'

/** One managed code host: the provider plus the normalized base URL its consumers address. */
export interface ManagedCredentialHost {
  provider: ManagedCredentialProvider
  /** Scheme, lower-cased host, non-default port, and any path prefix; never a trailing slash. */
  baseUrl: string
}

/** The env name the table travels on, minted beside the capability and agent identity. */
export const GITCRED_HOSTS_ENV = 'AC_GITCRED_HOSTS'

export const GITHUB_MANAGED_HOST: ManagedCredentialHost = {
  provider: IMPLICIT_CREDENTIAL_PROVIDER,
  baseUrl: 'https://github.com'
}

/** The default value of the GitLab host axis (§24.1) — absent is GitLab.com, never a second mode. */
export const GITLAB_COM_BASE_URL = 'https://gitlab.com'

function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1
  return value.slice(0, end)
}

function trimSurroundingSlashes(value: string): string {
  let start = 0
  while (start < value.length && value.charCodeAt(start) === 47) start += 1
  return trimTrailingSlashes(value.slice(start))
}

/** A spec-carried host as a base URL — trimmed, no trailing slash; undefined when the spec names none. */
export function normalizeManagedBaseUrl(host?: string): string | undefined {
  const trimmed = trimTrailingSlashes((host ?? '').trim())
  return trimmed === '' ? undefined : trimmed
}

/** The GitLab instance a spec's GitLab consumers address; an absent host means GitLab.com (§24.1). */
export function gitlabManagedHost(gitlabHost?: string): ManagedCredentialHost {
  return { provider: 'gitlab', baseUrl: normalizeManagedBaseUrl(gitlabHost) ?? GITLAB_COM_BASE_URL }
}

/** The default table — GitHub plus the one GitLab instance a spec names — and what an absent or
 *  unparseable env falls back to. An injected table is composed per provider by the daemon's
 *  code-host credential registry, which this leaf cannot reach. */
export function managedHostTableFor(gitlabHost?: string): ManagedCredentialHost[] {
  return [GITHUB_MANAGED_HOST, gitlabManagedHost(gitlabHost)]
}

/** `github=https://github.com gitlab=https://gitlab.example.test:8443/gitlab` — space separated,
 *  which no absolute URL may contain. */
export function encodeManagedHostTable(hosts: readonly ManagedCredentialHost[]): string {
  return hosts.map((entry) => `${entry.provider}=${entry.baseUrl}`).join(' ')
}

/** Absent or unparseable ⇒ the default table, which is what a deployment on GitLab.com means. An
 *  entry keeps whatever provider it names: the consumer that cannot place the name is the one that
 *  refuses it, so a newer daemon's table never reads as a table of nothing. */
export function decodeManagedHostTable(raw: string | undefined): ManagedCredentialHost[] {
  const entries: ManagedCredentialHost[] = []
  for (const token of (raw ?? '').split(/\s+/)) {
    const eq = token.indexOf('=')
    if (eq <= 0) continue
    const provider = token.slice(0, eq)
    const baseUrl = trimTrailingSlashes(token.slice(eq + 1))
    if (parseManagedBaseUrl(baseUrl) === undefined) continue
    entries.push({ provider, baseUrl })
  }
  return entries.length > 0 ? entries : managedHostTableFor()
}

export interface ManagedBaseUrlParts {
  /** Lower-cased scheme without the colon, as git spells it on the credential `protocol` line. */
  protocol: string
  /** Lower-cased host including a non-default port, as git spells it on the `host` line. */
  host: string
  /** Path prefix without surrounding slashes; empty for an instance at the URL root. */
  pathPrefix: string
}

export function parseManagedBaseUrl(baseUrl: string): ManagedBaseUrlParts | undefined {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]+)(\/[^?#\s]*)?$/i.exec(baseUrl.trim())
  if (!match) return undefined
  return {
    protocol: match[1]!.toLowerCase(),
    host: match[2]!.toLowerCase(),
    pathPrefix: trimSurroundingSlashes(match[3] ?? '')
  }
}

/**
 * The request path with the entry's prefix removed on an EXACT segment boundary, or undefined when
 * the prefix does not apply — a second GitLab at another prefix on the same host is not ours.
 */
export function stripHostPathPrefix(path: string, pathPrefix: string): string | undefined {
  const cleaned = path.replace(/^\/+/, '')
  if (pathPrefix === '') return cleaned
  if (!cleaned.startsWith(pathPrefix)) return undefined
  const rest = cleaned.slice(pathPrefix.length)
  if (rest === '') return ''
  if (!rest.startsWith('/')) return undefined
  return rest.replace(/^\/+/, '')
}

/** What git hands a credential helper on stdin, as far as routing cares. */
export interface ManagedHostQuery {
  protocol?: string
  host?: string
  path?: string
}

export interface ManagedHostMatch {
  entry: ManagedCredentialHost
  /** The request path with the entry's prefix stripped; absent when git sent no path. */
  path?: string
}

/**
 * The table entry a credential request belongs to — undefined means "not ours", and the caller must
 * stay silent rather than guess. Host comparison is exact, so a host that is a prefix or a suffix of
 * a managed one never matches; among matches the longest applicable path prefix wins.
 */
export function matchManagedHost(
  table: readonly ManagedCredentialHost[],
  query: ManagedHostQuery
): ManagedHostMatch | undefined {
  const protocol = query.protocol?.toLowerCase()
  const host = query.host?.toLowerCase()
  if (host === undefined) return undefined
  let best: ManagedHostMatch | undefined
  let bestPrefixLength = -1
  for (const entry of table) {
    const parts = parseManagedBaseUrl(entry.baseUrl)
    if (!parts) continue
    if (parts.host !== host) continue
    if (protocol !== undefined && protocol !== parts.protocol) continue
    let path: string | undefined
    if (query.path !== undefined) {
      path = stripHostPathPrefix(query.path, parts.pathPrefix)
      if (path === undefined) continue
    } else if (parts.pathPrefix !== '') {
      // A prefixed install cannot be recognized without the path git was asked for.
      continue
    }
    if (parts.pathPrefix.length <= bestPrefixLength) continue
    bestPrefixLength = parts.pathPrefix.length
    best = { entry, ...(path !== undefined ? { path } : {}) }
  }
  return best
}
