'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { SEG_FILL, bucketLabel, tickInterval } from '@/lib/spend-chart'
import { useRouter, useSearchParams } from 'next/navigation'
import { fetchUsage, fmtCost, fmtCountCompact as fmtCompact, type UsageRange } from '@/lib/api'
import { amountToNumber, sumAmounts } from '@/lib/amount'
import { agentLabel, modelLabel, runtimeLabel } from '@/lib/data'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { useConsoleData } from '@/lib/data-context'
import { AgentIconView, ModelMark, Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
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

/** Stands in for the residual row's icon. Deliberately not an agent avatar: the row is a
 *  sum over agents this viewer cannot name, and dressing it as one agent would say the
 *  opposite of what it means. */
const ResidualMark = () => (
  <span className="flex h-full w-full items-center justify-center bg-(--surface-active) text-(--text-tertiary)">
    <Icon name="eye-off" size={14} />
  </span>
)

// Metering-source filter, answered by the API's own `source` param: which authenticated
// ingress metered the session — the gateway collector (Cloud) or a daemon's EVT. The CP
// scopes the WHOLE aggregate to it, totals and rollups and the spend series alike, so this
// view does no filtering of its own and every figure on the page agrees by construction.
// Only offered where the pool exists (`daemon-pool` flag).
type SourceFilter = 'all' | 'gateway' | 'daemon'

// How the usage table is broken down. Runtime is derived from the per-agent
// aggregate; model comes from the server's per-session execution snapshots so
// changing an Agent's current default cannot rewrite historical usage.
type GroupBy = 'agent' | 'runtime' | 'model'
const GROUPS: { key: GroupBy; label: string }[] = [
  { key: 'agent', label: 'By agent' },
  { key: 'runtime', label: 'By runtime' },
  { key: 'model', label: 'By model' }
]

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

  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [groupBy, setGroupBy] = useState<GroupBy>('agent')
  // Chart-legend series filter. Keys are group-specific (agent ids vs model names),
  // so switching the rollup clears it rather than stranding a hidden key.
  const [hiddenKeys, setHiddenKeys] = useState<string[]>([])
  const selectGroup = (k: GroupBy) => {
    setGroupBy(k)
    setHiddenKeys([])
  }
  // The pool only exists behind the flag; without it every agent is daemon-placed
  // and the filter would be a control with one meaningful segment.
  const showSourceFilter = featureFlagEnabled('daemon-pool')
  const sourceOptions: { key: SourceFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    // Gateway-metered IS the hosted product: named as the placement picker names it —
    // the pool is the product on managed, the operator's own cluster elsewhere.
    { key: 'gateway', label: featureFlagEnabled('managed') ? 'Cloud' : 'Cluster' },
    { key: 'daemon', label: 'Daemons' }
  ]
  const selectSource = (k: SourceFilter) => {
    setSourceFilter(k)
    setHiddenKeys([])
  }

  const { agents } = useConsoleData()
  const waitingForOrg = orgLoading || (!activeOrg && orgs.length > 0)
  const usageKey = consoleKeys.usage(waitingForOrg ? null : activeOrg?.id, range, sourceFilter)
  const { data, error, isLoading } = useSWR(usageKey, ([, orgId, , requestedRange, requestedSource]) =>
    fetchUsage(requestedRange, orgId, requestedSource === 'all' ? undefined : requestedSource)
  )
  const loading = waitingForOrg || isLoading
  const err = orgError ?? (error ? (error instanceof Error ? error.message : String(error)) : null)

  const selectRange = (k: UsageRange) => router.replace(orgPath(`/usage?range=${k}`))

  const rangeLabel = RANGES.find((r) => r.key === range)?.label ?? '30 days'
  // Skeleton bar count = the range's real bucket count, so placeholder bar widths
  // match the incoming chart and swapping skeleton→data causes no layout shift.
  const skelBars = range === 'd1' ? 24 : range === 'd7' ? 7 : range === 'd90' ? 90 : 30
  // Join the CP aggregate (agentId + numbers) with the console's agent list for
  // the display name/runtime; fall back to a short id if the agent isn't loaded.
  const enriched = (data?.agents ?? []).map((a) => {
    const meta = agents.find((x) => x.id === a.agentId)
    return {
      agentId: a.agentId,
      name: meta ? agentLabel(meta) : a.agentId.length > 12 ? a.agentId.slice(0, 8) : a.agentId,
      icon: meta?.icon,
      runtime: meta?.runtime || meta?.model || '',
      totalTokens: a.totalTokens,
      sessions: a.sessions,
      costAmount: a.costAmount
    }
  })

  // The server totals are authoritative in every mode — the source filter is a request
  // parameter, so what came back IS the filtered aggregate and re-summing rows here could
  // only disagree with it.
  const totalTokens = data?.totals.totalTokens ?? 0
  const totalSessions = data?.totals.sessions ?? 0
  // Amounts arrive as exact decimal strings; a number appears only where the value is
  // being formatted or turned into pixels, never where two amounts are added.
  const totalSpend = amountToNumber(data?.totals.costAmount ?? '0')
  // Currency reported for this workspace's sessions (null when none/mixed → the
  // formatter falls back to USD). Amounts are summed as-is, so a mixed-currency
  // workspace shows an unlabeled total — acceptable until per-currency rollups.
  const currency = data?.totals.costCurrency ?? undefined
  const avgLabel = totalSessions > 0 ? `${fmtCost(totalSpend / totalSessions, currency)} avg / session` : '—'

  // Roll up to the selected grouping. Grouped rows omit `navId`, so only raw
  // Agent rows navigate. Model rows arrive pre-aggregated from session metadata.
  type Entry = {
    key: string
    kind: GroupBy
    /** The id-less rollup of what this viewer may not attribute. Not an agent: it never
     *  navigates, never carries an icon, and is pinned last however large it is. */
    residual?: true
    navId?: string
    name: string
    icon?: (typeof enriched)[number]['icon']
    runtime: string
    model: string
    totalTokens: number
    sessions: number
    costAmount: string
  }
  let entries: Entry[]
  if (groupBy === 'model') {
    entries = (data?.models ?? []).map((m) => ({
      key: `model:${m.model ?? ''}`,
      kind: 'model',
      name: modelLabel(m.model ?? ''),
      runtime: '',
      model: m.model ?? '',
      totalTokens: m.totalTokens,
      sessions: m.sessions,
      costAmount: m.costAmount
    }))
  } else if (groupBy === 'runtime') {
    const byRuntime = new Map<string, Entry>()
    for (const e of enriched) {
      const rt = e.runtime || 'unknown'
      const g = byRuntime.get(rt) ?? {
        key: `runtime:${rt}`,
        kind: 'runtime',
        name: runtimeLabel(rt),
        runtime: rt,
        model: '',
        totalTokens: 0,
        sessions: 0,
        costAmount: '0'
      }
      g.totalTokens += e.totalTokens
      g.sessions += e.sessions
      g.costAmount = sumAmounts([g.costAmount, e.costAmount])
      byRuntime.set(rt, g)
    }
    entries = [...byRuntime.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  } else {
    entries = enriched.map((e) => ({ ...e, key: e.agentId, kind: 'agent', navId: e.agentId, model: '' }))
  }
  // The totals are the ORG's; these rows are only what this viewer may attribute. Without
  // this line the table silently fails to add up to the card above it and the % column
  // silently fails to reach 100 — so the difference gets a row of its own, in every
  // grouping, appended after the sort so it reads as a footnote and not as the top agent.
  //
  // It is the server's own independently-summed figure, never `totals` minus these rows:
  // a subtraction here would absorb any bug in the rollup and still add up perfectly.
  if (data?.unattributed) {
    entries = [
      ...entries,
      {
        key: '\0unattributed',
        kind: groupBy,
        residual: true,
        name: 'Restricted agents',
        runtime: '',
        model: '',
        totalTokens: data.unattributed.totalTokens,
        sessions: data.unattributed.sessions,
        costAmount: data.unattributed.costAmount
      }
    ]
  }

  // Two bar geometries from one map: `pct` is the desktop share (percent of the
  // range TOTAL, shown with a % label); `barPct` is the mobile bar, normalized to
  // the busiest row (percent of MAX) so the leader always fills the track.
  const maxTok = Math.max(...entries.map((e) => e.totalTokens), 1)
  const rows = entries.map((e) => ({
    key: e.key,
    kind: e.kind,
    residual: e.residual,
    navId: e.navId,
    name: e.name,
    icon: e.icon,
    runtime: e.runtime,
    model: e.model,
    sessions: e.sessions.toLocaleString('en-US'),
    tokens: fmtCompact(e.totalTokens),
    spend: fmtCost(amountToNumber(e.costAmount), currency),
    pct: totalTokens > 0 ? Math.round((e.totalTokens / totalTokens) * 100) : 0,
    barPct: Math.round((e.totalTokens / maxTok) * 100)
  }))

  // Mobile (≤768px) renders only the scroll-body — the Shell provides the app
  // bar (title "Analytics") + bottom nav, so the desktop page header is CSS-hidden
  // there rather than removed.
  return (
    <div className="wrap">
      {/* Desktop header: description + 4-range pillbar */}
      <div className="mb-4 hidden min-h-[34px] items-center gap-4 desktop:flex">
        <div className="flex-1">
          <p className="psub mt-0">Tokens and spend across agents. Metered by the daemon per session.</p>
        </div>
        {showSourceFilter && (
          <div className="pillbar">
            {sourceOptions.map((s) => (
              <button
                key={s.key}
                className={sourceFilter === s.key ? 'pill on' : 'pill'}
                onClick={() => selectSource(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
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

      {/* Mobile source-filter segmented control (mirrors the desktop pillbar) */}
      {showSourceFilter && (
        <div className="mx-4 mt-2 grid h-11 grid-cols-3 gap-1 rounded-md border border-(--border-subtle) bg-(--gray-100) p-1 desktop:hidden">
          {sourceOptions.map((s) => {
            const on = sourceFilter === s.key
            return (
              <button
                key={s.key}
                onClick={() => selectSource(s.key)}
                className={`cursor-pointer rounded-sm border-0 font-sans text-[14px] leading-normal ${
                  on
                    ? 'bg-(--surface-card) font-semibold text-(--text-primary) shadow-(--shadow-xs)'
                    : 'font-medium text-(--text-secondary)'
                }`}
              >
                {s.label}
              </button>
            )
          })}
        </div>
      )}

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

      {/* Spend over time — recharts stacked bars. Hidden by graceful fallback if the
          CP predates `series`. */}

      {/* First-load skeleton: same card + 180px body footprint as the real chart so
          the swap to data causes no layout shift. Deterministic bar heights (no
          random → SSR-safe). */}
      {loading && !data && (
        <div className="card mb-[18px] max-desktop:mx-4 max-desktop:mb-3 max-desktop:rounded-lg">
          <div className="cardhead">
            <span className="cardtitle">Spend over time</span>
            <span className="ml-auto h-[11px] w-12 rounded-full bg-(--surface-active)" />
          </div>
          <div
            className="flex h-[212px] animate-pulse items-end px-[18px] pb-[22px] pt-9"
            style={{ gap: skelBars > 40 ? 2 : skelBars > 14 ? 4 : 10 }}
          >
            {Array.from({ length: skelBars }, (_, i) => (
              <div key={i} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
                <div
                  className="w-full max-w-[46px] rounded-t-[5px] bg-(--surface-active)"
                  style={{ height: `${28 + ((i * 23 + 13) % 60)}%` }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {data?.series &&
        (() => {
          const pts = data.series.points
          const unit = (currency ?? 'USD').toUpperCase()
          // Full IANA zone name (e.g. "Asia/Shanghai") — the buckets are aligned to
          // this zone, so tell the viewer. Client-only: the chart never renders on
          // the server (data is client-fetched), so no hydration mismatch.
          const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

          // Stacked breakdown, following the table's group-by. Buckets carry
          // byAgent/byModel from the CP; runtime rolls byAgent through the
          // console's agent list. Absent on an older CP → flat brand bars.
          const hasBreakdown = pts.some((p) => p.byAgent || p.byModel)
          const agentMeta = new Map(enriched.map((e) => [e.agentId, e]))
          // Bar heights are geometry, so each amount becomes a number here — the one
          // place in this view where a cost is allowed to be a float.
          const plot = (by: Record<string, string>): Record<string, number> =>
            Object.fromEntries(Object.entries(by).map(([k, v]) => [k, amountToNumber(v)]))
          const recs = pts.map((p) => {
            if (!hasBreakdown) return { '': amountToNumber(p.costAmount) }
            if (groupBy === 'model') return plot(p.byModel ?? {})
            if (groupBy === 'agent') return plot(p.byAgent ?? {})
            const rec: Record<string, number> = {}
            for (const [id, v] of Object.entries(plot(p.byAgent ?? {}))) {
              const rt = agentMeta.get(id)?.runtime || 'unknown'
              rec[rt] = (rec[rt] ?? 0) + v
            }
            return rec
          })
          // Fixed hue assignment: top-6 keys by range spend get --chart-1..6 in
          // order, the tail folds into a gray "Other" (hues are never cycled).
          const OTHER = '\0other'
          const totalsByKey = new Map<string, number>()
          for (const rec of recs)
            for (const [k, v] of Object.entries(rec)) totalsByKey.set(k, (totalsByKey.get(k) ?? 0) + v)
          const rankedKeys = [...totalsByKey.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
          const topKeys = rankedKeys.slice(0, 6)
          const stackKeys = rankedKeys.length > 6 ? [...topKeys, OTHER] : topKeys
          const keyName = (k: string) => {
            if (k === OTHER) return 'Other'
            if (!hasBreakdown) return ''
            if (groupBy === 'model') return modelLabel(k)
            if (groupBy === 'runtime') return runtimeLabel(k)
            const meta = agentMeta.get(k)
            return meta ? meta.name : k.length > 12 ? k.slice(0, 8) : k
          }
          const keyColor = (k: string) =>
            !hasBreakdown
              ? 'var(--brand)'
              : k === OTHER
                ? 'var(--chart-other)'
                : `var(--chart-${topKeys.indexOf(k) + 1})`
          // One recharts row per bucket. Series are `s<i>` (index into stackKeys) so a
          // model/agent id can never collide with `label`/`__total`. Negative deltas
          // (downward corrections) can't render as height — clamp to 0; `__total` in
          // the tooltip still reports the true net figure.
          const chartData = recs.map((rec, i) => {
            const row: Record<string, number | string> = {
              label: bucketLabel(pts[i]!.start, data.series!.bucket),
              __total: amountToNumber(pts[i]!.costAmount)
            }
            stackKeys.forEach((k, si) => {
              row[`s${si}`] =
                k === OTHER
                  ? Object.entries(rec).reduce((s, [kk, vv]) => (topKeys.includes(kk) ? s : s + Math.max(0, vv)), 0)
                  : Math.max(0, rec[k] ?? 0)
            })
            return row
          })

          // Legend-driven filter. A hidden key stays in `stackKeys` (its hue never
          // shifts onto another series) — the Bar is just `hide`den, so the stack and
          // the y-scale recompute from the visible series only.
          // Intersected with the current stackKeys — a key hidden under a prior
          // range/group-by can otherwise survive in `hiddenKeys` after that key
          // disappears from view, permanently flipping the tooltip into the
          // filtered-total branch with nothing left for the legend to un-hide.
          const hidden = new Set(hiddenKeys.filter((k) => stackKeys.includes(k)))
          const toggleKey = (k: string) =>
            setHiddenKeys((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))
          const visibleKeys = stackKeys.filter((k) => !hidden.has(k))

          // Legend content is our own markup (recharts' default swatches can't take a
          // `var()` color) rendered inside recharts' <Legend> slot, so the plot area
          // reserves room for it instead of the card doing its own layout.
          const LegendKeys = () => (
            <div className="flex flex-wrap gap-x-3 gap-y-1 px-[8px]">
              {stackKeys.map((k) => {
                const off = hidden.has(k)
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggleKey(k)}
                    aria-pressed={!off}
                    title={off ? `Show ${keyName(k)}` : `Hide ${keyName(k)}`}
                    className={`flex cursor-pointer items-center gap-[5px] border-0 bg-transparent p-0 font-sans text-[11px] leading-normal ${
                      off ? 'text-(--text-disabled)' : 'text-(--text-secondary)'
                    }`}
                  >
                    <span
                      className="h-[9px] w-[9px] flex-none rounded-[3px]"
                      style={{ backgroundColor: off ? 'var(--surface-active)' : keyColor(k) }}
                    />
                    {keyName(k)}
                  </button>
                )
              })}
            </div>
          )

          type TipSeg = { dataKey: string; name: string; value: number; payload: Record<string, number> }
          const Tip = ({ active, payload, label }: { active?: boolean; payload?: TipSeg[]; label?: string }) => {
            if (!active || !payload?.length) return null
            const segs = [...payload].reverse().filter((s) => s.value > 0)
            // With nothing hidden, report the bucket's true net cost (`__total` keeps the
            // negative corrections the clamped segments drop); legend-hidden, report what's shown.
            const total = hidden.size
              ? payload.reduce((s, x) => s + (x.value || 0), 0)
              : (payload[0]!.payload.__total ?? 0)
            return (
              <div className="rounded-md border border-(--border-subtle) bg-(--surface-card) px-2.5 py-2 shadow-(--shadow-md)">
                <div className="mono text-[11px] font-semibold text-(--text-primary)">
                  {label} · {fmtCost(total, currency)}
                </div>
                {hasBreakdown &&
                  segs.map((s) => (
                    <div
                      key={s.dataKey}
                      className="mt-1 flex items-center gap-[6px] font-sans text-[11px] leading-normal text-(--text-secondary)"
                    >
                      <span
                        className="h-[8px] w-[8px] flex-none rounded-[2px]"
                        style={{ backgroundColor: keyColor(stackKeys[Number(s.dataKey.slice(1))]!) }}
                      />
                      {s.name}: <span className="mono text-(--text-primary)">{fmtCost(s.value, currency)}</span>
                    </div>
                  ))}
              </div>
            )
          }
          return (
            <div className="card mb-[18px] max-desktop:mx-4 max-desktop:mb-3 max-desktop:rounded-lg">
              <div className="cardhead">
                <span className="cardtitle">Spend over time</span>
                <span className="mono text-[11px] text-(--text-tertiary)">{tzName}</span>
                {/* The series is scoped to the agents this viewer may attribute, so it does
                    not reach the org total in the card above. Said out loud, and only when
                    the two actually differ — a note explaining a difference that isn't
                    there is its own kind of wrong. The repo's own precedent for two honest
                    figures side by side: neither is a bug, so name which is which. */}
                {data.unattributed && (
                  <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                    · visible agents only
                  </span>
                )}
                <span className="mono ml-auto text-[11px] text-(--text-tertiary)">
                  {unit} / {data.series.bucket}
                </span>
              </div>
              {/* stackKeys order is bottom-up (largest series on the baseline), which is
                  also recharts' render order, so `seg-<i>` lines up with SEG_FILL. */}
              <div className={`h-[212px] px-[10px] pb-[6px] pt-3 text-(--text-tertiary) ${SEG_FILL}`}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 0, right: 8, bottom: 0, left: 8 }} barCategoryGap="18%">
                    <XAxis
                      dataKey="label"
                      interval={tickInterval(pts.length)}
                      tickLine={false}
                      axisLine={false}
                      tickMargin={6}
                      tick={{ fill: 'currentColor', fontSize: 10.5 }}
                      className="mono"
                    />
                    <Tooltip content={<Tip />} cursor={{ fill: 'var(--surface-hover)' }} />
                    {/* Legend shows even for a single key — the card title doesn't name
                        the series. Click a key to filter it out of the stack. */}
                    {/* No fixed `height` — recharts measures the rendered legend box
                        (which wraps to 2+ rows for 7 keys at mobile widths) and
                        reduces the plot by that real height instead of a guess. */}
                    {hasBreakdown && stackKeys.length > 0 && (
                      <Legend verticalAlign="top" align="left" content={<LegendKeys />} />
                    )}
                    {stackKeys.map((k, i) => (
                      <Bar
                        key={k}
                        dataKey={`s${i}`}
                        name={keyName(k)}
                        stackId="spend"
                        className={hasBreakdown ? `seg-${i}` : 'seg-flat'}
                        maxBarSize={46}
                        hide={hidden.has(k)}
                        // Round only the top of the visible stack.
                        radius={k === visibleKeys[visibleKeys.length - 1] ? [5, 5, 0, 0] : undefined}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )
        })()}

      {/* Usage-breakdown card. `card` supplies the desktop chrome; the mobile design is
          the same surface with a 12px radius, side margins and corner clipping
          (the utilities out-layer the `.card:has(.row)` overflow-x hack). */}
      <div className="card max-desktop:mx-4 max-desktop:overflow-hidden max-desktop:rounded-lg">
        {/* Group-by toolbar (both form factors): switch the rollup dimension. */}
        <div className="flex items-center gap-3 border-b border-(--border-subtle) px-4 py-3 desktop:px-[18px] desktop:py-[10px]">
          <div className="pillbar">
            {GROUPS.map((g) => (
              <button key={g.key} className={groupBy === g.key ? 'pill on' : 'pill'} onClick={() => selectGroup(g.key)}>
                {g.label}
              </button>
            ))}
          </div>
        </div>

        {/* Desktop table header */}
        <div className={`row h hidden desktop:grid ${GRID}`}>
          <span>{groupBy === 'agent' ? 'Agent' : groupBy === 'runtime' ? 'Runtime' : 'Model'}</span>
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
          <div className="px-4 py-7 text-[13px] text-(--status-error) desktop:px-[18px]">
            Couldn’t load usage: {err}
          </div>
        )}

        {data && rows.length === 0 && (
          <div className="px-4 py-7 text-[13px] text-(--text-tertiary) desktop:px-[18px]">
            No usage recorded in this range yet. Token usage appears here once agents run sessions.
          </div>
        )}

        {/* Mobile stacked rows: max-normalized bar. Per-agent rows tap through to
            the agent detail; grouped rows are inert (no navId). */}
        {data &&
          rows.map((r, i) => (
            <button
              key={r.key}
              onClick={r.navId ? () => router.push(orgPath(`/agents/${r.navId}`)) : undefined}
              className={`flex w-full flex-col gap-[7px] bg-(--surface-card) px-4 py-3 text-left desktop:hidden ${
                r.navId ? 'cursor-pointer' : 'cursor-default'
              } ${i === 0 ? '' : 'border-t border-(--border-subtle)'}`}
            >
              <span className="flex w-full items-center gap-[10px]">
                <span className="flex h-6 w-6 flex-none items-center justify-center overflow-hidden rounded-sm">
                  {r.residual ? (
                    <ResidualMark />
                  ) : r.kind === 'model' ? (
                    <ModelMark model={r.model} fallbackRuntime={r.runtime} />
                  ) : (
                    <AgentIconView icon={r.icon} runtime={r.runtime} size={24} />
                  )}
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
            <div key={r.key} className={`row hidden desktop:grid ${GRID}`}>
              <div className="flex items-center gap-[10px]">
                <span className="av h-7 w-7 rounded-[7px]">
                  {r.residual ? (
                    <ResidualMark />
                  ) : r.kind === 'model' ? (
                    <ModelMark model={r.model} fallbackRuntime={r.runtime} />
                  ) : (
                    <AgentIconView icon={r.icon} runtime={r.runtime} size={28} />
                  )}
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
