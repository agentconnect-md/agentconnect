/**
 * The **platform manifest** — §5 of integration-plugin-architecture.md, the one
 * platform-shaped table every host may read BEFORE a dispatch target exists.
 * That is D2's dividing rule for what earns a field here at all: if a host can
 * wait until it holds a connection, an adapter, or a turn, the answer belongs in
 * that host's Layer 1/2 contract or a strategy function, not in the manifest.
 *
 * Promoted from the daemon-local `platforms/manifest.ts` when the relay became
 * the second consumer (stage S3) — the field VOCABULARY is §5's as published,
 * and it lives in `protocol` because every host (daemon, relay, CP, web)
 * already depends on this package for the platform ids the table is keyed by.
 *
 * THE RULE HAS TEETH — it already rejected a field. Status-bar shape ("Slack
 * has an editable session status line; the others answer `/status` on demand")
 * looks exactly like a capability, and is not one: every read is from a turn
 * that already exists, i.e. post-dispatch. A manifest field is earned by a
 * PRE-DISPATCH read, in review, or it is just a capability flag with better
 * branding — the pattern this migration exists to eliminate.
 *
 * So this file is deliberately SMALL and grows one justified field at a time,
 * landing with the branches it retires, never speculatively.
 *
 * FAIL-CLOSED DEFAULTS ARE THE POINT. Lookup is total: an id this build does
 * not know gets `DEFAULT_MANIFEST`, whose every value is the conservative arm —
 * no authoritative enumeration API is assumed, no bot-sender admission is
 * granted, no bot serves more than one agent. That reproduces the behavior of
 * every branch being replaced (each was written as "Slack does X, everyone else
 * does Y"), and it means an unknown platform degrades quietly instead of taking
 * a Slack-shaped path it cannot serve.
 */

/** How a host can learn which conversations a bot can reach (§5).
 *
 *  - `authoritative` — the platform offers one cheap membership snapshot for the
 *    whole bot (Slack `users.conversations`), so core refreshes the full set when
 *    a connection comes up or membership changes.
 *  - `observed` — no such API. Core discovers reachable chats from traffic
 *    (approach-A discovery) and resolves each stored session's channel
 *    individually through its own connection.
 */
export type MembershipEnumeration = 'authoritative' | 'observed'

/** What a bot can actually withdraw from, once it is in a conversation (§5).
 *
 *  - `conversation` — the bot is a member of the individual chat and leaves it
 *    on its own (Slack `conversations.leave`, Telegram `leaveChat`).
 *  - `space` — membership is granted at the enclosing space and the bot has no
 *    per-conversation membership to drop, so the only withdrawal is leaving the
 *    whole space (Discord: a bot joins a guild, not a channel).
 */
export type LeaveGranularity = 'conversation' | 'space'

/** One platform's pre-dispatch capability declaration. */
export interface PlatformManifest {
  /** Diagnostic label; never parsed. */
  readonly platform: string
  readonly membershipEnumeration: MembershipEnumeration
  /** Channel ids syntactically recognizable as DIRECT MESSAGES, for ingress whose
   *  wire event omits the conversation type (Slack `app_mention` may omit
   *  `channel_type`, but its DM ids are D-prefixed). A PRE-DISPATCH read:
   *  conversation discovery consults it before routing resolves any target.
   *  Absent when the id syntax carries no DM signal — then `msg.isDm` is all
   *  there is. */
  readonly dmChannelPattern?: RegExp
  /** Whether bot-authored messages may enter the routing ladder at all (§5).
   *  Read by relay arbitration BEFORE any target resolves: on a `true` platform
   *  a third-party bot's message is admitted when it explicitly @-mentions the
   *  receiving bot (verified AgentConnect authors ride the full ladder
   *  separately); on a `false` platform bot senders never route. Fail-closed:
   *  an unknown platform admits no bot senders. */
  readonly botSenderRouting: boolean
  /** What a leave request may target on this platform (§5). A PRE-DISPATCH
   *  read: the control plane validates the SHAPE of a leave request — space vs
   *  conversation — before it resolves an owner, takes the mutation lease, or
   *  reaches the daemon that would perform the leave, so there is no adapter or
   *  turn to ask. The same axis is the daemon's two leave members
   *  (`leaveConversation` / `leaveSpace`) and the web module's
   *  `WebChannelListSemantics.leave`; this is the declaration all three read
   *  instead of re-spelling "Discord is the one with servers". */
  readonly leaveGranularity: LeaveGranularity
  /** Whether ONE bot identity here may serve SEVERAL agents (`Bot.shareable`,
   *  shared-bot-relay.md §4.1). A PRE-DISPATCH read: the control plane decides
   *  it from the platform alone at INSTALL time — `POST /integrations` refuses a
   *  shareable install and `PATCH /bots/:id` refuses the sharing toggle before a
   *  bot is reused, an integration row exists, or any daemon is reached.
   *  Fail-closed: an unknown platform serves one agent per bot, so a flag no
   *  install path honors can never be set. */
  readonly multiAgentShareable: boolean
}

