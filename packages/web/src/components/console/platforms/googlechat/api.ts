// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import {
  createIntegration,
  fetchGoogleChatPlatformInstall,
  installGoogleChatPlatformApp,
  replaceGoogleChatKey,
  type GoogleChatPlatformInstallDto
} from '@/lib/api'

// The Google Chat module's own CP client surface ({@link WebPlatformModule.apiBindings}); the pane keeps the created row's id for its test step.
export const googleChatApi = {
  create: createIntegration,
  readPlatformInstall: fetchGoogleChatPlatformInstall,
  installPlatformApp: installGoogleChatPlatformApp,
  replaceKey: replaceGoogleChatKey
}

export type GoogleChatApi = typeof googleChatApi
export type { GoogleChatPlatformInstallDto }
