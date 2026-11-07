import { describe, expect, it } from 'vitest'
import { MAX_TCP_DATA_BYTES, sendInPieces } from '../src/microsandbox/tcp.js'

describe('microsandbox TCP relay writes', () => {
  it('splits a backlog larger than one agentd message into ordered pieces under the limit', async () => {
    const data = Buffer.alloc(MAX_TCP_DATA_BYTES * 9 + 123)
    for (let i = 0; i < data.length; i++) data[i] = i % 251
    const sent: Buffer[] = []
    await sendInPieces(data, async (piece) => {
      sent.push(Buffer.from(piece))
    })
    expect(sent).toHaveLength(10)
    expect(sent.every((piece) => piece.length <= MAX_TCP_DATA_BYTES)).toBe(true)
    expect(Buffer.concat(sent).equals(data)).toBe(true)
    expect(MAX_TCP_DATA_BYTES).toBeLessThan(4 * 1024 * 1024)
  })

  it('sends one piece at a time and stops at the first refusal', async () => {
    const data = Buffer.alloc(MAX_TCP_DATA_BYTES * 3)
    let inFlight = 0
    let calls = 0
    const send = async (): Promise<void> => {
      calls += 1
      inFlight += 1
      expect(inFlight).toBe(1)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      if (calls === 2) throw new Error('refused')
    }
    await expect(sendInPieces(data, send)).rejects.toThrow('refused')
    expect(calls).toBe(2)
  })

  it('sends a small write as a single message', async () => {
    const sent: number[] = []
    await sendInPieces(Buffer.alloc(44_000), async (piece) => {
      sent.push(piece.length)
    })
    expect(sent).toEqual([44_000])
  })
})
