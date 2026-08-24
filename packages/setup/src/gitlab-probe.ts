/**
 * The unauthenticated half of the GitLab instance floor check
 * (gitlab-com-integration.md §24.2): when the instance base URL is saved, issue
 * `GET <base>/api/v4/version` with no credentials. A healthy GitLab API root
 * answers `401` with its own JSON error body, which proves DNS, TLS trust, and
 * shape — the things that fail far more often than the version does.
 *
 * ONLY the URL shape blocks the save. The Setup Server and the Control Plane
 * need not share a network position, so an instance this process cannot reach
 * may still be perfectly reachable from the Control Plane; a refusal here would
 * be this process guessing about someone else's network.
 */
import { normalizeGitlabBaseUrl } from '@agentconnect.md/control-plane/gitlab-config'

export type GitlabProbeStatus = 'ok' | 'invalid_url' | 'unreachable' | 'tls_untrusted' | 'not_a_gitlab_api_root'

export interface GitlabProbeResult {
  status: GitlabProbeStatus
  message: string
  /** The normalized base the probe addressed; absent when the shape was refused. */
  baseUrl?: string
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

/** Whether a probe verdict must stop the save. Shape only, by design (§24.2). */
export function probeBlocksSave(probe: GitlabProbeResult): boolean {
  return probe.status === 'invalid_url'
}

export async function probeGitlabInstance(rawBaseUrl: string, fetchImpl: typeof fetch): Promise<GitlabProbeResult> {
  let baseUrl: string
  try {
    baseUrl = normalizeGitlabBaseUrl(rawBaseUrl)
  } catch (error) {
    return { status: 'invalid_url', message: error instanceof Error ? error.message : 'invalid instance base URL' }
  }
  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}/api/v4/version`, {
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
  if (response.status !== 401 || !(await isJsonObjectBody(response))) {
    return {
      status: 'not_a_gitlab_api_root',
      baseUrl,
      message: `${baseUrl}/api/v4/version answered ${response.status} rather than a GitLab API root's 401; check the URL and any path prefix`
    }
  }
  return { status: 'ok', baseUrl, message: `${baseUrl} answered as a GitLab API root` }
}

async function isJsonObjectBody(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null
  } catch {
    return false
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
