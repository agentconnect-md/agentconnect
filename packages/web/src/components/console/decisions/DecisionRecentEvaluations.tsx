'use client'

// A Decision's places of use as tabs over their recent evaluations: All merges every recorded place by time.

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import type {
  DecisionAnswerSummary,
  DecisionEvaluationOutcome,
  DecisionQuestion,
  DecisionRoutingEvaluationOutcome
} from '@agentconnect.md/protocol/decision'
import type { DecisionUsage } from '@agentconnect.md/protocol/decision-api'
import { Icon } from '@/components/ui'
import { MarkSlot } from '@/components/marks'
import { fetchAgentModelEvaluations, type CodeHostRoutingKey } from '@/lib/api'
import { useDecisionsPrototype, type DecisionGateUsage } from '@/lib/decisions/provider'
import { errorParts } from '@/lib/decisions/binding'
import { answerText } from '@/lib/decisions/evaluations'
import { apiGateEvaluations, codeHostRoutingEvaluations } from '@/lib/decisions/evaluation-source'
import { ruleNumbers } from '@/lib/decisions/routing-draft'
import { EvaluationRow } from './EvaluationParts'
import { DecisionEvaluationsDrawer } from './DecisionEvaluationsDrawer'
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
  source?: RecordedUsage
}

interface Row {
  place: string
  seq: number
  at: string
  answer: DecisionAnswerSummary | null
  /** The raw outcome of this place's history, worded at render. */
  outcome: string
  latencyMs: number | null
  detailsExpired: boolean
  title: string | null
  channel?: string
  channelName?: string
  /** The runtime and model a model selection chose. */
  target?: string
}

// A place whose conversation the caller cannot read answers 404; that is a hidden place, not a failed one.
type Loaded = { items: Row[]; more: boolean } | { error: unknown } | { hidden: true }

const PAGE = 10
const ICONS: Record<Kind, string> = {
  gate: 'hash',
  shared_bot_routing: 'git-branch',
  code_host_routing: 'git-pull-request',
  model_selection: 'cpu',
  agent_tool: 'wrench',
  api_gate: 'code-xml'
}
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

