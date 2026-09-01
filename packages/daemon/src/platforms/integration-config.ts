/**
 * The **integration envelope + opaque config reads** (audit Appendix A class b,
 * stage S3; §6.4 final shape).
 *
 * §6.4 splits an integration into a CORE ENVELOPE core owns and reads
 * (`mode`, `bindRules`, `mutedChannels`, `gated`) and an OPAQUE `config` that
 * only the platform's own module understands. Core reads the envelope straight
 * off the entry; the config is validated against the platform module's own
 * zod schema, resolved through the static registry below — the same
 * one-entry-per-platform shape as `SELF_IDS` here, `ORDERINGS` in
 * message-ordering.ts, and the other §7.4 strategy tables. An unregistered
 * platform, an absent config, or a payload the schema rejects all read as
 * `undefined`, and every consumer fails CLOSED on that (skip the integration,
 * open no connection) — a platform this daemon has no module for cannot be
 * half-served.
 *
 * WHAT STAYS PER-PLATFORM beyond the schema: the bot's own id. §6.4
 * deliberately keeps it OUT of the core envelope because it is the platform's
 * identity vocabulary, not a routing knob — a Feishu bot has an `open_id`, not
 * a user id. So that one read is a registered strategy with a fail-safe
 * default (the `botUserId` name the other three share), which is what the
 * audit's class-b rows ask for: core keeps the envelope, the platform keeps
 * its own words.
 */
import type { z, ZodType } from 'zod'
import type { BindRuleConfig, Integration } from '../agents/agent-schema.js'
import {
  DiscordConfigSchema,
  FeishuConfigSchema,
  LinearConfigSchema,
  SlackConfigSchema,
  TelegramConfigSchema
} from '../agents/agent-schema.js'

/** The per-platform module schemas for the opaque `config` payload — the wire
 *  schemas (shared with the CP's projectors via the protocol package) plus the
 *  daemon-local extras. One registry line per platform. */
const CONFIG_SCHEMAS = {
  slack: SlackConfigSchema,
  telegram: TelegramConfigSchema,
  discord: DiscordConfigSchema,
  feishu: FeishuConfigSchema,
  linear: LinearConfigSchema
} as const

/** The union of every platform's validated config, derived from the registry
 *  rather than re-listed — the two cannot drift apart. */
export type IntegrationConfig = z.infer<(typeof CONFIG_SCHEMAS)[keyof typeof CONFIG_SCHEMAS]>

/**
 * Every chat platform this daemon has a module for, in registry order.
 *
 * THIS registry is the authority rather than one of the other per-platform tables
 * because absence here is TOTAL: {@link integrationConfig} returns `undefined` for an
 * unregistered id and every consumer fails closed on that (skip the integration, open
 * no connection). A platform missing from the turn-output or command-chrome registries
 * merely renders through the core fallback; a platform missing from this one cannot be
 * served at all.
 *
 * Read by the CP registration handshake, whose advertised `capabilities.platforms` is
 * what the CP's pre-install gate and the console's tile gating consume — so a platform
 * added here becomes installable without a second edit anywhere.
 */
export function platformIds(): string[] {
  return Object.keys(CONFIG_SCHEMAS)
}

/** The core routing knobs core owns, whatever the platform (§6.4 `core`). */
export interface IntegrationCore {
  mode: 'direct' | 'shared'
  bindRules: BindRuleConfig[]
  /** Channels the operator switched OFF. Normalized here so an integration
   *  assembled by hand rather than parsed (a fixture, a caller mapping a
   *  partial spec) still reads as "nothing muted" when the field is absent. */
  mutedChannels: string[]
  gated: boolean
}

/**
 * The integration's own config block, validated by its platform module's
 * schema (§6.4). `undefined` — fail closed — for an unregistered platform, an
 * absent payload (including a pre-S3 nested-shape entry, whose block is
 * stripped at parse), or a payload the schema rejects. Deliberately schema-only:
 * a partially-provisioned but well-formed payload (a hand-authored direct Slack
 * entry with no appToken yet) still reads — the consolidator that needs the
 * missing credential is the one that skips it, exactly as before the flatten.
 *
 * Parsed per read, uncached on purpose: reads happen at reconcile/routing
 * frequency (not per token/chunk), and a cache keyed on object identity would
 * silently ignore an in-place edit to a live entry.
 */
export function integrationConfig(int: Integration): IntegrationConfig | undefined {
  // `platform` is an OPEN string (S1a): guard the plain-object lookup with
  // hasOwn so a prototype name (`constructor`, `toString`, `__proto__`) reads
  // as unregistered instead of resolving an inherited non-schema value — the
  // same fail-closed rule the `ORDERINGS` strategy table pins.
  const schema: ZodType | undefined = Object.hasOwn(CONFIG_SCHEMAS, int.platform)
    ? CONFIG_SCHEMAS[int.platform as keyof typeof CONFIG_SCHEMAS]
    : undefined
  const parsed = int.config !== undefined ? schema?.safeParse(int.config) : undefined
  return parsed?.success ? (parsed.data as IntegrationConfig) : undefined
}

/**
 * The typed read a platform's OWN module uses for its config: the same
 * validated parse as {@link integrationConfig}, narrowed by the platform id the
 * caller states — which also guards it (`undefined` for any other platform's
 * entry, instead of a mis-typed cast). Core never calls this; it has no
 * platform id to state.
 */
export function platformIntegrationConfig<K extends keyof typeof CONFIG_SCHEMAS>(
  platform: K,
  int: Integration
): z.infer<(typeof CONFIG_SCHEMAS)[K]> | undefined {
  if (int.platform !== platform) return undefined
  return integrationConfig(int) as z.infer<(typeof CONFIG_SCHEMAS)[K]> | undefined
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
  if (!config) return undefined
  const read = SELF_IDS.get(int.platform)
  if (read) return read(config)
  return 'botUserId' in config ? config.botUserId : undefined
}

/** The core envelope of one integration: the routing knobs core reads for every
 *  platform, with no knowledge of which platform it is. Normalized for
 *  hand-assembled objects that bypassed the schema's defaults. */
export function integrationCore(int: Integration): IntegrationCore {
  const core = int.core as Partial<IntegrationCore> | undefined
  return {
    mode: core?.mode ?? 'direct',
    bindRules: core?.bindRules ?? [],
    mutedChannels: core?.mutedChannels ?? [],
    gated: core?.gated ?? false
  }
}
