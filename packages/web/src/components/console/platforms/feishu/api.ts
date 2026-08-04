// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import type { LarkFeishuTarget } from '@/components/LarkFeishuSwitcher'
import {
  getFeishuRegistration,
  startFeishuRegistration,
  type FeishuRegistrationStartDto,
  type FeishuRegistrationStatusDto
} from '@/lib/api'

/** §5 `regions` vocabulary for this platform's two clouds. */
export type FeishuRegion = LarkFeishuTarget

/**
 * The Feishu module's own CP client surface ({@link WebPlatformModule.apiBindings}).
 * OPAQUE to the chassis — no host code calls through it. It exists so this
 * module's wizard pane (and, later, its settings fragments) share one client
 * seam, and so the S4 packaging boundary is already visible.
 */
export const feishuApi = {
  startRegistration: startFeishuRegistration,
  getRegistration: getFeishuRegistration
}

export type FeishuApi = typeof feishuApi
export type { FeishuRegistrationStartDto, FeishuRegistrationStatusDto }
