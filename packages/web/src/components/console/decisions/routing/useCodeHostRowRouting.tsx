'use client'

// Every code-host row's decision routing wiring — entry, trigger lock, ⋯ items, Recent evaluations — for all providers (code-host-decisions.md §7).

import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type { Icon } from '@/components/ui'
import type { TriggerOption } from '@/components/console/TriggerSelect'
import { DecisionEvaluationsDrawer } from '@/components/console/decisions/DecisionEvaluationsDrawer'
import type { CodeHostRoutingDto, HookDto } from '@/lib/api'
import { useOptionalDecisionsPrototype } from '@/lib/decisions/provider'
import {
  codeHostRouted,
  codeHostRoutingScopeOf,
  codeHostScopeId,
  routingTargets,
  useCodeHostRoutings,
  type CodeHostRoutingMember
} from '@/lib/decisions/code-host-routing'
import { codeHostRoutingEvaluations } from '@/lib/decisions/evaluation-source'
import { CodeHostDecisionEntry } from './CodeHostDecisionEntry'

type IconName = Parameters<typeof Icon>[0]['name']
export interface RoutingMenuItem {
  icon: IconName
  label: string
  onClick: () => void
}

interface TriggerProps<T extends string> {
  options: TriggerOption<T>[]
  value: T
  onChange: (mode: T) => void
}

/** One row's routing: spread `trigger(...)` into its TriggerSelect and `menuItems` into its ⋯ menu. */
export interface CodeHostRowRouting {
  routed: boolean
  /** The Decision pill or `+ Decision`; null when the row's scope is not routable or the CP cannot serve it. */
  entry: ReactNode
  /** A routed row's options are locked and read `anyUpdate`, because the Decision judges every update. */
  trigger<T extends string>(props: TriggerProps<T>, anyUpdate: T): TriggerProps<T>
  menuItems: RoutingMenuItem[]
}

type AgentLookup = Parameters<typeof routingTargets>[1]

export function useCodeHostRowRouting({
  hooks,
  familyOf,
  pillOf,
  agentOf,
  firstAgentId,
  mockMembers
}: {
  /** Every code-host row; rows whose provider does not route their family carry no entry. */
  hooks: readonly HookDto[]
  /** The row's subject family in its host's stored vocabulary. */
  familyOf: (hook: HookDto) => string | null
  /** The row's family pill, for the drawer's subtitle. */
  pillOf: (hook: HookDto) => string
  agentOf: AgentLookup
  firstAgentId: string
  /** Mock mode has no CP membership, so its routings offer these agents. */
  mockMembers: readonly CodeHostRoutingMember[]
}): { rowOf: (hook: HookDto) => CodeHostRowRouting; drawer: ReactNode } {
  const t = useTranslations('Decisions.routing')
  const decisions = useOptionalDecisionsPrototype()
  const scopeOf = (hook: HookDto) => codeHostRoutingScopeOf(hook, familyOf(hook))
  const { routings } = useCodeHostRoutings(
    hooks.flatMap((hook) => scopeOf(hook) ?? []),
    mockMembers
  )
  const [evaluationsFor, setEvaluationsFor] = useState<{ routing: CodeHostRoutingDto; subtitle: string } | null>(null)

  const rowOf = (hook: HookDto): CodeHostRowRouting => {
    const scope = scopeOf(hook)
    const routing = scope ? (routings[codeHostScopeId(scope)] ?? null) : null
    const routed = codeHostRouted(routing)
    const openEvaluations = () => {
      if (routing) setEvaluationsFor({ routing, subtitle: `${routing.repoFullName} · ${pillOf(hook)}` })
    }
    const locked = t('codeHost.triggerLocked')
    return {
      routed,
      entry: routing && (
        <CodeHostDecisionEntry
          routing={routing}
          agents={routingTargets(routing.members, agentOf, firstAgentId, t('codeHost.hiddenAgent'))}
          onOpenEvaluations={openEvaluations}
        />
      ),
      trigger: (props, anyUpdate) =>
        routed
          ? {
              options: props.options.map((option) => ({
                ...option,
                hint: locked,
                description: locked,
                disabled: true
              })),
              value: anyUpdate,
              onChange: () => {}
            }
          : props,
      menuItems:
        routing?.config && decisions
          ? [{ icon: 'list-checks', label: t('recentEvaluations'), onClick: openEvaluations }]
          : []
    }
  }

  const drawer = evaluationsFor && decisions && (
    <DecisionEvaluationsDrawer
      source={codeHostRoutingEvaluations(decisions.api, decisions.orgId, evaluationsFor.routing)}
      channelName={evaluationsFor.subtitle}
      onClose={() => setEvaluationsFor(null)}
    />
  )
  return { rowOf, drawer }
}
