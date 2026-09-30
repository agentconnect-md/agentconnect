// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import { createIntegration, fetchGoogleChatDeploymentApp, replaceGoogleChatKey } from '@/lib/api'

// The Google Chat module's own CP client surface ({@link WebPlatformModule.apiBindings}); the pane keeps the created row's id for its test step.
export const googleChatApi = {
  create: createIntegration,
  deploymentApp: fetchGoogleChatDeploymentApp,
  replaceKey: replaceGoogleChatKey
}

export type GoogleChatApi = typeof googleChatApi
