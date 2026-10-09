import { WeixinMark } from './mark'
import type { WebPlatformModule } from '../contract'
import { identityCards, inviteBotHint } from '../wizard-chrome'
import { WeixinWizardBody } from './Body'

export const WeixinModule: WebPlatformModule = {
  platformId: 'weixin',
  Mark: WeixinMark,
  senderFallback: (sender) => (sender.startsWith('weixin:user:') ? `微信用户 · ${sender.slice(-8)}` : undefined),
  wizard: {
    Body: WeixinWizardBody,
    freeBotFilter: () => true,
    buildReuseInput: (bot, ctx) => ({ platform: 'weixin', agentId: ctx.agentId, botId: bot.id }),
    affordances: {},
    identityCards: () => identityCards('weixin'),
    inviteHint: () => inviteBotHint('conversation', 'Weixin')
  },
  apiBindings: {},
  channelList: { roomNoun: 'conversation', roomGlyph: '', leave: 'none' }
}
