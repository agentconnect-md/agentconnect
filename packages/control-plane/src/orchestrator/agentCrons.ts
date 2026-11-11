// An agent's own crons (`cron/self`, agent-cron-tools-v1): list, save and delete the crons bound to it, and retire a one-shot after its run.
import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import {
  isOneShotSchedule,
  type AgentCronResult,
  type AgentCronSave,
  type AgentCronView
} from '@agentconnect.md/protocol'
import { CronId, IntegrationId } from '../domain/ids.js'
import { refreshMutationAgent } from '../http/mutation-agent.js'
import type { AgentRecord, AgentRepo, AuditRepo, CronRecord, CronRepo, IntegrationRepo } from '../persistence/ports.js'
import { toDbPlatform } from '../persistence/platform.js'
import type { AgentDelivery, DeliveryErrorHandler } from './agentDelivery.js'
import type { AgentMutationGate } from './agentMutationGate.js'
import { cronToUpsert } from './placement.js'

export interface AgentCronDeps {
  crons: Pick<CronRepo, 'get' | 'upsert' | 'remove' | 'listForAgent'>
  agents: Pick<AgentRepo, 'get'>
  integrations: Pick<IntegrationRepo, 'get'>
  audit: Pick<AuditRepo, 'append'>
  delivery: Pick<AgentDelivery, 'cronUpsert' | 'cronRemove'>
  mutations: Pick<AgentMutationGate, 'tryBeginMutation'>
  recomputeDuties?: (orgId: string) => void
  /** Re-judges the agent's open `cron` capability requests against its crons. */
  cronsChanged?: (agent: AgentRecord) => Promise<void>
  now?: () => Date
  log: { warn(obj: object, msg: string): void }
}

const refused = (message: string): AgentCronResult => ({ status: 'refused', message })

