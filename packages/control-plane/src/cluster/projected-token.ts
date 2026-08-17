/**
 * The shared TokenReview core: "is this a projected ServiceAccount token belonging
 * to the workload I expect, in my own namespace?"
 *
 * Two callers ask that question about different principals — a daemon pool member
 * and the usage-report collector — and the answer must be reached the same way for
 * both. Every check here is load-bearing, which is precisely why it lives in ONE
 * place: a verifier that reimplemented four of the five checks would look correct in
 * review and authenticate the wrong pod at runtime.
 */
import type { K8sHttp } from '@agentconnect.md/k8s-client'
import { CP_TOKEN_AUDIENCE } from '@agentconnect.md/protocol'

/** What TokenReview answers, narrowed to the fields verification reads. */
interface TokenReviewResponse {
  status?: {
    authenticated?: boolean
    audiences?: string[]
    error?: string
    user?: { username?: string; extra?: Record<string, string[]> }
  }
}

/** The `system:serviceaccount:<namespace>:<name>` subject, or null for any other principal. */
export function parseServiceAccountSubject(username: string | undefined): {
  namespace: string
  serviceAccount: string
} | null {
  const parts = (username ?? '').split(':')
  if (parts.length !== 4 || parts[0] !== 'system' || parts[1] !== 'serviceaccount') return null
  const [, , namespace, serviceAccount] = parts
  if (!namespace || !serviceAccount) return null
  return { namespace, serviceAccount }
}

const POD_UID_EXTRA = 'authentication.kubernetes.io/pod-uid'

/** The Pod UID attested by TokenReview for a Pod-bound projected token. */
export function reviewedPodUid(extra: Record<string, string[]> | undefined): string | null {
  const values = extra?.[POD_UID_EXTRA]
  return values?.length === 1 && values[0] ? values[0] : null
}

/** A reviewed workload, reported as the API SERVER named it — callers bind on these
 *  rather than on what they expected, so a record is anchored to the answer and not
 *  to a re-derivation of the question. Equal to `expect` by construction. */
export interface ReviewedWorkload {
  namespace: string
  serviceAccount: string
  podUid: string
}

/**
 * Verify a projected token and pin it to exactly one expected principal. Null on any
 * fail-closed reason: unauthenticated, valid for some OTHER audience, not a
 * ServiceAccount, a different ServiceAccount or namespace, or not Pod-bound.
 * A store/API error PROPAGATES so a caller answers a retryable error rather than a
 * false "invalid credential".
 */
export async function reviewProjectedToken(
  http: K8sHttp,
  token: string,
  expect: { namespace: string; serviceAccount: string }
): Promise<ReviewedWorkload | null> {
  const review = await http.json<TokenReviewResponse>({
    method: 'POST',
    path: '/apis/authentication.k8s.io/v1/tokenreviews',
    body: {
      apiVersion: 'authentication.k8s.io/v1',
      kind: 'TokenReview',
      spec: { token, audiences: [CP_TOKEN_AUDIENCE] }
    }
  })
  const status = review.status ?? {}
  if (status.authenticated !== true) return null
  // Asserted rather than inferred from `authenticated`: the API server echoes the
  // audiences the token is actually valid for, and only ours may authenticate here.
  if (!status.audiences?.includes(CP_TOKEN_AUDIENCE)) return null
  const subject = parseServiceAccountSubject(status.user?.username)
  if (!subject) return null
  if (subject.serviceAccount !== expect.serviceAccount || subject.namespace !== expect.namespace) return null
  const podUid = reviewedPodUid(status.user?.extra)
  if (!podUid) return null
  return { namespace: subject.namespace, serviceAccount: subject.serviceAccount, podUid }
}
