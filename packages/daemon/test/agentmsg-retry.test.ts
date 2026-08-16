import { describe, it, expect, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import type { RdAgentMsg, RdAgentMsgAck } from '@agentconnect.md/protocol'
import { sendAgentMsgUntilReady, AGENTMSG_NOT_READY_RETRY } from '../src/cp/agentmsg-retry.js'

const payload: RdAgentMsg = {
  claimedFromAgentId: '00000000-0000-0000-0000-00000000000a',
  toAgentId: '00000000-0000-0000-0000-00000000000b',
  text: 'hi',
  coords: { platform: 'slack', channel: 'C1' },
  hopCount: 0,
  deliveryId: 'd-1'
}
const notReady: RdAgentMsgAck = { deliveryId: 'd-1', delivered: false, reason: 'not_ready' }
const delivered: RdAgentMsgAck = { deliveryId: 'd-1', delivered: true, childSessionId: 'k' }

/** Drive the loop against a scripted sequence of verdicts; time only moves through the fake clock. */
function run(verdicts: RdAgentMsgAck[], policy = { windowMs: 60_000, baseMs: 1_000, capMs: 8_000 }) {
  const clock = new FakeClock(1_000_000)
  const send = vi.fn(async () => verdicts[Math.min(send.mock.calls.length - 1, verdicts.length - 1)]!)
  const retries: number[] = []
  const done = sendAgentMsgUntilReady(payload, {
    send,
    clock,
    policy,
    jitter: () => 0,
    onRetry: (_attempt, delayMs) => retries.push(delayMs)
  })
  return { clock, send, retries, done }
}

/** Advance the fake clock a second at a time (every delay here is whole seconds) until the loop settles. */
async function settle(clock: FakeClock, done: Promise<unknown>, maxSteps = 200): Promise<void> {
  let settled = false
  void done.then(
    () => (settled = true),
    () => (settled = true)
  )
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
  for (let i = 0; i < maxSteps && !settled; i += 1) {
    await flush()
    if (settled) break
    if (clock.pending > 0) clock.advance(1_000)
    await flush()
  }
}

describe('sendAgentMsgUntilReady (rd/agentmsg install-window retry, #987)', () => {
  it('returns a terminal verdict at once — nothing is retried, no timer armed', async () => {
    const { clock, send, done } = run([{ deliveryId: 'd-1', delivered: false, reason: 'not_found' }])
    await expect(done).resolves.toMatchObject({ reason: 'not_found' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(clock.pending).toBe(0)
  })

  it('re-sends the SAME deliveryId with exponential backoff while not_ready, and returns the admission', async () => {
    const { clock, send, retries, done } = run([notReady, notReady, notReady, delivered])
    await settle(clock, done)
    await expect(done).resolves.toEqual(delivered)
    expect(send).toHaveBeenCalledTimes(4)
    for (const call of send.mock.calls) expect((call as unknown[])[0]).toBe(payload)
    expect(retries).toEqual([1_000, 2_000, 4_000])
  })

  it('caps the delay and gives up at the window: the last not_ready becomes the terminal verdict', async () => {
    const { clock, send, retries, done } = run([notReady], { windowMs: 30_000, baseMs: 1_000, capMs: 8_000 })
    await settle(clock, done)
    await expect(done).resolves.toEqual(notReady)
    // 1+2+4+8+8 = 23s of waiting fits inside 30s; the next 8s step would cross the window.
    expect(retries).toEqual([1_000, 2_000, 4_000, 8_000, 8_000])
    expect(send).toHaveBeenCalledTimes(6)
    expect(clock.now() - 1_000_000).toBe(23_000)
  })

  it('a verdict that lands mid-window ends the loop even after several misses', async () => {
    const { clock, send, done } = run([
      notReady,
      notReady,
      { deliveryId: 'd-1', delivered: false, reason: 'not_allowed' }
    ])
    await settle(clock, done)
    await expect(done).resolves.toMatchObject({ reason: 'not_allowed' })
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('the default window spans a few lease horizons', () => {
    expect(AGENTMSG_NOT_READY_RETRY.windowMs).toBeGreaterThanOrEqual(3 * 120_000)
    expect(AGENTMSG_NOT_READY_RETRY.capMs).toBeLessThan(AGENTMSG_NOT_READY_RETRY.windowMs)
  })
})
