/**
 * Feature flags, as the console sees them.
 *
 * `FEATURE_FLAGS` is a comma-separated list of the ids below, read at runtime through
 * `window.__AC_ENV` — so one prebuilt image serves every environment and a deployment decides
 * which flagged surfaces it shows. Unset means none: a new flag cannot arrive on.
 *
 * This is a CONSOLE-side switch. The Control Plane serves the feature either way; what an
 * environment turns off here is whether the console offers it, not whether it exists. That is the
 * point — the feature stays exercised end to end wherever it is on, with no server-side variant to
 * reason about.
 *
 * A flag is either temporary — an experiment, deleted once its feature is on everywhere — or a
 * standing switch for a surface only some deployments ever offer. Retiring one is removing its id
 * here and the checks with it.
 */

/** Every flag the console knows. Adding one is this union plus its checks. */
export type FeatureFlagId =
  /** Org-scoped daemon groups: the Infra section, the group dialogs, and group entries in the
   *  placement picker (docs/designs/daemon-groups.md §6 PR 2). */
  | 'daemon-groups'
  /** The install-wide daemon pool: its fleet entry and the Cloud placement option. An agent
   *  ALREADY on the pool still names it — hiding a live placement is not hiding an entry point. */
  | 'daemon-pool'
  /** This deployment IS AgentConnect's managed cloud: the pool is the product, so the Infra page
   *  names it "AgentConnect Cloud" and quotes the plan's included usage. Off — a self-hosted
   *  install — the same pool is the operator's OWN cluster, named and metered as such. */
  | 'managed'
  /** The billing page: its nav entry and its route. A standing switch, not an experiment —
   *  billing belongs to deployments that run a billing service, and a self-hosted console has
   *  nothing to point it at. `BILLING_URL` then says WHERE that service is; this says WHETHER to
   *  offer the page, so a missing endpoint is a misconfiguration rather than a silent opt-out. */
  | 'billing'
  /** The "Git URL" workspace tile — anonymous clones from arbitrary Git servers. A standing
   *  switch: the tile is only usable where the deployment widens the daemons' clone-origin
   *  allowlist past the managed hosts, so the environment that does that turns it on here. A
   *  workspace ALREADY on a git URL still renders its tile — hiding live state is not hiding an
   *  entry point. */
  | 'git-url'

function enabledIds(): ReadonlySet<string> {
  // The server must read the SAME value `PublicEnvScript` injects, in the same precedence, or a
  // runtime-only configuration renders the gate off on the server and on during hydration — which
  // is a React markup mismatch, not just a flicker. `public-env` resolves plain `FEATURE_FLAGS`
  // first and falls back to the build-time `NEXT_PUBLIC_` twin; so does this.
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

/**
 * Is this flag on for this deployment?
 *
 * Not a hook: it reads a value fixed for the life of the page (injected before the bundle runs),
 * so it needs no subscription and can be called from anywhere — a render, a helper, a projection.
 */
export function featureFlagEnabled(id: FeatureFlagId): boolean {
  return enabledIds().has(id)
}
