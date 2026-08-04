// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebPlatformModule } from '../contract'
import { inviteBotHint } from '../wizard-chrome'
import { slackApi, type SlackApi } from './api'
import { SlackWizardBody, SLACK_TRANSPORT_LABEL } from './Body'
import { SlackMark } from './mark'
import { slackSettingsFragments } from './settings'
import { useSlackPlatformInstall } from './use-platform-install'

/** Slack's provider-native message id: epoch seconds with a sub-second part
 *  (`1754123456.000200`). Chosen so a daemon-local 13-digit `monotonicTs()`
 *  millisecond stamp can never match it. */
const SLACK_NATIVE_TS = /^\d+\.\d+$/

export const slackModule: WebPlatformModule<SlackApi> = {
  platformId: 'slack',
  Mark: SlackMark,
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
  settingsFragments: slackSettingsFragments,
  apiBindings: slackApi,
  installPolling: { useInstallPoll: useSlackPlatformInstall },
  channelList: {
    roomNoun: 'channel',
    roomGlyph: '#',
    // `conversations.leave` would need `channels:manage`, which also grants
    // create/archive/kick/rename and would force every installed workspace to
    // re-authorize. Slack re-lists membership authoritatively instead, so
    // removing the bot IN Slack clears the row by itself — hence the footer note.
    leave: 'none',
    footerNote: 'To remove the bot from a channel, do it in Slack — this list updates by itself.'
  },
  messageIdentity: (row) => (SLACK_NATIVE_TS.test(row.ts) ? `ts:${row.ts}` : null),
  // Slack rows carry the workspace's own send-time, and a page must present
  // them in it: the daemon `seq` is ingest order, which reorders a burst that
  // arrived out of order. Every other platform trusts `seq`.
  transcriptOrdering: 'event-time'
}
