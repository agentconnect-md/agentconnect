// Real-time `Clock` for integration harnesses whose services arm background
// timers (e.g. the gitlab provisioner's 30s converge follow-up): identical to
// `SystemClock`, except an `afterEach` cancels every still-pending timer.
// A survivor would fire during a LATER test and — because the seed re-creates
// the same org id and fixtures reuse constant project ids — resolve that test's
// freshly created rows and race its leases, a leak the per-test DB sweep cannot
// stop. Call once at test-file module scope and share the instance.
import { afterEach } from 'vitest'
import type { Clock, TimerHandle } from '../../src/domain/clock.js'

type Handle = ReturnType<typeof globalThis.setTimeout>

export function trackedTestClock(): Clock {
  const pending = new Set<Handle>()
  afterEach(() => {
    for (const h of pending) globalThis.clearTimeout(h)
    pending.clear()
  })
  return {
    now: () => Date.now(),
    setTimeout(fn: () => void, ms: number): TimerHandle {
      const h = globalThis.setTimeout(() => {
        pending.delete(h)
        fn()
      }, ms)
      pending.add(h)
      return h
    },
    clearTimeout(h: TimerHandle): void {
      pending.delete(h as Handle)
      globalThis.clearTimeout(h as Handle)
    }
  }
}
