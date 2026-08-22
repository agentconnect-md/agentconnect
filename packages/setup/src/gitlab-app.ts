import { GITLAB_OAUTH_CALLBACK_PATH } from '@agentconnect.md/control-plane/gitlab-config'
import type { ProviderAppConfig } from './provider-app.js'

/** Exactly the scope set the Control Plane asks GitLab for (gitlab-com-integration.md §9.1). */
export const GITLAB_OAUTH_SCOPES = ['api'] as const

export interface GitlabConfiguredUrls {
  callbackUrl: string
  scopes: string[]
}

/** GitLab has no OAuth-application creation API, so setup only publishes what to register by hand. */
export function gitlabConfiguredUrls(config: ProviderAppConfig): GitlabConfiguredUrls {
  const controlPlane = config.services.controlPlane
  if (!controlPlane || new URL(controlPlane).protocol !== 'https:') {
    throw new Error('the GitLab OAuth application requires a saved HTTPS Control Plane public URL')
  }
  return {
    callbackUrl: `${controlPlane.replace(/\/$/, '')}${GITLAB_OAUTH_CALLBACK_PATH}`,
    scopes: [...GITLAB_OAUTH_SCOPES]
  }
}
