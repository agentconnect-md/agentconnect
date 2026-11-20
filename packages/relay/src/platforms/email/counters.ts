// The relay's mail counters (email-integration.md §6.3): in memory, one set per relay instance, lost on a restart.

/** How many times an hour one sender may start work on one agent (§4 step 4). */
export const EMAIL_INBOUND_PER_HOUR = 30
/** The most replies one address sends in a day. */
export const EMAIL_SENDS_PER_BOT_PER_DAY = 200
/** The most replies one organization's addresses send in a day, which keeps one organization from spending the deployment's quota. */
export const EMAIL_SENDS_PER_ORGANIZATION_PER_DAY = 1_000
/** The outside budget (§6.4): recipients outside the organization one address may mail in a day, kept apart from the member reply budgets. */
export const EMAIL_OUTSIDE_RECIPIENTS_PER_BOT_PER_DAY = 100
/** The outside budget across one organization's addresses, in recipients a day. */
export const EMAIL_OUTSIDE_RECIPIENTS_PER_ORGANIZATION_PER_DAY = 500

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
/** The most sender and bot pairs remembered at once; the oldest is forgotten first. */
const INBOUND_KEYS_MAX = 50_000

/** Admitted and refused mail of the last hour, per sender and bot: a message is counted once its verdict is settled, never while it may still be redelivered. */
export class EmailInboundRate {
  private readonly seen = new Map<string, number[]>()

  constructor(
    private readonly limit: number = EMAIL_INBOUND_PER_HOUR,
    private readonly windowMs: number = HOUR_MS
  ) {}

  private live(key: string, now: number): number[] {
    const stamps = (this.seen.get(key) ?? []).filter((at) => now - at < this.windowMs)
    if (stamps.length) this.seen.set(key, stamps)
    else this.seen.delete(key)
    return stamps
  }

  /** Whether this sender may still start work on this bot. */
  allows(botId: string, sender: string, now: number): boolean {
    return this.live(`${botId}\0${sender}`, now).length < this.limit
  }

  /** Count one settled message. */
  record(botId: string, sender: string, now: number): void {
    const key = `${botId}\0${sender}`
    const stamps = this.live(key, now)
    stamps.push(now)
    // Re-inserted, so the map's order is the order pairs were last counted in.
    this.seen.delete(key)
    this.seen.set(key, stamps)
    while (this.seen.size > INBOUND_KEYS_MAX) this.seen.delete(this.seen.keys().next().value!)
  }
}

export type EmailBudgetRefusal =
  'budget_bot' | 'budget_organization' | 'budget_deployment' | 'budget_outside_bot' | 'budget_outside_organization'

/** One send's place in the three daily budgets; `release` gives it back when the provider answered that nothing was sent. */
export interface EmailSendReservation {
  release(): void
}

/** One daily budget kept per bot and per organization: a member reply counts one send, the outside budget its recipients. */
class DailyBudget {
  private readonly bots = new Map<string, number>()
  private readonly organizations = new Map<string, number>()

  constructor(
    private readonly perBot: number,
    private readonly perOrganization: number
  ) {}

  clear(): void {
    this.bots.clear()
    this.organizations.clear()
  }

  /** Which of the two is spent by taking `count` more, or undefined when both have room. */
  spent(botId: string, organization: string, count: number): 'bot' | 'organization' | undefined {
    if ((this.bots.get(botId) ?? 0) + count > this.perBot) return 'bot'
    if ((this.organizations.get(organization) ?? 0) + count > this.perOrganization) return 'organization'
    return undefined
  }

  add(botId: string, organization: string, count: number): void {
    this.bots.set(botId, Math.max(0, (this.bots.get(botId) ?? 0) + count))
    this.organizations.set(organization, Math.max(0, (this.organizations.get(organization) ?? 0) + count))
  }
}

/** Mail sent in the current UTC day: member replies per bot and organization, the outside budget, and the whole deployment. */
export class EmailSendBudgets {
  private day = -1
  private readonly replies = new DailyBudget(EMAIL_SENDS_PER_BOT_PER_DAY, EMAIL_SENDS_PER_ORGANIZATION_PER_DAY)
  private readonly outside = new DailyBudget(
    EMAIL_OUTSIDE_RECIPIENTS_PER_BOT_PER_DAY,
    EMAIL_OUTSIDE_RECIPIENTS_PER_ORGANIZATION_PER_DAY
  )
  private deployment = 0

  private roll(now: number): void {
    const day = Math.floor(now / DAY_MS)
    if (day === this.day) return
    this.day = day
    this.replies.clear()
    this.outside.clear()
    this.deployment = 0
  }

  /** Take one send from its budgets, or name the first one that is spent; an `outside` send draws on the outside budget by recipient, and `deploymentLimit` is the operator's figure. */
  reserve(
    send: { botId: string; organization: string; deploymentLimit?: number; outside?: { recipients: number } },
    now: number
  ): EmailSendReservation | EmailBudgetRefusal {
    this.roll(now)
    const { botId, organization } = send
    const budget = send.outside ? this.outside : this.replies
    const count = send.outside ? Math.max(1, send.outside.recipients) : 1
    const spent = budget.spent(botId, organization, count)
    if (spent) return send.outside ? (`budget_outside_${spent}` as const) : (`budget_${spent}` as const)
    if (send.deploymentLimit !== undefined && this.deployment >= send.deploymentLimit) return 'budget_deployment'
    budget.add(botId, organization, count)
    this.deployment += 1
    const day = this.day
    let held = true
    return {
      release: () => {
        // A reservation of a day that has ended has nothing left to give back.
        if (!held || day !== this.day) return
        held = false
        budget.add(botId, organization, -count)
        this.deployment = Math.max(0, this.deployment - 1)
      }
    }
  }
}
