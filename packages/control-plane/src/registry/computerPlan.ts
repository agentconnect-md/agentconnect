// ComputerPlan — managed computer quotas, metering and egress per organization (computer-use.md §15.4, §15.5).
import { ComputerEgress, type ComputerAllocation } from '@agentconnect.md/protocol'
import { StoredEgress, type ComputerEgressUpdate } from '../domain/computerEgress.js'
import type { Clock } from '../domain/clock.js'
import { OrgId } from '../domain/ids.js'
import {
  ComputerQuotaOverrideSchema,
  desktopRefusal,
  effectiveQuotas,
  emptyDesktopCounts,
  utcMonthStart,
  viewerRefusal,
  type ComputerQuotaOverride,
  type ComputerQuotaRefusal,
  type ComputerQuotas,
  type DesktopCounts
} from '../domain/computerQuotas.js'
import { meteredState } from '../domain/computerMetering.js'
import { isComputerPoolPhase, COMPUTER_ALLOCATIONS } from '../domain/computerPool.js'
import type { ComputerRecord, ComputerUsageRepo, ComputerUsageTotals } from '../persistence/ports.js'
import type { SecretCipher } from '../secrets/cipher.js'
import { orgScope } from '../secrets/scope.js'
import type { ComputerPlanConfig } from '../computer-plan/config.js'

/** The console's view of an organization's egress; never the password. */
export interface ComputerEgressView {
  mode: 'deployment' | 'proxy'
  url: string | null
  username: string | null
  passwordSet: boolean
  orgProxyAllowed: boolean
  description: string | null
}

export interface ComputerQuotaStatus {
  defaults: ComputerQuotas
  override: ComputerQuotaOverride | null
  limits: ComputerQuotas
  used: {
    runningDesktops: number
    desktops: number
    storageGib: number
    monthlyDesktopHours: number
    modes: Record<ComputerAllocation, { runningDesktops: number; desktops: number }>
    viewers: number
    monthlyViewerGib: number
    screenshotStorageGib: number
  }
  volumeGib: number
}

/** Who is told when an organization's egress changes: its live managed desktops. */
export interface ComputerEgressChannels {
  pushEgress(orgId: string, egress: ComputerEgress): void
}

export interface ComputerPlanLog {
  warn(obj: object, msg: string): void
}

const RUNNING = new Set(['provisioning', 'registering', 'awake', 'waking', 'resetting'])
const GIB = 1024 ** 3

/** Lapsed viewings are deleted this often, once they are this old. */
const VIEWER_REAP_MS = 10 * 60_000

export class ComputerPlan {
  private channels: ComputerEgressChannels | undefined
  private timer: ReturnType<Clock['setTimeout']> | undefined
  private stopped = true

  constructor(
    private readonly repo: ComputerUsageRepo,
    private readonly cipher: SecretCipher,
    private readonly clock: Clock,
    private readonly config: ComputerPlanConfig,
    private readonly opts: {
      screenshotsStored?: (orgId: string) => Promise<number>
      log?: ComputerPlanLog
    } = {}
  ) {}

