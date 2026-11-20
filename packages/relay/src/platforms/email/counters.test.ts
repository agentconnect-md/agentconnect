import { describe, expect, it } from 'vitest'
import {
  EMAIL_INBOUND_PER_HOUR,
  EMAIL_SENDS_PER_BOT_PER_DAY,
  EMAIL_SENDS_PER_ORGANIZATION_PER_DAY,
  EmailInboundRate,
  EmailSendBudgets,
  type EmailSendReservation
} from './counters.js'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const T0 = 20_000 * DAY

describe('email inbound rate (§4 step 4)', () => {
  it('allows thirty settled messages an hour for one sender and bot, and frees each an hour later', () => {
    const rate = new EmailInboundRate()
    for (let i = 0; i < EMAIL_INBOUND_PER_HOUR; i += 1) {
      expect(rate.allows('bot', 'alice@corp.example.test', T0 + i)).toBe(true)
      rate.record('bot', 'alice@corp.example.test', T0 + i)
    }
    expect(rate.allows('bot', 'alice@corp.example.test', T0 + 100)).toBe(false)
    // Another sender, and the same sender writing to another bot, have counts of their own.
    expect(rate.allows('bot', 'bob@corp.example.test', T0 + 100)).toBe(true)
    expect(rate.allows('other-bot', 'alice@corp.example.test', T0 + 100)).toBe(true)
    expect(rate.allows('bot', 'alice@corp.example.test', T0 + HOUR - 1)).toBe(false)
    expect(rate.allows('bot', 'alice@corp.example.test', T0 + HOUR)).toBe(true)
  })

  it('counts nothing until a message is recorded', () => {
    const rate = new EmailInboundRate(1)
    expect(rate.allows('bot', 'alice@corp.example.test', T0)).toBe(true)
    expect(rate.allows('bot', 'alice@corp.example.test', T0)).toBe(true)
    rate.record('bot', 'alice@corp.example.test', T0)
    expect(rate.allows('bot', 'alice@corp.example.test', T0)).toBe(false)
  })
})

describe('email send budgets (§6.3)', () => {
  const reserved = (budgets: EmailSendBudgets, botId: string, organization: string, at = T0, limit?: number) =>
    budgets.reserve({ botId, organization, ...(limit !== undefined ? { deploymentLimit: limit } : {}) }, at)

  it('refuses a bot past two hundred sends in a day, and starts again the next day', () => {
    const budgets = new EmailSendBudgets()
    for (let i = 0; i < EMAIL_SENDS_PER_BOT_PER_DAY; i += 1)
      expect(reserved(budgets, 'bot-1', 'org-a')).toBeTypeOf('object')
    expect(reserved(budgets, 'bot-1', 'org-a')).toBe('budget_bot')
    expect(reserved(budgets, 'bot-2', 'org-a')).toBeTypeOf('object')
    expect(reserved(budgets, 'bot-1', 'org-a', T0 + DAY)).toBeTypeOf('object')
  })

  it('refuses an organization past a thousand sends across its bots, and leaves another organization alone', () => {
    const budgets = new EmailSendBudgets()
    for (let i = 0; i < EMAIL_SENDS_PER_ORGANIZATION_PER_DAY; i += 1)
      expect(reserved(budgets, `bot-${i % 10}`, 'org-a')).toBeTypeOf('object')
    expect(reserved(budgets, 'bot-11', 'org-a')).toBe('budget_organization')
    expect(reserved(budgets, 'bot-11', 'org-b')).toBeTypeOf('object')
  })

  it("applies the operator's deployment figure only when there is one", () => {
    const budgets = new EmailSendBudgets()
    expect(reserved(budgets, 'bot-1', 'org-a', T0, 2)).toBeTypeOf('object')
    expect(reserved(budgets, 'bot-2', 'org-b', T0, 2)).toBeTypeOf('object')
    expect(reserved(budgets, 'bot-3', 'org-c', T0, 2)).toBe('budget_deployment')
    expect(reserved(budgets, 'bot-3', 'org-c')).toBeTypeOf('object')
  })

  it('gives a released send back to all three budgets, once, and only within its own day', () => {
    const budgets = new EmailSendBudgets()
    const first = reserved(budgets, 'bot-1', 'org-a', T0, 1) as EmailSendReservation
    expect(reserved(budgets, 'bot-2', 'org-a', T0, 1)).toBe('budget_deployment')
    first.release()
    first.release()
    const second = reserved(budgets, 'bot-2', 'org-a', T0, 1) as EmailSendReservation
    expect(second).toBeTypeOf('object')
    expect(reserved(budgets, 'bot-3', 'org-a', T0, 1)).toBe('budget_deployment')
    // The next day starts from zero, and a release from the day before takes nothing from it.
    expect(reserved(budgets, 'bot-3', 'org-a', T0 + DAY, 1)).toBeTypeOf('object')
    second.release()
    expect(reserved(budgets, 'bot-4', 'org-a', T0 + DAY, 1)).toBe('budget_deployment')
  })
})
