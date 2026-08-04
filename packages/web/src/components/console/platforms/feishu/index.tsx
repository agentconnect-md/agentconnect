// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import { PlatformMark } from '@/components/marks'
import type { WebPlatformModule } from '../contract'
import { inviteBotHint } from '../wizard-chrome'
import { feishuApi, type FeishuApi } from './api'
import { FeishuWizardBody, FEISHU_TRANSPORT_LABEL } from './Body'

/** The region a bot without one belongs to — legacy rows predate the axis. */
const regionOf = (bot: { feishuRegion?: 'feishu' | 'lark' | null }) => bot.feishuRegion ?? 'feishu'

/** Both clouds share every string except the brand name. */
const brandOf = (region: string | undefined) => (region === 'feishu' ? 'Feishu' : 'Lark')

export const feishuModule: WebPlatformModule<FeishuApi> = {
  platformId: 'feishu',
  Mark: ({ fillPct }) => <PlatformMark platform="feishu" {...(fillPct === undefined ? {} : { fillPct })} />,
  wizard: {
    Body: FeishuWizardBody,
    // A bot belongs to ONE developer-console cloud; offering a Feishu bot while
    // the wizard is on Lark would mint an integration against the wrong gateway.
    freeBotFilter: (bot, ctx) => regionOf(bot) === (ctx.region ?? 'lark'),
    buildReuseInput: (bot, ctx) => ({
      platform: 'feishu',
      agentId: ctx.agentId,
      botId: bot.id,
      // Reuse keeps the bot's own transport (immutable post-create).
      transport: bot.transport ?? 'socket'
    }),
    affordances: {
      // Long Connection stays the default; a public callback address makes HTTP
      // available as an explicit choice, never as the default.
      transport: { labels: FEISHU_TRANSPORT_LABEL, httpByDefaultWhenRelayAvailable: false }
    },
    identityCards: (region) => ({
      create: `Create with one-click ${brandOf(region)} setup`,
      existing: `An unused ${brandOf(region)} bot`
    }),
    inviteHint: (region) => inviteBotHint('group', brandOf(region), '@-mention it to start')
  },
  apiBindings: feishuApi
}
