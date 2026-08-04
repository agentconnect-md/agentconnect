// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import { PlatformMark } from '@/components/marks'
import type { WebPlatformModule } from '../contract'
import { inviteBotHint } from '../wizard-chrome'
import { slackApi, type SlackApi } from './api'
import { SlackWizardBody, SLACK_TRANSPORT_LABEL } from './Body'

export const slackModule: WebPlatformModule<SlackApi> = {
  platformId: 'slack',
  Mark: ({ fillPct }) => <PlatformMark platform="slack" {...(fillPct === undefined ? {} : { fillPct })} />,
  wizard: {
    Body: SlackWizardBody,
    /**
     * A platform-app install (`teamId`) starts NON-shareable — one workspace
     * serves one agent (preset-agents.md §5.5) — and the CP 409s reusing it, so
     * the list must not offer it. Only the Slack platform-app install ever
     * persists a `teamId`, which is why this eligibility rule is Slack's and not
     * the chassis's generic predicate.
     */
    freeBotFilter: (bot) => !bot.teamId || bot.shareable,
    buildReuseInput: (bot, ctx) => ({
      platform: 'slack',
      agentId: ctx.agentId,
      botId: bot.id,
      // Reuse keeps the bot's own transport; the CP treats the durable bot row
      // as authoritative either way.
      transport: bot.transport ?? 'socket',
      ...(ctx.shared ? { shareable: true } : {})
    }),
    affordances: {
      transport: { labels: SLACK_TRANSPORT_LABEL, httpByDefaultWhenRelayAvailable: true },
      share: true
    },
    identityCards: () => ({ create: 'Create with a Slack manifest', existing: 'An unused Slack app' }),
    inviteHint: () => inviteBotHint('channel', 'Slack')
  },
  apiBindings: slackApi
}
