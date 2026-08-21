/**
 * GitLab.com OAuth application identity (gitlab-com-integration.md §18.3).
 *
 * Deployment config: one OAuth application per deployment, used ONLY as the
 * administration identity (project discovery, provisioning). v1 pins the host —
 * no GITLAB_BASE_URL, no self-managed branch. Opt-in mirrors the GitHub App:
 * both vars set ⇒ enabled, none ⇒ module not assembled, partial ⇒ fail fast.
 */
import type { AppConfig } from '../config/env.js'

/** OAuth, API, and Git remotes are pinned to GitLab.com in v1 (§3). */
export const GITLAB_HOST = 'https://gitlab.com'

/** The public callback path, in its gateway form (deploy-public-url-prefix decision). */
export const GITLAB_OAUTH_CALLBACK_PATH = '/v1/gitlab/oauth/callback'
/** The begin hop that stamps the browser-binding cookie before redirecting to GitLab. */
export const GITLAB_OAUTH_BEGIN_PATH = '/v1/gitlab/oauth/begin'

export interface GitlabAppConfig {
  clientId: string
  clientSecret: string
}

type GitlabEnvSlice = Pick<AppConfig, 'GITLAB_CLIENT_ID' | 'GITLAB_CLIENT_SECRET'>

/** Undefined ⇒ feature disabled. Throws on a partial pair. */
export function resolveGitlabAppConfig(config: GitlabEnvSlice): GitlabAppConfig | undefined {
  const present = {
    GITLAB_CLIENT_ID: config.GITLAB_CLIENT_ID !== undefined,
    GITLAB_CLIENT_SECRET: config.GITLAB_CLIENT_SECRET !== undefined
  }
  const set = Object.values(present).filter(Boolean).length
  if (set === 0) return undefined
  if (set < 2) {
    const missing = Object.entries(present)
      .filter(([, ok]) => !ok)
      .map(([k]) => k)
    throw new Error(`gitlab oauth config is partial — missing ${missing.join(', ')} (set both or none)`)
  }
  return { clientId: config.GITLAB_CLIENT_ID!, clientSecret: config.GITLAB_CLIENT_SECRET! }
}
