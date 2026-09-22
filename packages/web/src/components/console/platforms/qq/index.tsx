import { QQSettingsFragments } from './settings'
import { QQMark } from './mark'
import type { WebPlatformModule } from '../contract'
import { identityCards, inviteBotHint } from '../wizard-chrome'
import { QQWizardBody } from './Body'

export const QQModule: WebPlatformModule = {
  platformId: 'qq',
  requires: 'qq',
  Mark: QQMark,
  senderFallback: (sender) => (/^[0-9a-f]{32}$/i.test(sender) ? `QQ user · ${sender.slice(-8)}` : undefined),
  wizard: {
    Body: QQWizardBody,
    freeBotFilter: () => true,
    buildReuseInput: (bot, ctx) => ({ platform: 'qq', agentId: ctx.agentId, botId: bot.id }),
    affordances: {},
    identityCards: () => identityCards('qq'),
    inviteHint: () => inviteBotHint('group', 'QQ', true)
  },
  apiBindings: {},
  settingsFragments: QQSettingsFragments,
  channelList: { roomNoun: 'conversation', roomGlyph: '', leave: 'none' }
}
