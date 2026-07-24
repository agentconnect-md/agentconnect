/**
 * Post-restart health check (cli-daemon-split.md §5.3). The CLI has no IPC to the
 * daemon by design, so health is judged from PROCESS-level evidence: the service
 * is running and its PID stays stable across a short settle window (i.e. not
 * crash-looping). The stronger "new daemon reached CP READY" signal is closed by
 * the CP side (§7.2), which the CLI doesn't observe.
 */
import type { ServiceStatus } from './service/index.js'

export interface HealthResult {
  healthy: boolean
  reason: string
}

const defaultDelay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Sample the service status a few times over `settleMs`; healthy iff it is running
 * with a single stable PID throughout. Injectable `status`/`delay` keep it testable.
 */
export async function checkServiceHealthy(
  status: () => Promise<ServiceStatus>,
  opts: { settleMs?: number; samples?: number; delay?: (ms: number) => Promise<void> } = {}
): Promise<HealthResult> {
  const samples = Math.max(2, opts.samples ?? 3)
  const settleMs = opts.settleMs ?? 6000
  const delay = opts.delay ?? defaultDelay
  const gap = Math.max(0, Math.floor(settleMs / samples))

  let firstPid: number | undefined
  for (let i = 0; i < samples; i++) {
    if (i > 0) await delay(gap)
    const s = await status()
    if (!s.running) return { healthy: false, reason: `service not running (${s.label})` }
    if (!s.pid) return { healthy: false, reason: 'service running but reported no pid' }
    if (firstPid === undefined) firstPid = s.pid
    else if (s.pid !== firstPid) return { healthy: false, reason: `pid changed ${firstPid} → ${s.pid} (crash-looping)` }
  }
  return { healthy: true, reason: `stable pid ${firstPid}` }
}
