'use client'

import type { ReactNode } from 'react'
import { useParams } from 'next/navigation'
import SessionDetailView from '@/components/console/views/SessionDetailView'

export function SessionsRouteFrame({ children }: { children: ReactNode }) {
  const { id, key } = useParams<{ id?: string; key?: string }>()

  // The frame lives in /sessions/layout rather than [id]/page. That static
  // layout survives /sessions/a -> /sessions/b, so React updates the existing
  // detail view instead of rebuilding the whole right-hand page. The
  // /conversations/[key] route mounts the SAME view in merged-conversation
  // mode (merged-conversation-view.md §5.3).
  return id || key ? <SessionDetailView /> : children
}
