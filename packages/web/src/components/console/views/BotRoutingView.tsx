'use client'

// Integrations → shared bot → Configuration → Routing (decisions.md §9.2–§9.5).

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button, Icon } from '@/components/ui'
import { AgentIconView, LoadingState, PlatformMark } from '@/components/marks'
import { DecisionsNotOffered } from '@/components/console/decisions/DecisionsNotOffered'
import { DecisionRoutingEditor } from '@/components/console/decisions/routing/DecisionRoutingEditor'
import { DecisionRoutingTry } from '@/components/console/decisions/routing/DecisionRoutingTry'
import { DecisionRoutingEvaluationsPanel } from '@/components/console/decisions/routing/DecisionRoutingEvaluationsPanel'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { useOrgs } from '@/lib/org-context'
import { errorParts } from '@/lib/decisions/binding'
import { useDecisionProviders, useDecisionsPrototype } from '@/lib/decisions/provider'
import {
  INITIAL_ROUTING_STATE,
  routingPendingSync,
  ruleNumbers,
  type RoutingEvent
} from '@/lib/decisions/routing-draft'
import { useRoutingRoster } from '@/lib/decisions/routing-roster'

type Status =
  | 'ready'
  | 'pending_sync'
  | 'needs_review'
  | 'missing_credentials'
  | 'daemon_offline'
  | 'unsupported'
  | 'insufficient_credits'
  | 'paused'
  | 'draft'

const STATUS_BADGE: Record<Status, string> = {
  ready: 'bg-(--status-online-soft) text-(--status-online)',
  pending_sync: 'bg-(--brand-soft) text-(--brand-soft-text)',
  needs_review: 'bg-(--status-paused-soft) text-(--amber-500)',
  missing_credentials: 'bg-(--status-paused-soft) text-(--amber-500)',
  daemon_offline: 'bg-(--surface-active) text-(--text-secondary)',
  unsupported: 'bg-(--status-paused-soft) text-(--amber-500)',
  insufficient_credits: 'bg-(--status-paused-soft) text-(--amber-500)',
  paused: 'bg-(--surface-active) text-(--text-secondary)',
  draft: 'bg-(--surface-active) text-(--text-tertiary)'
}

function Banner({ icon, tone, children }: { icon: string; tone: 'warning' | 'info'; children: ReactNode }) {
  return (
    <div
      role="status"
      className={`flex items-start gap-[9px] rounded-md border px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55] ${
        tone === 'warning'
          ? 'border-(--amber-500) bg-(--status-paused-soft)'
          : 'border-(--border-subtle) bg-(--surface-sunken)'
      }`}
    >
      <Icon name={icon} size={14} className="mt-[2px] flex-none" />
      <span className="flex min-w-0 flex-col gap-1">{children}</span>
    </div>
  )
}

export default function BotRoutingView() {
  const params = useParams<{ botId?: string }>()
  const botId = decodeURIComponent(params?.botId ?? '')
  if (!featureFlagEnabled('decisions')) return <DecisionsNotOffered />
  return <BotRouting botId={botId} />
}

