// Managed computer quotas (computer-use.md §15.5): the limits, how an organization's override merges, and the pure checks.
import { z } from 'zod'
import { COMPUTER_ALLOCATIONS, type ComputerAllocation } from '@agentconnect.md/protocol'

/** A count or size limit; null is unlimited. */
const Limit = z.number().int().min(0).max(1_000_000_000).nullable()

const ModeLimits = z.strictObject({ runningDesktops: Limit.optional(), desktops: Limit.optional() })
export type ComputerModeLimits = z.infer<typeof ModeLimits>

export const ComputerQuotasSchema = z.strictObject({
  // Managed desktops whose pod runs (or is starting) at once.
  runningDesktops: Limit,
  // Managed desktops held, sleeping and failed ones with their kept volumes included.
  desktops: Limit,
  // The GiB those desktops' volumes hold together.
  storageGib: Limit,
  // Running desktop hours per UTC calendar month.
  monthlyDesktopHours: Limit,
  // The same two counts for one allocation mode, on top of the totals.
  modes: z.strictObject(
    Object.fromEntries(COMPUTER_ALLOCATIONS.map((m) => [m, ModeLimits.optional()])) as Record<
      ComputerAllocation,
      z.ZodOptional<typeof ModeLimits>
    >
  ),
  // People watching the organization's Computers at once, and one Computer.
  viewers: Limit,
  viewersPerComputer: Limit,
  // Viewer media the relays forward over TURN per UTC calendar month, in GiB.
  monthlyViewerGib: Limit,
  // Screenshots stored at once, in GiB, and the most days one is kept.
  screenshotStorageGib: Limit,
  screenshotRetentionDays: Limit
})
export type ComputerQuotas = z.infer<typeof ComputerQuotasSchema>

/** An organization's override: any subset; a mode's limits replace that mode's defaults key by key. */
export const ComputerQuotaOverrideSchema = ComputerQuotasSchema.partial().extend({
  modes: ComputerQuotasSchema.shape.modes.optional()
})
export type ComputerQuotaOverride = z.infer<typeof ComputerQuotaOverrideSchema>

/** Conservative defaults for a deployment that sets none; operators raise them in AC_COMPUTER_PLAN (decisions to confirm). */
export const DEFAULT_COMPUTER_QUOTAS: ComputerQuotas = {
  runningDesktops: 3,
  desktops: 10,
  storageGib: null,
  monthlyDesktopHours: 300,
  modes: {},
  viewers: 5,
  viewersPerComputer: 3,
  monthlyViewerGib: 100,
  screenshotStorageGib: 10,
  screenshotRetentionDays: null
}

/** The defaults with an organization's override on top. */
export function effectiveQuotas(defaults: ComputerQuotas, override: ComputerQuotaOverride | null): ComputerQuotas {
  if (!override) return defaults
  const { modes, ...rest } = override
  const merged: ComputerQuotas = { ...defaults, ...rest, modes: { ...defaults.modes } }
  for (const mode of COMPUTER_ALLOCATIONS) {
    const own = modes?.[mode]
    if (own) merged.modes[mode] = { ...defaults.modes[mode], ...own }
  }
  return merged
}

/** Managed desktops an organization holds now, by allocation. */
export interface DesktopCounts {
  running: Record<ComputerAllocation, number>
  held: Record<ComputerAllocation, number>
}

export const emptyDesktopCounts = (): DesktopCounts => ({
  running: { ephemeral: 0, 'per-agent': 0, manual: 0 },
  held: { ephemeral: 0, 'per-agent': 0, manual: 0 }
})

const sum = (byMode: Record<ComputerAllocation, number>): number =>
  COMPUTER_ALLOCATIONS.reduce((n, mode) => n + byMode[mode], 0)

/** Which quota a refusal is about; the console and the agent see it with the limit and the use. */
export type ComputerQuotaName =
  | 'runningDesktops'
  | 'desktops'
  | 'storageGib'
  | 'monthlyDesktopHours'
  | 'viewers'
  | 'viewersPerComputer'
  | 'monthlyViewerGib'

export interface ComputerQuotaRefusal {
  quota: ComputerQuotaName
  limit: number
  used: number
  message: string
}

const RAISE = 'ask the deployment’s operator to raise the limit'
const MODE_LABEL: Record<ComputerAllocation, string> = {
  ephemeral: 'session (ephemeral)',
  'per-agent': 'per-agent',
  manual: 'manual'
}

