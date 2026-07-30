import type { DaemonRow } from './data'

// Per-tab "skip onboarding" flag. The agents view redirects an uninitialized org to
// the onboarding route; "Explore the console first" sets this so the very next agents
// render doesn't bounce straight back (which would be an infinite redirect). Scoped to
// sessionStorage by org slug, so a fresh tab/session shows onboarding again while the
// org stays empty.
const key = (org: string) => `ac:onboarding-skip:${org}`

type OnboardingDaemon = Pick<DaemonRow, 'daemonId' | 'status' | 'lifecycleStatus'>

/** A planned relaunch keeps the daemon established even while its socket reconnects. */
export function daemonCompletesOnboarding(daemon: OnboardingDaemon): boolean {
  return daemon.status === 'online' || daemon.lifecycleStatus != null
}

/** Only an unexpectedly non-serving daemon is eligible for a replacement connect token. */
export function firstReconnectableDaemonId(daemons: readonly OnboardingDaemon[]): string | undefined {
  return daemons.find((daemon) => !daemonCompletesOnboarding(daemon))?.daemonId
}

export function needsOnboarding(
  agentsLoading: boolean,
  daemonsLoading: boolean,
  agentCount: number,
  hasOnlineDaemon: boolean
): boolean {
  return !agentsLoading && !daemonsLoading && agentCount === 0 && !hasOnlineDaemon
}

export function isOnboardingSkipped(org: string): boolean {
  try {
    return sessionStorage.getItem(key(org)) === '1'
  } catch {
    return false
  }
}

export function skipOnboarding(org: string): void {
  try {
    sessionStorage.setItem(key(org), '1')
  } catch {
    // ponytail: sessionStorage can throw (private mode / disabled). Worst case the
    // redirect loops once more — not worth a fallback store.
  }
}
