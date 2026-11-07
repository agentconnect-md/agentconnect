import type { ProviderAppConfig } from './provider-app.js'

export interface AzureDevOpsConfiguredUrls {
  /** The Console page Microsoft returns an Azure DevOps administrator to (azure-devops-integration.md §3.1). */
  connectRedirectUri: string
}

/** Azure DevOps reuses the Microsoft sign-in application; setup only publishes its extra redirect URI. */
export function azureDevOpsConfiguredUrls(config: ProviderAppConfig): AzureDevOpsConfiguredUrls {
  const { web } = config.services
  if (!web || new URL(web).protocol !== 'https:') {
    throw new Error('Azure DevOps requires a saved HTTPS console URL')
  }
  return { connectRedirectUri: `${web.replace(/\/+$/, '')}/azure-devops/connect` }
}
