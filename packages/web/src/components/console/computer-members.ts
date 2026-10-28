'use client'

import { useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'

/** Names a member for the Computers pages: "You", their display name or email, or a neutral placeholder. */
export function useMemberName(): (userId: string | null | undefined) => string {
  const t = useTranslations('Computers')
  const { members } = useConsoleData()
  const { me } = useProfile()
  return useCallback(
    (userId) => {
      if (!userId) return t('unknownMember')
      if (me?.userId === userId) return t('you')
      const member = members.find((m) => m.userId === userId)
      return member?.name || member?.email || t('unknownMember')
    },
    [members, me, t]
  )
}

/** The agent's name, or a neutral label for one the caller cannot see. */
export function useAgentName(): (agentId: string | null | undefined, fallback?: string | null) => string {
  const t = useTranslations('Computers')
  const { agents } = useConsoleData()
  return useCallback(
    (agentId, fallback) => {
      const agent = agentId ? agents.find((a) => a.id === agentId) : undefined
      return agent ? agentLabel(agent) : (fallback ?? t('hiddenAgent'))
    },
    [agents, t]
  )
}
