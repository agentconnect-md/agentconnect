// Per-tab "skip onboarding" flag. The agents view redirects an uninitialized org to
// the onboarding route; "Explore the console first" sets this so the very next agents
// render doesn't bounce straight back (which would be an infinite redirect). Scoped to
// sessionStorage by org slug, so a fresh tab/session shows onboarding again while the
// org stays empty.
const key = (org: string) => `ac:onboarding-skip:${org}`

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
