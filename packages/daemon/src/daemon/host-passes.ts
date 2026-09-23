import type { HostKey } from '../acp/host-key.js'

/** The daemon's own passes (distillation, the commit-message wand) on one of its hosts: each holds the host against the idle reaper while it runs, and restarts its idle clock when it settles (k8s-daemon-pool §4). */
export class HostPasses {
  private readonly running = new Map<HostKey, Set<{ startedAt: number }>>()
  private readonly lastSettled = new Map<HostKey, number>()

  /** Hold `owner` from `now` until the returned release runs with the settle time; releasing again is a no-op. */
  begin(owner: HostKey, now: number): (settledAt: number) => void {
    const pass = { startedAt: now }
    const passes = this.running.get(owner) ?? new Set<{ startedAt: number }>()
    passes.add(pass)
    this.running.set(owner, passes)
    return (settledAt) => {
      if (!passes.delete(pass)) return
      if (passes.size === 0) this.running.delete(owner)
      this.lastSettled.set(owner, Math.max(this.lastSettled.get(owner) ?? 0, settledAt))
    }
  }

  /** Whether a pass begun within `ceilingMs` of `now` runs on `owner`; an older one is taken as wedged and holds nothing. */
  holds(owner: HostKey, now: number, ceilingMs: number): boolean {
    for (const pass of this.running.get(owner) ?? []) if (now - pass.startedAt <= ceilingMs) return true
    return false
  }

  /** When the last pass on `owner` settled, or undefined if none has. */
  settledAt(owner: HostKey): number | undefined {
    return this.lastSettled.get(owner)
  }
}
