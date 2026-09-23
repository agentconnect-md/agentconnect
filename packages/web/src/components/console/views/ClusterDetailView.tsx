'use client'

// The pool's own detail page, in both of its readings (design: the Cloud / cluster detail
// screen, `cd.isCloud` and `cd.isCluster`).
//
// A pool member is a Pod: no member id survives a rollout, so opening the Infra entry must
// not land on one machine's page and call it the pool. Everything here aggregates the
// serving members.
//
// Which reading applies is not cosmetic — it is whose infrastructure this IS:
//
//   managed   → AgentConnect Cloud, a product the org buys. Node count, host names,
//               versions and CPU are the operator's business, not the reader's, so the page
//               shows what the org can act on: what runs there, what it can run, what it
//               holds, and what it costs.
//   self-host → the operator's OWN cluster. Now the topology IS theirs, so capacity and
//               utilization are the numbers worth quoting and nothing is billed here.
//
// The design's mint/rotate-token action and its log tail are deliberately absent in both:
// the console mints no pool credentials, and inventing a log stream would be
// indistinguishable from real telemetry (same call the daemon detail page made).

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { isPoolPlacementKind, poolFleetStatus, poolLabel, status, type DaemonRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { consoleKeys } from '@/lib/swr-keys'
import { fetchUsage, probePoolRuntimes } from '@/lib/api'
import { amountToNumber, sumAmounts } from '@/lib/amount'
import { SEG_FILL, bucketLabel, tickInterval } from '@/lib/spend-chart'
import {
  fetchBillingAccount,
  fetchBillingTransactionsSince,
  fmtDecimalUsd,
  fmtMicroUsd,
  type BillingCredit
} from '@/lib/billing-api'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { NotFound } from '@/components/console/NotFound'
import {
  FleetAgentsCard,
  FleetRuntimesCard,
  FleetStat,
  FleetStatColumn,
  FleetUsageCard,
  ResourceDial,
  ResourceDials,
  unionRuntimes
} from '@/components/console/FleetDetail'
import { KubernetesMark, LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'

/** The daemon feature that says a member takes probe requests (protocol `RUNTIME_PROBE_FEATURE`). */
const RUNTIME_PROBE_FEATURE = 'runtime-probe-v1'
/** A probe takes minutes, so the capability read is re-pulled on this cadence for that long. */
const PROBE_POLL_MS = 20_000
const PROBE_WATCH_MS = 5 * 60_000

/** Ask the pool to re-probe its runtime image, then re-read capabilities while that probe runs. */
function RuntimeProbeButton() {
  const t = useTranslations('Daemons.clusterDetail')
  const { refreshDaemons } = useConsoleData()
  const [state, setState] = useState<'idle' | 'sending' | 'probing' | 'failed'>('idle')
  useEffect(() => {
    if (state !== 'probing') return
    const poll = setInterval(() => void refreshDaemons(), PROBE_POLL_MS)
    const done = setTimeout(() => setState('idle'), PROBE_WATCH_MS)
    return () => {
      clearInterval(poll)
      clearTimeout(done)
    }
  }, [state, refreshDaemons])
  const start = async () => {
    setState('sending')
    try {
      setState((await probePoolRuntimes()).state === 'probing' ? 'probing' : 'failed')
    } catch {
      setState('failed')
    }
  }
  const busy = state === 'sending' || state === 'probing'
  return (
    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void start()}>
      {busy ? t('refreshingRuntimes') : state === 'failed' ? t('refreshRuntimesFailed') : t('refreshRuntimes')}
    </Button>
  )
}

export default function ClusterDetailView() {
  const t = useTranslations('Daemons.clusterDetail')
  const { orgPath, myRole } = useOrgs()
  const router = useRouter()
  const { daemons, agents, orgSetIds, daemonsLoading } = useConsoleData()

  const showPool = featureFlagEnabled('daemon-pool')
  // Whose infrastructure the pool IS decides how the page reads — see the file header.
  const managed = featureFlagEnabled('managed')
  // Cloud's one honest action and its one honest figure both live on the Billing page, so
  // neither is offered where this deployment does not have one.
  const billingOffered = managed && featureFlagEnabled('billing')
  const members = useMemo(() => (showPool ? daemons.filter((d) => d.pool) : []), [daemons, showPool])
  const serving = useMemo(() => members.filter((m) => m.status === 'online'), [members])
  // Pool agents carry the POOL sentinel, never a member id: the Pod holding the duty is
  // ephemeral, so `agentFromDto` maps a set placement to `daemon: POOL_PLACEMENT`. Matching
  // member ids here would report an empty pool however many agents run on it.
  const hosted = useMemo(
    () => agents.filter((a) => isPoolPlacementKind(a.placementKind, a.setId, orgSetIds)),
    [agents, orgSetIds]
  )

  // A member that stopped answering can no longer serve a runtime, so the union is over the
  // serving members only.
  const runtimes = useMemo(() => unionRuntimes(serving), [serving])

  if (members.length === 0) {
    if (daemonsLoading)
      return (
        <div className="wrap max-w-[1240px]">
          <LoadingState fill />
        </div>
      )
    return (
      <div className="wrap max-w-[1240px]">
        <NotFound
          icon="server-off"
          kind={managed ? 'CLOUD' : 'CLUSTER'}
          title={managed ? t('cloudUnavailable') : t('noCluster')}
          pre={managed ? t('cloudEmpty') : t('clusterEmpty')}
          actionLabel={t('backToDaemons')}
          actionHref={orgPath('/daemons')}
          searchLabel={t('searchDaemons')}
        />
      </div>
    )
  }

  const s = status(poolFleetStatus(members))
  const online = serving.length > 0

  // `maxAgents <= 0` is the daemon's UNBOUNDED sentinel, not a ceiling of zero — a cluster
  // holding one has no finite budget, so it reads ∞ rather than a total that says "full".
  const caps = serving.map((m) => Number(m.conns))
  const unbounded = caps.some((c) => !Number.isFinite(c) || c <= 0)
  const capacity = unbounded ? 0 : caps.reduce((sum, c) => sum + c, 0)
  const used = serving.reduce((sum, m) => sum + m.loadAgents, 0)
  // An idle cluster has no ceiling to quote — the members that reported one are gone, so the
  // figure drops its denominator rather than reading "0 / 0", which says full.
  const capacityLabel = `${used} / ${unbounded ? '∞' : capacity}`
  const avg = (pick: (m: DaemonRow) => number) =>
    serving.length > 0 ? Math.round(serving.reduce((sum, m) => sum + pick(m), 0) / serving.length) : 0
  const cpu = avg((m) => m.cpu)
  const mem = avg((m) => m.mem)
  const sessions = serving.reduce((sum, m) => sum + Number(m.activeSessions ?? 0), 0)
  // The serving members roll together, so they share a release; an idle pool has no
  // version worth quoting rather than one belonging to a Pod that is gone.
  const version = online ? serving[0]!.version : '—'
  // One serving member stands in for the set when reading what it can run — the same
  // substitution Add-agent and Edit-agent make (edit-agent-daemon-choice.ts).
  const capabilitySource = serving[0]
  // Cloud refreshes on its own schedule; a self-hosted pool whose members take requests offers it to owners.
  const probeOffered =
    !managed && myRole === 'owner' && serving.some((m) => m.caps.features.includes(RUNTIME_PROBE_FEATURE))
  const models = runtimes.reduce((sum, rt) => sum + rt.models.length, 0)

  // Cloud's tiles. They stack in a column beside the Credits card, and spread three-up where a
  // deployment offers no billing and there is no card to stand beside.
  const cloudTiles = (
    <>
      <FleetStat icon="bot" label={t('agents')} value={String(hosted.length)} />
      <FleetStat icon="activity" label={t('activeSessions')} value={String(sessions)} />
      <FleetStat
        icon="cpu"
        label={t('runtimesAvailable')}
        value={String(runtimes.length)}
        note={`${models} model${models === 1 ? '' : 's'}`}
      />
    </>
  )

  return (
    <div className="wrap max-w-[1240px] px-4 pt-[14px] pb-1 desktop:p-0">
      {/* header — no credential action in either reading: pool credentials are minted where
          the pool runs, never here, so there is nothing for this page to offer. Cloud does
          get the one action it can honestly own, which is where its usage is paid for. */}
      <div className="mb-5 flex items-start gap-4">
        <span
          className={`relative flex h-13 w-13 flex-none items-center justify-center rounded-lg ${
            managed ? 'bg-(--brand-soft)' : 'border border-(--border-subtle) bg-(--surface-sunken)'
          }`}
        >
          {managed ? (
            <Icon name="cloud" size={26} color={online ? 'var(--brand)' : 'var(--text-tertiary)'} />
          ) : (
            <span className="flex h-[26px] w-[26px]">
              <KubernetesMark />
            </span>
          )}
          <span
            className="dot absolute -right-1 -bottom-1 h-[14px] w-[14px] border-[2.5px] border-(--surface-app)"
            style={{ background: s.dot }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-[10px]">
            <h1 className="ptitle">{poolLabel()}</h1>
            <span className="badge" style={{ background: s.bg, color: s.text }}>
              <span className="dot h-[6px] w-[6px]" style={{ background: s.dot }} />
              {s.label}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            {managed ? (
              <MetaItem icon="cloud" text={t('managedBy')} />
            ) : (
              <>
                <MetaItem
                  icon="server"
                  text={online ? t('nodesServing', { count: serving.length }) : t('noNodesServing')}
                />
                <MetaItem icon="tag" mono text={version} />
              </>
            )}
          </div>
        </div>
        {probeOffered && <RuntimeProbeButton />}
        {billingOffered && (
          <Button variant="secondary" size="sm" onClick={() => router.push(orgPath('/billing'))}>
            {t('manageBilling')}
          </Button>
        )}
      </div>

      {/* Band one. Cloud quotes what its usage COSTS; a cluster is the operator's own machines,
          so it reads like one — what it can hold, then what has run on it. Neither borrows the
          other's figure: a plan's included usage cannot be derived from load telemetry, and a
          self-hoster is billed nothing here. */}
      {managed ? (
        <div
          className={`mb-[18px] grid grid-cols-1 gap-[14px] ${billingOffered ? 'desktop:grid-cols-[300px_1fr]' : ''}`}
        >
          {billingOffered ? (
            <FleetStatColumn>{cloudTiles}</FleetStatColumn>
          ) : (
            <div className="grid grid-cols-2 gap-[14px] desktop:grid-cols-3">{cloudTiles}</div>
          )}
          {billingOffered && <CloudCreditsCard />}
        </div>
      ) : (
        <div className="mb-[18px] grid grid-cols-1 gap-[14px] desktop:grid-cols-[280px_120px_1fr]">
          <FleetStatColumn>
            {/* The heartbeat count against the ceiling, never the placed-agent list: a set
                placement names the set rather than the member serving it, so the two are not
                on one axis. This is the pair the CP's placement check compares. */}
            <FleetStat
              icon="bot"
              label={t('agents')}
              value={online ? capacityLabel : String(used)}
              note={online ? t('running') : undefined}
            />
            <FleetStat icon="activity" label={t('activeSessions')} value={String(sessions)} />
            <FleetStat
              icon="server"
              label={t('nodes')}
              value={`${serving.length} / ${members.length}`}
              note={t('serving')}
            />
          </FleetStatColumn>
          <ClusterResourcesCard {...{ online, cpu, mem }} />
          {/* The agents placed here, exactly as the daemon page reads it. A metering ingress
              cannot stand in for a fleet: a daemon reports its own usage by default, pool
              members included, so `gateway` is empty on an ordinary cluster and `daemon` sweeps
              in every other machine the org connected. */}
          <FleetUsageCard agentIds={hosted.map((a) => a.id)} note={t('agentsPlaced')} />
        </div>
      )}

      {/* Band two — what the set can run, and what runs on it. */}
      <FleetRuntimesCard
        title={t('runtimes')}
        runtimes={runtimes}
        agents={hosted}
        empty={managed ? t('noCloudRuntimes') : t('noClusterRuntimes')}
      />

      <FleetAgentsCard
        title={managed ? t('agentsOnCloud') : t('agentsOnCluster')}
        agents={hosted}
        capabilitySource={capabilitySource}
        onOpen={(id) => router.push(orgPath(`/agents/${id}`))}
        emptyTitle={t('noAgentsHere')}
        emptyHint={t('placeAgent', { pool: poolLabel() })}
      />

      {managed && (
        <p className="mt-[14px] max-w-[780px] font-sans text-[12px] font-normal leading-[1.6] text-(--text-tertiary) text-pretty">
          {t('cloudBilled')}
        </p>
      )}
    </div>
  )
}

function MetaItem({ icon, text, mono = false }: { icon: string; text: string; mono?: boolean }) {
  return (
    <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
      <Icon name={icon} size={14} color="var(--text-tertiary)" />
      {mono ? <span className="mono text-[12px]">{text}</span> : text}
    </span>
  )
}

// Every figure here is live, and the two halves of "credits" come from two services because
// that is where they live: the balance and the top-ups are the billing service's ledger, the
// daily spend is the CP's usage rollup.
//
// The spend is NOT read off the billing debits, and scope is the whole reason. A debit's
// `period` is `YYYY-MM`, so it is a monthly aggregate of the org's ENTIRE usage — quoting it
// here would contradict this page's own footnote about agents on daemons you connected
// yourself. `fetchUsage('d30', …, 'gateway')` buckets cost per day already scoped to the
// gateway collector — the ingress the hosted pool meters through, and the same figure the
// billing service bills — so the series total IS the Cloud figure and this card sums nothing.
//
// Scoping by metering source rather than by current placement is also what makes the number
// historically true: placement is CURRENT-state, so filtering the per-agent split by it made
// an agent moved onto the pool bring along 30 days of spend it incurred on a self-connected
// daemon, and one moved off drop its real Cloud spend.
const CREDITS_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
// Two series, one shared axis: both are USD, and a second axis scaled to make a $0.40 day
// look like a $50 top-up would be the misleading chart. SVG `fill` can't take a `var()`
// attribute, so the hues are descendant rules on the wrapper — the trick `SEG_FILL` uses.
const SERIES_FILL = '[&_.bar-spend_path]:fill-(--brand) [&_.bar-topup_path]:fill-(--green-500)'
// Only the credit side of the window: this card charts top-ups against the CP's own usage
// series, so the ledger's debit rows would double-count what `usage` already carries.
const fetchTopUps = async (orgId: string, sinceMs: number): Promise<BillingCredit[]> =>
  (await fetchBillingTransactionsSince(orgId, sinceMs)).filter((t): t is BillingCredit => t.type === 'credit')

function CloudCreditsCard() {
  const t = useTranslations('Daemons.clusterDetail')
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id ?? null
  // Same `billingAccount` key the Billing page reads, so the two pages cannot disagree.
  const account = useSWR(consoleKeys.billingAccount(orgId), () => fetchBillingAccount(orgId!))
  // `source=gateway` is the scope, as a request parameter: the CP answers with the
  // gateway-metered aggregate only, so nothing here filters or re-sums it.
  const usage = useSWR(consoleKeys.usage(orgId, 'd30', 'gateway'), () => fetchUsage('d30', orgId!, 'gateway'))
  const topUps = useSWR(consoleKeys.billingTopUps(orgId), () =>
    fetchTopUps(orgId!, Date.now() - CREDITS_WINDOW_DAYS * DAY_MS)
  )

  const points = usage.data?.series?.points ?? []
  const daily = points.map((p) => p.costAmount)
  const spent = sumAmounts(daily)
  const spendLoading = usage.isLoading
  // An error is the figure's state only while there is nothing to show: SWR keeps `data` across
  // a failed revalidation, and flipping the header to "unavailable" beside a chart still drawn
  // from that same retained series would have the card disagree with itself.
  const spendError = usage.error && !usage.data ? (usage.error as Error).message : undefined

  const credits = topUps.data ?? []
  // The NET of the credit side — a negative adjustment subtracts, which is what the balance
  // does with it too.
  const toppedUpMicro = credits.reduce((sum, c) => sum + c.amountMicro, 0)
  // The note counts what the word means and the chart marks — the positive rows. A negative
  // adjustment stays in the net value above but is not a "top-up" and draws no bar.
  const topUpCount = credits.filter((c) => c.amountMicro > 0).length
  // A top-up lands on the bucket it posted into: the last one that started at or before it.
  // Negative credits stay out of the chart: stacked on a positive spend base, a negative
  // segment draws DOWNWARD over the brand bar — they are in the net total above instead.
  const topUpByDay = new Map<number, number>()
  for (const c of credits) {
    if (c.amountMicro <= 0) continue
    const at = Date.parse(c.at)
    for (let i = points.length - 1; i >= 0; i--) {
      if (Date.parse(points[i]!.start) <= at) {
        topUpByDay.set(i, (topUpByDay.get(i) ?? 0) + c.amountMicro)
        break
      }
    }
  }

  // One recharts row per bucket. `spend` is geometry, so the amount becomes a number here and
  // nowhere else; the exact string is what `spent` above was summed from.
  const bucket = usage.data?.series?.bucket ?? 'day'
  const chartData = daily.map((amount, day) => ({
    label: bucketLabel(points[day]!.start, bucket),
    spend: amountToNumber(amount),
    topUp: (topUpByDay.get(day) ?? 0) / 1_000_000
  }))

  // Pixel floor for a nonzero segment, so a cent beside a $50 top-up is still visible — and 0
  // for a segment with nothing, so it draws nothing. The callback reads the row's own field:
  // in a stack, recharts hands it the segment's cumulative TOP, so a zero top-up capping a
  // nonzero spend would otherwise inherit the spend's "nonzero" and get floored into a green
  // cap on a day nothing was topped up.
  const minBar = (key: 'spend' | 'topUp') => (_: number | null | undefined, index: number) =>
    (chartData[index]?.[key] ?? 0) > 0 ? 3 : 0

  type TipRow = { payload: (typeof chartData)[number] }
  const Tip = ({ active, payload }: { active?: boolean; payload?: TipRow[] }) => {
    const row = active ? payload?.[0]?.payload : undefined
    if (!row) return null
    return (
      <div className="rounded-md border border-(--border-subtle) bg-(--surface-card) px-2.5 py-2 shadow-(--shadow-md)">
        <div className="mono text-[11px] font-semibold text-(--text-primary)">{row.label}</div>
        <div className="mt-1 flex items-center gap-[6px] font-sans text-[11px] leading-normal text-(--text-secondary)">
          <span className="h-[9px] w-[9px] flex-none rounded-[2px] bg-(--brand)" />
          {t('spent')}{' '}
          <span className="mono text-(--text-primary)">{fmtMicroUsd(Math.round(row.spend * 1_000_000))}</span>
        </div>
        {row.topUp > 0 && (
          <div className="mt-1 flex items-center gap-[6px] font-sans text-[11px] leading-normal text-(--text-secondary)">
            <span className="h-[9px] w-[9px] flex-none rounded-[2px] bg-(--green-500)" />
            {t('toppedUp')}{' '}
            <span className="mono text-(--text-primary)">{fmtMicroUsd(Math.round(row.topUp * 1_000_000))}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    // `min-w-0`: recharts measures this box, and a grid item's auto min-width would otherwise
    // let the plot widen its own column.
    <div className="card flex min-w-0 flex-col">
      <div className="cardhead">
        <span className="cardtitle">{t('credits')}</span>
        <span className="mono ml-auto text-[11px] text-(--text-tertiary)">
          {t('lastDays', { count: CREDITS_WINDOW_DAYS })}
        </span>
      </div>

      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 pt-[15px] pb-[13px] desktop:gap-x-5">
        <Figure
          label={t('toppedUpWindow', { days: CREDITS_WINDOW_DAYS })}
          value={topUps.data ? fmtMicroUsd(toppedUpMicro) : '—'}
          note={topUps.data ? `${topUpCount} top-up${topUpCount === 1 ? '' : 's'}` : ' '}
          error={topUps.error && !topUps.data ? (topUps.error as Error).message : undefined}
          loading={topUps.isLoading}
        />
        <span className="w-px flex-none self-stretch bg-(--border-subtle)" />
        <Figure
          label={t('spentWindow', { days: CREDITS_WINDOW_DAYS })}
          value={usage.data ? fmtDecimalUsd(spent) : '—'}
          // Divided by the labelled window, not `daily.length`: the CP floors the window's
          // start to a local day boundary, so a 30-day span is 31 buckets whenever "now" is
          // not midnight, and the edge two are partial days.
          note={
            usage.data
              ? t('averagePerDay', {
                  amount: fmtMicroUsd(Math.round((amountToNumber(spent) / CREDITS_WINDOW_DAYS) * 1_000_000))
                })
              : ' '
          }
          error={spendError}
          valueClass="text-[20px] text-(--brand) desktop:text-[24px]"
          loading={spendLoading}
        />
        <Figure
          className="ml-auto flex-none text-right"
          label={t('balance')}
          value={account.data ? fmtMicroUsd(account.data.balanceMicro) : '—'}
          // Not only unreachability: `assertAccount` throws BillingShapeError on an unexpected
          // shape and lands here too — likely, since this console deploys ahead of the pinned
          // billing image. So the label stays neutral and the service's own message says which.
          error={account.error && !account.data ? (account.error as Error).message : undefined}
          valueClass="text-[18px]"
          loading={account.isLoading}
          note="USD"
        />
      </div>

      {/* Two series on one shared axis, STACKED rather than grouped: a grouped pair reserves
          half of every day's band for a top-up, on all 30 days, and top-ups happen on three of
          them — so both bars end up half-width for nothing. Stacked, a day is one full-width
          bar, which is the design's proportion, and a day with no top-up is simply all spend.
          One axis on purpose: both are USD, and a second axis scaled so a $0.40 day matched a
          $50 top-up would be the misleading chart. `minPointSize` keeps the small side
          readable — a pixel floor under any nonzero value, and 0 for a day with none, so an
          idle day still draws nothing. */}
      {(spendLoading || chartData.length > 0) && (
        <>
          {spendLoading ? (
            <SpendSkeleton />
          ) : (
            <div className={`min-h-[140px] flex-1 px-[6px] pb-[6px] text-(--text-tertiary) ${SEG_FILL} ${SERIES_FILL}`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 8 }} barCategoryGap="12%">
                  <XAxis
                    dataKey="label"
                    interval={tickInterval(chartData.length)}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={6}
                    tick={{ fill: 'currentColor', fontSize: 10.5 }}
                    className="mono"
                  />
                  <Tooltip content={<Tip />} cursor={{ fill: 'var(--surface-hover)' }} />
                  {/* Spend on the baseline, the top-up capping it — and the radius on both, so
                      whichever segment ends up on top of a given day is the rounded one. */}
                  <Bar
                    dataKey="spend"
                    name="daily spend"
                    className="bar-spend"
                    stackId="day"
                    radius={[3, 3, 0, 0]}
                    minPointSize={minBar('spend')}
                  />
                  <Bar
                    dataKey="topUp"
                    name="top-up"
                    className="bar-topup"
                    stackId="day"
                    radius={[3, 3, 0, 0]}
                    minPointSize={minBar('topUp')}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="flex items-center justify-center gap-3 px-4 pb-[13px]">
            <span className="inline-flex items-center gap-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              <span className="h-[9px] w-[9px] rounded-[2px] bg-(--brand)" />
              {t('dailySpend')}
            </span>
            <span className="inline-flex items-center gap-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              <span className="h-[9px] w-[9px] rounded-[2px] bg-(--green-500)" />
              {t('topUp')}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

/** First-load stand-in for the chart: the same 140px body, so data landing shifts nothing.
 *  Heights are a fixed pattern, never random — a random walk redraws on every render. */
function SpendSkeleton() {
  return (
    <div className="flex min-h-[140px] flex-1 animate-pulse items-end gap-[3px] px-[14px] pt-3 pb-[26px]">
      {Array.from({ length: CREDITS_WINDOW_DAYS }, (_, i) => (
        <span
          key={i}
          className="min-w-0 max-w-[22px] flex-1 rounded-t-[3px] bg-(--surface-active)"
          style={{ height: `${24 + ((i * 23 + 13) % 60)}%` }}
        />
      ))}
    </div>
  )
}

/** One figure in the Credits header. Each has its own source, so each fails on its own: a
 *  dash where a request failed would read as zero, which is a number the org could act on. */
function Figure({
  label,
  value,
  note,
  error,
  loading = false,
  valueClass = 'text-[20px] desktop:text-[24px]',
  className = ''
}: {
  label: string
  value: string
  note?: string
  error?: string
  loading?: boolean
  valueClass?: string
  className?: string
}) {
  const t = useTranslations('Daemons.clusterDetail')
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="eyebrow">{label}</div>
      {loading ? (
        <>
          <span className="mt-[6px] inline-block h-[22px] w-24 animate-pulse rounded-md bg-(--surface-active)" />
          <div className="mt-[9px]">
            <span className="inline-block h-[10px] w-16 animate-pulse rounded-full bg-(--surface-active)" />
          </div>
        </>
      ) : error ? (
        <div
          className="mt-[6px] inline-flex items-center gap-[6px] font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)"
          title={error}
        >
          <Icon name="triangle-alert" size={14} color="var(--status-error)" />
          {t('unavailable')}
        </div>
      ) : (
        <>
          <div className={`mono mt-[6px] leading-none font-semibold tracking-[-.02em] ${valueClass}`}>{value}</div>
          {note && (
            <div className="mt-[7px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              {note}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** What a self-hoster's own members are spending — the daemon page's pair, averaged. */
function ClusterResourcesCard({ online, cpu, mem }: { online: boolean; cpu: number; mem: number }) {
  const t = useTranslations('Daemons.clusterDetail')
  return (
    <div className="card flex flex-col">
      <div className="cardhead">
        <span className="cardtitle">{t('resources')}</span>
      </div>
      {/* An idle cluster has nothing to average: the dials read '—' rather than 0%, which would
          be a measurement it cannot make. */}
      <ResourceDials>
        <ResourceDial label={t('cpu')} pct={cpu} muted={!online} />
        <ResourceDial label={t('memory')} pct={mem} muted={!online} />
      </ResourceDials>
    </div>
  )
}
