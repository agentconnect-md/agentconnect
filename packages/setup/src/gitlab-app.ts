import { GITLAB_DEFAULT_BASE_URL, GITLAB_OAUTH_CALLBACK_PATH } from '@agentconnect.md/control-plane/gitlab-config'
import type { ProviderAppConfig } from './provider-app.js'

/** Exactly the scope set the Control Plane asks GitLab for (gitlab-com-integration.md §9.1). */
export const GITLAB_OAUTH_SCOPES = ['api'] as const

/** Where a user registers their own OAuth application on any instance. */
const USER_APPLICATIONS_PATH = '/-/user_settings/applications'
/** Where an administrator registers an instance-wide one instead. */
const ADMIN_APPLICATIONS_PATH = '/admin/applications'

export interface GitlabConfiguredUrls {
  callbackUrl: string
  scopes: string[]
  /** The instance these links target (§24.1) — GitLab.com when the axis is unset. */
  instanceUrl: string
  applicationsUrl: string
  adminApplicationsUrl: string
}

/**
 * GitLab has no OAuth-application creation API, so setup only publishes what to
 * register by hand — on whichever instance this deployment is bound to.
 *
 * Instance links are composed by CONCATENATION onto the normalized base (§24.1):
 * resolving `/-/user_settings/applications` against a prefixed install root would
 * silently discard the prefix.
 */
export function gitlabConfiguredUrls(
  config: ProviderAppConfig,
  baseUrl: string = GITLAB_DEFAULT_BASE_URL
): GitlabConfiguredUrls {
  const controlPlane = config.services.controlPlane
  if (!controlPlane || new URL(controlPlane).protocol !== 'https:') {
    throw new Error('the GitLab OAuth application requires a saved HTTPS Control Plane public URL')
  }
  const instanceUrl = baseUrl.replace(/\/+$/, '')
  return {
    callbackUrl: `${controlPlane.replace(/\/$/, '')}${GITLAB_OAUTH_CALLBACK_PATH}`,
    scopes: [...GITLAB_OAUTH_SCOPES],
    instanceUrl,
    applicationsUrl: `${instanceUrl}${USER_APPLICATIONS_PATH}`,
    adminApplicationsUrl: `${instanceUrl}${ADMIN_APPLICATIONS_PATH}`
  }
}
