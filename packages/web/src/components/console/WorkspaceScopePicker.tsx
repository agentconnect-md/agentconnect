'use client'

import Link from 'next/link'
import { Icon } from '@/components/ui'
import type { Session } from '@/lib/data'

function worktreeLabel(session: Pick<Session, 'id' | 'title' | 'time'>): string {
  const title = session.title.trim() || `Session ${session.id.slice(0, 8)}`
  return `Worktree · ${title}${session.time && session.time !== '—' ? ` · ${session.time}` : ''}`
}

export function WorkspaceScopePicker({
  sessions,
  selectedSessionId,
  selectedSession,
  loading,
  hasMore,
  loadingMore,
  onChange,
  onLoadMore,
  orgPath
}: {
  sessions: Session[]
  selectedSessionId: string | null
  selectedSession?: Session
  loading: boolean
  hasMore: boolean
  loadingMore: boolean
  onChange: (sessionId: string | null) => void
  onLoadMore: () => void
  orgPath: (path: string) => string
}) {
  const worktrees = sessions.filter(
    (session) => session.workspaceIsolation === 'session' && session.contentPurgedAt === undefined
  )
  const selectedInList = selectedSessionId ? worktrees.some((session) => session.id === selectedSessionId) : true

  return (
    <div className="card flex flex-wrap items-center gap-[10px] px-4 py-[9px] max-desktop:rounded-lg">
      <span className="eyebrow flex-none text-[10.5px]">Viewing</span>
      <span className="flex h-7 min-w-0 flex-[1_1_260px] items-center gap-2 rounded-md border border-(--border-subtle) bg-(--surface-card) px-2 focus-within:border-(--brand)">
        <Icon name={selectedSessionId ? 'git-branch' : 'folder-git-2'} size={13} className="flex-none" />
        <select
          value={selectedSessionId ?? ''}
          aria-label="Workspace checkout"
          onChange={(event) => onChange(event.target.value || null)}
          className="min-w-0 flex-1 border-0 bg-transparent font-sans text-[12.5px] font-medium leading-normal text-(--text-primary) outline-none"
        >
          <option value="">Primary checkout</option>
          {!selectedInList && selectedSessionId ? (
            <option value={selectedSessionId}>
              {selectedSession ? worktreeLabel(selectedSession) : `Worktree · ${selectedSessionId.slice(0, 8)}`}
            </option>
          ) : null}
          {worktrees.map((session) => (
            <option key={session.id} value={session.id}>
              {worktreeLabel(session)}
            </option>
          ))}
        </select>
      </span>

      {selectedSessionId ? (
        <Link
          href={orgPath(`/sessions/${encodeURIComponent(selectedSessionId)}`)}
          className="lnk flex-none text-[12px] text-(--text-secondary)"
          title="Open this session"
        >
          <Icon name="messages-square" size={13} />
          Session
        </Link>
      ) : null}

      {hasMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="lnk flex-none border-0 bg-transparent text-[12px] disabled:cursor-default disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load older'}
        </button>
      ) : loading && worktrees.length === 0 ? (
        <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          Loading worktrees…
        </span>
      ) : null}
    </div>
  )
}
