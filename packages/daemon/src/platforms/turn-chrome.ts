/**
 * The **turn-chrome facet** (§7.4, stage S2) — the declarative half of Layer 2:
 * which pieces of per-turn CHROME a platform's output surface offers. The
 * behavior behind each flag stays where it always ran (core sequencing, or the
 * platform's turn-output module); this facet only answers "does `platform` have
 * one?", which used to be a `=== 'slack'` literal at every consulting site.
 *
 * THIS IS THE STRATEGY #532 SENT HERE. `statusSurface` was first proposed as a
 * manifest axis and rejected by review — correctly: every read happens with a
 * `Pending` in hand, i.e. AFTER dispatch, which is D2's line between a manifest
 * capability and an adapter strategy. The Layer-2 surface family is the home
 * that review named for it; the other four flags are the same shape of fact.
 *
 * LOOKUP IS EXACT, NOT CORE-FALLBACK, and the difference is load-bearing:
 * webchat / hook / dream RENDER through the core (Slack-shaped) surface, but
 * they must not inherit Slack's chrome — a hook turn gets no attribution
 * footer, no DM title, no approval cards. An unregistered platform gets `{}`:
 * every flag reads absent, and each site's legacy default arm applies.
 *
 * `statusSurface` is deliberately THREE-state: `'turn-bar'` (Slack's in-place
 * session status row), `'on-demand'` (state answered by `/status`; the emit
 * path records its dedup key but posts nothing), and ABSENT (no declaration —
 * the emit path's legacy default arm, which is what webchat/hook/headless and
 * unknown platforms take today).
 */

export interface TurnChrome {
  /** How session status reaches the user: an in-place per-turn status bar, or
   *  on demand via `/status`. Absent ⇒ the legacy default arm. */
  readonly statusSurface?: 'turn-bar' | 'on-demand'
  /** Attribution footer lifecycle: blocks pre-built at prompt start so reply
   *  sections are born with them, refreshed once more at final. */
  readonly attributionFooter?: boolean
  /** Live session titles pushed onto the platform's threads. Slack renders them as the
   *  thread panel's header in DMs AND channels — a thread becomes eligible once any
   *  agents.sessions call or a card stream registers it (verified live 2026-08-29). */
  readonly sessionTitle?: boolean
  /** In-chat human-input cards: permission approvals, MCP-approval
   *  elicitations, and the generic elicitation card. */
  readonly chatInputCards?: boolean
  /** Failure notices are posted with a chrome marker (and agent identity) so a
   *  peer daemon's thread backfill skips them. */
  readonly chromeMarkedNotices?: boolean
}

const CHROME = new Map<string, TurnChrome>([
  [
    'slack',
    {
      statusSurface: 'turn-bar',
      attributionFooter: true,
      sessionTitle: true,
      chatInputCards: true,
      chromeMarkedNotices: true
    }
  ],
  // The three on-demand platforms declare so EXPLICITLY: their status emit path
  // records the dedup key and posts nothing, which is different from having no
  // declaration at all (the legacy default arm).
  ['telegram', { statusSurface: 'on-demand' }],
  ['discord', { statusSurface: 'on-demand' }],
  ['feishu', { statusSurface: 'on-demand' }]
])

const NONE: TurnChrome = {}

/** `platform`'s chrome declaration. Exact lookup — see the class doc for why
 *  this must NOT fall back to the core surface's declaration. */
export function turnChromeFor(platform: string): TurnChrome {
  return CHROME.get(platform) ?? NONE
}
