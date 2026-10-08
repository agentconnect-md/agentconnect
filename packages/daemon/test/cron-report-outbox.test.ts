// A CP cron run's terminal outcome survives a disconnect: it is released only on the CP's ACK (high-availability.md).
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { CronReport } from '@agentconnect.md/protocol'
import { CronReportOutbox } from '../src/store/cron-report-outbox.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'

const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CRON = 'c0c0c0c0-cccc-4ccc-8ccc-cccccccccccc'
const REPORT: CronReport = {
  cronId: CRON,
  agentId: AGENT,
  firedAt: '2026-09-30T09:00:00.000Z',
  status: 'success',
  durationMs: 1200,
  sessionId: 'outward-1'
}

async function world() {
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  const sync = vi.fn<(report: CronReport) => Promise<'acknowledged' | 'unsupported'>>(async () => 'acknowledged')
  const emit = vi.fn<(report: CronReport) => void>()
  const cp = { state: 'READY', syncCronReport: sync, emitCronReport: emit }
  const warn = vi.fn()
  const outbox = new CronReportOutbox({
    store: () => store,
    cpClient: () => cp as never,
    // Retry timers are real but cleared by `dispose()`.
    clock: () => ({ now: () => 1_000_000, setTimeout, clearTimeout }) as never,
    servedAgentIds: () => [AGENT],
    draining: () => false,
    warn,
    debug: vi.fn()
  })
  const pending = async () => (await store.pendingCronReports(10, [AGENT])).map((row) => JSON.parse(row.report))
  return { store, cp, sync, emit, warn, outbox, pending }
}

describe('cron report outbox', () => {
  it('releases a terminal outcome only once the CP has acknowledged it', async () => {
    const w = await world()
    await w.outbox.record(REPORT)
    expect(w.sync).toHaveBeenCalledWith(REPORT)
    expect(await w.pending()).toEqual([])
    w.outbox.dispose()
    await w.store.close()
  })

  it('keeps an outcome whose send failed and re-sends it on the next drain', async () => {
    const w = await world()
    w.sync.mockRejectedValueOnce(Object.assign(new Error('connection closed'), { retryable: true }))
    await w.outbox.record(REPORT)
    expect(await w.pending()).toEqual([REPORT])

    await w.outbox.drainReports()
    expect(w.sync).toHaveBeenCalledTimes(2)
    expect(await w.pending()).toEqual([])
    w.outbox.dispose()
    await w.store.close()
  })

  it('holds an outcome recorded while the link is down until a drain on the new link', async () => {
    const w = await world()
    w.cp.state = 'DEGRADED'
    await w.outbox.record(REPORT)
    expect(w.sync).not.toHaveBeenCalled()
    expect(await w.pending()).toEqual([REPORT])

    w.cp.state = 'READY'
    await w.outbox.drainReports()
    expect(w.sync).toHaveBeenCalledWith(REPORT)
    expect(await w.pending()).toEqual([])
    w.outbox.dispose()
    await w.store.close()
  })

  it('sends an older CP the best-effort report once and releases it', async () => {
    const w = await world()
    w.sync.mockResolvedValue('unsupported')
    await w.outbox.record(REPORT)
    expect(w.emit).toHaveBeenCalledWith(REPORT)
    expect(await w.pending()).toEqual([])
    w.outbox.dispose()
    await w.store.close()
  })

  it('drops an outcome the CP can never accept instead of retrying it forever', async () => {
    const w = await world()
    w.sync.mockRejectedValueOnce(Object.assign(new Error('organization is required'), { retryable: false }))
    await w.outbox.record(REPORT)
    expect(await w.pending()).toEqual([])
    expect(w.warn).toHaveBeenCalledWith(expect.stringContaining('permanently rejected'))
    w.outbox.dispose()
    await w.store.close()
  })

  it('keeps one row per run, so a replayed outcome replaces its own row', async () => {
    const w = await world()
    w.cp.state = 'DEGRADED'
    const next = { ...REPORT, firedAt: '2026-09-30T10:00:00.000Z', status: 'failed' as const, reason: 'boom' }
    await w.outbox.record(REPORT)
    await w.outbox.record(REPORT)
    await w.outbox.record(next)
    expect(await w.pending()).toEqual([REPORT, next])
    w.outbox.dispose()
    await w.store.close()
  })
})
