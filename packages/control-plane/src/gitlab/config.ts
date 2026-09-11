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
import { GITLAB_DEFAULT_BASE_URL } from '@agentconnect.md/protocol'
import { normalizeCodeHostBaseUrl } from '../codehost/base-url.js'
import type { AppConfig } from '../config/env.js'

// The default value of the host axis: an unset base URL means GitLab.com (§24.1). It is
// the protocol's, not this module's — the same absence means GitLab.com on the wire.
export { GITLAB_DEFAULT_BASE_URL }

/** The public callback path, in its gateway form (deploy-public-url-prefix decision). */
export const GITLAB_OAUTH_CALLBACK_PATH = '/v1/gitlab/oauth/callback'
/** The begin hop that stamps the browser-binding cookie before redirecting to GitLab. */
export const GITLAB_OAUTH_BEGIN_PATH = '/v1/gitlab/oauth/begin'

/** The one normalization of the host axis (§24.1); downstream sees only its result. The rules
 *  are the instance axis itself rather than GitLab's, so they live in `codehost/base-url.ts` and
 *  every self-hosted code host reads the same ones. */
export function normalizeGitlabBaseUrl(raw: string): string {
  return normalizeCodeHostBaseUrl(raw, 'gitlab')
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
