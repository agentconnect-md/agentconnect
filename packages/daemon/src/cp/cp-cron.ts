/** CP cron definitions live only in daemon memory and are re-converged on reconnect. */
import type { CronUpsert } from '@agentconnect.md/protocol'
import type { CronDef } from '../agents/agent-schema.js'
import { toCronDef, type WriteCronDeps } from '../agents/write-cron.js'

interface Entry {
  agentId: string
  cron: CronDef
}

export class CpCronRegistry {
  private readonly entries = new Map<string, Entry>()

  constructor(
    _agentsDir: string,
    _deps: WriteCronDeps,
    private readonly onChange: () => void
  ) {}

  upsert(cron: CronUpsert): void {
    this.entries.set(cron.cronId, { agentId: cron.agentId, cron: toCronDef(cron) })
    this.onChange()
  }

  remove(cronId: string): void {
    if (this.entries.delete(cronId)) this.onChange()
  }

  converge(crons: CronUpsert[]): void {
    for (const cron of crons ?? []) this.entries.set(cron.cronId, { agentId: cron.agentId, cron: toCronDef(cron) })
    this.onChange()
  }

  agentForCron(cronId: string): string | undefined {
    return this.entries.get(cronId)?.agentId
  }

  forAgent(agentId: string): CronDef[] {
    return [...this.entries.values()].filter((entry) => entry.agentId === agentId).map((entry) => entry.cron)
  }

  retainForAgent(agentId: string, desiredIds: ReadonlySet<string>): boolean {
    let changed = false
    for (const [id, entry] of this.entries) {
      if (entry.agentId === agentId && !desiredIds.has(id)) {
        this.entries.delete(id)
        changed = true
      }
    }
    if (changed) this.onChange()
    return changed
  }
}
