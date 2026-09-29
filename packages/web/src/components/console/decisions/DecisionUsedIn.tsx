'use client'

// A Decision's places of use, one row each: its rule, its evaluations in the last 24 hours, and its settings and history.

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { gateUsageRules, type DecisionQuestion, type DecisionUsageRules } from '@agentconnect.md/protocol/decision'
import type { DecisionUsage } from '@agentconnect.md/protocol/decision-api'
import { Icon } from '@/components/ui'
import { useHoverCard } from '@/components/ui/HoverCard'
import { MarkSlot } from '@/components/marks'
import { fetchAgentModelEvaluations, type CodeHostRoutingKey } from '@/lib/api'
import { useDecisionsPrototype, type DecisionGateUsage } from '@/lib/decisions/provider'
import { errorParts } from '@/lib/decisions/binding'
import { apiGateEvaluations, codeHostRoutingEvaluations } from '@/lib/decisions/evaluation-source'
import { ruleNumbers } from '@/lib/decisions/routing-draft'
import { DecisionEvaluationsDrawer } from './DecisionEvaluationsDrawer'
import { DecisionRulesHover, useRuleLines } from './DecisionRulesHover'
import { ModelSelectionEvaluationsDrawer } from './ModelSelectionEvaluations'
import { DecisionRoutingEvaluationsDrawer } from './routing/DecisionRoutingEvaluationsDrawer'

type RecordedUsage = DecisionUsage & {
  kind: 'gate' | 'shared_bot_routing' | 'code_host_routing' | 'model_selection' | 'api_gate'
}
type Kind = DecisionUsage['kind']

interface Place {
  key: string
  /** The integration, bot, code host, or agent mark this place is known by, when the caller resolves one. */
  mark?: ReactNode
  kind: Kind
  label: string
  href: string | null
  review?: boolean
  rules?: Partial<DecisionUsageRules>
  source?: RecordedUsage
}

// A place whose conversation the caller cannot read answers 404; that is a hidden place, not a failed one.
type Loaded = { day: number; more: boolean } | { error: unknown } | { hidden: true }

// The lists cap a page at 50, so a busier day reads as `50+`.
const PAGE = 50
const DAY_MS = 24 * 60 * 60 * 1000
const ICONS: Record<Kind, string> = {
  gate: 'hash',
  shared_bot_routing: 'git-branch',
  code_host_routing: 'git-pull-request',
  model_selection: 'cpu',
  agent_tool: 'wrench',
  api_gate: 'code-xml'
}
const COLUMNS = 'desktop:grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_56px_68px]'
const usageKey = (usage: DecisionUsage) => `${usage.kind}:${usage.id}${usage.protocol ? `:${usage.protocol}` : ''}`

function recorded(usage: DecisionUsage): usage is RecordedUsage {
  return (
    (usage.kind === 'gate' && !!usage.integrationId && !!usage.channelId) ||
    usage.kind === 'shared_bot_routing' ||
    (usage.kind === 'code_host_routing' && !!usage.provider && !!usage.repoId && !!usage.family) ||
    usage.kind === 'model_selection' ||
    (usage.kind === 'api_gate' && !!usage.protocol)
  )
}

