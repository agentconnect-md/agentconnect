// Who gets the chrome_* tools on this desktop (computer-use.md §5.8): the desktop's own guard, not the agent daemon's.
import type { ComputerPolicy } from '@agentconnect.md/protocol/computer'
import { isBrowserName } from '../linux/desktops.js'

export interface BrowserAccessInputs {
  // The channel token's `br`; for a local client token, whether the daemon is unregistered.
  granted: boolean
  viewOnly: boolean
  registered: boolean
  // The last policy the Control Plane pushed; undefined before the first one.
  policy: Pick<ComputerPolicy, 'browserTier' | 'agentMode' | 'appAllowlist' | 'redactApps'> | undefined
  // An unregistered daemon's `browserTier` in its config.
  configTier: boolean
}

const BROWSER_APP = (app: string): boolean => isBrowserName(app) || /^com\.google\.chrome$/i.test(app.trim())

/** Why this caller gets no chrome_* tools, or undefined when every condition of §5.8 holds. */
export function browserToolsRefusal(inputs: BrowserAccessInputs): string | undefined {
  if (!inputs.granted) return 'the token does not grant the browser tier'
  if (inputs.viewOnly) return 'a view grant has no browser tools'
  if (inputs.registered) {
    const { policy } = inputs
    // An unset field reads off, so an older Control Plane grants none.
    if (policy?.browserTier !== true) return "this computer's policy does not allow the browser tier"
    if (policy.agentMode !== 'control') return "this computer's policy lets agents only watch"
    if (policy.appAllowlist && !policy.appAllowlist.some(BROWSER_APP))
      return "this computer's policy leaves the browser out of its allowed apps"
    if (policy.redactApps.some(BROWSER_APP)) return "this computer's policy masks the browser"
  } else if (!inputs.configTier) return "browserTier is off in this computer's config"
  return undefined
}
