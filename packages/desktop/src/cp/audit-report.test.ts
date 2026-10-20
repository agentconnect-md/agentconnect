import { describe, expect, it } from 'vitest'
import type { ComputerAuditEntry } from '@agentconnect.md/protocol/computer'
import type { AuditRecord } from '../audit.js'
import { AuditReporter, auditEntry } from './audit-report.js'

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
})

describe('AuditReporter', () => {
  it('sends queued entries in order and keeps them until the CP stores them', async () => {
    const sent: ComputerAuditEntry[][] = []
    let accept = false
    const reporter = new AuditReporter({
      send: async (entries) => {
        sent.push(entries)
        return accept
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
          ? new Promise<boolean>((resolve) => (release = () => resolve(true)))
          : Promise.resolve(true)
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
})
