'use client'

import useSWR from 'swr'
import { fetchAssistantSubsession, type AssistantSubsessionDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'

/** The coordinator a threaded task belongs to now, read from its daemon by the task's own session (auto-session-mode.md §11); null for any other session. */
export function useThreadedTaskParent(agentId: string | null, sessionId: string): AssistantSubsessionDto['parent'] {
  const { activeOrg } = useOrgs()
  const { data } = useSWR(
    agentId ? consoleKeys.assistantSubsession(activeOrg?.id, agentId, sessionId) : null,
    () => fetchAssistantSubsession(agentId!, sessionId),
    { shouldRetryOnError: false, revalidateOnFocus: false }
  )
  return data?.threaded && data.visible ? data.parent : null
}
