import { QQSettingsFragments } from './settings'
import { QQMark } from './mark'
import type { WebPlatformModule } from '../contract'
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
    identityCards: () => ({ create: 'Connect a QQ bot', existing: 'An unused QQ bot' }),
    inviteHint: () => 'Send your bot a private message or @mention it in a QQ group.'
  },
  apiBindings: {},
  settingsFragments: QQSettingsFragments,
  channelList: { roomNoun: 'conversation', roomGlyph: '', leave: 'none' }
}
