'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import type { DecisionQuestion, DecisionEvaluationRecord } from '@agentconnect.md/protocol/decision'
import type { DecisionUsage } from '@agentconnect.md/protocol/decision-api'
import { fetchAgentModelEvaluations, type CodeHostRoutingKey } from '@/lib/api'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { errorParts } from '@/lib/decisions/binding'
import { answerText } from '@/lib/decisions/evaluations'
import { codeHostRoutingEvaluations } from '@/lib/decisions/evaluation-source'
import { ruleNumbers } from '@/lib/decisions/routing-draft'
import { formatEvaluationTime } from './EvaluationParts'
import { DecisionEvaluationsDrawer } from './DecisionEvaluationsDrawer'
import { ModelSelectionEvaluationsDrawer } from './ModelSelectionEvaluationsDrawer'
import { DecisionRoutingEvaluationsDrawer } from './routing/DecisionRoutingEvaluationsDrawer'

type RecordedUsage = DecisionUsage & { kind: 'gate' | 'shared_bot_routing' | 'code_host_routing' | 'model_selection' }
type RecentRow = Pick<DecisionEvaluationRecord, 'seq' | 'at' | 'answer'> & {
  outcome: string
  channel?: string
  target?: string
}

const PAGE = 10
const sourceKey = (usage: RecordedUsage) => `${usage.kind}:${usage.id}`

function recorded(usages: DecisionUsage[]): RecordedUsage[] {
  return usages.filter(
    (usage): usage is RecordedUsage =>
      (usage.kind === 'gate' && !!usage.integrationId && !!usage.channelId) ||
      usage.kind === 'shared_bot_routing' ||
      (usage.kind === 'code_host_routing' && !!usage.provider && !!usage.repoId && !!usage.family) ||
      usage.kind === 'model_selection'
  )
}

