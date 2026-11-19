import { emailInboundUrl } from '@agentconnect.md/protocol'
import type { ProviderAppConfig } from './provider-app.js'

/** Where the operator onboards the mail domain, deploys the ingress Worker and creates the sending token (email-integration.md §7). */
export const EMAIL_PROVIDER_DASHBOARD_URL = 'https://dash.cloudflare.com/'

export interface EmailConfiguredUrls {
  /** The relay route the ingress Worker posts each inbound mail to. */
  inboundUrl: string
  dashboardUrl: string
}

/** Mail has no API that installs the Worker or its route, so setup only publishes what to enter by hand. */
export function emailConfiguredUrls(config: ProviderAppConfig): EmailConfiguredUrls {
  const relay = config.services.relay
  if (!relay || new URL(relay).protocol !== 'https:') {
    throw new Error('Email requires a saved HTTPS ingress public URL')
  }
  return { inboundUrl: emailInboundUrl(relay), dashboardUrl: EMAIL_PROVIDER_DASHBOARD_URL }
}
