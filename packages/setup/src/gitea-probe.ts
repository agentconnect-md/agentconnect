/**
 * The unauthenticated half of the Gitea instance check (gitea-integration.md §3): when the
 * instance base URL is saved, issue `GET <base>/api/v1/version` with no credentials. Gitea answers
 * that one without a token, which is why the VERSION FLOOR is checked here and not at first
 * credentialed contact — unlike GitLab, whose `/version` needs a token and whose probe can only
 * prove DNS, TLS trust and shape.
 *
 * Two verdicts block the save: a URL shape this product will not address, and an instance below
 * the floor. Everything else warns, because the Setup Server and the Control Plane need not share
 * a network position — an instance this process cannot reach may be perfectly reachable from the
 * Control Plane, and refusing would be this process guessing about someone else's network.
 */
import { normalizeGiteaBaseUrl, GITEA_MINIMUM_VERSION } from '@agentconnect.md/control-plane/gitea-config'

export type GiteaProbeStatus =
  'ok' | 'invalid_url' | 'instance_version_unsupported' | 'unreachable' | 'tls_untrusted' | 'not_a_gitea_api_root'

export interface GiteaProbeResult {
  status: GiteaProbeStatus
  message: string
  /** The normalized base the probe addressed; absent when the shape was refused. */
  baseUrl?: string
  /** The version string the instance reported, when it reported a parseable one. */
  version?: string
}

/** Give up on a silent instance rather than hold the save request open. */
const PROBE_TIMEOUT_MS = 5_000

/** Node's TLS verification failures, as they surface through `fetch`'s cause chain. */
const TLS_FAILURE_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
])

/** Whether a probe verdict must stop the save: the URL shape, and the version floor (§3). */
export function probeBlocksSave(probe: GiteaProbeResult): boolean {
  return probe.status === 'invalid_url' || probe.status === 'instance_version_unsupported'
}

/**
 * The `<major>.<minor>` the floor applies to, or undefined when the string carries none.
 *
 * A build marker naming GITEA COMPATIBILITY (`11.0.0+gitea-1.22.0`, how Forgejo reports itself) is
 * what the floor reads, because the leading version is then the fork's own. Forgejo forked from
 * Gitea 1.22 and diverges in ways that matter here, so its string lands below the floor and is
 * refused — that is §3's refusal, not an accident of parsing leniency. A genuine Gitea reports
 * `1.23.1` or `1.27.0+dev` and is read from the front.
 */
export function parseGiteaVersion(raw: unknown): { major: number; minor: number } | undefined {
  if (typeof raw !== 'string') return undefined
  const match = /\+gitea-(\d+)\.(\d+)/.exec(raw) ?? /^\s*v?(\d+)\.(\d+)/.exec(raw)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]) }
}

const FLOOR = parseGiteaVersion(GITEA_MINIMUM_VERSION)!

/** Fail CLOSED on a version this build cannot read (§3). */
function meetsFloor(version: { major: number; minor: number }): boolean {
  return version.major > FLOOR.major || (version.major === FLOOR.major && version.minor >= FLOOR.minor)
}

export async function probeGiteaInstance(rawBaseUrl: string, fetchImpl: typeof fetch): Promise<GiteaProbeResult> {
  let baseUrl: string
  try {
    baseUrl = normalizeGiteaBaseUrl(rawBaseUrl)
  } catch (error) {
    return { status: 'invalid_url', message: error instanceof Error ? error.message : 'invalid instance base URL' }
  }
  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}/api/v1/version`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
  } catch (error) {
    if (isTlsFailure(error)) {
      return {
        status: 'tls_untrusted',
        baseUrl,
        message: `the certificate at ${baseUrl} was not trusted by this process; the Control Plane needs the instance authority bundle`
      }
    }
    return {
      status: 'unreachable',
      baseUrl,
      message: `${baseUrl} could not be reached from the Setup Server; saved anyway, because the Control Plane may reach it`
    }
  }
  const reported = response.ok ? await readVersionBody(response) : undefined
  if (reported === undefined) {
    return {
      status: 'not_a_gitea_api_root',
      baseUrl,
      message: `${baseUrl}/api/v1/version answered ${response.status} rather than a Gitea version; check the URL and any path prefix`
    }
  }
  const parsed = parseGiteaVersion(reported)
  if (!parsed || !meetsFloor(parsed)) {
    return {
      status: 'instance_version_unsupported',
      baseUrl,
      version: reported,
      message: `${baseUrl} reports version ${reported}; AgentConnect requires Gitea ${GITEA_MINIMUM_VERSION} or later`
    }
  }
  return { status: 'ok', baseUrl, version: reported, message: `${baseUrl} answered as Gitea ${reported}` }
}

/** The `{ version }` string of a Gitea API root, or undefined for any other body. */
async function readVersionBody(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return undefined
    const version = (body as { version?: unknown }).version
    return typeof version === 'string' && version.trim() !== '' ? version.trim() : undefined
  } catch {
    return undefined
  }
}

/** `fetch` reports a TLS failure through nested causes, so walk a bounded chain. */
function isTlsFailure(error: unknown): boolean {
  for (let cursor: unknown = error, depth = 0; cursor !== undefined && cursor !== null && depth < 5; depth++) {
    const candidate = cursor as { code?: unknown; cause?: unknown }
    if (typeof candidate.code === 'string' && TLS_FAILURE_CODES.has(candidate.code)) return true
    cursor = candidate.cause
  }
  return false
}