/** `runAt`'s instant as the wall-clock time croner reads in `timezone`, e.g. `2026-11-12T09:00:00`. */
export function wallClockIn(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(instant)
  const at = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${at('year')}-${at('month')}-${at('day')}T${at('hour')}:${at('minute')}:${at('second')}`
}

function validTimezone(timezone: string): boolean {
  try {
    const canonical = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone
    return !canonical.startsWith('+') && !canonical.startsWith('-')
  } catch {
    return false
  }
}

/** Whether `firedAt` is a fire of THIS one-shot definition: its one moment lies at or before the
 *  report. A schedule replaced while a run was in flight has no fire before it, so nothing retires. */
function firedThisOneShot(schedule: string, timezone: string, firedAt: Date): boolean {
  if (!isOneShotSchedule(schedule)) return false
  try {
    return new Cron(schedule, { timezone, paused: true }).previousRuns(1, new Date(firedAt.getTime() + 1000)).length > 0
  } catch {
    return false
  }
}

/** The schedule's next fire after `now`, or a reason it has none. */
function nextFire(schedule: string, timezone: string, now: Date): Date | string {
  try {
    const cron = new Cron(schedule, { timezone, paused: true })
    const next = cron.nextRun(now)
    cron.stop()
    return next ?? 'the schedule never fires after now'
  } catch (err) {
    return `not a valid croner schedule: ${(err as Error).message}`
  }
}

export function agentCronView(cron: CronRecord): AgentCronView {
  return {
    cronId: cron.id,
    name: cron.name,
    schedule: cron.schedule,
    timezone: cron.timezone,
    once: isOneShotSchedule(cron.schedule),
    trigger: cron.trigger,
    enabled: cron.enabled,
    target: cron.targetChannel
      ? {
          platform: toDbPlatform(cron.targetPlatform),
          channel: cron.targetChannel,
          integrationId: cron.targetIntegrationId
        }
      : null,
    lastRunAt: cron.lastRunAt ? cron.lastRunAt.toISOString() : null
  }
}

export class AgentCronService {
  constructor(private readonly deps: AgentCronDeps) {}

  private pushFailed(what: string): DeliveryErrorHandler {
    return (err, daemonId) =>
      this.deps.log.warn({ err, daemonId }, `${what} push failed — daemon converges on next register`)
  }

  async list(agent: AgentRecord): Promise<AgentCronResult> {
    const crons = await this.deps.crons.listForAgent(agent.id)
    return { status: 'ok', crons: crons.filter((c) => c.orgId === agent.orgId).map(agentCronView) }
  }

  async save(agent: AgentRecord, input: AgentCronSave): Promise<AgentCronResult> {
    if ((input.schedule === undefined) === (input.runAt === undefined))
      return refused('give exactly one of schedule (recurring) or runAt (once)')
    if (!validTimezone(input.timezone)) return refused(`not a valid IANA timezone: ${input.timezone}`)
    const now = this.deps.now?.() ?? new Date()
    let schedule: string
    if (input.runAt !== undefined) {
      const at = new Date(input.runAt)
      if (at.getTime() <= now.getTime() + 60_000) return refused('runAt must be at least a minute in the future')
      schedule = wallClockIn(at, input.timezone)
    } else {
      schedule = input.schedule!.trim()
      if (isOneShotSchedule(schedule))
        return refused('a date-time schedule fires once: pass it as runAt with an offset')
    }
    const next = nextFire(schedule, input.timezone, now)
    if (typeof next === 'string') return refused(next)

    const existing = input.cronId ? await this.deps.crons.get(agent.orgId, CronId(input.cronId)) : null
    if (input.cronId && existing?.agentId !== agent.id) return refused('no cron with that id is bound to you')

    let targetIntegrationId: IntegrationId | undefined
    let targetPlatform = existing?.targetPlatform
    if (input.target) {
      const integration = await this.deps.integrations.get(agent.orgId, IntegrationId(input.target.integrationId))
      if (!integration || integration.agentId !== agent.id) return refused('the target integration is not one of yours')
      targetIntegrationId = integration.id
      targetPlatform = toDbPlatform(integration.platform)
    }

    const release = this.deps.mutations.tryBeginMutation(agent.id)
    if (!release) return refused('your agent is being moved; try again in a moment')
    try {
      const current = await refreshMutationAgent(this.deps.agents, agent)
      if (!current) return refused('your agent changed meanwhile; try again')
      const cron = await this.deps.crons.upsert({
        cronId: existing?.id ?? CronId(randomUUID()),
        orgId: agent.orgId,
        agentId: agent.id,
        ...((input.name ?? existing?.name) ? { name: input.name ?? existing!.name! } : {}),
        schedule,
        timezone: input.timezone,
        ...(targetPlatform ? { targetPlatform } : {}),
        // An edit without a target keeps the one the cron has.
        ...(input.target
          ? { targetChannel: input.target.channel, ...(targetIntegrationId ? { targetIntegrationId } : {}) }
          : input.target === undefined && existing?.targetChannel
            ? {
                targetChannel: existing.targetChannel,
                ...(existing.targetIntegrationId ? { targetIntegrationId: existing.targetIntegrationId } : {})
              }
            : {}),
        trigger: input.trigger,
        enabled: input.enabled ?? existing?.enabled ?? true
      })
      this.deps.recomputeDuties?.(agent.orgId)
      this.audit(agent, 'cron/upsert', `cron ${cron.id} upserted by its agent`, {
        cronId: cron.id,
        schedule: cron.schedule,
        timezone: cron.timezone,
        targetChannel: cron.targetChannel,
        enabled: cron.enabled
      })
      const wire = cronToUpsert(cron)
      if (wire) await this.deps.delivery.cronUpsert(current, wire, this.pushFailed('cron/upsert'))
      await this.deps
        .cronsChanged?.(current)
        .catch((err: unknown) =>
          this.deps.log.warn({ err }, 'capability request: re-evaluation after an agent cron save failed')
        )
      return { status: 'ok', cron: agentCronView(cron) }
    } finally {
      release()
    }
  }

  async remove(agent: AgentRecord, cronId: string): Promise<AgentCronResult> {
    const existing = await this.deps.crons.get(agent.orgId, CronId(cronId))
    if (existing?.agentId !== agent.id) return refused('no cron with that id is bound to you')
    return (await this.removeBound(agent, existing, 'by its agent'))
      ? { status: 'ok' }
      : refused('the cron changed meanwhile; try again')
  }

  /** A one-shot cron's run completed: it has nothing left to fire, so it goes — but only if the
   *  run reported is a fire of the definition stored now, never one of a schedule since replaced. */
  async retireOneShot(cron: CronRecord, firedAt: Date): Promise<void> {
    if (!cron.agentId) return
    const current = await this.deps.crons.get(cron.orgId, cron.id)
    if (!current?.agentId || !firedThisOneShot(current.schedule, current.timezone, firedAt)) return
    const agent = await this.deps.agents.get(cron.orgId, current.agentId)
    if (!agent) return
    // The definition is re-checked inside the delete, so a save that lands in between wins.
    await this.removeBound(agent, current, 'after its one run', {
      schedule: current.schedule,
      timezone: current.timezone
    })
  }

  private async removeBound(
    agent: AgentRecord,
    cron: CronRecord,
    why: string,
    definition?: { schedule: string; timezone: string }
  ): Promise<boolean> {
    const release = this.deps.mutations.tryBeginMutation(agent.id)
    if (!release) return false
    try {
      if (!(await this.deps.crons.remove(agent.orgId, cron.id, agent.id, definition))) return false
      this.deps.recomputeDuties?.(agent.orgId)
      this.audit(agent, 'cron/remove', `cron ${cron.id} removed ${why}`, { cronId: cron.id })
      await this.deps.delivery.cronRemove(agent, cron.id, cron.orgId, this.pushFailed('cron/remove'))
      return true
    } finally {
      release()
    }
  }

  private audit(agent: AgentRecord, frameType: string, message: string, details: Record<string, unknown>): void {
    void this.deps.audit
      .append({ kind: 'cron_change', orgId: agent.orgId, agentId: agent.id, frameType, message, details })
      .catch(() => {})
  }
}
