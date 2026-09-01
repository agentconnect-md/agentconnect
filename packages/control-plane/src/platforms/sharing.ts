/**
 * The user-facing refusal when a platform cannot serve multi-agent bots
 * (`Bot.shareable`, shared-bot-relay.md §4.1).
 *
 * The FACT is no longer here: it is the §5 manifest's `multiAgentShareable`,
 * read at each gate as `manifestFor(platform).multiAgentShareable` — the
 * install-time, pre-dispatch read that field was earned by. What stays core is
 * the COPY, one derivation for both gates because the two had already drifted
 * once: the create path refused a multi-agent install outright
 * (`http/routes/integrations.ts`'s `validateShareableInstall`) while
 * `PATCH /bots/:id` gated only on transport, so an HTTP-transport bot on any
 * other platform could be flipped `shareable` and carry a flag no install path
 * honors.
 *
 * It names the offending platform rather than enumerating the supported set:
 * the set now grows with the manifest, and a sentence that lists it goes stale
 * the moment a row is added.
 */

/** The refusal both multi-agent gates send, for the platform that was refused.
 *  `platform` is a closed vocabulary at both call sites — the create body's
 *  registry enum, or a persisted `platform` column past `toDbPlatform`. */
export function multiAgentUnsupportedMessage(platform: string): string {
  return `multi-agent bots are not supported on ${platform}`
}