// The place's rule as a chip: its conditions in one line, and every rule with its fallback on hover.
function RuleChip({
  place,
  question,
  agentName
}: {
  place: Place
  question: DecisionQuestion
  agentName?: (id: string) => string | undefined
}) {
  const t = useTranslations('Decisions')
  const card = useHoverCard()
  const { decisions } = useDecisionsPrototype()
  const ruleLines = useRuleLines()
  const lines = ruleLines(place.rules, question, {
    ...(agentName ? { agent: agentName } : {}),
    decision: (id) => decisions.find((entry) => entry.id === id)?.name
  })
  if (!lines.rules.length) return <span className="text-[12.5px] text-(--text-tertiary)">—</span>
  return (
    <span
      {...card.triggerProps}
      data-rule-chip
      className={`inline-flex h-[26px] min-w-0 max-w-full items-center gap-[6px] justify-self-start rounded-sm border px-[7px] ${
        place.review ? 'border-(--amber-500)' : 'border-(--brand) bg-(--brand-soft)'
      }`}
    >
      <Icon
        name={place.review ? 'triangle-alert' : 'split'}
        size={13}
        className={`flex-none ${place.review ? 'text-(--amber-500)' : 'text-(--brand)'}`}
      />
      <span className="mono truncate text-[11px] font-medium text-(--text-primary)">
        {lines.rules.map((rule) => rule.when).join(', ')}
      </span>
      {card.card(
        <DecisionRulesHover
          rows={place.review ? [[t('binding.statusLabel'), t('binding.status.needs_review')]] : undefined}
          {...lines}
        />
      )}
    </span>
  )
}

