'use client'

// The `/` picker's candidate pool: what every participant's runtime advertised it can be asked to
// run. Fetched when the conversation opens rather than on the keystroke — each read is a CP → daemon
// round trip, and a roster of five would otherwise fire five of them the moment `/` is pressed.

import { useMemo } from 'react'
import useSWR from 'swr'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { fetchAgentRuntimeCommands, type RuntimeCommandsDto } from '@/lib/api'
import { MOCK_MODE } from '@/lib/data'
import { offerableCommands, type CommandCandidate } from '@/components/console/runtime-command-menu'

// Demo advertisement for mock mode, mirroring real adapter shapes (claude suffix-classified names,
// a codex `$` name, argument hints) so the picker is demoable and its layout visually testable.
const MOCK_COMMANDS: RuntimeCommandsDto = {
  reported: true,
  commands: [
    {
      name: 'deploy-checklist',
      description: 'Walk the release checklist: build, canary, dashboards, rollout gates.',
      hint: '[service]',
      skill: true
    },
    {
      name: 'code-review',
      description: 'Review the current diff against the team conventions and open questions.',
      hint: '[pr-number]',
      skill: true
    },
    {
      name: '$rollback',
      description: 'Roll the named service back to the last good build.',
      hint: '<service>',
      skill: true
    },
    { name: 'triage', description: 'Sort the incoming issues by severity and route them.', hint: null, skill: true }
  ]
}

/** Why one participant contributes nothing, so the picker can say so instead of going blank. */
export type RuntimeCommandsGap = 'unreported' | 'unavailable'

export interface RosterCommands {
  candidates: CommandCandidate[]
  /** Participants that answered with nothing, and why. */
  gaps: Array<{ agentId: string; agentName: string; reason: RuntimeCommandsGap }>
  loading: boolean
}

export function useRuntimeCommands(
  roster: ReadonlyArray<{ agentId: string; name: string }>,
  enabled: boolean
): RosterCommands {
  const { activeOrg } = useOrgs()
  // Sorted + joined so the key is stable across re-renders that reorder the roster.
  const ids = useMemo(() => roster.map((p) => p.agentId).sort(), [roster])
  const names = useMemo(() => new Map(roster.map((p) => [p.agentId, p.name])), [roster])
  const key = enabled && ids.length > 0 ? consoleKeys.agentRuntimeCommands(activeOrg?.id, ids.join(',')) : null

  // allSettled, not all: one offline daemon or one daemon too old to answer must not blank the whole
  // menu — that participant becomes a gap and the rest still list.
  const { data, isLoading } = useSWR(key, async () => {
    if (MOCK_MODE) {
      return ids.map((agentId) => ({ agentId, result: { status: 'fulfilled', value: MOCK_COMMANDS } as const }))
    }
    const settled = await Promise.allSettled(ids.map((id) => fetchAgentRuntimeCommands(id)))
    return ids.map((agentId, index) => ({ agentId, result: settled[index]! }))
  })

  return useMemo(() => {
    const candidates: CommandCandidate[] = []
    const gaps: RosterCommands['gaps'] = []
    for (const row of data ?? []) {
      const agentName = names.get(row.agentId) ?? ''
      if (row.result.status === 'rejected') {
        gaps.push({ agentId: row.agentId, agentName, reason: 'unavailable' })
        continue
      }
      const value = row.result.value
      if (!value.reported) {
        gaps.push({ agentId: row.agentId, agentName, reason: 'unreported' })
        continue
      }
      candidates.push(...offerableCommands({ agentId: row.agentId, agentName }, value.commands))
    }
    return { candidates, gaps, loading: isLoading }
  }, [data, isLoading, names])
}
