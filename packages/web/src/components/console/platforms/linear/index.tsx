// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebPlatformModule } from '../contract'
import { linearApi, type LinearApi } from './api'
import { LinearWizardBody } from './Body'
import { LinearWorkspaceRows } from './card'
import { linearLinkInput } from './link'
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
    buildReuseInput: (bot, ctx) => linearLinkInput(ctx.agentId, bot.id),
    affordances: {
      // No transport CHOICE: `http` is the platform's single fixed transport, which
      // is a different thing from offering two (contract: absent ⇒ fixed).
      // Multi-agent is STRUCTURAL, not an opt-in: the provider stamps
      // `shareable: true` on every workspace bot (§4.3), so reuse admits members
      // while neither the wizard nor Settings offers a flag to move.
      share: 'fixed'
    },
    // The pane replaces the identity chassis outright, so these two never render for
    // Linear; the contract requires them of every module and they stay honest copy.
    identityCards: () => ({ create: 'Connect a Linear workspace', existing: 'A connected Linear workspace' }),
    // Not `inviteBotHint`: nobody invites the app to an issue. A Linear session starts
    // by delegating the issue to the app or mentioning it, and neither is an invite.
    inviteHint: () => 'delegate an issue to the app in Linear, or mention it to reach one agent by name.'
  },
  settingsFragments: linearSettingsFragments,
  apiBindings: linearApi,
  // NO `channelList`. The generic list enumerates rooms a bot was added to, each with
  // a trigger and a way out; a Linear workspace has none of those — linking is the
  // consent act and unlinking is how an agent goes quiet — and its issues are not a
  // roster the console keeps. The card body below renders the workspace instead, so
  // the generic list is never reached and its semantics would describe nothing.
  agentCard: { Body: LinearWorkspaceRows },
  // Agent activities are append-only rows with their own ids (§15), so a duplicate
  // across sources is the same activity; anything else never dedupes.
  messageIdentity: (row) => (LINEAR_ACTIVITY_ID.test(row.ts) ? `ts:${row.ts}` : null),
  // Linear rows arrive over one relay-terminated ingress in daemon `seq` order and
  // carry no provider send-time the display must follow.
  transcriptOrdering: 'seq'
}
