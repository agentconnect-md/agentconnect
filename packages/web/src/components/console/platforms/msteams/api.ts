// No 'use client' here: reached only from ModalProvider's tree and the Settings view, both client trees.

import {
  createIntegration,
  downloadMsTeamsAppPackage,
  fetchMsTeamsDeploymentApp,
  replaceMsTeamsSecret,
  startMsTeamsConnect
} from '@/lib/api'

// The Teams module's own CP client surface ({@link WebPlatformModule.apiBindings}); the pane keeps the created row's id for the package download.
export const msTeamsApi = {
  create: createIntegration,
  replaceSecret: replaceMsTeamsSecret,
  appPackage: downloadMsTeamsAppPackage,
  deploymentApp: fetchMsTeamsDeploymentApp,
  connect: startMsTeamsConnect
}

export type MsTeamsApi = typeof msTeamsApi
