import { AsyncLocalStorage } from 'node:async_hooks'

export type StartupPhase = 'sandbox' | 'workspace' | 'runtime'
type Report = (phase: StartupPhase | undefined) => void
const context = new AsyncLocalStorage<{ report: Report; phase?: StartupPhase }>()
const shared = new WeakMap<Promise<unknown>, { phase?: StartupPhase; listeners: Set<Report> }>()

// Observers belong to one turn; work that outlives it cannot publish through its closed observer.
export async function observeStartup<T>(report: Report, work: () => Promise<T>): Promise<T> {
  let active = true
  try {
    return await context.run({ report: (phase) => active && report(phase) }, work)
  } finally {
    active = false
  }
}

// A nested wait restores its enclosing phase, such as workspace preparation after a sandbox binds.
export async function withStartupPhase<T>(phase: StartupPhase, work: () => Promise<T>): Promise<T> {
  const parent = context.getStore()
  if (!parent) return await work()
  parent.report(phase)
  const result = await context.run({ report: parent.report, phase }, work)
  parent.report(parent.phase)
  return result
}

// Shared host starts broadcast to their current waiters, including a turn joining an existing start.
export function shareStartup<T>(work: () => Promise<T>): Promise<T> {
  const state: { phase?: StartupPhase; listeners: Set<Report> } = { listeners: new Set() }
  const promise = context.run(
    {
      report: (phase) => {
        state.phase = phase
        for (const report of state.listeners) report(phase)
      }
    },
    work
  )
  shared.set(promise, state)
  return promise
}

export async function awaitStartup<T>(promise: Promise<T>): Promise<T> {
  const observer = context.getStore()
  const state = shared.get(promise)
  if (!observer || !state) return await promise
  state.listeners.add(observer.report)
  observer.report(state.phase)
  try {
    const result = await promise
    observer.report(observer.phase)
    return result
  } finally {
    state.listeners.delete(observer.report)
  }
}
