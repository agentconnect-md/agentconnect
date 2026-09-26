// Console-only gates from runtime FEATURE_FLAGS; unset means none, and the Control Plane serves features either way.
// Retire temporary flags by removing their ids and checks once their features are available everywhere.
export type FeatureFlagId =
  // The pool's fleet entry and Cloud placement option; existing pool placements remain visible.
  | 'daemon-pool'
  // Names and meters the pool as AgentConnect Cloud; otherwise it is the operator's own cluster.
  | 'managed'
  // Offers billing where a billing service exists; BILLING_URL separately identifies its endpoint.
  | 'billing'
  // Offers Git URL workspaces where clone origins allow them; existing Git URL workspaces remain visible.
  | 'git-url'
  // The QQ integration's install entry points; existing QQ bots keep their Bots tab.
  | 'qq'
  // The By decision checkout for additional repositories; a row already By decision keeps it, and a set selector stays shown.
  | 'repository-decision'

function enabledIds(): ReadonlySet<string> {
  // Match PublicEnvScript's precedence so server rendering and browser hydration agree.
  const raw =
    (typeof window === 'undefined'
      ? (process.env.FEATURE_FLAGS ?? process.env.NEXT_PUBLIC_FEATURE_FLAGS)
      : window.__AC_ENV?.FEATURE_FLAGS) ?? ''
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  )
}

// Flags are fixed for the page lifetime and can be read during rendering without a subscription.
export function featureFlagEnabled(id: FeatureFlagId): boolean {
  return enabledIds().has(id)
}
