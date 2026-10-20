import { describe, expect, it } from 'vitest'
import { COMPUTER_AUDIT_BATCH_BYTES, type ComputerAuditEntry } from '@agentconnect.md/protocol/computer'
import type { AuditRecord } from '../audit.js'
import { AuditReporter, auditEntry, nextBatch, type AuditSendResult } from './audit-report.js'

const record = (tool: string, args: Record<string, unknown> = {}): AuditRecord => ({
  client: 'agent/sess-1',
  tool,
  args,
  outcome: 'ok',
  ms: 4.6
})

describe('auditEntry', () => {
  it('reports typed text by its length only', () => {
    const entry = auditEntry(
      { ...record('computer_type', { text: 'p4ssw0rd' }), approval: 'allowed' },
      new Date(0),
      'id'
    )
    expect(entry).toEqual({
      id: 'id',
      at: '1970-01-01T00:00:00.000Z',
      tool: 'computer_type',
      client: 'agent/sess-1',
      outcome: 'ok',
      approval: 'allowed',
      args: {},
      textLength: 8,
      ms: 5
    })
    expect(JSON.stringify(entry)).not.toContain('p4ssw0rd')
  })

  it('strips control characters and lone surrogates from every string, keys and nested values included', () => {
    const entry = auditEntry(
      {
        ...record('computer_launch\u0000', {
          app: 'fire\u0000fox',
          keys: ['re\u0007turn'],
          nested: { 'k\u0000': ['\ud800x'] }
        }),
        client: 'agent/\u0000sess',
        code: '\u0000\u0001'
      },
      new Date(0),
      'id'
    )
    expect(entry).toMatchObject({
      tool: 'computer_launch',
      client: 'agent/sess',
      args: { app: 'firefox', keys: ['return'], nested: { k: ['\ufffdx'] } }
    })
    expect(entry.code).toBeUndefined()
    expect(JSON.stringify(entry)).not.toMatch(/\\u0000/)
  })
})

describe('AuditReporter', () => {
  it('sends queued entries in order and keeps them until the CP stores them', async () => {
    const sent: ComputerAuditEntry[][] = []
    let accept = false
    const reporter = new AuditReporter({
      send: async (entries) => {
        sent.push(entries)
        return accept ? 'stored' : 'retry'
      },
      log: () => {}
    })
    reporter.sink(record('computer_click'))
    reporter.sink(record('computer_key'))
    await reporter.flush()
    expect(reporter.pending).toBe(2)
    accept = true
    await reporter.flush()
    expect(reporter.pending).toBe(0)
    expect(sent.at(-1)!.map((entry) => entry.tool)).toEqual(['computer_click', 'computer_key'])
  })

  it('drops the oldest entries past its cap and keeps what arrived during a send', async () => {
    const logs: string[] = []
    const sent: string[][] = []
    let release!: () => void
    const reporter = new AuditReporter({
      send: (entries) => {
        sent.push(entries.map((entry) => entry.tool))
        return sent.length === 1
          ? new Promise<AuditSendResult>((resolve) => (release = () => resolve('stored')))
          : Promise.resolve('stored')
      },
      log: (line) => logs.push(line),
      maxQueued: 2
    })
    reporter.sink(record('a'))
    reporter.sink(record('b'))
    reporter.sink(record('c'))
    const flushing = reporter.flush()
    await Promise.resolve()
    reporter.sink(record('d'))
    release()
    await flushing
    expect(logs[0]).toContain('1 entries were dropped')
    // `d` arrived mid-send and pushed `b` out of the queue; the sent ids are removed, so `d` goes next.
    expect(sent).toEqual([['b', 'c'], ['d']])
    expect(reporter.pending).toBe(0)
  })

  it('drops an entry the CP refuses for good and still delivers the ones after it', async () => {
    const logs: string[] = []
    const stored: string[] = []
    const reporter = new AuditReporter({
      send: async (entries) => {
        if (entries.some((entry) => entry.tool === 'poison')) return 'rejected'
        stored.push(...entries.map((entry) => entry.tool))
        return 'stored'
      },
      log: (line) => logs.push(line)
    })
    for (const tool of ['a', 'poison', 'b', 'c']) reporter.sink(record(tool))
    await reporter.flush()
    expect(stored).toEqual(['a', 'b', 'c'])
    expect(reporter.pending).toBe(0)
    expect(logs.some((line) => line.includes('refused') && line.includes('poison'))).toBe(true)
    reporter.sink(record('d'))
    await reporter.flush()
    expect(stored).toEqual(['a', 'b', 'c', 'd'])
  })

  it('stops at the first entry that is not stored for now when isolating a refused batch', async () => {
    let calls = 0
    const reporter = new AuditReporter({
      send: async (entries) => {
        calls++
        return entries.length > 1 ? 'rejected' : entries[0]!.tool === 'b' ? 'retry' : 'stored'
      },
      log: () => {}
    })
    for (const tool of ['a', 'b', 'c']) reporter.sink(record(tool))
    await reporter.flush()
    expect(calls).toBe(3)
    expect(reporter.pending).toBe(2)
  })

  it('fills a batch by encoded bytes as well as by count', () => {
    const big = (i: number): ComputerAuditEntry =>
      auditEntry(
        record('computer_launch', Object.fromEntries(Array.from({ length: 7 }, (_, k) => [`a${k}`, '€'.repeat(256)]))),
        new Date(0),
        `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      )
    const queue = Array.from({ length: 100 }, (_, i) => big(i))
    const batch = nextBatch(queue)
    // About 5.4 KB each in UTF-8, so a hundred would overflow one frame.
    expect(batch.length).toBeGreaterThan(0)
    expect(batch.length).toBeLessThan(100)
    expect(Buffer.byteLength(JSON.stringify({ entries: batch }))).toBeLessThanOrEqual(COMPUTER_AUDIT_BATCH_BYTES)
    expect(nextBatch([big(0)])).toHaveLength(1)
  })
})
