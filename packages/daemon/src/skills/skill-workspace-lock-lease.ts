import { AsyncLocalStorage } from 'node:async_hooks'

/** Bridge the external workspace lock to its detached mutation provider without
 * plumbing lock internals through every installer layer. A provider may receive
 * its GO byte only after `registerHelper` durably records its process group on
 * Unix or process ID on Windows. */
export interface SkillMutationHelperLease {
  registerHelper(pgid: number): Promise<void>
  clearHelper(pgid: number): Promise<void>
}

const activeLease = new AsyncLocalStorage<SkillMutationHelperLease>()

export function withSkillMutationHelperLease<T>(lease: SkillMutationHelperLease, fn: () => Promise<T>): Promise<T> {
  return activeLease.run(lease, fn)
}

export function currentSkillMutationHelperLease(): SkillMutationHelperLease | undefined {
  return activeLease.getStore()
}
