/**
 * The ONE answer to "can this daemon actually serve this platform?" — the predicate behind both the
 * install-time gate (`http/daemon-platform-capability.ts`) and the duty ledger's claim gate.
 *
 * A daemon resolves an integration's config through its own platform-module registry
 * (`daemon/src/platforms/integration-config.ts`) and fails CLOSED on an id it has no module for:
 * it skips the integration and opens no connection. So a claim that ignores capabilities does not
 * degrade gracefully — the agent's whole surface on that platform goes dead on that member, with
 * no error anywhere, until the group moves again. Every rollout that adds a platform has that
 * window, so the gate belongs on the claim, not only on the install.
 *
 * `platform` is an OPEN id (integration-plugin-architecture.md §9): the ids stored on integration
 * rows come from the CP's platform registry, and the daemon's advertised list is the authority for
 * what it can run. Nothing here parses either — a fifth registered platform needs no edit.
 */

/** What a member advertised on register — `RegisterReq.capabilities.platforms`. */
export type AdvertisedPlatforms = readonly string[]

/** Does this member advertise a module for one platform? The install-time gate's whole question. */
export function servesPlatform(advertised: AdvertisedPlatforms, platform: string): boolean {
  return advertised.includes(platform)
}

/** The platforms a member would have to skip, in first-seen order and deduped — the log's payload. */
export function missingPlatforms(advertised: AdvertisedPlatforms, required: Iterable<string>): string[] {
  return [...new Set(required)].filter((platform) => !servesPlatform(advertised, platform))
}

/** Subset: a member may serve this surface only when it advertises EVERY platform it needs.
 *  An empty requirement is served by anyone, which is what keeps a botless agent claimable. */
export function servesPlatforms(advertised: AdvertisedPlatforms, required: Iterable<string>): boolean {
  return missingPlatforms(advertised, required).length === 0
}
