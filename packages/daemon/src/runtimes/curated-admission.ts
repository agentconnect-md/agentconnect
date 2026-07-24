import type { RuntimeDef } from '../config/config-schema.js'
import type { ResolvedRuntimeCatalog, RuntimeSource } from './registry.js'
import type { RuntimeProbeResult } from './runtime-prober.js'

export type CuratedAdmissionStatus = 'pending' | 'verified' | 'failed'

interface AdmissionRecord {
  checkedAt: number
  result: RuntimeProbeResult
}

export class CuratedRuntimeAdmissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CuratedRuntimeAdmissionError'
  }
}

/** In-memory compatibility admission for curated-only runtime winners. Registry
 * and explicit user definitions intentionally retain their existing behavior. */
export class CuratedRuntimeAdmission {
  private readonly records = new Map<string, AdmissionRecord>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? 5 * 60_000
  }

  private fresh(id: string): AdmissionRecord | undefined {
    const record = this.records.get(id)
    if (!record || this.now() - record.checkedAt >= this.ttlMs) return undefined
    return record
  }

  status(id: string, source: RuntimeSource): CuratedAdmissionStatus {
    if (source !== 'curated') return 'verified'
    const record = this.fresh(id)
    if (!record) return 'pending'
    return record.result.ok ? 'verified' : 'failed'
  }

  record(result: RuntimeProbeResult): void {
    this.records.set(result.runtime, { checkedAt: this.now(), result: { ...result } })
  }

  result(id: string): RuntimeProbeResult | undefined {
    const result = this.records.get(id)?.result
    return result ? { ...result, models: [...result.models] } : undefined
  }

  probeCandidates(catalog: ResolvedRuntimeCatalog): Record<string, RuntimeDef> {
    const candidates: Record<string, RuntimeDef> = {}
    for (const [id, entry] of Object.entries(catalog.entries)) {
      if (entry.source === 'curated' && this.status(id, entry.source) === 'pending') {
        candidates[id] = entry.runtime
      }
    }
    return candidates
  }

  /** Curated ids whose FRESH admission record was an ACP auth-required rejection:
   * installed and speaking ACP, but logged out on this host. They stay OUT of
   * admission (filterCatalog / assertLaunch exclude them until a probe succeeds)
   * yet must still reach the facts snapshot, or the console could never show the
   * login warning for this runtime class. A stale record stops driving the
   * warning — the runtime goes back to `pending` and is re-probed instead. */
  authRequiredIds(catalog: ResolvedRuntimeCatalog): string[] {
    return Object.entries(catalog.entries)
      .filter(([id, entry]) => entry.source === 'curated' && this.fresh(id)?.result.authRequired === true)
      .map(([id]) => id)
  }

  filterCatalog(catalog: ResolvedRuntimeCatalog): ResolvedRuntimeCatalog {
    const entries = Object.fromEntries(
      Object.entries(catalog.entries).filter(([id, entry]) => this.status(id, entry.source) === 'verified')
    )
    return {
      entries,
      runtimes: Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.runtime]))
    }
  }

  assertLaunch(id: string, source: RuntimeSource): void {
    if (source !== 'curated') return
    const record = this.fresh(id)
    if (record?.result.ok) return
    const detail = record?.result.error ? `: ${record.result.error}` : ''
    throw new CuratedRuntimeAdmissionError(
      `curated runtime "${id}" cannot launch because its ACP probe has not succeeded${detail}`
    )
  }
}
