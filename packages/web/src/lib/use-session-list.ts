'use client'

import { useCallback, useMemo } from 'react'
import useSWRInfinite from 'swr/infinite'
import { fetchSessions, type SessionListFilters, type SessionListPage } from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'

const SESSION_PAGE_LIMIT = 50
const SESSION_FALLBACK_REFRESH_MS = 60_000
type SessionPageKey = NonNullable<ReturnType<typeof consoleKeys.sessions>>

export function useSessionList(orgId: string | null | undefined, filters: SessionListFilters = {}) {
  const agentId = filters.agentId ?? ''
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
        githubRepoId
      )
    },
    [agentId, channel, githubRepoId, integration, orgId, platform, triggeredBy]
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
        keyGithubRepoId
      ] = args as SessionPageKey
      return fetchSessions(cursor || undefined, Number(limit), keyOrgId, {
        ...(keyAgentId ? { agentId: keyAgentId } : {}),
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
      parallel: false,
      // SSE is the immediate path; this safety net covers buffering proxies.
      refreshInterval: SESSION_FALLBACK_REFRESH_MS
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
    nextCursor,
    loadingMore,
    loadMore,
    error,
    isLoading,
    isValidating,
    mutate
  }
}
