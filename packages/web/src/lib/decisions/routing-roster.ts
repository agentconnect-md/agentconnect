'use client'

// The shared bot, its connected agents, and its conversations as the Routing screen needs them, from live or mock data.

import useSWR from 'swr'
import type { AgentIcon } from '@/lib/agent-icon'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useDecisionsPrototype } from './provider'

export interface RosterAgent {
  id: string
  name: string
  available: boolean
  icon?: AgentIcon | null
  runtime: string
}

export interface RosterChannel {
  channelId: string
  name: string
  kind: 'channel' | 'im' | 'mpim'
  trigger: 'off' | 'mention' | 'any' | 'decision'
  binding: 'gate' | 'shared_bot_routing' | null
  defaultAgentId: string | null
}

export interface RoutingRoster {
  loading: boolean
  error: string | null
  bot: { id: string; name: string; platform: string | null; shared: boolean } | null
  agents: RosterAgent[]
  channels: RosterChannel[]
  /** Revalidates the bot, its agents' availability, and its conversations. */
  refresh: () => void
}

const rank = (kind: RosterChannel['kind']) => (kind === 'channel' ? 0 : 1)

export function useRoutingRoster(botId: string): RoutingRoster {
  const { api, orgId } = useDecisionsPrototype()
  const live = useConsoleData()
  const mock = api.mode === 'mock'
  const { data, error, isLoading, mutate } = useSWR(
    mock && orgId ? ['decision-roster', api.mode, orgId, botId] : null,
    async () => {
      const [bots, channels] = await Promise.all([api.listBots(), api.listChannels(botId)])
      return { bot: bots.find((entry) => entry.id === botId) ?? null, channels }
    }
  )
  if (mock) {
    const bot = data?.bot ?? null
    return {
      loading: isLoading && !data,
      error: error ? (error instanceof Error ? error.message : String(error)) : null,
      bot: bot ? { id: bot.id, name: bot.name, platform: null, shared: bot.shared } : null,
      agents: (bot?.agents ?? []).map((agent) => ({ ...agent, runtime: '' })),
      channels: (data?.channels ?? []).map((channel) => ({
        channelId: channel.id,
        name: channel.name,
        kind: channel.kind === 'dm' ? 'im' : 'channel',
        trigger: channel.settings.trigger === 'auto' ? 'any' : channel.settings.trigger,
        binding: channel.settings.trigger === 'decision' ? channel.settings.decisionBinding.type : null,
        defaultAgentId: channel.agentId || null
      })),
      refresh: () => void mutate()
    }
  }
  const bot = live.bots.find((entry) => entry.id === botId) ?? null
  const merged = new Map<string, RosterChannel>()
  for (const integration of live.integrations) {
    if (integration.botId !== botId) continue
    for (const row of integration.channels) {
      const prior = merged.get(row.channelId)
      if (prior) {
        if (!prior.defaultAgentId && row.agentId) prior.defaultAgentId = row.agentId
        continue
      }
      merged.set(row.channelId, {
        channelId: row.channelId,
        name: row.name,
        kind: row.kind ?? 'channel',
        trigger: row.trigger,
        binding: row.trigger === 'decision' ? (row.decisionBinding?.type ?? null) : null,
        defaultAgentId: row.agentId ?? null
      })
    }
  }
  return {
    loading: !live.botsLoaded || !live.integrationsLoaded,
    error: null,
    bot: bot
      ? { id: bot.id, name: bot.name, platform: bot.platform, shared: bot.transport === 'http' && bot.shareable }
      : null,
    agents: (bot?.agentIds ?? []).map((id) => {
      const agent = live.getAgent(id)
      return {
        id,
        name: agent ? agentLabel(agent) : id,
        available: agent ? (agent.placementReady ?? agent.status === 'online') : false,
        icon: agent?.icon ?? null,
        runtime: agent?.runtime || agent?.model || ''
      }
    }),
    channels: [...merged.values()].sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name)),
    refresh: () => live.refresh()
  }
}
