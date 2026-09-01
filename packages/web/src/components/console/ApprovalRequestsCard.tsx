'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { decideAgentPermissionRequest, fetchAgentPermissionRequests, type AgentPermissionRequestDto } from '@/lib/api'
import { MOCK_MODE } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { Button, Icon } from '@/components/ui'

export function ApprovalRequestsCard({
  agentId,
  sessionId,
  pendingOnly = false,
  bare = false,
  className = ''
}: {
  agentId: string
  sessionId?: string
  /** Composer strip mode: only unanswered requests, hidden entirely when none. */
  pendingOnly?: boolean
  /** Rows only, no card chrome / header / collapse — for embedding in a popover. */
  bare?: boolean
  className?: string
}) {
  const { activeOrg } = useOrgs()
  const requestsKey = MOCK_MODE ? null : consoleKeys.agentPermissionRequests(activeOrg?.id, agentId)
  const {
    data: allRequests,
    error,
    isLoading,
    mutate
  } = useSWR<AgentPermissionRequestDto[]>(requestsKey, ([, , , id]) => fetchAgentPermissionRequests(id as string), {
    refreshInterval: 3_000,
    shouldRetryOnError: false
  })
  const [busy, setBusy] = useState<string | null>(null)
  // Collapse follows the pending set by default — nothing to answer, nothing to
  // show — and a manual toggle only overrides that until the SET changes. Keyed
  // by the pending ids (not the count): a count can return to its old value with
  // different requests in it, and a stale "collapsed at 1 pending" must not hide
  // a genuinely new request.
  const [collapseOverride, setCollapseOverride] = useState<{ key: string; collapsed: boolean } | null>(null)
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const sessionRequests = sessionId ? allRequests?.filter((request) => request.sessionId === sessionId) : allRequests
  const pendingRequests = sessionRequests?.filter((request) => request.status === 'pending') ?? []
  const pendingCount = pendingRequests.length
  const pendingKey = pendingRequests
    .map((request) => request.id)
    .sort()
    .join('\n')
  // The composer strip only shows what still needs an answer: fully-resolved
  // history lives behind the header's Requests popover instead.
  const requests = pendingOnly ? sessionRequests && pendingRequests : sessionRequests

  if (pendingOnly && pendingCount === 0) return null

  const decide = async (request: AgentPermissionRequestDto, decision: 'allow' | 'deny') => {
    if (busy || request.status !== 'pending') return
    setBusy(`${request.id}:${decision}`)
    setDecisionError(null)
    try {
      await decideAgentPermissionRequest(agentId, request.id, decision)
      void mutate(
        (rows) =>
          rows?.map((row) =>
            row.id === request.id
              ? {
                  ...row,
                  status: decision === 'allow' ? ('allowed' as const) : ('denied' as const),
                  resolvedAt: new Date().toISOString()
                }
              : row
          ),
        { revalidate: false }
      )
    } catch {
      setDecisionError('This approval request could not be updated. Try again.')
      void mutate()
    } finally {
      setBusy(null)
    }
  }

  const collapsed = collapseOverride?.key === pendingKey ? collapseOverride.collapsed : pendingCount === 0

  const body = (
    <>
      {isLoading ? (
        <div className="px-3 py-3 font-sans text-[12px] text-(--text-tertiary)">Loading requests…</div>
      ) : error && allRequests === undefined ? (
        <div className="px-3 py-3 font-sans text-[12px] text-(--text-tertiary)">
          Approval requests are temporarily unavailable.
        </div>
      ) : requests?.length ? (
        // Capped so a pile of requests can never push the composer off-screen.
        <div className="max-h-[34vh] overflow-y-auto">
          {requests.map((request, index) => {
            const allowBusy = busy === `${request.id}:allow`
            const denyBusy = busy === `${request.id}:deny`
            return (
              <div
                key={request.id}
                className={`flex flex-col gap-2 px-3 py-2 desktop:flex-row desktop:items-center ${
                  index > 0 ? 'border-t border-(--border-subtle)' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className="font-sans text-[12px] font-semibold leading-normal text-(--text-primary)">
                      {request.requesterName ?? request.requesterId ?? 'Unknown user'}
                    </span>
                    <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      {formatApprovalTime(request.createdAt)}
                    </span>
                    {request.status !== 'pending' && (
                      <span className="badge bg-(--surface-active) text-(--text-tertiary)">
                        {request.status}
                        {request.resolvedByName ? ` · ${request.resolvedByName}` : ''}
                      </span>
                    )}
                  </div>
                  <div
                    className="mt-[2px] line-clamp-2 break-words font-mono text-[11.5px] leading-[1.45] text-(--text-secondary)"
                    title={request.command}
                  >
                    {request.command}
                  </div>
                </div>
                {request.status === 'pending' && (
                  <div className="flex flex-none items-center gap-2">
                    <Button
                      variant="secondary"
                      size="xs"
                      disabled={busy !== null}
                      onClick={() => void decide(request, 'deny')}
                    >
                      {denyBusy ? 'Denying…' : 'Deny'}
                    </Button>
                    <Button size="xs" disabled={busy !== null} onClick={() => void decide(request, 'allow')}>
                      {allowBusy ? 'Allowing…' : 'Allow'}
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="px-3 py-3 font-sans text-[12px] text-(--text-tertiary)">No approval requests yet.</div>
      )}
      {decisionError && (
        <div className="border-t border-(--border-subtle) px-3 py-2 font-sans text-[11.5px] text-(--red-600)">
          {decisionError}
        </div>
      )}
    </>
  )

  if (bare) return <div className={className}>{body}</div>

  return (
    <div className={`card overflow-hidden ${className}`}>
      {/* Collapsed, the card is just this one header row — the pending count stays
        visible so it can be reopened knowingly. */}
      <div
        className={`flex items-center justify-between px-3 py-[6px] ${collapsed ? '' : 'border-b border-(--border-subtle)'}`}
      >
        <button
          type="button"
          onClick={() => setCollapseOverride({ key: pendingKey, collapsed: !collapsed })}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 text-left"
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={13} color="var(--text-tertiary)" />
          <span className="font-sans text-[12.5px] font-semibold leading-normal">
            {pendingOnly ? 'Pending requests' : 'Approval requests'}
          </span>
        </button>
        {pendingCount > 0 && <span className="badge bg-(--amber-50) text-(--amber-600)">{pendingCount} pending</span>}
      </div>
      {collapsed ? null : body}
    </div>
  )
}

function formatApprovalTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}
