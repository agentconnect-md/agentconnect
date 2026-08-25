import type { DaemonRow } from './data'
import type { OrgDto } from './api'

// Per-tab "already marked / mid-exit" flag. Finishing or skipping onboarding PATCHes the
// org's persisted `onboardingCompleted`, but the org list refresh races the navigation —
// this sessionStorage latch suppresses the redirect bounce until the fresh org row lands.
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

// The wizard is owner-only and runs once per org: the persisted `onboardingCompleted`
// flag (set on finish OR skip) decides re-entry. Older CPs don't send the field —
// treat those orgs as already onboarded rather than bouncing everyone into the wizard.
// An org that already runs a daemon is set up regardless of the flag (e.g. connected
// outside the wizard) — never pull its owner back in.
export function needsOnboarding(org: Pick<OrgDto, 'role' | 'onboardingCompleted' | 'daemonCount'> | null): boolean {
  return org != null && org.role === 'owner' && org.onboardingCompleted === false && (org.daemonCount ?? 0) === 0
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
