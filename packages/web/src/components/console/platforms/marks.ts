// No 'use client' here: the marks are reached from `PlatformMark`
// (components/marks.tsx), which is already a client boundary.

import type { ComponentType } from 'react'
import { DiscordMark } from './discord/mark'
import { FeishuMark } from './feishu/mark'
import { LinearMark } from './linear/mark'
import { SlackMark } from './slack/mark'
import { TelegramMark } from './telegram/mark'

/**
 * The BRAND-MARK view of the platform registry — deliberately a second, tiny
 * lookup rather than a read through `platformRegistry`.
 *
 * `registry.ts` eagerly imports each module's `index.tsx`, and those pull in the
 * wizard `Body` and the module's CP client. `PlatformMark` lives in
 * `components/marks.tsx`, which the LOGIN, waitlist, join and activate routes
 * import for `Wordmark` / `Spinner` / `SocialLoginMark` — so a registry read from
 * there would drag the whole install wizard into the signed-out bundles. Each
 * module still exposes the same component as its {@link WebPlatformModule.Mark},
 * so the mark itself is defined exactly once; only the *set* is listed twice, and
 * `platform-set.test.ts` fails the build if the two ever disagree.
 */
export type PlatformMarkComponent = ComponentType<{ fillPct?: number }>

/**
 * A `Map`, not a record, so lookup is total for every string rather than every
 * string that is not an `Object.prototype` key — the same reason the protocol's
 * platform manifest is a Map.
 */
const MARKS = new Map<string, PlatformMarkComponent>([
  ['slack', SlackMark],
  ['telegram', TelegramMark],
  ['discord', DiscordMark],
  ['feishu', FeishuMark],
  ['linear', LinearMark],
  // Lark and Feishu are one platform id (`feishu`) with the cloud on a separate
  // `region` field, so nothing in the console routes a bare 'lark' here today.
  // The alias is kept because the id IS the other cloud's brand name and the
  // substring chain this replaces accepted it.
  ['lark', FeishuMark]
])

/** This platform's brand mark, or undefined when no module claims the id (the
 *  caller falls back to its own generic glyph). */
export function platformMark(platformId: string): PlatformMarkComponent | undefined {
  return MARKS.get(platformId)
}

/** The ids `platformMark` answers for — the module ids plus the `lark` alias.
 *  Exported for the registry-parity test, not for dispatch. */
export const PLATFORM_MARK_IDS: readonly string[] = [...MARKS.keys()]
