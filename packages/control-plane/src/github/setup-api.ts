import { githubRequest, mintAppJwt } from './api.js'
import { resolveGithubAppConfig, type GithubAppConfig } from './config.js'

export interface GithubSetupAppIdentity {
  appId: number
  slug: string
  clientId: string | null
  privateKeyBase64: string
}

/** Adapt persisted deployment credentials to the same validated App config used by the Control Plane. */
export function resolveGithubSetupAppConfig(identity: GithubSetupAppIdentity): GithubAppConfig {
  const config = resolveGithubAppConfig({
    GITHUB_APP_ID: identity.appId,
    GITHUB_APP_SLUG: identity.slug,
    GITHUB_APP_PRIVATE_KEY_B64: identity.privateKeyBase64,
    ...(identity.clientId ? { GITHUB_APP_CLIENT_ID: identity.clientId } : {})
  })
  if (!config) throw new Error('GitHub App credentials are not configured')
  return config
}

export { githubRequest, mintAppJwt }
export type { FetchLike, GithubRequestOpts } from './api.js'
