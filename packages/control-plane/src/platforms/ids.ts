/**
 * The control plane's **static platform-id declaration** — the S3 exit
 * criterion's "registry is the single platform-set authority" for the readers
 * that cannot hold the registry INSTANCE.
 *
 * WHY A STATIC DECLARATION AND NOT `CpPlatformRegistry.ids()`. Same reason
 * `platforms/env.ts` exists: some core readers run before, or entirely without,
 * `buildContainer()`.
 *
 *  - `http/dto/index.ts` builds its zod schemas at MODULE LOAD. `z.enum(...)`
 *    needs its members while the module is being evaluated, long before a
 *    container exists — and the OpenAPI document generated from those schemas
 *    is a published contract, so the set has to be knowable statically.
 *  - `persistence/platform.ts`'s `toDbPlatform` is a free function called from
 *    eight repositories, the placement compiler, and two route files. Threading
 *    a registry through all of them to answer "is this id served?" would put the
 *    platform seam inside every persistence call signature for one membership
 *    test.
 *
 * What keeps this from being the SIXTH hand-copied union the audit counted is
 * `ids.test.ts`: it pins this list against the ids the four PRODUCTION
 * providers register, so a provider added to the container and forgotten here
 * fails a test instead of silently dropping out of the cron target vocabulary,
 * the waitlist intake, and the persistence fence. Adding a platform is one
 * entry here plus the provider — the same two-line shape `env.ts` documents,
 * and no edit to any consumer.
 *
 * Deliberately DEPENDENCY-FREE. Persistence imports this module, so it must not
 * reach the provider modules (which would invert the layering and risk an
 * import cycle through the repositories those providers' seams are built from).
 */

/**
 * Every chat platform this build serves — the id set `CpPlatformRegistry.ids()`
 * returns at runtime.
 *
 * `webchat`, `hook` and `dream` are NOT here: they are session-identity-only
 * protocol platforms with no provider, no persisted integration row, and no
 * install funnel (`persistence/platform.ts`, `isSessionIdentityPlatform`).
 */
export const CP_PLATFORM_IDS = ['slack', 'telegram', 'discord', 'feishu', 'linear'] as const

/** One served chat platform. The closed static type behind `DbPlatform` and the
 *  cron/hook target vocabulary. */
export type CpPlatformId = (typeof CP_PLATFORM_IDS)[number]
