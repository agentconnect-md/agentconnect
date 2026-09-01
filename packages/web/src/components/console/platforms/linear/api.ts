// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import {
  getLinearConnect,
  reconnectLinearWorkspace,
  setBotPreferredAgent,
  startLinearConnect,
  type LinearConnectStartDto,
  type LinearConnectStatusDto
} from '@/lib/api'

/**
 * The Linear module's own CP client surface ({@link WebPlatformModule.apiBindings}) —
 * the workspace connect funnel, its reconnect arm, and the workspace's default-agent
 * move. OPAQUE to the chassis: the wizard pane and the settings workspace card share
 * this one client seam.
 *
 * `setDefaultAgent` is `PATCH /bots/:id` with `preferredAgentId` — a generic bot route
 * (any shared bot may name a default), named here because Linear is the surface that
 * drives it: §7.4's rule that a bare delegation needs a default is the reason the
 * workspace card can move one at all.
 *
 * Removing a member is deliberately ABSENT. It is the generic
 * `DELETE /integrations/:id`, and the card commits it through
 * `useConsoleData().deleteIntegration` so the console's integration/bot projections
 * refresh with it — the same reason a create commits through
 * {@link WizardHost.createIntegration}.
 */
export const linearApi = {
  startConnect: startLinearConnect,
  getConnect: getLinearConnect,
  reconnect: reconnectLinearWorkspace,
  setDefaultAgent: setBotPreferredAgent
}

export type LinearApi = typeof linearApi
export type { LinearConnectStartDto, LinearConnectStatusDto }
