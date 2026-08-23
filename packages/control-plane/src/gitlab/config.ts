/**
 * GitLab OAuth application identity (gitlab-com-integration.md §18.3, §24.1).
 *
 * Deployment config: one OAuth application per deployment, used ONLY as the
 * administration identity (project discovery, provisioning). The instance base
 * URL is one axis beside that pair, not a mode: absent means GitLab.com, so no
 * code path branches on "is this GitLab.com". Opt-in mirrors the GitHub App:
 * both client vars set ⇒ enabled, none ⇒ module not assembled, partial ⇒ fail
 * fast — and a base URL without the pair is a configuration error too.
 */
import type { AppConfig } from '../config/env.js'

/** The default value of the host axis: an unset base URL means GitLab.com (§24.1). */
export const GITLAB_DEFAULT_BASE_URL = 'https://gitlab.com'

/** The public callback path, in its gateway form (deploy-public-url-prefix decision). */
export const GITLAB_OAUTH_CALLBACK_PATH = '/v1/gitlab/oauth/callback'
/** The begin hop that stamps the browser-binding cookie before redirecting to GitLab. */
export const GITLAB_OAUTH_BEGIN_PATH = '/v1/gitlab/oauth/begin'

/** The one normalization of the host axis (§24.1); downstream sees only its
 *  result. HTTPS, no userinfo/query/fragment, lower-cased host, explicit
 *  non-default port kept, no trailing slash, and a path prefix preserved —
 *  a relative URL root is a first-class install shape. */
export function normalizeGitlabBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('gitlab base url must be an absolute URL')
  }
  if (url.protocol !== 'https:') throw new Error('gitlab base url must use https')
  if (url.username !== '' || url.password !== '') throw new Error('gitlab base url must not carry userinfo')
  if (url.search !== '') throw new Error('gitlab base url must not carry a query')
  if (url.hash !== '') throw new Error('gitlab base url must not carry a fragment')
  // `url.host` already lower-cases the host and drops the default 443 port.
  return `https://${url.host}${url.pathname.replace(/\/+$/, '')}`
}

export interface GitlabAppConfig {
  clientId: string
  clientSecret: string
  /** Normalized instance base URL; `GITLAB_DEFAULT_BASE_URL` when the axis is unset. */
  baseUrl: string
}

type GitlabEnvSlice = Pick<AppConfig, 'GITLAB_CLIENT_ID' | 'GITLAB_CLIENT_SECRET' | 'GITLAB_BASE_URL'>

/** Undefined ⇒ feature disabled. Throws on a partial pair, or a base URL without one. */
export function resolveGitlabAppConfig(config: GitlabEnvSlice): GitlabAppConfig | undefined {
  const present = {
    GITLAB_CLIENT_ID: config.GITLAB_CLIENT_ID !== undefined,
    GITLAB_CLIENT_SECRET: config.GITLAB_CLIENT_SECRET !== undefined
  }
  const set = Object.values(present).filter(Boolean).length
  const rawBaseUrl = config.GITLAB_BASE_URL?.trim()
  if (set === 0) {
    if (rawBaseUrl) {
      throw new Error('GITLAB_BASE_URL is set but no gitlab oauth application is — set the client pair or unset it')
    }
    return undefined
  }
  if (set < 2) {
    const missing = Object.entries(present)
      .filter(([, ok]) => !ok)
      .map(([k]) => k)
    throw new Error(`gitlab oauth config is partial — missing ${missing.join(', ')} (set both or none)`)
  }
  return {
    clientId: config.GITLAB_CLIENT_ID!,
    clientSecret: config.GITLAB_CLIENT_SECRET!,
    baseUrl: rawBaseUrl ? normalizeGitlabBaseUrl(rawBaseUrl) : GITLAB_DEFAULT_BASE_URL
  }
}
