/**
 * The `/api/v4` root of the one GitLab instance a deployment talks to (gitlab-com-integration.md
 * §24.1, §24.4).
 *
 * Composed by CONCATENATION onto the normalized base, never by URL resolution against an absolute
 * path, which silently discards a path prefix. Every daemon client resolves this PER TURN from the
 * host its spec or its trusted hook metadata carries: a deployment has exactly one instance, so the
 * value is constant, but reading it per turn is what keeps the host a data dependency rather than a
 * boot-time constant nothing can re-target.
 */
import { GITLAB_DEFAULT_BASE_URL } from '@agentconnect.md/protocol'

export function gitlabApiBaseUrl(host?: string): string {
  const trimmed = host?.trim()
  return `${trimmed ? trimmed.replace(/\/+$/, '') : GITLAB_DEFAULT_BASE_URL}/api/v4`
}
