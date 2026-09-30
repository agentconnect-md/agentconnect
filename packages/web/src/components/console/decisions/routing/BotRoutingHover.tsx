'use client'

// A shared bot's routing chip card: read on first hover, through the same cache entry as the rules modal.

import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { routingUsageRules } from '@agentconnect.md/protocol/decision'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { DecisionRulesHover, decisionRow, useRuleLines } from '../DecisionRulesHover'

export function BotRoutingHover({ botId, name }: { botId: string; name: string }) {
  const t = useTranslations('Decisions')
  const { orgPath } = useOrgs()
  const { agents } = useConsoleData()
  const { api, orgId, decisions } = useDecisionsPrototype()
  const ruleLines = useRuleLines()
  const { data } = useSWR(orgId ? ['decision-routing', api.mode, orgId, botId] : null, () => api.getRouting(botId))
  const config = data?.config
  const decision = decisions.find((entry) => entry.id === config?.decisionId)
  return (
    <DecisionRulesHover
      rows={[
        decisionRow(
          t('binding.decision'),
          decision?.name ?? name,
          decision && orgPath(`/decisions/${encodeURIComponent(decision.id)}`)
        )
      ]}
      {...ruleLines(config ? routingUsageRules(config, config.decisionId) : null, decision?.question, {
        agent: (id) => {
          const agent = agents.find((entry) => entry.id === id)
          return agent && agentLabel(agent)
        },
        decision: (id) => decisions.find((entry) => entry.id === id)?.name
      })}
    />
  )
}