  /** Deletes lapsed viewer rows in the background. */
  start(): void {
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  private arm(): void {
    if (this.stopped) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      void this.repo
        .reapViewers(new Date(this.clock.now() - VIEWER_REAP_MS))
        .catch((err) => this.opts.log?.warn({ err: (err as Error).message }, 'computer-plan: viewer reap failed'))
        .finally(() => this.arm())
    }, VIEWER_REAP_MS)
  }

  /** Where egress changes are pushed; set once the channel registry exists. */
  bindChannels(channels: ComputerEgressChannels): void {
    this.channels = channels
  }

  get volumeGib(): number {
    return this.config.volumeGib
  }

  async override(orgId: string): Promise<ComputerQuotaOverride | null> {
    const row = await this.repo.settings(orgId)
    if (!row?.quotas) return null
    const parsed = ComputerQuotaOverrideSchema.safeParse(row.quotas)
    if (!parsed.success)
      this.opts.log?.warn({ orgId }, 'computer-plan: stored quota override is invalid; using defaults')
    return parsed.success ? parsed.data : null
  }

  async limits(orgId: string): Promise<ComputerQuotas> {
    return effectiveQuotas(this.config.quotas, await this.override(orgId))
  }

  async setOverride(orgId: string, override: ComputerQuotaOverride | null): Promise<void> {
    await this.repo.setQuotas(orgId, override)
  }

  private async counts(orgId: string): Promise<DesktopCounts> {
    const counts = emptyDesktopCounts()
    for (const { allocation, phase, count } of await this.repo.desktopPhases(orgId)) {
      if (!(COMPUTER_ALLOCATIONS as readonly string[]).includes(allocation)) continue
      const mode = allocation as ComputerAllocation
      counts.held[mode] += count
      if (RUNNING.has(phase)) counts.running[mode] += count
    }
    return counts
  }

  /** Why a managed desktop may not start now, or null; `adding` is a new one. */
  async desktopRefusal(
    orgId: string,
    start: { allocation: ComputerAllocation; adding: boolean }
  ): Promise<ComputerQuotaRefusal | null> {
    const [limits, counts, month] = await Promise.all([
      this.limits(orgId),
      this.counts(orgId),
      this.repo.since(orgId, utcMonthStart(this.clock.now()))
    ])
    return desktopRefusal(limits, counts, start, month.runningSeconds / 3600, this.config.volumeGib)
  }

  /** Why this person may not open (or renew) a viewer now, or null. */
  async viewerRefusal(orgId: string, computerId: string, userId: string): Promise<ComputerQuotaRefusal | null> {
    const now = this.clock.now()
    const [limits, others, month] = await Promise.all([
      this.limits(orgId),
      this.repo.viewers(orgId, computerId, userId, new Date(now)),
      this.repo.since(orgId, utcMonthStart(now))
    ])
    return viewerRefusal(limits, others, month.relayedBytes)
  }

  async viewerGranted(orgId: string, computerId: string, userId: string, expiresAt: Date): Promise<void> {
    await this.repo.touchViewer(orgId, computerId, userId, expiresAt)
  }

  /** The screenshot limits an upload is held to: stored bytes and the longest retention; null is unlimited. */
  async screenshotLimits(orgId: string): Promise<{ storedBytes: number | null; retentionDays: number | null }> {
    const limits = await this.limits(orgId)
    return {
      storedBytes: limits.screenshotStorageGib === null ? null : limits.screenshotStorageGib * GIB,
      retentionDays: limits.screenshotRetentionDays
    }
  }

  async status(orgId: string): Promise<ComputerQuotaStatus> {
    const now = this.clock.now()
    const [override, counts, month, viewers, screenshots] = await Promise.all([
      this.override(orgId),
      this.counts(orgId),
      this.repo.since(orgId, utcMonthStart(now)),
      this.repo.viewers(orgId, '00000000-0000-0000-0000-000000000000', '', new Date(now)),
      this.opts.screenshotsStored?.(orgId) ?? Promise.resolve(0)
    ])
    const held = COMPUTER_ALLOCATIONS.reduce((n, m) => n + counts.held[m], 0)
    return {
      defaults: this.config.quotas,
      override,
      limits: effectiveQuotas(this.config.quotas, override),
      used: {
        runningDesktops: COMPUTER_ALLOCATIONS.reduce((n, m) => n + counts.running[m], 0),
        desktops: held,
        storageGib: held * this.config.volumeGib,
        monthlyDesktopHours: Math.round((month.runningSeconds / 3600) * 10) / 10,
        modes: Object.fromEntries(
          COMPUTER_ALLOCATIONS.map((m) => [m, { runningDesktops: counts.running[m], desktops: counts.held[m] }])
        ) as ComputerQuotaStatus['used']['modes'],
        viewers: viewers.org,
        monthlyViewerGib: Math.round((month.relayedBytes / GIB) * 100) / 100,
        screenshotStorageGib: Math.round((screenshots / GIB) * 100) / 100
      },
      volumeGib: this.config.volumeGib
    }
  }

  /** Bill a managed desktop's time since its last metering to its current phase; a no-op for anything else. */
  async accrue(row: ComputerRecord, now: number): Promise<void> {
    if (row.kind !== 'managed' || !row.poolPhase || !isComputerPoolPhase(row.poolPhase)) return
    await this.repo.accrue({
      computerId: row.id,
      orgId: row.orgId,
      allocation: row.allocation,
      meteredAt: row.poolMeteredAt ?? null,
      since: row.createdAt,
      to: new Date(now),
      state: meteredState(row.poolPhase),
      volumeGib: this.config.volumeGib
    })
  }

  /** TURN bytes a relay forwarded per Computer (`rc/computer-media-usage`). */
  async recordRelayed(entries: ReadonlyArray<{ computerId: string; bytes: number }>, at: Date): Promise<void> {
    await this.repo.addRelayed(entries, at)
  }

  async usage(orgId: string, window: { from: Date; to: Date }): Promise<ComputerUsageTotals> {
    return await this.repo.usage(orgId, window)
  }

  private async storedEgress(orgId: string): Promise<{ egress: StoredEgress; password: string | null }> {
    const row = await this.repo.settings(orgId)
    const parsed = StoredEgress.safeParse(row?.egress ?? { mode: 'deployment' })
    return {
      egress: parsed.success ? parsed.data : { mode: 'deployment' },
      password: row?.egressProxyPassword ?? null
    }
  }

  async egressView(orgId: string): Promise<ComputerEgressView> {
    const { egress, password } = await this.storedEgress(orgId)
    return {
      mode: egress.mode,
      url: egress.mode === 'proxy' ? egress.url : null,
      username: egress.mode === 'proxy' ? (egress.username ?? null) : null,
      passwordSet: egress.mode === 'proxy' && password !== null,
      orgProxyAllowed: this.config.egress.orgProxy,
      description: this.config.egress.description ?? null
    }
  }

  /** What a managed desktop of this organization applies; the deployment's own egress when it allows no proxies. */
  async egressFor(orgId: string): Promise<ComputerEgress> {
    const { egress, password } = await this.storedEgress(orgId)
    if (egress.mode !== 'proxy' || !this.config.egress.orgProxy) return { mode: 'direct' }
    const opened = password ? await this.cipher.open(password, orgScope(OrgId(orgId))) : null
    return ComputerEgress.parse({
      mode: 'proxy',
      url: egress.url,
      ...(egress.username ? { username: egress.username } : {}),
      ...(opened ? { password: opened } : {})
    })
  }

  /** Store an organization's egress and tell its live managed desktops; false when the deployment allows no proxies. */
  async setEgress(orgId: string, update: ComputerEgressUpdate): Promise<boolean> {
    if (update.mode === 'proxy' && !this.config.egress.orgProxy) return false
    const current = await this.storedEgress(orgId)
    let stored: StoredEgress = { mode: 'deployment' }
    let sealed: string | null = null
    if (update.mode === 'proxy') {
      stored = { mode: 'proxy', url: update.url, ...(update.username ? { username: update.username } : {}) }
      if (typeof update.password === 'string') sealed = await this.cipher.seal(update.password, orgScope(OrgId(orgId)))
      // An omitted password stays only for the same proxy, so a changed host never receives the old one.
      else if (update.password === undefined && current.egress.mode === 'proxy' && current.egress.url === update.url)
        sealed = current.password
    }
    await this.repo.setEgress(orgId, stored, sealed)
    this.channels?.pushEgress(orgId, await this.egressFor(orgId))
    return true
  }
}
