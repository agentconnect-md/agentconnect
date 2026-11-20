// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebChannelListSemantics, WebPlatformModule } from '../contract'
import { identityCards } from '../wizard-chrome'
import { emailApi } from './api'
import { EmailWizardBody } from './Body'
import { emailAgentCard, emailSettingsFragments } from './card'
import { EmailMark } from './mark'
import { emailUnnamedLabel } from './unnamed'

/** A room row is a thread with several people; one thread is one session, and no conversation is left from the Console. */
export const EMAIL_CHANNEL_LIST: WebChannelListSemantics = {
  roomNoun: 'thread',
  roomGlyph: '',
  leave: 'none',
  sessionModes: ['createNew']
}

export const emailModule: WebPlatformModule = {
  platformId: 'email',
  integrationGroup: 'workflow',
  // Mail is a trigger without a product of its own, so it sits beside the generic webhook rather than ahead of the code hosts.
  pickerBefore: 'webhook',
  docsPath: 'connect-automate/triggers-automation/email',
  requires: 'email',
  offered: emailApi.offered,
  Mark: EmailMark,
  unnamedLabel: emailUnnamedLabel,
  wizard: {
    Body: EmailWizardBody,
    // An address is never moved to another agent, so no freed address is offered for reuse.
    freeBotFilter: () => false,
    buildReuseInput: (bot, ctx) => ({ platform: 'email', agentId: ctx.agentId, botId: bot.id, transport: 'http' }),
    affordances: {},
    identityCards: () => identityCards('email'),
    inviteHint: () => ({
      key: 'Integrations.dialog.platformHints.mail',
      values: { target: 'Integrations.dialog.platformHints.targets.group', platform: 'Platforms.email.brand' }
    })
  },
  apiBindings: emailApi,
  settingsFragments: emailSettingsFragments,
  agentCard: emailAgentCard,
  channelList: EMAIL_CHANNEL_LIST
}
