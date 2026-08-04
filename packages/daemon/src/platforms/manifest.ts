/**
 * The **platform manifest** — the third facet of the daemon adapter contract
 * (integration-plugin-architecture.md §5, stage S2).
 *
 * Layer 1 (`contract.ts`) is what a platform DOES; Layer 2 (`turn-output.ts`) is
 * what it renders; the registry (`registry.ts`) is how its connections are keyed.
 * The manifest is the fourth thing core needs and the only one it reads BEFORE a
 * dispatch target exists — which is exactly D2's dividing rule for what earns a
 * manifest field at all. If core can wait until it holds a connection, an
 * adapter, or a `Pending` turn, the answer belongs in Layer 1/2 or a strategy
 * function, not here.
 *
 * THE RULE HAS TEETH — it already rejected a field. Status-bar shape ("Slack has
 * an editable session status line; the others answer `/status` on demand") looks
 * exactly like a capability, and is not one: every read is from a `Pending`, i.e.
 * after the turn and its output surface exist. The S0 audit classifies all four
 * of those branches as class (c) `status-bar renderer`, and §5 deliberately omits
 * them. They stay as literals in `daemon.ts` until the chrome strategy extraction
 * owns them. A manifest field is earned by a PRE-DISPATCH read, in review, or it
 * is just a capability flag with better branding — the pattern this migration
 * exists to eliminate.
 *
 * So this file is deliberately SMALL and grows one justified field at a time. The
 * S0 audit classified 48 daemon branches as manifest-capability reads; each
 * becomes a field only when its call site is shown to be pre-dispatch. Fields land
 * with the branches they retire, never speculatively.
 *
 * FAIL-CLOSED DEFAULTS ARE THE POINT. Lookup is total: an id this build does not
 * know gets `DEFAULT_MANIFEST`, whose every value is the conservative arm — no
 * authoritative enumeration API is assumed to exist. That reproduces today's
 * behavior exactly (every branch being replaced is written as "Slack does X,
 * everyone else does Y"), and it means an unknown platform degrades quietly
 * instead of taking a Slack-shaped path it cannot serve.
 *
 * NOT THE CROSS-HOST MANIFEST — YET. §5's full field list is read by relay, CP,
 * and web too (`credentialShape`, `identityScope`, `regions`, …). Those hosts are
 * S3. Promoting this to a shared package is that stage's job; declaring the
 * cross-host shape now, with only one consumer to check it against, would be
 * guessing. The FIELD VOCABULARY, however, is §5's as published — a daemon-local
 * synonym would just become a rename in S3.
 */

/** How core can learn which conversations a bot can reach (§5).
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
}

/** The conservative arm of every axis — see the fail-closed note above. */
export const DEFAULT_MANIFEST: Omit<PlatformManifest, 'platform'> = {
  membershipEnumeration: 'observed'
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
  ['slack', { membershipEnumeration: 'authoritative', dmChannelPattern: /^D/ }],
  ['telegram', { membershipEnumeration: 'observed' }],
  ['discord', { membershipEnumeration: 'observed' }],
  ['feishu', { membershipEnumeration: 'observed' }]
])

/** The manifest for `platform`. Total by construction: an unregistered id gets
 *  the fail-closed defaults rather than throwing or falling into a Slack path. */
export function manifestFor(platform: string): PlatformManifest {
  return { platform, ...(MANIFESTS.get(platform) ?? DEFAULT_MANIFEST) }
}
