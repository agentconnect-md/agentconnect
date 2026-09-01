/**
 * The platform slot's contribution to `AppConfigSchema`
 * (integration-plugin-architecture.md §9 `envSchema`).
 *
 * WHY A STATIC DECLARATION AND NOT THE REGISTRY INSTANCE. `loadConfig()` runs
 * BEFORE `buildContainer()` — and it must, because a provider is constructed
 * FROM the parsed config (the Slack funnel's TTL knobs, the platform-app
 * credentials). So the composition cannot read `CpPlatformRegistry.all()`
 * without a cycle. What it can read is the same `envSchema` object each
 * provider module exports and each provider instance hands back: the list below
 * is that set, and `platforms/env.test.ts` pins it against what the four
 * PROVIDERS declare, so a provider that grows a key and forgets this file fails
 * a test instead of silently losing its env at boot.
 *
 * Resolution into typed config — including the all-or-none partial-set
 * fail-fast of `config/slack-platform.ts` / `config/feishu-platform.ts` —
 * happens inside the provider's factory. Core consumes only the schema shape.
 */
import type { ZodRawShape } from 'zod'
import { SlackCpEnvSchema } from './slack/provider.js'
import { FeishuCpEnvSchema } from './feishu/provider.js'
import { LinearCpEnvSchema } from './linear/provider.js'

/** Every platform's declared env keys. Telegram and Discord own none — their
 *  whole install is the create-DTO path, with no deployment-level
 *  configuration, so they are absent here rather than present-and-empty. */
export const CP_PLATFORM_ENV_SCHEMAS = [
  { platformId: 'slack', envSchema: SlackCpEnvSchema },
  { platformId: 'feishu', envSchema: FeishuCpEnvSchema },
  { platformId: 'linear', envSchema: LinearCpEnvSchema }
] as const

type EnvSchemaOf<T> = T extends { envSchema: infer S } ? S : never
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never

/** The composed shape's STATIC type, derived from the same list — so a provider
 *  that adds a key gets it typed on `AppConfig` with no edit here, and adding a
 *  platform is one list entry. */
export type CpPlatformEnvShape = UnionToIntersection<EnvSchemaOf<(typeof CP_PLATFORM_ENV_SCHEMAS)[number]>>

/**
 * Fold every platform's env keys into one shape for `AppConfigSchema`.
 *
 * Fails LOUDLY on a collision — two platforms claiming one key, or a platform
 * shadowing a core key. Either would silently change how a deployment's
 * environment parses (the shadowing platform's schema would win the spread),
 * which is precisely the class of boot-time surprise a fail-fast config module
 * exists to prevent. `coreKeys` is passed in rather than imported to keep the
 * dependency one-directional: `config/env.ts` reads this module, never the
 * reverse.
 */
export function composeCpPlatformEnv(
  coreKeys: readonly string[],
  /** The declarations to fold. Defaults to the production list; a caller passes
   *  another only to exercise the guards below on a synthetic pair (the return
   *  TYPE always describes the production fold). */
  decls: readonly { platformId: string; envSchema: ZodRawShape }[] = CP_PLATFORM_ENV_SCHEMAS
): CpPlatformEnvShape {
  const core = new Set(coreKeys)
  // `ZodRawShape` is readonly-indexed in zod v4, so the accumulator names its
  // value type rather than the shape itself.
  const composed: Record<string, ZodRawShape[string]> = {}
  const owner = new Map<string, string>()
  for (const { platformId, envSchema } of decls) {
    for (const [key, schema] of Object.entries(envSchema)) {
      if (core.has(key)) {
        throw new Error(`platform ${platformId} env key shadows a core config key: ${key}`)
      }
      const claimed = owner.get(key)
      if (claimed) {
        throw new Error(`platform env key ${key} is declared by both ${claimed} and ${platformId}`)
      }
      owner.set(key, platformId)
      composed[key] = schema
    }
  }
  // The ONE cast: the loop above builds the same object the type derives from
  // {@link CP_PLATFORM_ENV_SCHEMAS} statically, and the collision guards are
  // exactly what makes the two agree (a shadowed key is the only way a spread
  // could drop one).
  return composed as CpPlatformEnvShape
}
