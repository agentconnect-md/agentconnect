// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import {
  getLinearConnect,
  reconnectLinearWorkspace,
  startLinearConnect,
  type LinearConnectStartDto,
  type LinearConnectStatusDto
} from '@/lib/api'

/**
 * The Linear module's own CP client surface ({@link WebPlatformModule.apiBindings}) —
 * the workspace connect funnel and its reconnect arm. OPAQUE to the chassis: the
 * wizard pane and the settings workspace card share this one client seam.
 */
export const linearApi = {
  startConnect: startLinearConnect,
  getConnect: getLinearConnect,
  reconnect: reconnectLinearWorkspace
}

export type LinearApi = typeof linearApi
export type { LinearConnectStartDto, LinearConnectStatusDto }