export function DecisionUsedIn({
  decisionId,
  question,
  usages,
  usageStatus,
  gated = [],
  hiddenCount = 0,
  inUse = false,
  hrefFor,
  markFor,
  agentName
}: {
  decisionId: string
  question: DecisionQuestion
  usages: DecisionUsage[]
  usageStatus: 'loading' | 'ready' | 'error'
  /** Local gates the prototype store tracks, with whether an edit left their condition needing review. */
  gated?: DecisionGateUsage[]
  hiddenCount?: number
  /** A server refusal said the Decision is used, so an empty list still names that someone uses it. */
  inUse?: boolean
  hrefFor: (usage: DecisionUsage) => string | null
  markFor?: (usage: DecisionUsage) => ReactNode
  /** A rule's target agent by the name the viewer sees; unresolved agents read as hidden. */
  agentName?: (id: string) => string | undefined
}) {
  const t = useTranslations('Decisions')
  const { api, orgId } = useDecisionsPrototype()
  const places: Place[] = [
    ...gated.map((gate) => ({
      key: `gate-local:${gate.channelId}`,
      kind: 'gate' as const,
      label: gate.channelName,
      href: null,
      review: gate.needsReview,
      rules: gateUsageRules({ decisionId, when: gate.when }, decisionId) ?? undefined
    })),
    ...usages.map((usage) => ({
      key: usageKey(usage),
      kind: usage.kind,
      label: usage.label,
      href: hrefFor(usage),
      mark: markFor?.(usage),
      rules: { rules: usage.rules, otherwise: usage.otherwise },
      ...(recorded(usage) ? { source: usage } : {})
    }))
  ]
  const sources = places.flatMap((place) => (place.source ? [place.source] : []))
  const [openedKey, setOpenedKey] = useState<string | null>(null)
  const drawerSource = sources.find((source) => usageKey(source) === openedKey)
  const drawerDecisionId = drawerSource?.rootDecisionId ?? decisionId

  // Only the count is kept: `more` marks a page wholly inside the last 24 hours with rows beyond it.
  const read = async (source: RecordedUsage): Promise<{ day: number; more: boolean }> => {
    const query = { decisionId: source.rootDecisionId ?? decisionId, limit: PAGE }
    const page: { items: { at: string }[]; nextCursor: unknown } =
      source.kind === 'shared_bot_routing'
        ? await api.listRoutingEvaluations(source.id, query)
        : source.kind === 'model_selection'
          ? api.mode === 'mock'
            ? { items: [], nextCursor: null }
            : await fetchAgentModelEvaluations(source.id, query, orgId)
          : source.kind === 'api_gate'
            ? await apiGateEvaluations(api, orgId, source.id, source.protocol!).list(query)
            : source.kind === 'gate'
              ? await api.listEvaluations({ integrationId: source.integrationId!, channelId: source.channelId! }, query)
              : await codeHostRoutingEvaluations(api, orgId, {
                  provider: source.provider!,
                  repoId: source.repoId!,
                  family: source.family!
                } satisfies CodeHostRoutingKey).list(query)
    const since = Date.now() - DAY_MS
    const day = page.items.filter((item) => Date.parse(item.at) >= since).length
    return { day, more: day === page.items.length && page.nextCursor !== null }
  }

  // One read per recorded place; a place that fails keeps its error without hiding the others.
  const { data, mutate } = useSWR(
    sources.length ? ['decision-used-in', api.mode, orgId, decisionId, ...sources.map(usageKey)] : null,
    async (): Promise<Record<string, Loaded>> =>
      Object.fromEntries(
        await Promise.all(
          sources.map(async (source) => {
            try {
              return [usageKey(source), await read(source)] as const
            } catch (error) {
              // An API gate's calls are its agent's editors' alone, so a 403 reads like an unseen place.
              const status = errorParts(error)?.status
              return [usageKey(source), status === 404 || status === 403 ? { hidden: true } : { error }] as const
            }
          })
        )
      )
  )
  const routingSource = drawerSource?.kind === 'shared_bot_routing' ? drawerSource : null
  const routing = useSWR(routingSource ? ['decision-routing', api.mode, orgId, routingSource.id] : null, () =>
    api.getRouting(routingSource!.id)
  )
  const routingChannels =
    routing.data?.channels.map((channel) => ({
      channelId: channel.channelId,
      name: channel.name ?? channel.channelId
    })) ?? []
  const agentNames = new Map(
    (routing.data?.channels ?? []).flatMap((channel) =>
      channel.defaultAgent
        ? [[channel.defaultAgent.id, channel.defaultAgent.name ?? channel.defaultAgent.id] as const]
        : []
    )
  )

  const loadedOf = (place: Place): Loaded | undefined => (place.source ? data?.[place.key] : undefined)
  const failed = places.filter((place) => {
    const loaded = loadedOf(place)
    return loaded && 'error' in loaded
  })
  const dayCount = (place: Place): ReactNode => {
    const loaded = loadedOf(place)
    if (!loaded || !('day' in loaded))
      return (
        <span
          title={loaded && 'hidden' in loaded ? t('usedIn.hidden') : loaded ? t('usedIn.error') : undefined}
          className="text-(--text-tertiary)"
        >
          —
        </span>
      )
    return `${loaded.day}${loaded.more ? '+' : ''}`
  }
  const markOf = (place: Place) =>
    place.mark ? (
      <MarkSlot size={14}>{place.mark}</MarkSlot>
    ) : (
      <Icon name={ICONS[place.kind]} size={13} className="flex-none text-(--text-tertiary)" />
    )
  const note = (text: string) => <p className="m-0 px-4 py-3 text-[12.5px] text-(--text-tertiary)">{text}</p>

  return (
    <div className="card" data-testid="decision-used-in">
      <div className="cardhead flex-wrap justify-between gap-y-2">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-[10px]">
          <span className="cardtitle">{t('usedIn.title')}</span>
          <span className="truncate font-mono text-[11.5px] leading-normal text-(--text-tertiary)">
            {usageStatus === 'ready'
              ? t('places', { count: places.length + hiddenCount })
              : usageStatus === 'loading'
                ? t('usedBy.loading')
                : t('usedBy.error')}
          </span>
        </span>
        {failed.length > 0 && (
          <span role="alert" className="text-[12px] text-(--status-error)">
            {t('usedIn.partialError', { count: failed.length })}{' '}
            <button type="button" className="lnk" onClick={() => void mutate()}>
              {t('usedIn.retry')}
            </button>
          </span>
        )}
      </div>

      {usageStatus === 'ready' && places.length === 0 ? (
        note(inUse || hiddenCount > 0 ? t('usedBy.hiddenUnknown') : t('notUsed'))
      ) : usageStatus !== 'ready' ? null : (
        <>
          <div className={`row h hidden gap-3 desktop:grid ${COLUMNS}`}>
            <span>{t('usedIn.place')}</span>
            <span>{t('usedIn.rule')}</span>
            <span>{t('usedIn.day')}</span>
            <span />
          </div>
          {places.map((place) => {
            const loaded = loadedOf(place)
            const history = !!place.source && !(loaded && 'hidden' in loaded)
            return (
              <div
                key={place.key}
                data-place={place.key}
                className={`row grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 last:border-b-0 ${COLUMNS}`}
              >
                <span className="col-span-2 flex min-w-0 items-center gap-[9px] desktop:col-span-1">
                  {markOf(place)}
                  <span className="mono min-w-0 truncate text-[12.5px] text-(--text-primary)">{place.label}</span>
                  <span className="flex-none text-[11.5px] text-(--text-tertiary)">
                    {t(`usedBy.kind.${place.kind}`)}
                  </span>
                </span>
                <RuleChip place={place} question={question} agentName={agentName} />
                <span className="flex items-center justify-end gap-3 desktop:contents">
                  <span className="font-mono text-[12.5px] text-(--text-secondary)" data-day-count>
                    {dayCount(place)}
                  </span>
                  <span className="flex items-center justify-end gap-[6px]">
                    {place.href ? (
                      <Link
                        href={place.href}
                        className="iconbtn"
                        aria-label={t('usedIn.edit', { place: place.label })}
                        title={t('usedIn.edit', { place: place.label })}
                      >
                        <Icon name="sliders-horizontal" size={14} />
                      </Link>
                    ) : (
                      <span className="w-[30px]" />
                    )}
                    {history ? (
                      <button
                        type="button"
                        className="iconbtn"
                        aria-label={t('usedIn.history', { place: place.label })}
                        title={t('usedIn.history', { place: place.label })}
                        onClick={() => setOpenedKey(place.key)}
                      >
                        <Icon name="history" size={14} />
                      </button>
                    ) : (
                      <span className="w-[30px]" />
                    )}
                  </span>
                </span>
              </div>
            )
          })}
          {hiddenCount > 0 && (
            <p className="m-0 border-t border-(--border-subtle) px-4 py-[10px] text-[12px] text-(--text-tertiary)">
              {t('usedBy.hidden', { count: hiddenCount })}
            </p>
          )}
        </>
      )}

      {drawerSource?.kind === 'gate' && (
        <DecisionEvaluationsDrawer
          conversation={{ integrationId: drawerSource.integrationId!, channelId: drawerSource.channelId! }}
          channelName={drawerSource.label}
          decisionId={drawerDecisionId}
          onClose={() => setOpenedKey(null)}
        />
      )}
      {drawerSource?.kind === 'code_host_routing' && (
        <DecisionEvaluationsDrawer
          source={codeHostRoutingEvaluations(api, orgId, {
            provider: drawerSource.provider!,
            repoId: drawerSource.repoId!,
            family: drawerSource.family!
          })}
          channelName={drawerSource.label}
          decisionId={drawerDecisionId}
          onClose={() => setOpenedKey(null)}
        />
      )}
      {drawerSource?.kind === 'api_gate' && (
        <DecisionEvaluationsDrawer
          source={apiGateEvaluations(api, orgId, drawerSource.id, drawerSource.protocol!)}
          channelName={drawerSource.label}
          decisionId={drawerDecisionId}
          onClose={() => setOpenedKey(null)}
        />
      )}
      {drawerSource?.kind === 'shared_bot_routing' && (
        <DecisionRoutingEvaluationsDrawer
          botId={drawerSource.id}
          botName={drawerSource.label}
          channels={routingChannels}
          agentNames={agentNames}
          ruleNumbers={
            drawerDecisionId === decisionId ? ruleNumbers(question, routing.data?.config?.rules ?? []) : new Map()
          }
          decisionId={drawerDecisionId}
          onClose={() => setOpenedKey(null)}
        />
      )}
      {drawerSource?.kind === 'model_selection' && (
        <ModelSelectionEvaluationsDrawer
          target={{ agentId: drawerSource.id, agentName: drawerSource.label, live: true }}
          decisionId={drawerDecisionId}
          onClose={() => setOpenedKey(null)}
        />
      )}
    </div>
  )
}
