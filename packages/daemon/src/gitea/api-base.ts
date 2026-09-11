/**
 * The `/api/v1` root of the one Gitea instance a deployment talks to (gitea-integration.md §3, §11).
 *
 * Composed by CONCATENATION onto the normalized base, never by URL resolution against an absolute
 * path, which silently discards a path prefix — a first-class install shape here. Every daemon client
 * resolves this PER TURN from the host its spec or its trusted hook metadata carries, so the value
 * stays a data dependency rather than a boot-time constant nothing can re-target.
 */
import { GITEA_DEFAULT_BASE_URL } from '@agentconnect.md/protocol'

export function giteaApiBaseUrl(host?: string): string {
  const trimmed = host?.trim()
  return `${trimmed ? trimmed.replace(/\/+$/, '') : GITEA_DEFAULT_BASE_URL}/api/v1`
}
