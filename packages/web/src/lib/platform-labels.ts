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
 * and `platformRegistry.ids()` ever disagree, and so is the room sigil, whose
 * authority is the module contract's `roomGlyph`; this is the copy a session label
 * can read without pulling the wizard in behind it.
 */

/** One platform's two display names. They differ on exactly one platform today,
 *  and deliberately: a sentence says "remove it in Lark", while the picker tile
 *  has to be findable by users of EITHER cloud, whose brands are different words. */
export interface PlatformLabel {
  /** The name used in prose, chips and filters — one word for the platform. */
  readonly name: string
  /** The install picker's tile label. */
  readonly picker: string
  /** The sigil a room's name is written with — `'#'` where the channel convention
   *  applies, `''` where the platform has no such marker. The module contract's
   *  `roomGlyph` is the authority; `platform-set.test.tsx` fails if they disagree. */
  readonly sigil: string
}

/** A `Map`, not a record, so lookup is total for every string rather than every
 *  string that is not an `Object.prototype` key. */
const LABELS = new Map<string, PlatformLabel>([
  ['slack', { name: 'Slack', picker: 'Slack', sigil: '#' }],
  ['telegram', { name: 'Telegram', picker: 'Telegram', sigil: '' }],
  ['discord', { name: 'Discord', picker: 'Discord', sigil: '#' }],
  // One platform id, two clouds. Prose picks the international brand; the picker
  // names both so a Feishu user recognizes their own tile.
  ['feishu', { name: 'Lark', picker: 'Lark/Feishu', sigil: '' }],
  // A Linear room is a TEAM, named "<Workspace> / <Team>" — nothing an operator writes a "#" in.
  ['linear', { name: 'Linear', picker: 'Linear', sigil: '' }],
  // Nothing routes a bare 'lark' id today (the cloud rides on its own `region`
  // field), but the substring chains this replaces accepted it.
  ['lark', { name: 'Lark', picker: 'Lark/Feishu', sigil: '' }]
])

/** This platform's labels, or undefined when no chat platform claims the id. */
export function platformLabel(platformId: string): PlatformLabel | undefined {
  return LABELS.get(platformId)
}

/** The prose name, or `fallback` when the id is not a chat platform. */
export function chatPlatformName(platformId: string | undefined, fallback: string): string {
  return (platformId && LABELS.get(platformId)?.name) || fallback
}

/** The sigil this platform's room names are written with. An id no chat platform claims
 *  keeps the channel convention, which is what every non-module platform rendered before. */
export function chatRoomSigil(platformId: string | undefined): string {
  const label = platformId ? LABELS.get(platformId) : undefined
  return label ? label.sigil : '#'
}

/** The ids this table answers for — the module ids plus the `lark` alias.
 *  Exported for the registry-parity test, not for dispatch. */
export const PLATFORM_LABEL_IDS: readonly string[] = [...LABELS.keys()]
