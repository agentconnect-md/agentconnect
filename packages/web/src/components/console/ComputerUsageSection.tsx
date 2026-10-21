'use client'

// Computer usage on the Usage page (computer-use.md §15.5): managed desktop hours, kept storage, viewer media and screenshots.
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { fetchComputerUsage, type ComputerAllocation, type ComputerUsageDto, type UsageRange } from '@/lib/api'
import { MOCK_MODE } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'

const GRID = 'grid-cols-[2fr_1fr_1fr_1fr_1fr]'
const GB = 1000 ** 3

const isAllocation = (value: string | null): value is ComputerAllocation =>
  value === 'ephemeral' || value === 'per-agent' || value === 'manual'

/** Whether a window metered anything worth a section. */
export function hasComputerUsage(usage: ComputerUsageDto): boolean {
  const { totals, screenshots } = usage
  return (
    totals.runningSeconds + totals.sleepingSeconds + totals.relayedBytes > 0 ||
    screenshots.written.count + screenshots.stored.count > 0
  )
}

export default function ComputerUsageSection({ range }: { range: UsageRange }) {
  const t = useTranslations('Usage.computers')
  const format = useFormatter()
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id
  const { data } = useSWR<ComputerUsageDto | null>(
    !MOCK_MODE && orgId ? ['computer-usage', orgId, range] : null,
    ([, scoped, r]: [string, string, UsageRange]) => fetchComputerUsage(r, scoped).catch(() => null)
  )
  if (!data || !hasComputerUsage(data)) return null
  const hours = (seconds: number) => format.number(seconds / 3600, { maximumFractionDigits: seconds < 36_000 ? 1 : 0 })
  const gb = (bytes: number) => format.number(bytes / GB, { maximumFractionDigits: bytes < 10 * GB ? 2 : 1 })
  const gibHours = (gibSeconds: number) => format.number(gibSeconds / 3600, { maximumFractionDigits: 0 })
  const { totals, screenshots } = data
  const tiles = [
    {
      key: 'running',
      label: t('runningHours'),
      value: hours(totals.runningSeconds),
      sub: t('sleepingHours', { hours: hours(totals.sleepingSeconds) })
    },
    { key: 'storage', label: t('keptStorage'), value: gibHours(totals.volumeGibSeconds), sub: t('keptStorageUnit') },
    { key: 'media', label: t('viewerMedia'), value: gb(totals.relayedBytes), sub: t('viewerMediaUnit') },
    {
      key: 'screenshots',
      label: t('screenshots'),
      value: gb(screenshots.stored.bytes),
      sub: t('screenshotsWritten', { count: screenshots.written.count, gb: gb(screenshots.written.bytes) })
    }
  ]
  const computers = [...data.computers]
    .sort(
      (a, b) =>
        b.runningSeconds + b.sleepingSeconds - (a.runningSeconds + a.sleepingSeconds) || b.relayedBytes - a.relayedBytes
    )
    .slice(0, 10)
  return (
    <section className="mt-[18px] max-desktop:mx-4" data-computer-usage>
      <h2 className="mb-2 font-sans text-[14px] font-semibold leading-normal">{t('title')}</h2>
      <div className="mb-3 grid grid-cols-2 gap-[10px] desktop:grid-cols-4 desktop:gap-[14px]">
        {tiles.map((tile) => (
          <div key={tile.key} className="card stat" data-computer-usage-tile={tile.key}>
            <div className="statlbl">{tile.label}</div>
            <div className="statval">{tile.value}</div>
            <div className="mt-1 font-sans text-[12px] font-medium leading-normal text-(--text-tertiary)">
              {tile.sub}
            </div>
          </div>
        ))}
      </div>
      {computers.length > 0 && (
        <div className="card overflow-hidden max-desktop:rounded-lg">
          <div className={`row h hidden desktop:grid ${GRID}`}>
            <span>{t('columns.computer')}</span>
            <span className="text-right">{t('columns.running')}</span>
            <span className="text-right">{t('columns.sleeping')}</span>
            <span className="text-right">{t('columns.storage')}</span>
            <span className="text-right">{t('columns.media')}</span>
          </div>
          {computers.map((c) => (
            <div
              key={c.computerId}
              className="row grid grid-cols-2 gap-y-1 desktop:grid-cols-[2fr_1fr_1fr_1fr_1fr]"
              data-computer-usage-row={c.computerId}
            >
              <span className="col-span-2 min-w-0 truncate font-sans text-[13px] font-medium leading-normal desktop:col-span-1">
                {c.name ?? t('removed')}
                {isAllocation(c.allocation) && (
                  <span className="ml-2 font-sans text-[11.5px] font-normal text-(--text-tertiary)">
                    {t(`allocation.${c.allocation}`)}
                  </span>
                )}
              </span>
              <span className="font-mono text-[12px] tabular-nums desktop:text-right">{hours(c.runningSeconds)}</span>
              <span className="text-right font-mono text-[12px] tabular-nums">{hours(c.sleepingSeconds)}</span>
              <span className="font-mono text-[12px] tabular-nums desktop:text-right">
                {gibHours(c.volumeGibSeconds)}
              </span>
              <span className="text-right font-mono text-[12px] tabular-nums">{gb(c.relayedBytes)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