function BotRouting({ botId }: { botId: string }) {
  const t = useTranslations('Decisions.routing')
  const { orgPath, myRole } = useOrgs()
  const canWrite = myRole !== 'viewer'
  const { api, orgId, decisions, routingDrafts, routingKeyFor, dispatchRouting } = useDecisionsPrototype()
  const roster = useRoutingRoster(botId)
  const { providers } = useDecisionProviders()
  const state = routingDrafts[routingKeyFor(botId)] ?? INITIAL_ROUTING_STATE
  const dispatch = useCallback((event: RoutingEvent) => dispatchRouting(botId, event), [botId, dispatchRouting])
  const [testing, setTesting] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyRef = useRef<HTMLElement>(null)
  const { data, error, mutate } = useSWR(orgId && botId ? ['decision-routing', api.mode, orgId, botId] : null, () =>
    api.getRouting(botId)
  )
  useEffect(() => {
    if (data) dispatch({ type: 'LOADED', detail: data })
  }, [data, dispatch])
  useEffect(() => {
    if (error) dispatch({ type: 'LOAD_FAIL', error })
  }, [error, dispatch])
  // A successful save becomes the cached detail, so reopening reads the saved state.
  const savedDetail = state.phase === 'saved' ? state.saved : null
  useEffect(() => {
    if (savedDetail) void mutate(savedDetail, { revalidate: false })
  }, [savedDetail, mutate])
  useEffect(() => {
    if (historyOpen) historyRef.current?.scrollIntoView({ block: 'start' })
  }, [historyOpen])

  const integrations = orgPath('/integrations')
  const botSettings = orgPath(`/integrations?bot=${encodeURIComponent(botId)}`)
  const bot = roster.bot
  const notFound = (!roster.loading && !bot) || (error && errorParts(error)?.status === 404)
  const wrap = (children: ReactNode) => <div className="wrap max-w-[1180px] max-desktop:p-4">{children}</div>

  if (notFound)
    return wrap(
      <div className="card px-5 py-10 text-center font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
        {t('notFound')}
      </div>
    )
  if (roster.loading || (!state.draft && state.phase === 'loading'))
    return wrap(<LoadingState size={22} padding={30} />)
  if (bot && !bot.shared)
    return wrap(
      <div className="card px-5 py-10 text-center font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
        {t('notShared')}
      </div>
    )
  if (state.phase === 'load_error' || !state.draft)
    return wrap(
      <div className="card flex flex-col items-center gap-3 px-5 py-10 text-center font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
        <span>{t('loadError', { message: errorParts(state.error)?.message ?? String(state.error ?? '') })}</span>
        <Button variant="secondary" size="sm" onClick={() => void mutate()}>
          {t('retryLoad')}
        </Button>
      </div>
    )

  const saved = state.saved
  const decision = state.draft.decisionId
    ? (decisions.find((entry) => entry.id === state.draft!.decisionId) ?? null)
    : null
  const status: Status = !saved?.config ? 'draft' : !saved.config.enabled ? 'paused' : saved.readiness.status
  const agentNames = new Map(roster.agents.map((agent) => [agent.id, agent.name]))
  const savedDecision = saved?.config
    ? (decisions.find((entry) => entry.id === saved.config!.decisionId) ?? null)
    : null
  const savedRuleNumbers = ruleNumbers(savedDecision?.question ?? null, saved?.config?.rules ?? [])
  const providerId = savedDecision?.providerId ?? null
  const providerName =
    (providerId && providers.find((provider) => provider.id === providerId)?.name) ||
    providerId ||
    t('banner.unknownProvider')
  const routedChannels = (saved?.channels ?? []).map((channel) => ({
    channelId: channel.channelId,
    name: roster.channels.find((c) => c.channelId === channel.channelId)?.name ?? channel.name ?? channel.channelId
  }))

  const banners: ReactNode[] = []
  if (!canWrite)
    banners.push(
      <Banner key="ro" icon="lock" tone="info">
        {t('readOnly')}
      </Banner>
    )
  if (saved?.config && !saved.config.enabled)
    banners.push(
      <Banner key="paused" icon="pause" tone="info">
        {t('banner.paused')}
      </Banner>
    )
  if (routingPendingSync(state))
    banners.push(
      <Banner key="sync" icon="clock" tone="info">
        {t('banner.pendingSync')}
      </Banner>
    )
  if (saved?.config && saved.readiness.status === 'needs_review')
    banners.push(
      <Banner key="review" icon="triangle-alert" tone="warning">
        <span>{t('banner.needsReview')}</span>
        <Link href={orgPath(`/decisions/${encodeURIComponent(saved.config.decisionId)}`)} className="lnk self-start">
          {t('banner.openDecision')}
        </Link>
      </Banner>
    )
  if (
    saved?.config &&
    (saved.readiness.status === 'missing_credentials' || saved.readiness.status === 'insufficient_credits')
  )
    banners.push(
      <Banner key="keys" icon="key-round" tone="warning">
        <span>
          {t(
            saved.readiness.status === 'insufficient_credits'
              ? 'banner.insufficientCredits'
              : 'banner.missingCredentials',
            {
              provider: providerName
            }
          )}
        </span>
        <Link href={orgPath('/daemons')} className="lnk self-start">
          {t('banner.providerKeys')}
        </Link>
      </Banner>
    )
  if (saved?.config && saved.readiness.status === 'daemon_offline')
    banners.push(
      <Banner key="offline" icon="wifi-off" tone="info">
        {t('banner.daemonOffline')}
      </Banner>
    )
  if (saved?.config && saved.readiness.status === 'unsupported')
    banners.push(
      <Banner key="unsupported" icon="circle-arrow-up" tone="warning">
        {saved.evaluationHost?.status === 'unsupported' ? t('banner.unsupportedHost') : t('banner.unsupportedRelay')}
      </Banner>
    )
  if (roster.agents.length === 0)
    banners.push(
      <Banner key="agents" icon="users" tone="warning">
        <span>{t('banner.noAgents')}</span>
        <Link href={botSettings} className="lnk self-start">
          {t('banner.connectAgent')}
        </Link>
      </Banner>
    )

  return wrap(
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <nav
          aria-label={t('title')}
          className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)"
        >
          <ol className="m-0 flex list-none flex-wrap items-center gap-[6px] p-0">
            <li>
              <Link href={integrations} className="lnk">
                {t('breadcrumb.integrations')}
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <Link href={botSettings} className="lnk">
                {bot?.name ?? botId}
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>{t('breadcrumb.configuration')}</li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-(--text-secondary)">
              {t('breadcrumb.routing')}
            </li>
          </ol>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          {bot?.platform && (
            <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] border border-(--border-default) bg-(--surface-card)">
              <span className="flex h-4 w-4 items-center justify-center">
                <PlatformMark platform={bot.platform} fillPct={100} />
              </span>
            </span>
          )}
          <span className="flex min-w-0 flex-col">
            <h1 className="m-0 truncate font-sans text-[17px] font-semibold leading-normal">{bot?.name ?? botId}</h1>
            <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              {t('subtitle')}
            </span>
          </span>
          <span className="isolate flex items-center">
            {roster.agents.map((agent, index) => (
              <span
                key={agent.id}
                title={agent.name}
                className={`av h-[22px] w-[22px] rounded-[6px] ${index > 0 ? '-ml-[6px] shadow-[-1px_0_0_0_var(--surface-card)]' : ''}`}
              >
                <AgentIconView icon={agent.icon} runtime={agent.runtime} size={22} />
              </span>
            ))}
          </span>
          <span className={`badge flex-none ${STATUS_BADGE[status]}`}>{t(`status.${status}`)}</span>
          <span className="flex-1" />
          <Button
            variant="secondary"
            size="sm"
            ariaExpanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <Icon name="list" size={14} />
            {t('recentEvaluations')}
          </Button>
        </div>
      </header>

      {banners}

      {!saved?.config && (
        <div className="card flex flex-col gap-1 px-4 py-3">
          <b className="font-sans text-[13px] font-semibold leading-normal">{t('empty.title')}</b>
          <span className="font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-tertiary)">
            {t('empty.body')}
          </span>
        </div>
      )}

      <DecisionRoutingEditor
        botId={botId}
        state={state}
        dispatch={dispatch}
        roster={roster}
        canWrite={canWrite}
        testing={testing}
        onToggleTest={() => setTesting((open) => !open)}
      />

      {canWrite && testing && decision && (
        <DecisionRoutingTry botId={botId} draft={state.draft} decision={decision} roster={roster} open={testing} />
      )}

      {historyOpen && (
        <section ref={historyRef} aria-labelledby="routing-history" className="flex flex-col gap-2">
          <h2 id="routing-history" className="m-0 font-sans text-[14px] font-semibold leading-normal">
            {t('evaluations.title')}
          </h2>
          <DecisionRoutingEvaluationsPanel
            botId={botId}
            channels={routedChannels}
            agentNames={agentNames}
            ruleNumbers={savedRuleNumbers}
          />
        </section>
      )}
    </div>
  )
}
