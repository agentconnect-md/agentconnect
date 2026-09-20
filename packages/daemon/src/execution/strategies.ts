import { hostShimUnavailableReason } from './host-shim.js'

/** The v1 execution strategies of session-executors.md §5; `srt` and `docker` come later. */
export type ExecutionStrategy = 'host' | 'microsandbox'

export type StrategyAvailability = { available: true } | { available: false; reason: string }

/** The EFFECTIVE table: what this machine can run now, each entry with the reason it cannot. Nothing reports it over the wire yet. */
export function effectiveStrategies(input: {
  platform?: NodeJS.Platform
  /** The existing sandbox probe: whether microsandbox is the configured backend, and why it is down when it is. */
  microsandbox: { configured: boolean; unavailable?: string }
}): Record<ExecutionStrategy, StrategyAvailability> {
  const host = hostShimUnavailableReason(input.platform ?? process.platform)
  const microsandbox = !input.microsandbox.configured
    ? 'microsandbox is not the configured sandbox backend'
    : input.microsandbox.unavailable
  return {
    host: host ? { available: false, reason: host } : { available: true },
    microsandbox: microsandbox ? { available: false, reason: microsandbox } : { available: true }
  }
}
