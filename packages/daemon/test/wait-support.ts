/**
 * The one place a poll budget is tuned per platform.
 *
 * `vi.waitFor` carries its own budget, which the config's `testTimeout` never governs — so a
 * number written at a call site is per-platform tuning in the wrong place, the same reason the
 * suite's inline per-test budgets were dropped.
 */

/** Windows triples it: slower I/O, and four test workers contending for four vCPUs. */
export function waitBudget(timeout: number, interval?: number): { timeout: number; interval?: number } {
  return { timeout: process.platform === 'win32' ? timeout * 3 : timeout, interval }
}

/** What every poll gets unless it has a stated reason to wait longer. */
export const WAIT = waitBudget(10_000)