/** The conservative arm of every axis — see the fail-closed note above. */
export const DEFAULT_MANIFEST: Omit<PlatformManifest, 'platform'> = {
  membershipEnumeration: 'observed',
  botSenderRouting: false,
  // The arm the retired branch took for every non-Discord id: an unknown
  // platform is assumed to have no space to leave, so a space-targeted request
  // is refused rather than dispatched at a platform that cannot serve it.
  leaveGranularity: 'conversation',
  // The arm the retired Slack-only predicate took for every other id: one agent per bot.
  multiAgentShareable: false
}

/**
 * A `Map`, not an object literal, so lookup is total for EVERY string rather than
 * every string that is not an `Object.prototype` key. With a plain record,
 * `manifestFor('constructor')` would spread a function and advertise `undefined`
 * axes — a fail-OPEN hole in the exact guarantee this module sells.
 */
const MANIFESTS = new Map<string, Omit<PlatformManifest, 'platform'>>([
  // Slack is the only platform with an authoritative membership snapshot — which
  // is why the branches this replaces read "Slack does X, everyone else does Y".
  // It is also the only platform whose normalizer attributes bot authorship AND
  // explicit @-mentions well enough to admit third-party bot messages safely.
  [
    'slack',
    {
      membershipEnumeration: 'authoritative',
      dmChannelPattern: /^D/,
      botSenderRouting: true,
      leaveGranularity: 'conversation',
      multiAgentShareable: true
    }
  ],
  [
    'telegram',
    {
      membershipEnumeration: 'observed',
      botSenderRouting: false,
      leaveGranularity: 'conversation',
      multiAgentShareable: false
    }
  ],
  // A Discord bot is added to a GUILD, not to a channel — there is no
  // per-channel membership to drop, so the only withdrawal is the whole server.
  [
    'discord',
    {
      membershipEnumeration: 'observed',
      botSenderRouting: false,
      leaveGranularity: 'space',
      multiAgentShareable: false
    }
  ],
  [
    'feishu',
    {
      membershipEnumeration: 'observed',
      botSenderRouting: false,
      leaveGranularity: 'conversation',
      multiAgentShareable: false
    }
  ],
  // A connected Linear workspace IS a shared bot: the deployment's one OAuth app
  // is the identity and each enabled agent is a member (linear-integration.md §4.3).
  [
    'linear',
    {
      membershipEnumeration: 'observed',
      botSenderRouting: false,
      leaveGranularity: 'conversation',
      multiAgentShareable: true
    }
  ]
])

/** The manifest for `platform`. Total by construction: an unregistered id gets
 *  the fail-closed defaults rather than throwing or falling into a Slack path. */
export function manifestFor(platform: string): PlatformManifest {
  return { platform, ...(MANIFESTS.get(platform) ?? DEFAULT_MANIFEST) }
}
