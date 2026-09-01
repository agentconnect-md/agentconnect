import type { ProviderAppConfig } from './provider-app.js'

/** The public `/v1` OAuth callback the deployment app must list (linear-integration.md §7.1). */
export const LINEAR_OAUTH_CALLBACK_PATH = '/v1/integrations/linear/oauth/callback'

/** Relay-terminated ingress: Linear has no dial-out transport (§4.2, §6.1). */
export const LINEAR_WEBHOOK_PATH = '/linear/events'

/** The generic settings page; a workspace-specific URL would not resolve for another operator. */
export const LINEAR_APPLICATIONS_URL = 'https://linear.app/settings/api/applications'

export interface LinearConfiguredUrls {
  callbackUrl: string
  webhookUrl: string
  applicationsUrl: string
}

/** Linear has no OAuth-application creation API, so setup only publishes what to register by hand (§7.1). */
export function linearConfiguredUrls(config: ProviderAppConfig): LinearConfiguredUrls {
  // Both halves are required: the Control Plane terminates OAuth, the relay terminates webhooks.
  const controlPlane = config.services.controlPlane
  const relay = config.services.relay
  if (!controlPlane || new URL(controlPlane).protocol !== 'https:') {
    throw new Error('the Linear OAuth application requires a saved HTTPS Control Plane public URL')
  }
  if (!relay || new URL(relay).protocol !== 'https:') {
    throw new Error('the Linear OAuth application requires a saved HTTPS ingress public URL')
  }
  return {
    callbackUrl: `${controlPlane.replace(/\/$/, '')}${LINEAR_OAUTH_CALLBACK_PATH}`,
    webhookUrl: `${relay.replace(/\/$/, '')}${LINEAR_WEBHOOK_PATH}`,
    applicationsUrl: LINEAR_APPLICATIONS_URL
  }
}
