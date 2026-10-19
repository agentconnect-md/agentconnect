import { describe, expect, it, vi } from 'vitest'
import { ActionType } from '@microsoft/agent-host-protocol'
import { AhpActionJournal } from '../../src/ahp/action-journal.js'

const action = { type: ActionType.ChatTurnCancelled, turnId: 'turn' } as const
const channel = 'ahp-chat:/one/main'
const scopes = new Set([channel])
function allocator() {
  let high = 0
  return async (size: number) => {
    const start = high + 1
    high += size
    return { start, end: high }
  }
}

describe('AHP action journal', () => {
  it('reserves durable ranges across sockets and restarts, with a fresh snapshot floor', async () => {
    const reserve = allocator()
    const first = await AhpActionJournal.create({ reserve, blockSize: 2 })
    expect((await first.append({ channel, action })).serverSeq).toBe(2)
    expect((await first.append({ channel, action })).serverSeq).toBe(3)
    const next = await AhpActionJournal.create({ reserve, blockSize: 2 })
    expect(next.currentSequence).toBe(5)
    expect(next.replay(3, scopes)).toBeUndefined()
    expect((await next.append({ channel, action })).serverSeq).toBe(6)
  })

  it('keeps rejection payloads private while allowing global sequence gaps', async () => {
    const journal = await AhpActionJournal.create({ reserve: allocator() })
    const received: unknown[] = []
    journal.subscribe((envelope) => received.push(envelope))
    await journal.append({ channel, action, rejectionReason: 'denied', origin: { clientId: 'one', clientSeq: 1 } })
    await journal.append({ channel: 'ahp-chat:/hidden/main', action })
    const accepted = await journal.append({ channel, action })
    expect(received).toHaveLength(2)
    expect(journal.replay(1, scopes)).toEqual([accepted])
    expect(JSON.stringify(journal.replay(1, scopes))).not.toContain('denied')
  })

  it('bounds retained bytes and events, and protects stored values from callers', async () => {
    const journal = await AhpActionJournal.create({ reserve: allocator(), maxEvents: 1 })
    const first = await journal.append({ channel, action })
    const second = await journal.append({ channel, action })
    expect(journal.replay(1, scopes)).toBeUndefined()
    expect(journal.replay(first.serverSeq, scopes)).toEqual([second])
    const replay = journal.replay(first.serverSeq, scopes)!
    if ('turnId' in replay[0]!.action) replay[0]!.action.turnId = 'mutated'
    expect(journal.replay(first.serverSeq, scopes)).toEqual([second])
    const tiny = await AhpActionJournal.create({ reserve: allocator(), maxBytes: 1 })
    await tiny.append({ channel, action })
    expect(tiny.replay(1, scopes)).toBeUndefined()
  })

  it('serializes concurrent appends and fails closed on reservation errors', async () => {
    const reserve = vi.fn(allocator())
    const journal = await AhpActionJournal.create({ reserve, blockSize: 2 })
    const failed = vi.fn()
    journal.subscribe(() => {}, failed)
    const values = await Promise.all([journal.append({ channel, action }), journal.append({ channel, action })])
    expect(values.map((entry) => entry.serverSeq)).toEqual([2, 3])
    reserve.mockRejectedValueOnce(new Error('storage unavailable'))
    await journal.append({ channel, action })
    await expect(journal.append({ channel, action })).rejects.toThrow('storage unavailable')
    await expect(journal.append({ channel, action })).rejects.toThrow('storage unavailable')
    expect(failed).toHaveBeenCalledOnce()
    expect(journal.replay(1, scopes)).toBeUndefined()
  })

  it('isolates a failing subscriber and rejects reused durable ranges', async () => {
    const journal = await AhpActionJournal.create({ reserve: async () => ({ start: 1, end: 2 }), blockSize: 2 })
    const good = vi.fn()
    journal.subscribe(() => {
      throw new Error('socket gone')
    })
    journal.subscribe(good)
    await journal.append({ channel, action })
    expect(good).toHaveBeenCalledOnce()
    await expect(journal.append({ channel, action })).rejects.toThrow('Invalid durable')
  })
})
