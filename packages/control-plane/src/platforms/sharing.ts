/**
 * Which platforms may serve SEVERAL agents from ONE bot identity
 * (`Bot.shareable`, shared-bot-relay.md §4.1) — Slack alone today.
 *
 * CORE-OWNED, not a provider member. `multiAgentShareable` is one of the §5
 * MANIFEST values the provider contract deliberately excludes (`provider.ts`,
 * D2: manifest values are cross-host declarative data, not behavior); until that
 * manifest lands in protocol the fact has to live somewhere core, and this is
 * that somewhere. When the manifest arrives, this predicate is what it replaces
 * — one call site per route, not a scattered literal.
 *
 * It is a module rather than a literal in each route because the two routes that
 * read it had already drifted: the create path refused a multi-agent install
 * outright (`http/routes/integrations.ts`'s `validateShareableInstall`), while
 * `PATCH /bots/:id` gated only on transport. Any HTTP-transport bot on another
 * platform could therefore be flipped `shareable` and the flag would sit on the
 * row as a promise no install path ever honors.
 */

/** Whether `platform` supports multi-agent bots at all — the precondition BOTH
 *  the shareable install and the sharing toggle check before anything else. */
export function supportsMultiAgentBots(platform: string): boolean {
  return platform === 'slack'
}

/** The user-facing refusal for a platform that does not. One string for both
 *  routes: it names the same set {@link supportsMultiAgentBots} decides, so the
 *  two move together. */
export const MULTI_AGENT_UNSUPPORTED_MESSAGE = 'multi-agent bots currently support Slack only'
