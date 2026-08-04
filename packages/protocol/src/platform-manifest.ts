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
 * granted. That reproduces the behavior of every branch being replaced (each
 * was written as "Slack does X, everyone else does Y"), and it means an unknown
 * platform degrades quietly instead of taking a Slack-shaped path it cannot
 * serve.
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

/** One platform's pre-dispatch capability declaration. */
export interface PlatformManifest {
  /** Diagnostic label; never parsed. */
  readonly platform: string
  readonly membershipEnumeration: MembershipEnumeration
  /** Channel ids syntactically recognizable as DIRECT MESSAGES, for ingress whose
   *  wire event omits the conversation type (Slack `app_mention` may omit
   *  `channel_type`, but its DM ids are D-prefixed). A PRE-DISPATCH read: gated-
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
}

/** The conservative arm of every axis — see the fail-closed note above. */
export const DEFAULT_MANIFEST: Omit<PlatformManifest, 'platform'> = {
  membershipEnumeration: 'observed',
  botSenderRouting: false
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
  ['slack', { membershipEnumeration: 'authoritative', dmChannelPattern: /^D/, botSenderRouting: true }],
  ['telegram', { membershipEnumeration: 'observed', botSenderRouting: false }],
  ['discord', { membershipEnumeration: 'observed', botSenderRouting: false }],
  ['feishu', { membershipEnumeration: 'observed', botSenderRouting: false }]
])

/** The manifest for `platform`. Total by construction: an unregistered id gets
 *  the fail-closed defaults rather than throwing or falling into a Slack path. */
export function manifestFor(platform: string): PlatformManifest {
  return { platform, ...(MANIFESTS.get(platform) ?? DEFAULT_MANIFEST) }
}
