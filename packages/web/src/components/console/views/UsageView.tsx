'use client'

import useSWR from 'swr'
import { useRouter, useSearchParams } from 'next/navigation'
import { fetchUsage, fmtCost, fmtCountCompact as fmtCompact, type UsageRange } from '@/lib/api'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { AgentIconView, Spinner } from '@/components/marks'
import { useOrgs } from '@/lib/org-context'
import { useIsMobile } from '@/lib/use-is-mobile'
import { consoleKeys } from '@/lib/swr-keys'

const RANGES: { key: UsageRange; label: string }[] = [
  { key: 'd1', label: '24 hours' },
  { key: 'd7', label: '7 days' },
  { key: 'd30', label: '30 days' },
  { key: 'd90', label: '90 days' }
]

// The mobile segmented control shows only three ranges (the design has no 90-day
// segment) and uses a compact "24h" label for the first one.
const MOBILE_RANGES: { key: UsageRange; label: string }[] = [
  { key: 'd1', label: '24h' },
  { key: 'd7', label: '7 days' },
  { key: 'd30', label: '30 days' }
]

const GRID = 'grid-cols-[2fr_1fr_1fr_1fr_1.4fr]'
const USAGE_REFRESH_MS = 30_000

export default function UsageView() {
  const { orgPath, activeOrg, orgs, loading: orgLoading, error: orgError } = useOrgs()
  // Behavior-only mobile check (layout differences are CSS-gated below): the
  // mobile segmented control has no 90-day option (MOBILE_RANGES), so clamp a
  // deep-linked ?range=d90 to d30 there — otherwise the view fetches a range no
  // rendered segment represents.
  const isMobile = useIsMobile()
  const params = useSearchParams()
  const router = useRouter()
  const raw = params.get('range')
  const parsed: UsageRange = raw === 'd1' || raw === 'd7' || raw === 'd90' ? raw : 'd30'
  const range: UsageRange = isMobile && parsed === 'd90' ? 'd30' : parsed

  const { agents } = useConsoleData()
  const waitingForOrg = orgLoading || (!activeOrg && orgs.length > 0)
  const usageKey = consoleKeys.usage(waitingForOrg ? null : activeOrg?.id, range)
  const { data, error, isLoading } = useSWR(
    usageKey,
    ([, orgId, , requestedRange]) => fetchUsage(requestedRange, orgId),
    { refreshInterval: USAGE_REFRESH_MS }
  )
  const loading = waitingForOrg || isLoading
  const err = orgError ?? (error ? (error instanceof Error ? error.message : String(error)) : null)

  const selectRange = (k: UsageRange) => router.replace(orgPath(`/usage?range=${k}`))

  const rangeLabel = RANGES.find((r) => r.key === range)?.label ?? '30 days'
  const totalTokens = data?.totals.totalTokens ?? 0
  const totalSpend = data?.totals.costAmount ?? 0
  const totalSessions = data?.totals.sessions ?? 0
  // Currency reported for this workspace's sessions (null when none/mixed → the
  // formatter falls back to USD). Amounts are summed as-is, so a mixed-currency
  // workspace shows an unlabeled total — acceptable until per-currency rollups.
  const currency = data?.totals.costCurrency ?? undefined
  const avgLabel = totalSessions > 0 ? `${fmtCost(totalSpend / totalSessions, currency)} avg / session` : '—'

  // Join the CP aggregate (agentId + numbers) with the console's agent list for
  // the display name/model; fall back to a short id if the agent isn't loaded.
  // Two bar geometries from one map: `pct` is the desktop share (percent of the
  // range TOTAL, shown with a % label); `barPct` is the mobile bar, normalized
  // to the busiest agent (percent of MAX) so the leader always fills the track —
  // matching the design.
  const maxTok = Math.max(...(data?.agents ?? []).map((a) => a.totalTokens), 1)
  const rows = (data?.agents ?? []).map((a) => {
    const meta = agents.find((x) => x.id === a.agentId)
    return {
      agentId: a.agentId,
      name: meta ? agentLabel(meta) : a.agentId.length > 12 ? a.agentId.slice(0, 8) : a.agentId,
      icon: meta?.icon,
      model: meta?.model || meta?.runtime || '',
      runtime: meta?.runtime || meta?.model || '',
      sessions: a.sessions.toLocaleString('en-US'),
      tokens: fmtCompact(a.totalTokens),
      spend: fmtCost(a.costAmount, currency),
      pct: totalTokens > 0 ? Math.round((a.totalTokens / totalTokens) * 100) : 0,
      barPct: Math.round((a.totalTokens / maxTok) * 100)
    }
  })

  // Mobile (≤768px) renders only the scroll-body — the Shell provides the app
  // bar (title "Usage") + bottom nav, so the desktop page header is CSS-hidden
  // there rather than removed.
  return (
    <div className="wrap">
      {/* Desktop header: description + 4-range pillbar */}
      <div className="mb-4 hidden min-h-[34px] items-center gap-4 desktop:flex">
        <div className="flex-1">
          <p className="psub mt-0">Tokens and spend across agents. Metered by the daemon per session.</p>
        </div>
        <div className="pillbar">
          {RANGES.map((r) => (
            <button key={r.key} className={range === r.key ? 'pill on' : 'pill'} onClick={() => selectRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Mobile segmented range control (3 segments, no 90-day) */}
      <div className="mx-4 mt-3 grid h-11 grid-cols-3 gap-1 rounded-md border border-(--border-subtle) bg-(--gray-100) p-1 desktop:hidden">
        {MOBILE_RANGES.map((r) => {
          const on = range === r.key
          return (
            <button
              key={r.key}
              onClick={() => selectRange(r.key)}
              className={`cursor-pointer rounded-sm border-0 font-sans text-[14px] leading-normal ${
                on
                  ? 'bg-(--surface-card) font-semibold text-(--text-primary) shadow-(--shadow-xs)'
                  : 'font-medium text-(--text-secondary)'
              }`}
            >
              {r.label}
            </button>
          )
        })}
      </div>

      {/* Mobile compact 3-metric strip (Sessions / Tokens / Spend — no fabricated
          p95 latency, it's not in the UsageDto) */}
      <div className="mx-4 my-3 grid grid-cols-3 overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs) desktop:hidden">
        {[
          { label: 'Sessions', value: totalSessions.toLocaleString('en-US') },
          { label: 'Tokens', value: fmtCompact(totalTokens) },
          { label: 'Spend', value: fmtCost(totalSpend, currency) }
        ].map((m, i, arr) => (
          <div
            key={m.label}
            className={`flex min-h-13 flex-col justify-between px-[9px] py-[10px] ${
              i < arr.length - 1 ? 'border-r border-(--border-subtle)' : ''
            }`}
          >
            <div className="font-sans text-[10px] font-medium leading-[1.3] text-(--text-tertiary)">{m.label}</div>
            <div className="font-mono text-[16px] font-semibold leading-normal tracking-[-.02em] tabular-nums">
              {m.value}
            </div>
          </div>
        ))}
      </div>

      {/* Desktop stat cards */}
      <div className="mb-[18px] hidden gap-[14px] desktop:grid desktop:grid-cols-3">
        <div className="card stat">
          <div className="statlbl">Total tokens · {rangeLabel}</div>
          <div className="statval">{fmtCompact(totalTokens)}</div>
        </div>
        <div className="card stat">
          <div className="statlbl">Total spend · {rangeLabel}</div>
          <div className="statval">{fmtCost(totalSpend, currency)}</div>
        </div>
        <div className="card stat">
          <div className="statlbl">Sessions · {rangeLabel}</div>
          <div className="statval">{totalSessions.toLocaleString('en-US')}</div>
          <div className="mt-1 font-sans text-[12px] font-medium leading-normal text-(--text-tertiary)">{avgLabel}</div>
        </div>
      </div>

      {/* By-agent card. `card` supplies the desktop chrome; the mobile design is
          the same surface with a 12px radius, side margins and corner clipping
          (the utilities out-layer the `.card:has(.row)` overflow-x hack). */}
      <div className="card max-desktop:mx-4 max-desktop:overflow-hidden max-desktop:rounded-lg">
        {/* Mobile list header */}
        <div className="flex items-center justify-between border-b border-(--border-subtle) px-4 py-3 desktop:hidden">
          <span className="font-sans text-[14px] font-semibold leading-normal">By agent</span>
          <span className="font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">tokens share</span>
        </div>

        {/* Desktop table header */}
        <div className={`row h hidden desktop:grid ${GRID}`}>
          <span>Agent</span>
          <span className="text-right">Sessions</span>
          <span className="text-right">Tokens</span>
          <span className="text-right">Spend</span>
          <span />
        </div>

        {loading && !data && (
          <div className="flex justify-center py-10">
            <Spinner size={26} />
          </div>
        )}

        {!data && err && (
          <div className="px-4 py-7 text-[13px] text-(--text-tertiary) desktop:px-[18px] desktop:text-(--danger-text,var(--text-tertiary))">
            Couldn’t load usage: {err}
          </div>
        )}

        {data && rows.length === 0 && (
          <div className="px-4 py-7 text-[13px] text-(--text-tertiary) desktop:px-[18px]">
            No usage recorded in this range yet. Token usage appears here once agents run sessions.
          </div>
        )}

        {/* Mobile stacked rows: tappable (→ agent detail), max-normalized bar. */}
        {data &&
          rows.map((r, i) => (
            <button
              key={r.agentId}
              onClick={() => router.push(orgPath(`/agents/${r.agentId}`))}
              className={`flex w-full cursor-pointer flex-col gap-[7px] bg-(--surface-card) px-4 py-3 text-left desktop:hidden ${
                i === 0 ? '' : 'border-t border-(--border-subtle)'
              }`}
            >
              <span className="flex w-full items-center gap-[10px]">
                <span className="flex h-6 w-6 flex-none items-center justify-center overflow-hidden rounded-sm">
                  <AgentIconView icon={r.icon} runtime={r.runtime} size={24} />
                </span>
                <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                  {r.name}
                </span>
                <span className="font-mono text-[13px] font-semibold leading-normal text-(--text-primary) tabular-nums">
                  {r.spend}
                </span>
              </span>
              <span className="pl-[34px] font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
                {r.tokens} tok · {r.sessions} sessions
              </span>
              <span className="ml-[34px] block h-1 w-[calc(100%_-_34px)] overflow-hidden rounded-[2px] bg-(--surface-active)">
                <span className="block h-full rounded-[2px] bg-(--brand)" style={{ width: `${r.barPct}%` }} />
              </span>
            </button>
          ))}

        {/* Desktop table rows: inert, total-share bar + % label. No navigation —
            the mobile tap-through is deliberate mobile-only behavior. These must
            stay the card's LAST children so `.row:last-child` drops the final
            border, exactly as in the desktop-only tree. */}
        {data &&
          rows.map((r) => (
            <div key={r.agentId} className={`row hidden desktop:grid ${GRID}`}>
              <div className="flex items-center gap-[10px]">
                <span className="av h-7 w-7 rounded-[7px]">
                  <AgentIconView icon={r.icon} runtime={r.runtime} size={28} />
                </span>
                <span className="font-sans text-[13px] font-semibold leading-normal">{r.name}</span>
              </div>
              <span className="mono text-right text-[13px]">{r.sessions}</span>
              <span className="mono text-right text-[13px]">{r.tokens}</span>
              <span className="mono text-right text-[13px] font-semibold text-(--text-primary)">{r.spend}</span>
              <div className="flex items-center gap-[9px] pl-[18px]">
                <div className="h-[6px] flex-1 overflow-hidden rounded-[3px] bg-(--surface-active)">
                  <div className="h-full rounded-[3px] bg-(--brand)" style={{ width: `${r.pct}%` }} />
                </div>
                <span className="mono w-[34px] text-right text-[11px] text-(--text-tertiary)">{r.pct}%</span>
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}
