/**
 * The **platform manifest** — the third facet of the daemon adapter contract
 * (integration-plugin-architecture.md §5, stage S2).
 *
 * Layer 1 (`contract.ts`) is what a platform DOES; Layer 2 (`turn-output.ts`) is
 * what it renders; the registry (`registry.ts`) is how its connections are keyed.
 * The manifest is the fourth thing core needs and the only one it reads BEFORE a
 * dispatch target exists — which is exactly D2's dividing rule for what earns a
 * manifest field at all. If core can wait until it holds a connection or an
 * adapter, the answer belongs in Layer 1/2 or a strategy function, not here.
 *
 * That rule is why this file is deliberately SMALL and grows one justified field
 * at a time. The S0 audit classified 48 daemon branches as manifest-capability
 * reads; each becomes a field only when its call site is shown to be pre-dispatch.
 * Fields land with the branches they retire, never speculatively.
 *
 * FAIL-CLOSED DEFAULTS ARE THE POINT. Lookup is total: an id this build does not
 * know gets `DEFAULT_MANIFEST`, whose every value is the conservative arm — no
 * bulk enumeration API is assumed to exist, no status bar is assumed to be
 * editable. That reproduces today's behavior exactly (every branch being replaced
 * is written as "Slack does X, everyone else does Y"), and it means an unknown
 * platform degrades quietly instead of taking a Slack-shaped path it cannot serve.
 *
 * NOT THE CROSS-HOST MANIFEST — YET. §5's full field list is read by relay, CP,
 * and web too (`credentialShape`, `identityScope`, `regions`, …). Those hosts are
 * S3. Promoting this to a shared package is that stage's job; declaring the
 * cross-host shape now, with only one consumer to check it against, would be
 * guessing. The daemon's own reads are what this file is accountable to.
 */

/** How core can learn which conversations a bot can reach.
 *
 *  - `bulk` — the platform offers one cheap membership snapshot for the whole
 *    bot (Slack `users.conversations`), so core refreshes the full set when a
 *    connection comes up or membership changes.
 *  - `per-conversation` — no such API. Core discovers reachable chats from
 *    traffic (approach-A observed discovery) and resolves each stored session's
 *    channel individually through its own connection.
 */
export type MembershipEnumeration = 'bulk' | 'per-conversation'

/** Where a session's live status is shown.
 *
 *  - `turn-bar` — the platform supports one editable session-scoped status line
 *    that core keeps current in place (Slack).
 *  - `on-demand` — no persistent bar; the user asks (`/status`) and the answer is
 *    rendered then. Core still tracks the dedup key so the shared bookkeeping
 *    stays consistent, but emits nothing.
 */
export type StatusSurface = 'turn-bar' | 'on-demand'

/** One platform's pre-dispatch capability declaration. */
export interface PlatformManifest {
  /** Diagnostic label; never parsed. */
  readonly platform: string
  readonly membershipEnumeration: MembershipEnumeration
  readonly statusSurface: StatusSurface
}

/** The conservative arm of every axis — see the fail-closed note above. */
export const DEFAULT_MANIFEST: Omit<PlatformManifest, 'platform'> = {
  membershipEnumeration: 'per-conversation',
  statusSurface: 'on-demand'
}

const MANIFESTS: Record<string, Omit<PlatformManifest, 'platform'>> = {
  // Slack is the only platform with both a bulk membership snapshot and an
  // editable session status line — which is why the branches this replaces all
  // read "Slack does X, everyone else does Y".
  slack: { membershipEnumeration: 'bulk', statusSurface: 'turn-bar' },
  telegram: { membershipEnumeration: 'per-conversation', statusSurface: 'on-demand' },
  discord: { membershipEnumeration: 'per-conversation', statusSurface: 'on-demand' },
  feishu: { membershipEnumeration: 'per-conversation', statusSurface: 'on-demand' }
}

/** The manifest for `platform`. Total by construction: an unregistered id gets
 *  the fail-closed defaults rather than throwing or falling into a Slack path. */
export function manifestFor(platform: string): PlatformManifest {
  return { platform, ...(MANIFESTS[platform] ?? DEFAULT_MANIFEST) }
}
