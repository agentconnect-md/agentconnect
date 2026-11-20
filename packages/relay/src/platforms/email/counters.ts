// The relay's mail counters (email-integration.md §6.3): in memory, one set per relay instance, lost on a restart.

/** How many times an hour one sender may start work on one agent (§4 step 4). */
export const EMAIL_INBOUND_PER_HOUR = 30
/** The most replies one address sends in a day. */
export const EMAIL_SENDS_PER_BOT_PER_DAY = 200
/** The most replies one organization's addresses send in a day, which keeps one organization from spending the deployment's quota. */
export const EMAIL_SENDS_PER_ORGANIZATION_PER_DAY = 1_000

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

export type EmailBudgetRefusal = 'budget_bot' | 'budget_organization' | 'budget_deployment'

/** One send's place in the three daily budgets; `release` gives it back when the provider answered that nothing was sent. */
export interface EmailSendReservation {
  release(): void
}

/** Replies sent in the current UTC day, per bot, per organization and for the whole deployment. */
export class EmailSendBudgets {
  private day = -1
  private readonly bots = new Map<string, number>()
  private readonly organizations = new Map<string, number>()
  private deployment = 0

  private roll(now: number): void {
    const day = Math.floor(now / DAY_MS)
    if (day === this.day) return
    this.day = day
    this.bots.clear()
    this.organizations.clear()
    this.deployment = 0
  }

  /** Take one send from every budget, or name the first one that is spent; `deploymentLimit` is the operator's figure, absent when there is none. */
  reserve(
    send: { botId: string; organization: string; deploymentLimit?: number },
    now: number
  ): EmailSendReservation | EmailBudgetRefusal {
    this.roll(now)
    const { botId, organization } = send
    if ((this.bots.get(botId) ?? 0) >= EMAIL_SENDS_PER_BOT_PER_DAY) return 'budget_bot'
    if ((this.organizations.get(organization) ?? 0) >= EMAIL_SENDS_PER_ORGANIZATION_PER_DAY)
      return 'budget_organization'
    if (send.deploymentLimit !== undefined && this.deployment >= send.deploymentLimit) return 'budget_deployment'
    this.bots.set(botId, (this.bots.get(botId) ?? 0) + 1)
    this.organizations.set(organization, (this.organizations.get(organization) ?? 0) + 1)
    this.deployment += 1
    const day = this.day
    let held = true
    return {
      release: () => {
        // A reservation of a day that has ended has nothing left to give back.
        if (!held || day !== this.day) return
        held = false
        this.bots.set(botId, Math.max(0, (this.bots.get(botId) ?? 0) - 1))
        this.organizations.set(organization, Math.max(0, (this.organizations.get(organization) ?? 0) - 1))
        this.deployment = Math.max(0, this.deployment - 1)
      }
    }
  }
}
