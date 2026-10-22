// The per-app, per-tenant write budget (teams-integration.md §4.3): one bucket shared by every Teams connection of an app on this daemon.
import { WriteBudgets, type WriteBudget, type WriteBudgetSettings } from '../write-budget.js'

/** Microsoft's ceiling for one app in one tenant, above which it answers 429. */
export const MSTEAMS_TENANT_WRITES_PER_SECOND = 50

export const MSTEAMS_WRITE_BUDGET: WriteBudgetSettings = {
  capacity: MSTEAMS_TENANT_WRITES_PER_SECOND,
  refillPerMinute: MSTEAMS_TENANT_WRITES_PER_SECOND * 60
}

/** One bucket per (app, tenant); Entra IDs compare case-insensitively. */
export class MsTeamsWriteBudgets {
  private readonly budgets: WriteBudgets

  constructor(
    settings: WriteBudgetSettings = MSTEAMS_WRITE_BUDGET,
    now?: () => number,
    sleep?: (ms: number) => Promise<void>
  ) {
    this.budgets = new WriteBudgets(settings, now, sleep)
  }

  for(appId: string, tenantId: string): WriteBudget {
    return this.budgets.for(`${appId.toLowerCase()}\u0000${tenantId.toLowerCase()}`)
  }
}
