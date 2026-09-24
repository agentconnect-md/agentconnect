'use client'

// A code-host repository's decision routing per provider and subject family, read and written through the CP (code-host-decisions.md §3.1).

import { useCallback } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import {
  CODE_HOST_ROUTING_PROVIDER_FAMILIES,
  type CodeHostRoutingProvider,
  type SharedBotDecisionRouting
} from '@agentconnect.md/protocol/decision'
import {
  deleteCodeHostRouting,
  fetchCodeHostRouting,
  saveCodeHostRouting,
  type CodeHostRoutingDto,
  type CodeHostRoutingFamily,
  type CodeHostRoutingKey
} from '@/lib/api'
import type { AgentIcon } from '@/lib/agent-icon'
import { CODE_HOST_PROJECTION } from '@/lib/code-hosts'
import { useOptionalDecisionsPrototype } from './provider'
import type { RosterAgent } from './routing-roster'

export interface CodeHostRoutingScope extends CodeHostRoutingKey {
  repoFullName: string
}

export type CodeHostRoutingMember = CodeHostRoutingDto['members'][number]

/** One scope's identity within an organization: provider, repository and family. */
export const codeHostScopeId = (scope: CodeHostRoutingKey) => `${scope.provider}|${scope.repoId}|${scope.family}`

/** A hook row's routing scope when its provider routes its family (the protocol's table); null otherwise. */
export function codeHostRoutingScopeOf(
  hook: { kind: string; repoId?: string | null; repoFullName: string | null; name: string },
  family: string | null
): CodeHostRoutingScope | null {
  const families = CODE_HOST_ROUTING_PROVIDER_FAMILIES[hook.kind as CodeHostRoutingProvider] as
    readonly string[] | undefined
  if (!hook.repoId || !family || !families?.includes(family)) return null
  return {
    provider: hook.kind as CodeHostRoutingProvider,
    repoId: hook.repoId,
    family: family as CodeHostRoutingFamily,
    repoFullName: hook.repoFullName ?? hook.name
  }
}

/** The copy selector for a scope's subject: `issues`, or what its host calls a proposed change. */
export const codeHostRoutingSubject = (scope: CodeHostRoutingKey): 'issues' | 'pull_request' | 'merge_request' =>
  scope.family === 'issues' ? 'issues' : CODE_HOST_PROJECTION[scope.provider].changeNoun

/** A saved routing that is on: its scope's @-mention trigger is unavailable. */
export const codeHostRouted = (routing: CodeHostRoutingDto | null | undefined) => routing?.config?.enabled === true

/** The members as rule targets, each with the console's icon and availability when it knows the agent. */
export function routingTargets(
  members: readonly CodeHostRoutingMember[],
  agentOf: (
    id: string
  ) =>
    | { icon?: AgentIcon | null; runtime?: string; model?: string; placementReady?: boolean; status?: string }
    | undefined,
  firstId?: string,
  hiddenName = ''
): RosterAgent[] {
  return [...members]
    .sort((a, b) => Number(b.agentId === firstId) - Number(a.agentId === firstId))
    .map((member) => {
      const agent = agentOf(member.agentId)
      return {
        id: member.agentId,
        name: member.name ?? hiddenName,
        available: agent ? (agent.placementReady ?? agent.status === 'online') : true,
        icon: agent?.icon ?? null,
        runtime: agent?.runtime || agent?.model || ''
      }
    })
}

// Mock mode keeps routings in memory, with the caller's visible agents as members.
const mockConfigs = new Map<string, SharedBotDecisionRouting>()

function mockRouting(
  orgId: string,
  scope: CodeHostRoutingScope,
  members: readonly CodeHostRoutingMember[]
): CodeHostRoutingDto {
  const config = mockConfigs.get(`${orgId}|${codeHostScopeId(scope)}`) ?? null
  return {
    provider: scope.provider,
    repoId: scope.repoId,
    repoFullName: scope.repoFullName,
    family: scope.family,
    config: config ? structuredClone(config) : null,
    status: config ? 'enabled' : null,
    members: [...members],
    evaluationAgentId: members[0]?.agentId ?? null
  }
}

/** Tests start from an empty mock store. */
export function resetCodeHostRoutingMock() {
  mockConfigs.clear()
}

type RoutingMap = Readonly<Record<string, CodeHostRoutingDto | null>>

/** Each scope's routing by {@link codeHostScopeId}; a scope the CP cannot serve (older CP, no access) reads null. */
export function useCodeHostRoutings(
  scopes: readonly CodeHostRoutingScope[],
  mockMembers: readonly CodeHostRoutingMember[] = []
): { routings: RoutingMap; loading: boolean } {
  const prototype = useOptionalDecisionsPrototype()
  const mode = prototype?.api.mode
  const orgId = prototype?.orgId ?? ''
  const ids = [...new Set(scopes.map(codeHostScopeId))].sort()
  const key = prototype && orgId && ids.length > 0 ? ['code-host-routings', mode, orgId, ...ids] : null
  const { data, isLoading } = useSWR(key, async () => {
    const entries = await Promise.all(
      scopes.map(async (scope): Promise<[string, CodeHostRoutingDto | null]> => {
        try {
          const routing =
            mode === 'mock' ? mockRouting(orgId, scope, mockMembers) : await fetchCodeHostRouting(scope, orgId)
          // An older CP omits `provider`; the scope that was asked for is the routing's address.
          return [codeHostScopeId(scope), { ...routing, provider: scope.provider }]
        } catch {
          return [codeHostScopeId(scope), null]
        }
      })
    )
    return Object.fromEntries(entries) as RoutingMap
  })
  return { routings: data ?? {}, loading: isLoading }
}

/** Save (PUT) and stop (DELETE) one scope's routing, updating every loaded read of it. */
export function useCodeHostRoutingActions() {
  const prototype = useOptionalDecisionsPrototype()
  const mode = prototype?.api.mode
  const orgId = prototype?.orgId ?? ''
  const { mutate } = useSWRConfig()
  const apply = useCallback(
    async (next: CodeHostRoutingDto) => {
      const id = codeHostScopeId(next)
      await mutate(
        (key) =>
          Array.isArray(key) &&
          key[0] === 'code-host-routings' &&
          key[1] === mode &&
          key[2] === orgId &&
          key.includes(id),
        (current: RoutingMap | undefined) => (current ? { ...current, [id]: next } : current),
        { revalidate: false }
      )
    },
    [mutate, mode, orgId]
  )
  const save = useCallback(
    async (current: CodeHostRoutingDto, config: SharedBotDecisionRouting) => {
      let next: CodeHostRoutingDto
      if (mode === 'mock') {
        mockConfigs.set(`${orgId}|${codeHostScopeId(current)}`, structuredClone(config))
        next = mockRouting(orgId, current, current.members)
      } else next = { ...(await saveCodeHostRouting(current, config, orgId)), provider: current.provider }
      await apply(next)
      return next
    },
    [mode, orgId, apply]
  )
  const remove = useCallback(
    async (current: CodeHostRoutingDto) => {
      if (mode === 'mock') mockConfigs.delete(`${orgId}|${codeHostScopeId(current)}`)
      else await deleteCodeHostRouting(current, orgId)
      await apply({ ...current, config: null, status: null })
    },
    [mode, orgId, apply]
  )
  return { save, remove }
}
