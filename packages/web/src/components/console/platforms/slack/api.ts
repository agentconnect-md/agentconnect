// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import {
  deleteSlackConfig,
  fetchSlackConfig,
  getSlackInstall,
  getSlackPlatformInstall,
  refreshSlackBot,
  replaceSlackBotToken,
  saveSlackConfig,
  startSlackInstall,
  startSlackPlatformInstall
} from '@/lib/api'

// The Slack module's own CP client surface ({@link WebPlatformModule.apiBindings}); install finalize goes through `useConsoleData()` so projections refresh.
export const slackApi = {
  startInstall: startSlackInstall,
  getInstall: getSlackInstall,
  startPlatformInstall: startSlackPlatformInstall,
  getPlatformInstall: getSlackPlatformInstall,
  readConfig: fetchSlackConfig,
  saveConfig: saveSlackConfig,
  clearConfig: deleteSlackConfig,
  refreshBot: refreshSlackBot,
  replaceBotToken: replaceSlackBotToken
}

export type SlackApi = typeof slackApi