/** Whether a managed desktop may start: `adding` a new row, else a held one starting again; `hoursUsed` this month. */
export function desktopRefusal(
  quotas: ComputerQuotas,
  counts: DesktopCounts,
  start: { allocation: ComputerAllocation; adding: boolean },
  hoursUsed: number,
  volumeGib: number
): ComputerQuotaRefusal | null {
  const mode = quotas.modes[start.allocation] ?? {}
  const running = sum(counts.running)
  const held = sum(counts.held)
  if (quotas.monthlyDesktopHours !== null && hoursUsed >= quotas.monthlyDesktopHours)
    return {
      quota: 'monthlyDesktopHours',
      limit: quotas.monthlyDesktopHours,
      used: Math.floor(hoursUsed),
      message: `this organization used its ${quotas.monthlyDesktopHours} managed computer hours for this month; they renew on the 1st (UTC), or ${RAISE}`
    }
  if (quotas.runningDesktops !== null && running >= quotas.runningDesktops)
    return {
      quota: 'runningDesktops',
      limit: quotas.runningDesktops,
      used: running,
      message: `this organization already runs ${running} managed computer(s), its limit of ${quotas.runningDesktops}; put one to sleep or delete one, or ${RAISE}`
    }
  const modeRunning = mode.runningDesktops ?? null
  if (modeRunning !== null && counts.running[start.allocation] >= modeRunning)
    return {
      quota: 'runningDesktops',
      limit: modeRunning,
      used: counts.running[start.allocation],
      message: `this organization already runs ${counts.running[start.allocation]} ${MODE_LABEL[start.allocation]} managed computer(s), its limit of ${modeRunning}; ${RAISE}`
    }
  if (!start.adding) return null
  if (quotas.desktops !== null && held >= quotas.desktops)
    return {
      quota: 'desktops',
      limit: quotas.desktops,
      used: held,
      message: `this organization already holds ${held} managed computer(s), sleeping ones included, its limit of ${quotas.desktops}; delete one, or ${RAISE}`
    }
  const modeHeld = mode.desktops ?? null
  if (modeHeld !== null && counts.held[start.allocation] >= modeHeld)
    return {
      quota: 'desktops',
      limit: modeHeld,
      used: counts.held[start.allocation],
      message: `this organization already holds ${counts.held[start.allocation]} ${MODE_LABEL[start.allocation]} managed computer(s), its limit of ${modeHeld}; delete one, or ${RAISE}`
    }
  if (quotas.storageGib !== null && (held + 1) * volumeGib > quotas.storageGib)
    return {
      quota: 'storageGib',
      limit: quotas.storageGib,
      used: held * volumeGib,
      message: `another managed computer’s ${volumeGib} GiB volume would take this organization past its ${quotas.storageGib} GiB of managed computer storage; delete one, or ${RAISE}`
    }
  return null
}

/** Whether one more person may watch: `others` counts the viewings other than this person's own on that Computer. */
export function viewerRefusal(
  quotas: ComputerQuotas,
  others: { org: number; computer: number },
  relayedBytesThisMonth: number
): ComputerQuotaRefusal | null {
  const gib = relayedBytesThisMonth / 1024 ** 3
  if (quotas.monthlyViewerGib !== null && gib >= quotas.monthlyViewerGib)
    return {
      quota: 'monthlyViewerGib',
      limit: quotas.monthlyViewerGib,
      used: Math.floor(gib),
      message: `this organization’s viewers used its ${quotas.monthlyViewerGib} GiB of relayed video for this month; it renews on the 1st (UTC), or ${RAISE}`
    }
  if (quotas.viewersPerComputer !== null && others.computer >= quotas.viewersPerComputer)
    return {
      quota: 'viewersPerComputer',
      limit: quotas.viewersPerComputer,
      used: others.computer,
      message: `${others.computer} people are already watching this computer, its limit of ${quotas.viewersPerComputer}; try again when one of them leaves`
    }
  if (quotas.viewers !== null && others.org >= quotas.viewers)
    return {
      quota: 'viewers',
      limit: quotas.viewers,
      used: others.org,
      message: `${others.org} viewers are already open in this organization, its limit of ${quotas.viewers}; try again when one closes, or ${RAISE}`
    }
  return null
}

/** The first instant of the UTC month `now` falls in. */
export function utcMonthStart(now: number): Date {
  const d = new Date(now)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}
