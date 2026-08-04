// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import {
  deleteSlackConfig,
  fetchSlackConfig,
  getSlackInstall,
  getSlackPlatformInstall,
  refreshSlackBot,
  saveSlackConfig,
  startSlackInstall,
  startSlackPlatformInstall
} from '@/lib/api'

/**
 * The Slack module's own CP client surface ({@link WebPlatformModule.apiBindings}) —
 * the config-token funnel, the platform-published "Add to Slack" install, and the
 * bot-maintenance refresh its settings fragments will use. OPAQUE to the chassis.
 *
 * `readConfig` is the IMPERATIVE re-read a failed install performs to learn
 * whether the CP just invalidated a rejected access-only token. The REACTIVE
 * read of the same endpoint is the chassis-owned deployment probe
 * (`platforms/deployment-config.ts`), because its relay fields are
 * deployment-scoped rather than Slack-scoped; the funnel flags riding the same
 * DTO are read off that one shared request.
 *
 * Finalizing an install is deliberately absent: it goes through
 * `useConsoleData().finalizeSlackInstall`, which also refreshes the console's
 * integration/bot projections — the same reason a create commits through
 * {@link WizardHost.createIntegration}.
 *
 * `saveConfig`/`clearConfig` are the Profile card's writes
 * ({@link WebPlatformModule.ProfileCredentialCard}, `./profile.tsx`): the same
 * per-user config token the funnel reads, maintained on the page where its
 * owner lives.
 */
export const slackApi = {
  startInstall: startSlackInstall,
  getInstall: getSlackInstall,
  startPlatformInstall: startSlackPlatformInstall,
  getPlatformInstall: getSlackPlatformInstall,
  readConfig: fetchSlackConfig,
  saveConfig: saveSlackConfig,
  clearConfig: deleteSlackConfig,
  refreshBot: refreshSlackBot
}

export type SlackApi = typeof slackApi
