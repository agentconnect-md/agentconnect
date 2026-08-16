import { Cron } from 'croner'
import type { CronDef } from '../agents/agent-schema.js'
import type { NormalizedMessage } from '../messages/normalized.js'

export function buildSyntheticMessage(
  agentId: string,
  cron: CronDef,
  traceId: string
): { agentId: string; msg: NormalizedMessage } {
  // No target ⇒ headless fire: the channel is a synthetic key (transcript/session
  // bookkeeping only) and `headless` suppresses all platform output in dispatch.
  // An anchored fire lives on the TARGET's platform (replies post there);
  // headless fires keep the legacy 'slack' key so existing synthetic sessions
  // stay continuous across this change.
  const msg: NormalizedMessage = {
    msgId: `cron:${cron.id}:${traceId}`,
    traceId,
    source: 'cron',
    platform: cron.target?.platform ?? 'slack',
    channel: cron.target?.channel ?? `cron:${cron.id}`,
    thread: `cron:${cron.id}:${traceId}`, // fresh thread per fire (replaced by the real anchor ts when posted)
    sender: { id: `cron:${cron.id}`, isBot: false },
    text: cron.trigger,
    mentionedBots: [],
    isDm: false,
    trigger: 'cron',
    ...(cron.target ? {} : { headless: true })
  }
  return { agentId, msg }
}

/** Staleness cap on a catch-up: past this, a swallowed moment is history rather than a late fire. */
const CATCH_UP_GRACE_CAP_MS = 60 * 60 * 1_000

/** The fields that DEFINE when a schedule fires — a cron entry or an agent's dreaming policy. */
export interface ScheduleDefinition {
  schedule: string
  timezone?: string
  enabled: boolean
}

/** Durable record of the last fire: when it happened, and under which definition. */
export interface ScheduleRun {
  lastRunAt: number
  definition: string | null
}

/**
 * Identity of a schedule DEFINITION, stored next to its stamp.
 *
 * A stamp on its own proves nothing about the CURRENT schedule: cron ids are edited in place and
 * dreaming policies are mutable, so "daily, last fired 03:00" then "switched to hourly at 12:30"
 * would otherwise look like an hourly fire owed at 12:00 that the hourly definition never covered.
 * Comparing this fingerprint answers "is that stamp a fire of THIS definition".
 */
export function scheduleFingerprint(definition: ScheduleDefinition): string {
  return JSON.stringify([definition.enabled, definition.schedule, definition.timezone ?? null])
}

/**
 * The one occurrence a duty handover swallowed, or undefined when nothing is owed (#1031).
 *
 * A freshly constructed `Cron` knows nothing of a moment that has already passed, so a schedule
 * whose moment lands between the old holder unregistering and the new one arming runs nowhere.
 * This answers "was a fire of THIS definition due since its stamp": the previous occurrence, when
 * it is newer than the stamp and still within one interval (capped). Only the NEWEST missed moment
 * is returned — a catch-up compensates a gap, it never replays a backlog. Nothing is owed without a
 * stamp (nothing durable says this schedule has ever been due) or when the stamp was written under
 * a different definition (the moment it recorded belongs to a schedule that no longer exists).
 */
export function missedOccurrence(
  definition: ScheduleDefinition,
  run: ScheduleRun | undefined,
  now: number
): number | undefined {
  if (!definition.enabled || !run || run.definition !== scheduleFingerprint(definition)) return undefined
  let runs: Date[]
  try {
    // Pattern-only: croner schedules nothing without a handler, so this is a pure query.
    runs = new Cron(definition.schedule, definition.timezone ? { timezone: definition.timezone } : {}).previousRuns(
      2,
      new Date(now)
    )
  } catch {
    return undefined // malformed patterns are warned about where they are armed
  }
  const [previous, before] = runs
  if (!previous || previous.getTime() <= run.lastRunAt) return undefined
  const interval = before ? previous.getTime() - before.getTime() : CATCH_UP_GRACE_CAP_MS
  const grace = Math.min(interval, CATCH_UP_GRACE_CAP_MS)
  return now - previous.getTime() <= grace ? previous.getTime() : undefined
}

/**
 * Local scheduler for `agent.json.crons[]` (D5). Jobs are keyed per agent so the
 * reconciler can converge them on any agent change (design §5.2: crons change →
 * Scheduler upsert/remove) — `sync` replaces an agent's whole job set, `unregister`
 * drops it. A malformed schedule skips that one cron (warned), never the rest.
 */
export class Scheduler {
  private jobs = new Map<string, Cron[]>() // agentId → live jobs
  constructor(
    private deps: {
      onFire: (agentId: string, msg: NormalizedMessage, cron: CronDef) => void
      newTraceId: () => string
      warn?: (msg: string) => void
    }
  ) {}

  /** Converge one agent's job set to its current `crons[]` (replace-all, idempotent).
   *  Disabled crons stay on disk but are not scheduled. */
  sync(agentId: string, crons: CronDef[]): void {
    this.unregister(agentId)
    const jobs: Cron[] = []
    for (const cron of crons) {
      if (cron.enabled === false) continue
      try {
        jobs.push(
          new Cron(cron.schedule, cron.timezone ? { timezone: cron.timezone } : {}, () => {
            const { msg } = buildSyntheticMessage(agentId, cron, this.deps.newTraceId())
            this.deps.onFire(agentId, msg, cron)
          })
        )
      } catch (err) {
        this.deps.warn?.(`scheduler: skipping cron "${cron.id}" of agent "${agentId}": ${(err as Error).message}`)
      }
    }
    if (jobs.length) this.jobs.set(agentId, jobs)
  }

  /** Stop and drop an agent's jobs (agent removed / deactivated). */
  unregister(agentId: string): void {
    for (const j of this.jobs.get(agentId) ?? []) j.stop()
    this.jobs.delete(agentId)
  }

  /** Live job count for one agent (0 when none). */
  count(agentId: string): number {
    return this.jobs.get(agentId)?.length ?? 0
  }

  stop(): void {
    for (const agentId of [...this.jobs.keys()]) this.unregister(agentId)
  }
}
