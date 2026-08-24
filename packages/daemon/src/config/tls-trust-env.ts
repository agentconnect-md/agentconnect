/**
 * The customer authority bundle, as process configuration (gitlab-com-integration.md §24.5).
 *
 * A self-managed instance is commonly fronted by a private certificate authority, so Node, git and
 * the tools the daemon spawns each need to be pointed at the operator's bundle. That is the ONLY
 * mechanism: there is no skip-verify flag at any layer. These names are an addition to the daemon's
 * existing deliberately narrow forwarding allowlists, not a new channel.
 */
export const TLS_TRUST_ENV = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO'] as const

export function tlsTrustEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of TLS_TRUST_ENV) {
    const value = source[name]
    if (value !== undefined && value !== '') env[name] = value
  }
  return env
}
