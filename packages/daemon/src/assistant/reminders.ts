// Assistant-mode reminders (assistant-mode.md §5.9): the cheap tier of self-scheduling, text the duty holder posts at its time with no model turn.
import type { Agent } from '../agents/agent-schema.js'
import { assistantModeOn } from '../mcp/ops/assistant-items.js'
import {
  ASSISTANT_REMINDER_CLAIM_STALE_MS,
  ASSISTANT_REMINDER_LATE_MAX_MS,
  ASSISTANT_REMINDER_MAX_ATTEMPTS,
  type AssistantReminder,
  type AssistantReminderLedger
} from '../store/assistant-reminders.js'

/** Due reminders one sweep delivers per agent; the rest wait for the next sweep. */
const REMINDERS_PER_SWEEP = 20

export interface AssistantRemindersHost {
  now(): number
  log: { info(message: string): void; warn(message: string): void; debug(message: string): void }
  agents(): Iterable<Pick<Agent, 'id' | 'assistantMode'>>
  /** This daemon holds the agent's duty, and the agent is neither paused nor draining. */
  mayDeliver(agentId: string): boolean
  draining(): boolean
  reminders: AssistantReminderLedger
  /** The agent is enabled in this conversation (conversation gating). */
  placeEnabled(agentId: string, integrationId: string, channel: string): boolean
  placeExternal(agentId: string, integrationId: string, channel: string): boolean
  /** Post the text as the agent, the way an approved draft posts; the message id, or undefined when none came back. Throws on a platform error. */
  post(reminder: AssistantReminder): Promise<string | undefined>
  /** Draft the text for an internal member's approval, the way an external place's reply is drafted (§5.5); the draft's id. */
  draft(reminder: AssistantReminder): Promise<string>
}

export class AssistantReminders {
  private sweeping = false

  constructor(private readonly host: AssistantRemindersHost) {}

  /** One pass over the agents this daemon delivers for: expire the long overdue, fail cut claims, deliver what is due. */
  async sweep(): Promise<void> {
    if (this.sweeping || this.host.draining()) return
    this.sweeping = true
    try {
      for (const agent of this.host.agents()) {
        if (!assistantModeOn(agent) || !this.host.mayDeliver(agent.id)) continue
        try {
          await this.deliverFor(agent.id)
        } catch (err) {
          this.host.log.warn(`reminders: agent ${agent.id} was not swept: ${(err as Error).message}`)
        }
      }
    } finally {
      this.sweeping = false
    }
  }

  private async deliverFor(agentId: string): Promise<void> {
    const { reminders, log } = this.host
    const now = this.host.now()
    const expired = await reminders.expireOverdue(agentId, now - ASSISTANT_REMINDER_LATE_MAX_MS, now)
    if (expired > 0)
      log.info(`reminders: agent ${agentId} had ${expired} reminder(s) more than 24 hours overdue; expired`)
    for (const id of await reminders.failStaleClaims(agentId, now - ASSISTANT_REMINDER_CLAIM_STALE_MS, now))
      log.warn(`reminder ${id}: a delivery was cut short and may have posted; marked failed, never posted again`)
    for (const reminder of await reminders.due(agentId, now, REMINDERS_PER_SWEEP)) {
      if (this.host.draining() || !this.host.mayDeliver(agentId)) return
      await this.deliver(reminder)
    }
  }

  /** Claim, then post once: directly, as a draft where the place turned external, or not at all. */
  private async deliver(reminder: AssistantReminder): Promise<void> {
    const { reminders, log } = this.host
    const { agentId, id, integrationId } = reminder
    const attempt = await reminders.claim(agentId, id, this.host.now())
    if (attempt === undefined) return
    const fail = async (failure: string): Promise<void> => {
      await reminders.settle(agentId, id, { status: 'failed', failure }, this.host.now())
      log.warn(`reminder ${id} of agent ${agentId} failed: ${failure}`)
    }
    if (!this.host.placeEnabled(agentId, integrationId, reminder.place.channel))
      return await fail('the agent is no longer enabled in that conversation')
    // An external place posts nothing unapproved (§5.5): the text goes to an internal member as a draft.
    const external = this.host.placeExternal(agentId, integrationId, reminder.place.channel)
    let outcome: { status: 'delivered'; messageId: string | null } | { status: 'drafted'; draftId: string }
    try {
      outcome = external
        ? { status: 'drafted', draftId: await this.host.draft(reminder) }
        : { status: 'delivered', messageId: (await this.host.post(reminder)) ?? null }
    } catch (err) {
      const failure = (err as Error).message
      if (attempt >= ASSISTANT_REMINDER_MAX_ATTEMPTS)
        return await fail(`${attempt} attempts failed; the last: ${failure}`)
      await reminders.release(agentId, id, failure, this.host.now())
      log.info(`reminder ${id}: attempt ${attempt} failed (${failure}); retried on a later sweep`)
      return
    }
    // Outside the retry: a settle that fails leaves the claim to go stale, never to post twice.
    await reminders.settle(agentId, id, outcome, this.host.now())
    if (outcome.status === 'drafted')
      log.info(`reminder ${id}: its conversation is shared with another organization; drafted as ${outcome.draftId}`)
    else log.debug(`reminder ${id} of agent ${agentId} delivered`)
  }
}
