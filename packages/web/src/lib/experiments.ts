/**
 * Experimental features, as the console sees them.
 *
 * `EXPERIMENTS` is a comma-separated list of the ids below, read at runtime through
 * `window.__AC_ENV` — so one prebuilt image serves every environment and a deployment decides
 * which experimental surfaces it shows. Unset means none: a new experiment cannot arrive on.
 *
 * This is a CONSOLE-side switch. The Control Plane serves the feature either way; what an
 * environment turns off here is whether the console offers it, not whether it exists. That is the
 * point — the feature stays exercised end to end wherever it is on, with no server-side variant to
 * reason about.
 *
 * A flag is temporary. When a feature is on everywhere, delete its id here and the checks with it.
 */

/** Every experiment the console knows. Adding one is this union plus its checks. */
export type ExperimentId =
  /** Org-scoped daemon groups: the Infra section, the group dialogs, and group entries in the
   *  placement picker (docs/designs/daemon-groups.md §6 PR 2). The install-wide pool is not an
   *  experiment and is unaffected. */
  'daemon-groups'

function enabledIds(): ReadonlySet<string> {
  const raw =
    (typeof window === 'undefined' ? undefined : window.__AC_ENV?.EXPERIMENTS) ??
    process.env.NEXT_PUBLIC_EXPERIMENTS ??
    ''
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  )
}

/**
 * Is this experiment on for this deployment?
 *
 * Not a hook: it reads a value fixed for the life of the page (injected before the bundle runs),
 * so it needs no subscription and can be called from anywhere — a render, a helper, a projection.
 */
export function experimentEnabled(id: ExperimentId): boolean {
  return enabledIds().has(id)
}
