// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { WebPlatformModule } from '../contract'
import { linearApi, type LinearApi } from './api'
import { LinearWizardBody } from './Body'
import { LinearWorkspaceCard, LinearWorkspaceHeaderActions, LinearWorkspaceRows } from './card'
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
  // The TEAM is the channel (§4.3): one row per team, each with its dispatch default and an Off.
  // The roster is the workspace's own, so nothing is left or dropped from here — a team goes
  // quiet by turning its row Off, or the whole workspace by unlinking the agent.
  channelList: {
    roomNoun: 'team',
    roomGlyph: '',
    leave: 'none',
    roster: 'derived',
    // No `any`: every Linear event is addressed by construction (§6.1), so nothing would match it.
    triggers: ['off', 'mention'],
    footerNote:
      'Every team of this workspace is listed here; a delegation or a mention starts a session in one that is not off.',
    // §4.3: a gated member acts in a team only as its default, so enabling the row is half the gate.
    gatedNote: 'Private agent: it answers in a team only where it is the default and the team is not off.',
    // §6.2: the default seat IS a gated agent's grant, and a Linear AgentSession has one writer (§4.6).
    ownerChangeWarning: {
      title: 'Move this team’s default?',
      body: ({ owner, room }) =>
        `${owner} is a private agent, and being ${room}’s default is what lets it act there. Its live sessions in this team can still be stopped, but it will not answer in them again. A new mention or delegation opens a session with the new default.`,
      confirmLabel: 'Move'
    }
  },
  // The host header names the workspace and unlinks it; the module adds Reconnect there and
  // mounts the generic list of team rows beneath, both reading one card-scoped round trip.
  agentCard: {
    CardProvider: LinearWorkspaceCard,
    HeaderActions: LinearWorkspaceHeaderActions,
    Body: LinearWorkspaceRows
  },
  // Agent activities are append-only rows with their own ids (§15), so a duplicate
  // across sources is the same activity; anything else never dedupes.
  messageIdentity: (row) => (LINEAR_ACTIVITY_ID.test(row.ts) ? `ts:${row.ts}` : null),
  // Linear rows arrive over one relay-terminated ingress in daemon `seq` order and
  // carry no provider send-time the display must follow.
  transcriptOrdering: 'seq'
}
