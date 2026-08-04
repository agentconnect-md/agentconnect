// The Lark / Feishu REGION axis, in one place. Both clouds are the single
// platform id `feishu` on the wire — the cloud rides on its own field — so every
// per-cloud value (brand word, developer-console host) is derived here rather
// than re-branched at each render site.

import type { LarkFeishuTarget } from '@/components/LarkFeishuSwitcher'

export type FeishuRegion = LarkFeishuTarget

/** The region a bot without one belongs to — rows predating the axis are Feishu. */
export function feishuRegionOf(bot: { feishuRegion?: FeishuRegion | null }): FeishuRegion {
  return bot.feishuRegion ?? 'feishu'
}

/** Both clouds share every string except the brand name. */
export function feishuBrand(region: FeishuRegion | string | undefined): string {
  return region === 'feishu' ? 'Feishu' : 'Lark'
}

/** The developer-console origin for one cloud. Public vendor hosts, not
 *  deployment configuration. */
export function feishuConsoleOrigin(region: FeishuRegion): string {
  return region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
}

/** One app's Basic Info page, or the console's app index when the id is unknown. */
export function feishuConsoleAppUrl(appId: string | null | undefined, region: FeishuRegion): string {
  const origin = feishuConsoleOrigin(region)
  return appId ? `${origin}/app/${encodeURIComponent(appId)}/baseinfo` : `${origin}/app`
}
