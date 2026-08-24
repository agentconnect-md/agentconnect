/**
 * The chat platforms' DISPLAY NAMES — one table, host-owned.
 *
 * WHY NOT A MODULE MEMBER. §5's `displayName` is manifest data shared with the
 * daemon, relay and CP, which is exactly why the web contract lists it as
 * "deliberately absent" (platforms/contract.ts, D2): a module must not become a
 * second authority for it. Its real home is `PlatformManifest` in
 * `@agentconnect.md/protocol`, which grows one justified field at a time. Until
 * `displayName` earns its place there, the host carries it — and carries it
 * ONCE, which is the part that was missing: the console had THREE independent
 * per-platform name switches (`platName`'s chat arms in lib/data.ts, the picker's
 * `BOT_PLATFORM_LABEL` in AddIntegrationModal, and `platformName` inside
 * IntegrationChannelList), each an ordered substring chain or a hand-copied
 * record, free to drift apart. This is that one table.
 *
 * WHY NOT NEXT TO THE REGISTRY. `platforms/registry.ts` eagerly imports every
 * module's wizard `Body`. `lib/data.ts` is imported by essentially every view, so
 * reading labels through the registry would pull the install wizard into every
 * route. Same reason `platforms/marks.ts` is its own small lookup.
 *
 * The id set is still the registry's — `platform-set.test.ts` fails if this table
 * and `platformRegistry.ids()` ever disagree.
 */

/** One platform's two display names. They differ on exactly one platform today,
 *  and deliberately: a sentence says "remove it in Lark", while the picker tile
 *  has to be findable by users of EITHER cloud, whose brands are different words. */
export interface PlatformLabel {
  /** The name used in prose, chips and filters — one word for the platform. */
  readonly name: string
  /** The install picker's tile label. */
  readonly picker: string
}

/** A `Map`, not a record, so lookup is total for every string rather than every
 *  string that is not an `Object.prototype` key. */
const LABELS = new Map<string, PlatformLabel>([
  ['slack', { name: 'Slack', picker: 'Slack' }],
  ['telegram', { name: 'Telegram', picker: 'Telegram' }],
  ['discord', { name: 'Discord', picker: 'Discord' }],
  // One platform id, two clouds. Prose picks the international brand; the picker
  // names both so a Feishu user recognizes their own tile.
  ['feishu', { name: 'Lark', picker: 'Lark/Feishu' }],
  // Nothing routes a bare 'lark' id today (the cloud rides on its own `region`
  // field), but the substring chains this replaces accepted it.
  ['lark', { name: 'Lark', picker: 'Lark/Feishu' }]
])

/** This platform's labels, or undefined when no chat platform claims the id. */
export function platformLabel(platformId: string): PlatformLabel | undefined {
  return LABELS.get(platformId)
}

/** The prose name, or `fallback` when the id is not a chat platform. */
export function chatPlatformName(platformId: string | undefined, fallback: string): string {
  return (platformId && LABELS.get(platformId)?.name) || fallback
}

/** The ids this table answers for — the module ids plus the `lark` alias.
 *  Exported for the registry-parity test, not for dispatch. */
export const PLATFORM_LABEL_IDS: readonly string[] = [...LABELS.keys()]
