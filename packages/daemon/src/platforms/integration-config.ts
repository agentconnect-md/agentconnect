/**
 * The **integration envelope read** (audit Appendix A class b,
 * `router/routing-rule.ts:46–68`, stage S3).
 *
 * §6.4 splits an `IntegrationSpec` into a CORE ENVELOPE that core owns and reads
 * (`bindRules`, `mutedChannels`, `gated`, …) and an OPAQUE `config` that only the
 * platform's own module understands. The router had the split backwards: it
 * switched on the platform id four ways purely to reach three identically-named
 * core fields, so every new platform had to edit the router to be routable at all.
 *
 * The knobs are already spelled the same in all four config schemas — the switch
 * was never reading four different shapes, only four different property paths.
 * Reading the block through the integration's own platform id collapses the four
 * arms into one and survives §6.4's rename as a one-line change: today the block
 * is nested under the platform id (`{ platform: 'slack', slack: {…} }`), after the
 * emission flip it is `config`, and nothing else here moves.
 *
 * WHAT STAYS PER-PLATFORM: the bot's own id. §6.4 deliberately keeps it OUT of the
 * core envelope because it is the platform's identity vocabulary, not a routing
 * knob — a Feishu bot has an `open_id`, not a user id. So that one read is a
 * registered strategy with a fail-safe default (the name the other three share),
 * which is what the audit's class-b rows ask for: core keeps the envelope, the
 * platform keeps its own words.
 */
import type { BindRuleConfig, Integration } from '../agents/agent-schema.js'

/** The union of every platform's config block, derived from the `Integration`
 *  union rather than re-listed — the block always lives at the integration's own
 *  platform id, so the two can never drift apart. Written as an `infer` over
 *  `Record<I['platform'], …>` because TypeScript will not let a generic index a
 *  distributed member by its own discriminant. */
export type IntegrationConfig<I extends Integration = Integration> =
  I extends Record<I['platform'], infer C> ? C : never

/** The core routing knobs core owns, whatever the platform (§6.4 `core`). */
export interface IntegrationCore {
  bindRules: BindRuleConfig[]
  /** Channels the operator switched OFF. Post-dates the schema, so an integration
   *  assembled by hand rather than parsed (a fixture, a caller mapping a partial
   *  spec) can arrive without it; absent means "nothing muted" — the behaviour
   *  before the field existed — and normalizing once here keeps every reader free
   *  of the same defaulting. */
  mutedChannels: string[]
  gated: boolean
}

/** The integration's own config block — opaque to core under §6.4, and the only
 *  place its core knobs and its platform-private credentials both live today. */
export function integrationConfig(int: Integration): IntegrationConfig {
  return (int as unknown as Record<string, unknown>)[int.platform] as IntegrationConfig
}

/** How one platform names the bot's own id inside its config block. */
type SelfIdRead = (config: IntegrationConfig) => string | undefined

const SELF_IDS = new Map<string, SelfIdRead>([
  // Feishu identifies a bot by open_id; there is no "user id" in its vocabulary.
  ['feishu', (config) => ('botOpenId' in config ? config.botOpenId : undefined)]
])

/** The bot's own id as CONFIGURED — what `mention` rules match against before a
 *  live connection has resolved the real one. Total by construction: a platform
 *  that registers no reader uses the core `botUserId` name, which is what Slack,
 *  Telegram and Discord all call it, so a new platform is routable without
 *  touching this file. */
export function configuredBotSelfId(int: Integration): string | undefined {
  const config = integrationConfig(int)
  const read = SELF_IDS.get(int.platform)
  if (read) return read(config)
  return 'botUserId' in config ? config.botUserId : undefined
}

/** The core envelope of one integration: the routing knobs core reads for every
 *  platform, with no knowledge of which platform it is. */
export function integrationCore(int: Integration): IntegrationCore {
  const config = integrationConfig(int)
  return {
    bindRules: config.bindRules,
    mutedChannels: config.mutedChannels ?? [],
    gated: config.gated
  }
}