export function DecisionRecentEvaluations({
  decisionId,
  question,
  usages
}: {
  decisionId: string
  question: DecisionQuestion
  usages: DecisionUsage[]
}) {
  const t = useTranslations('Decisions')
  const modelT = useTranslations('Agents.detail.modelEvaluations')
  const locale = useLocale()
  const { api, orgId } = useDecisionsPrototype()
  const sources = recorded(usages)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [opened, setOpened] = useState<{ key: string; seq?: number; channel?: string } | null>(null)
  const selected = sources.find((source) => sourceKey(source) === selectedKey) ?? sources[0]!
  const drawerSource = sources.find((source) => sourceKey(source) === opened?.key)
  const { data, error, isLoading, mutate } = useSWR(
    selected ? ['decision-recent-evaluations', api.mode, orgId, decisionId, sourceKey(selected)] : null,
    async (): Promise<{ items: RecentRow[]; nextCursor: number | null }> => {
      let page
      if (selected.kind === 'gate') {
        page = await api.listEvaluations(
          { integrationId: selected.integrationId!, channelId: selected.channelId! },
          { decisionId, limit: PAGE }
        )
      } else if (selected.kind === 'shared_bot_routing') {
        page = await api.listRoutingEvaluations(selected.id, { decisionId, limit: PAGE })
      } else if (selected.kind === 'code_host_routing') {
        const scope: CodeHostRoutingKey = {
          provider: selected.provider!,
          repoId: selected.repoId!,
          family: selected.family!
        }
        page = await codeHostRoutingEvaluations(api, orgId, scope).list({ decisionId, limit: PAGE })
      } else {
        page =
          api.mode === 'mock'
            ? { items: [], nextCursor: null }
            : await fetchAgentModelEvaluations(selected.id, { decisionId, limit: PAGE }, orgId)
      }
      return {
        items: page.items.map((item) => ({
          seq: item.seq,
          at: item.at,
          answer: item.answer,
          outcome: item.outcome,
          ...('channel' in item ? { channel: item.channel } : {}),
          ...('target' in item ? { target: `${item.target.runtime} · ${item.target.model}` } : {})
        })),
        nextCursor: page.nextCursor
      }
    }
  )
  const routing = useSWR(
    drawerSource?.kind === 'shared_bot_routing' ? ['decision-recent-routing', api.mode, orgId, drawerSource.id] : null,
    () => api.getRouting(drawerSource!.id)
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
  const answerWords = { yes: t('condition.yes'), no: t('condition.no') }
  const outcome = (row: RecentRow) =>
    selected.kind === 'model_selection'
      ? modelT(`outcome.${row.outcome as 'selected' | 'fallback'}`)
      : selected.kind === 'shared_bot_routing'
        ? t(`routing.evaluations.outcomes.${row.outcome as 'routed'}`)
        : t(`evaluations.outcomes.${row.outcome as 'triggered'}`)

  return (
    <div className="card">
      <div className="cardhead">
        <span className="cardtitle">{t('recentBySource.title')}</span>
      </div>
      {sources.length === 0 ? (
        <p className="px-4 py-3 text-[12.5px] text-(--text-tertiary)">{t('recentBySource.noSources')}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 border-b border-(--border-subtle) px-4 py-3">
            {sources.map((source) => (
              <button
                key={sourceKey(source)}
                type="button"
                onClick={() => setSelectedKey(sourceKey(source))}
                aria-pressed={sourceKey(source) === sourceKey(selected)}
                className={`rounded-md border px-2.5 py-1.5 text-left text-[12px] leading-normal ${
                  sourceKey(source) === sourceKey(selected)
                    ? 'border-(--border-strong) bg-(--surface-active) text-(--text-primary)'
                    : 'border-(--border-subtle) bg-transparent text-(--text-secondary) hover:bg-(--surface-hover)'
                }`}
              >
                <span className="block font-medium">{source.label}</span>
                <span className="text-[11px] text-(--text-tertiary)">{t(`usedBy.kind.${source.kind}`)}</span>
              </button>
            ))}
          </div>
          {isLoading && !data && <p className="px-4 py-3 text-[12px] text-(--text-tertiary)">{t('loading')}</p>}
          {error && !data && (
            <p role="alert" className="px-4 py-3 text-[12px] text-(--status-error)">
              {errorParts(error)?.code === 'DAEMON_UPGRADE_REQUIRED'
                ? t('recentBySource.upgrade')
                : t('recentBySource.error')}{' '}
              <button type="button" className="lnk" onClick={() => void mutate()}>
                {t('recentBySource.retry')}
              </button>
            </p>
          )}
          {data && data.items.length === 0 && data.nextCursor === null && (
            <p className="px-4 py-3 text-[12px] text-(--text-tertiary)">{t('recentBySource.empty')}</p>
          )}
          <ul className="m-0 list-none p-0">
            {data?.items.map((row) => (
              <li key={`${row.channel ?? ''}:${row.seq}`} className="border-b border-(--border-subtle)">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 border-0 bg-transparent px-4 py-2.5 text-left hover:bg-(--surface-hover)"
                  onClick={() =>
                    setOpened({
                      key: sourceKey(selected),
                      seq: row.seq,
                      ...(row.channel ? { channel: row.channel } : {})
                    })
                  }
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-[11px] text-(--text-tertiary)">
                      {formatEvaluationTime(row.at, locale)}
                    </span>
                    <span className="block truncate text-[12.5px] text-(--text-primary)">
                      {row.channel ? `${row.channel} · ` : ''}
                      {row.target ? `${row.target} · ` : ''}
                      {answerText(row.answer, answerWords) ?? '—'}
                    </span>
                  </span>
                  <span className="badge shrink-0 bg-(--surface-active) text-(--text-secondary)">{outcome(row)}</span>
                </button>
              </li>
            ))}
          </ul>
          {data && (data.items.length > 0 || data.nextCursor !== null) && (
            <button
              type="button"
              className="lnk mx-4 my-3 text-[12px]"
              onClick={() => setOpened({ key: sourceKey(selected) })}
            >
              {t('recentBySource.viewAll')}
            </button>
          )}
        </>
      )}
      {drawerSource?.kind === 'gate' && (
        <DecisionEvaluationsDrawer
          conversation={{ integrationId: drawerSource.integrationId!, channelId: drawerSource.channelId! }}
          channelName={drawerSource.label}
          decisionId={decisionId}
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
          decisionId={decisionId}
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
          ruleNumbers={ruleNumbers(question, routing.data?.config?.rules ?? [])}
          decisionId={decisionId}
          initialEvaluation={
            opened?.seq !== undefined && opened.channel ? { seq: opened.seq, channel: opened.channel } : undefined
          }
          onClose={() => setOpened(null)}
        />
      )}
      {drawerSource?.kind === 'model_selection' && (
        <ModelSelectionEvaluationsDrawer
          agentId={drawerSource.id}
          agentName={drawerSource.label}
          orgId={orgId}
          decisionId={decisionId}
          initialSeq={opened?.seq}
          onClose={() => setOpened(null)}
        />
      )}
    </div>
  )
}
