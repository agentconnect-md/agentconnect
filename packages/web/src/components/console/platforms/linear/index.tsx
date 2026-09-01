// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebPlatformModule } from '../contract'
import { linearApi, type LinearApi } from './api'
import { LinearWizardBody } from './Body'
import { LinearMark } from './mark'
import { linearSettingsFragments } from './settings'

/** Linear's provider-native activity id: a v4 UUID. A daemon-local numeric stamp
 *  can never match it, and neither can any other platform's id shape. */
const LINEAR_ACTIVITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const linearModule: WebPlatformModule<LinearApi> = {
  platformId: 'linear',
  Mark: LinearMark,
  wizard: {
    Body: LinearWizardBody,
    /**
     * Every connected workspace of the org is offered, unfenced (§7.4): the Bot row
     * IS the workspace, `shareable: true` is structural on it, and adding a member
     * needs no reuse fence — the CP refuses nothing the list could show. The chassis
     * predicate already drops revoked rows and other platforms'.
     */
    freeBotFilter: () => true,
    buildReuseInput: (bot, ctx) => ({
      platform: 'linear',
      agentId: ctx.agentId,
      botId: bot.id,
      // Linear offers no dial-out transport, so a workspace bot is only ever http
      // (§4.2); the CP treats the durable bot row as authoritative either way.
      transport: 'http'
    }),
    affordances: {
      // No transport CHOICE: `http` is the platform's single fixed transport, which
      // is a different thing from offering two (contract: absent ⇒ fixed).
      // A connected workspace is definitionally multi-agent — the §5 manifest's
      // `multiAgentShareable`, mirrored here for the wizard's opt-in and the
      // Settings toggle to read one declaration.
      share: true
    },
    identityCards: () => ({ create: 'Connect a Linear workspace', existing: 'A connected Linear workspace' }),
    // Not `inviteBotHint`: nobody invites the app to an issue. A Linear session starts
    // by delegating the issue to the app or mentioning it, and neither is an invite.
    inviteHint: () => 'delegate an issue to the app in Linear, or mention it to reach one agent by name.'
  },
  settingsFragments: linearSettingsFragments,
  apiBindings: linearApi,
  channelList: {
    // A Linear issue is the room: several agents bind to it, one session each.
    roomNoun: 'issue',
    // Issues are titled, not `#name`-prefixed — the row shows the bare title.
    roomGlyph: '',
    // No console-driven leave: an issue's agent sessions end in Linear, and the app
    // is removed from the workspace by disconnecting it here instead.
    leave: 'none',
    cannotLeaveRowHint: 'The app stays on the issue — end the agent session in Linear for that.',
    footerNote: 'An issue lands here when the app is delegated to it or mentioned on it.'
  },
  // Agent activities are append-only rows with their own ids (§15), so a duplicate
  // across sources is the same activity; anything else never dedupes.
  messageIdentity: (row) => (LINEAR_ACTIVITY_ID.test(row.ts) ? `ts:${row.ts}` : null),
  // Linear rows arrive over one relay-terminated ingress in daemon `seq` order and
  // carry no provider send-time the display must follow.
  transcriptOrdering: 'seq'
}
