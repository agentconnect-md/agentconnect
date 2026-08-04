/**
 * The control plane's **platform-provider registry** (integration-plugin-
 * architecture.md §9, stage S3) — the concrete {@link CpPlatformRegistry},
 * landing with the first two providers exactly as the contract's seam-first
 * note promised ("the concrete registry lands with the first provider move,
 * not with the contract").
 *
 * One instance is composed at `buildContainer` time and threaded to its
 * adopters — today the create route and ALL wire projection (spec assembly +
 * `rc/bot-assign`); `loadConfig`'s schema fold, route mounting, and
 * `startBackground()` follow — so adding a platform registers one provider here
 * and edits no core file beyond the composition line (§12). The registry is
 * also the platform-set authority the audit's six hand-copied closed unions
 * converge on (S3 exit criterion).
 *
 * Deliberately dumb, mirroring the S2 registry precedents (`daemon/src/
 * platforms/registry.ts`, `relay/src/platforms/registry.ts`): a keyed map
 * that never parses a platform id and holds no per-platform knowledge — a
 * duplicate registration is a composition bug and fails construction.
 */
import type { CpPlatformProvider, CpPlatformRegistry } from './provider.js'

export function buildCpPlatformRegistry(providers: readonly CpPlatformProvider[]): CpPlatformRegistry {
  const byId = new Map<string, CpPlatformProvider>()
  for (const provider of providers) {
    if (byId.has(provider.platformId)) {
      throw new Error(`duplicate control-plane platform provider: ${provider.platformId}`)
    }
    byId.set(provider.platformId, provider)
  }
  const all = Object.freeze([...byId.values()])
  const ids = Object.freeze([...byId.keys()])
  return {
    get: (platformId) => byId.get(platformId),
    all: () => all,
    ids: () => ids
  }
}
