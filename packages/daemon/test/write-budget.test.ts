/** The per-app Google Chat write budget (google-chat-integration.md §10.8): a token bucket writes wait on, under a fake clock. */
import { describe, it, expect } from 'vitest'
import {
  GoogleChatWriteBudget,
  GoogleChatWriteBudgets,
  googleChatWriteBudgetSettings
} from '../src/platforms/googlechat/write-budget.js'

function fakeClock() {
  let t = 1_000_000
  const sleeps: number[] = []
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    sleeps
  }
}

describe('GoogleChatWriteBudget', () => {
  it('derives the default budget from Google’s project quota over the pool, and takes both overrides', () => {
    expect(googleChatWriteBudgetSettings()).toEqual({ capacity: 750, refillPerMinute: 750 })
    expect(googleChatWriteBudgetSettings({ poolSize: 3 })).toEqual({ capacity: 1000, refillPerMinute: 1000 })
    expect(googleChatWriteBudgetSettings({ writesPerMinute: 120, writeBurst: 10 })).toEqual({
      capacity: 10,
      refillPerMinute: 120
    })
    expect(googleChatWriteBudgetSettings({ poolSize: 0 })).toEqual({ capacity: 3000, refillPerMinute: 3000 })
  })

  it('admits a burst up to the capacity, then delays each write by the refill in arrival order, dropping none', async () => {
    const clk = fakeClock()
    const budget = new GoogleChatWriteBudget({ capacity: 2, refillPerMinute: 60 }, clk.now, clk.sleep)
    const order: number[] = []
    await Promise.all([1, 2, 3, 4].map((n) => budget.take().then(() => order.push(n))))
    expect(order).toEqual([1, 2, 3, 4])
    // The third and fourth writes each waited one refill (one token a second at 60 a minute).
    expect(clk.sleeps).toEqual([1000, 1000])
    expect(budget.available()).toBe(0)
  })

  it('refills with elapsed time, capped at the capacity', async () => {
    const clk = fakeClock()
    const budget = new GoogleChatWriteBudget({ capacity: 5, refillPerMinute: 600 }, clk.now, clk.sleep)
    await budget.take()
    await budget.take()
    expect(budget.available()).toBe(3)
    clk.advance(100) // one token at ten a second
    expect(budget.available()).toBe(4)
    clk.advance(60_000)
    expect(budget.available()).toBe(5)
    expect(clk.sleeps).toEqual([])
  })

  it('keeps one bucket per app on the daemon, shared by every connection of that app', () => {
    const budgets = new GoogleChatWriteBudgets({ capacity: 1, refillPerMinute: 60 })
    expect(budgets.for('100000000000')).toBe(budgets.for('100000000000'))
    expect(budgets.for('100000000000')).not.toBe(budgets.for('200000000000'))
  })
})