export function DecisionRecentEvaluations({
  decisionId,
  question,
  usages,
  usageStatus,
  gated = [],
  hiddenCount = 0,
  inUse = false,
  hrefFor,
  markFor
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
}) {
  const t = useTranslations('Decisions')
  const modelT = useTranslations('Agents.dialog.modelSelection.evaluations')
  const locale = useLocale()
  const { api, orgId } = useDecisionsPrototype()
  const places: Place[] = [
    ...gated.map((gate) => ({
      key: `gate-local:${gate.channelId}`,
      kind: 'gate' as const,
      label: gate.channelName,
      href: null,
      review: gate.needsReview
    })),
    ...usages.map((usage) => ({
      key: usageKey(usage),
      kind: usage.kind,
      label: usage.label,
      href: hrefFor(usage),
      mark: markFor?.(usage),
      ...(recorded(usage) ? { source: usage } : {})
    }))
  ]
  const sources = places.flatMap((place) => (place.source ? [place.source] : []))
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const selected = places.find((place) => place.key === selectedKey) ?? null
  const [opened, setOpened] = useState<{ key: string; seq?: number; channel?: string } | null>(null)
  const drawerSource = sources.find((source) => usageKey(source) === opened?.key)
  const drawerDecisionId = drawerSource?.rootDecisionId ?? decisionId

  const read = async (source: RecordedUsage): Promise<{ items: Row[]; more: boolean }> => {
    const root = source.rootDecisionId ?? decisionId
    const place = usageKey(source)
    const common = (item: {
      seq: number
      at: string
      answer: DecisionAnswerSummary | null
      latencyMs: number | null
      detailsExpired: boolean
    }) => ({
      place,
      seq: item.seq,
      at: item.at,
      answer: item.answer,
      latencyMs: item.latencyMs,
      detailsExpired: item.detailsExpired
    })
    if (source.kind === 'shared_bot_routing') {
      const [page, routing] = await Promise.all([
        api.listRoutingEvaluations(source.id, { decisionId: root, limit: PAGE }),
        api.getRouting(source.id).catch(() => null)
      ])
      const names = new Map(routing?.channels.map((channel) => [channel.channelId, channel.name ?? channel.channelId]))
      return {
        items: page.items.map((item) => ({
          ...common(item),
          outcome: item.outcome,
          title: item.title,
          channel: item.channel,
          channelName: names.get(item.channel) ?? item.channel
        })),
        more: page.nextCursor !== null
      }
    }
    if (source.kind === 'model_selection') {
      const page =
        api.mode === 'mock'
          ? { items: [], nextCursor: null }
          : await fetchAgentModelEvaluations(source.id, { decisionId: root, limit: PAGE }, orgId)
      return {
        items: page.items.map((item) => ({
          ...common(item),
          outcome: item.outcome,
          title: item.title,
          target: `${item.target.runtime} · ${item.target.model}`
        })),
        more: page.nextCursor !== null
      }
    }
    const page =
      source.kind === 'api_gate'
        ? await apiGateEvaluations(api, orgId, source.id, source.protocol!).list({ decisionId: root, limit: PAGE })
        : source.kind === 'gate'
          ? await api.listEvaluations(
              { integrationId: source.integrationId!, channelId: source.channelId! },
              { decisionId: root, limit: PAGE }
            )
          : await codeHostRoutingEvaluations(api, orgId, {
              provider: source.provider!,
              repoId: source.repoId!,
              family: source.family!
            } satisfies CodeHostRoutingKey).list({ decisionId: root, limit: PAGE })
    return {
      items: page.items.map((item) => ({
        ...common(item),
        outcome: item.outcome,
        title: item.title
      })),
      more: page.nextCursor !== null
    }
  }

  // One read per recorded place; a place that fails keeps its error without hiding the others.
  const { data, isLoading, mutate } = useSWR(
    sources.length ? ['decision-recent-evaluations', api.mode, orgId, decisionId, ...sources.map(usageKey)] : null,
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
  const routing = useSWR(routingSource ? ['decision-recent-routing', api.mode, orgId, routingSource.id] : null, () =>
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
  const rowsOf = (place: Place) => {
    const loaded = loadedOf(place)
    return loaded && 'items' in loaded ? loaded.items : []
  }
  const countOf = (place: Place) => {
    const loaded = loadedOf(place)
    return loaded && 'items' in loaded ? `${loaded.items.length}${loaded.more ? '+' : ''}` : null
  }
  const shownPlaces = selected ? [selected] : places
  const rows = shownPlaces.flatMap(rowsOf).sort((a, b) => (a.at === b.at ? b.seq - a.seq : a.at < b.at ? 1 : -1))
  const failed = shownPlaces.filter((place) => {
    const loaded = loadedOf(place)
    return loaded && 'error' in loaded
  })
  const placeByKey = new Map(places.map((place) => [place.key, place]))
  const answerWords = { yes: t('condition.yes'), no: t('condition.no') }
  const total = places.reduce((sum, place) => sum + rowsOf(place).length, 0)
  const anyMore = places.some((place) => {
    const loaded = loadedOf(place)
    return !!loaded && 'items' in loaded && loaded.more
  })
  const markOf = (place: Place, size: number) =>
    place.mark ? (
      <MarkSlot size={14}>{place.mark}</MarkSlot>
    ) : (
      <Icon name={ICONS[place.kind]} size={size} className="flex-none text-(--text-tertiary)" />
    )
  const note = (text: string) => <p className="m-0 px-4 py-3 text-[12.5px] text-(--text-tertiary)">{text}</p>
  const kindWord = (kind: Kind) => t(`usedBy.kind.${kind}`)
  // Outcomes stay raw in the cache and are worded here, so a language switch rewords rows already loaded.
  const outcomeText = (row: Row, kind: Kind) =>
    kind === 'model_selection'
      ? modelT(`outcome.${row.outcome as 'selected' | 'fallback'}`)
      : kind === 'shared_bot_routing'
        ? t(`routing.evaluations.outcomes.${row.outcome as DecisionRoutingEvaluationOutcome}`)
        : t(`evaluations.outcomes.${row.outcome as DecisionEvaluationOutcome}`)
  const hint = (place: Place) =>
    [
      place.label,
      [
        kindWord(place.kind),
        place.review !== undefined ? (place.review ? t('usedBy.needsReview') : t('usedBy.ok')) : null
      ]
        .filter(Boolean)
        .join(' · ')
    ].join('\n')
  const tab = (active: boolean) =>
    `-mb-px flex items-center gap-[7px] border-0 border-b-2 border-solid bg-transparent px-0 py-[10px] text-[13px] leading-normal ${
      active
        ? 'border-(--brand) font-semibold text-(--text-primary)'
        : 'border-transparent font-medium text-(--text-secondary) hover:text-(--text-primary)'
    }`
  const counter = (text: string | null) =>
    text === null ? null : (
      <span className="rounded-full bg-(--surface-active) px-[7px] font-mono text-[11px] leading-[18px] text-(--text-secondary)">
        {text}
      </span>
    )

  const usedIn =
    usageStatus === 'ready'
      ? t('recentBySource.usedIn', { count: places.length + hiddenCount })
      : usageStatus === 'loading'
        ? t('usedBy.loading')
        : t('usedBy.error')

  return (
    <div className="card" data-testid="decision-recent-evaluations">
      <div className="cardhead flex-wrap justify-between gap-y-2">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-[10px]">
          <span className="cardtitle">{t('recentBySource.title')}</span>
          <span className="truncate font-mono text-[11.5px] leading-normal text-(--text-tertiary)">{usedIn}</span>
        </span>
        {selected && (
          <span className="flex flex-none items-center gap-4">
            {selected.href && (
              <Link href={selected.href} className="lnk gap-[6px] text-[12.5px] font-medium">
                <Icon name="settings" size={13} />
                {t('recentBySource.settings')}
              </Link>
            )}
            {selected.source && (
              <button
                type="button"
                className="lnk gap-[6px] text-[12.5px] font-medium"
                onClick={() => setOpened({ key: selected.key })}
              >
                <Icon name="panel-right" size={13} />
                {t('recentBySource.openPanel')}
              </button>
            )}
          </span>
        )}
      </div>

      {usageStatus === 'ready' && places.length === 0 ? (
        note(inUse || hiddenCount > 0 ? t('usedBy.hiddenUnknown') : t('notUsed'))
      ) : usageStatus !== 'ready' ? null : (
        <>
          <div
            role="tablist"
            aria-label={t('recentBySource.title')}
            className="flex flex-wrap gap-x-6 border-b border-(--border-subtle) px-4"
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected === null}
              className={tab(selected === null)}
              onClick={() => setSelectedKey(null)}
            >
              {t('recentBySource.all')}
              {counter(data ? `${total}${anyMore ? '+' : ''}` : null)}
            </button>
            {places.map((place) => (
              <button
                key={place.key}
                type="button"
                role="tab"
                aria-selected={selected?.key === place.key}
                title={hint(place)}
                className={tab(selected?.key === place.key)}
                onClick={() => setSelectedKey(place.key)}
              >
                {markOf(place, 13)}
                <span className="mono max-w-[260px] truncate">{place.label}</span>
                {place.review && <span aria-hidden className="size-[6px] flex-none rounded-full bg-(--amber-500)" />}
                {counter(countOf(place))}
              </button>
            ))}
          </div>

          {selected?.source?.rootDecisionId && selected.source.rootDecisionId !== decisionId && (
            <p className="m-0 px-4 pt-3 text-[12px] text-(--text-tertiary)">{t('recentBySource.chainHistory')}</p>
          )}
          {selected && !selected.source ? (
            note(t('recentBySource.notRecorded'))
          ) : selected && loadedOf(selected) && 'hidden' in loadedOf(selected)! ? (
            note(t('recentBySource.hidden'))
          ) : !selected && sources.length === 0 ? (
            note(t('recentBySource.noSources'))
          ) : isLoading && !data ? (
            note(t('recentBySource.loading'))
          ) : (
            <>
              {failed.length > 0 && (
                <p role="alert" className="m-0 px-4 pt-3 text-[12px] text-(--status-error)">
                  {selected
                    ? errorParts((loadedOf(selected) as { error: unknown }).error)?.code === 'DAEMON_UPGRADE_REQUIRED'
                      ? t('recentBySource.upgrade')
                      : t('recentBySource.error')
                    : t('recentBySource.partialError', { count: failed.length })}{' '}
                  <button type="button" className="lnk" onClick={() => void mutate()}>
                    {t('recentBySource.retry')}
                  </button>
                </p>
              )}
              {rows.length === 0 && failed.length === 0 ? (
                note(selected ? t('recentBySource.empty') : t('recentBySource.emptyAll'))
              ) : rows.length > 0 ? (
                <ul className="m-0 list-none p-0">
                  {rows.map((row) => {
                    const place = placeByKey.get(row.place)!
                    const answer = answerText(row.answer, answerWords)
                    return (
                      <li
                        key={`${row.place}:${row.channel ?? ''}:${row.seq}`}
                        className="border-b border-(--border-subtle) last:border-b-0"
                      >
                        <EvaluationRow
                          data-at={row.at}
                          title={row.title}
                          expired={row.detailsExpired}
                          answer={answer}
                          outcome={outcomeText(row, place.kind)}
                          meta={
                            <>
                              {markOf(place, 12)}
                              <span className="truncate">
                                {[place.label, row.channelName].filter(Boolean).join(' · ')}
                                {row.target ? ` → ${row.target}` : ''}
                              </span>
                            </>
                          }
                          at={row.at}
                          latencyMs={row.latencyMs}
                          onClick={() =>
                            setOpened({
                              key: row.place,
                              seq: row.seq,
                              ...(row.channel ? { channel: row.channel } : {})
                            })
                          }
                        />
                      </li>
                    )
                  })}
                </ul>
              ) : null}
            </>
          )}
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
          initialSeq={opened?.seq}
          onClose={() => setOpened(null)}
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
          initialSeq={opened?.seq}
          onClose={() => setOpened(null)}
        />
      )}
      {drawerSource?.kind === 'api_gate' && (
        <DecisionEvaluationsDrawer
          source={apiGateEvaluations(api, orgId, drawerSource.id, drawerSource.protocol!)}
          channelName={drawerSource.label}
          decisionId={drawerDecisionId}
          initialSeq={opened?.seq}
          onClose={() => setOpened(null)}
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
          initialEvaluation={
            opened?.seq !== undefined && opened.channel ? { seq: opened.seq, channel: opened.channel } : undefined
          }
          onClose={() => setOpened(null)}
        />
      )}
      {drawerSource?.kind === 'model_selection' && (
        <ModelSelectionEvaluationsDrawer
          target={{ agentId: drawerSource.id, agentName: drawerSource.label, live: true }}
          decisionId={drawerDecisionId}
          initialSeq={opened?.seq}
          onClose={() => setOpened(null)}
        />
      )}
    </div>
  )
}
