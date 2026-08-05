'use client'

import { useCallback, useMemo } from 'react'
import useSWRInfinite from 'swr/infinite'
import { fetchConversations, fetchSessions, type SessionListFilters, type SessionListPage } from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'

const SESSION_PAGE_LIMIT = 50
type SessionPageKey = NonNullable<ReturnType<typeof consoleKeys.sessions>>

/** The agent filter as one scalar SWR key part. Sorted so the same set of agents
 *  always addresses the same cache entry regardless of the order they were
 *  picked in — the CP's answer does not depend on it either. */
export function sessionFilterAgentKey(agentId: SessionListFilters['agentId']): string {
  if (!agentId) return ''
  return (typeof agentId === 'string' ? [agentId] : [...agentId]).filter(Boolean).sort().join(',')
}

export function useSessionList(
  orgId: string | null | undefined,
  filters: SessionListFilters = {},
  // GROUPED by default — one row per conversation (merged-conversation-view.md
  // §5.2). A conversation is the unit the console talks about everywhere it
  // lists runs, so the flat view is the exception, not the default: reading it
  // by accident lists a thread once per agent that answered in it, and once
  // more per superseded ACP session. `grouped: false` is for a consumer that
  // genuinely wants session rows.
  options: { grouped?: boolean } = {}
) {
  const grouped = options.grouped !== false
  // The key is a scalar cache discriminator, so a multi-agent filter travels as
  // one comma-joined string and the fetcher splits it back into repeated params.
  const agentId = sessionFilterAgentKey(filters.agentId)
  const integration = filters.integration ?? ''
  const platform = filters.platform ?? ''
  const channel = filters.channel ?? ''
  const triggeredBy = filters.triggeredBy ?? ''
  const githubRepoId = filters.githubRepoId ?? ''
  const getKey = useCallback(
    (pageIndex: number, previousPage: SessionListPage | null) => {
      if (!orgId) return null
      if (previousPage && !previousPage.nextCursor) return null
      const cursor = pageIndex === 0 ? '' : (previousPage?.nextCursor ?? '')
      return consoleKeys.sessions(
        orgId,
        cursor,
        String(SESSION_PAGE_LIMIT),
        agentId,
        integration,
        platform,
        channel,
        triggeredBy,
        githubRepoId,
        grouped ? 'grouped' : 'flat'
      )
    },
    [agentId, channel, githubRepoId, grouped, integration, orgId, platform, triggeredBy]
  )
  const {
    data: pages = [],
    error,
    isLoading,
    isValidating,
    size,
    setSize,
    mutate
  } = useSWRInfinite<SessionListPage>(
    getKey,
    (args) => {
      const [
        ,
        keyOrgId,
        ,
        cursor,
        limit,
        keyAgentId,
        keyIntegration,
        keyPlatform,
        keyChannel,
        keyTriggeredBy,
        keyGithubRepoId,
        keyView
      ] = args as SessionPageKey
      const fetchPage = keyView === 'grouped' ? fetchConversations : fetchSessions
      return fetchPage(cursor || undefined, Number(limit), keyOrgId, {
        ...(keyAgentId ? { agentId: keyAgentId.split(',') } : {}),
        ...(keyIntegration ? { integration: keyIntegration } : {}),
        ...(keyPlatform ? { platform: keyPlatform } : {}),
        ...(keyChannel ? { channel: keyChannel } : {}),
        ...(keyTriggeredBy ? { triggeredBy: keyTriggeredBy } : {}),
        ...(keyGithubRepoId ? { githubRepoId: keyGithubRepoId } : {})
      })
    },
    {
      // Cursor pages are sequential. Revalidate every loaded page from page one
      // so a session moving to the top cannot leave stale cursor boundaries.
      revalidateAll: true,
      persistSize: false,
      // SSE is the immediate path. Focus, reconnect and explicit refresh retain
      // the fallback without polling live provider authorization every minute.
      parallel: false
    }
  )

  const sessions = useMemo(() => {
    const byId = new Map<string, SessionListPage['sessions'][number]>()
    for (const page of pages) {
      for (const session of page.sessions) byId.set(session.id, session)
    }
    return [...byId.values()]
  }, [pages])
  const nextCursor = pages.at(-1)?.nextCursor ?? null
  const accessIssues = useMemo(
    () => [
      ...new Map(
        pages
          .flatMap((page) => page.accessIssues ?? [])
          .map((issue) => [`${issue.provider}:${issue.region ?? ''}:${issue.reason}`, issue])
      ).values()
    ],
    [pages]
  )
  const loadingMore = isValidating && size > pages.length
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    try {
      await setSize(pages.length + 1)
    } catch {
      // SWR exposes the page error while retaining the last good rows.
    }
  }, [loadingMore, nextCursor, pages.length, setSize])

  return {
    sessions,
    total: pages[0]?.total ?? 0,
    /** Org-level "any session exists" (first page carries it; older CPs omit it). */
    orgHasSessions: pages[0]?.orgHasSessions,
    accessSyncDegraded: pages.some((page) => page.accessSyncDegraded === true),
    accessIssues,
    nextCursor,
    loadingMore,
    loadMore,
    error,
    isLoading,
    isValidating,
    mutate
  }
}
