'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { decideAgentPermissionRequest, fetchAgentPermissionRequests, type AgentPermissionRequestDto } from '@/lib/api'
import { MOCK_MODE } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { Button } from '@/components/ui'

export function ApprovalRequestsCard({
  agentId,
  sessionId,
  hideWhenEmpty = false,
  className = ''
}: {
  agentId: string
  sessionId?: string
  hideWhenEmpty?: boolean
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
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const requests = sessionId ? allRequests?.filter((request) => request.sessionId === sessionId) : allRequests

  if (hideWhenEmpty && !requests?.length) return null

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

  const pendingCount = requests?.filter((request) => request.status === 'pending').length ?? 0

  return (
    <div className={`card overflow-hidden ${className}`}>
      <div className="flex min-h-[53px] items-center justify-between border-b border-(--border-subtle) px-4 py-3 desktop:min-h-[55px] desktop:py-[13px]">
        <span className="font-sans text-[14px] font-semibold leading-normal">Approval requests</span>
        {pendingCount > 0 && <span className="badge bg-(--amber-50) text-(--amber-600)">{pendingCount} pending</span>}
      </div>
      {isLoading ? (
        <div className="px-4 py-5 font-sans text-[13px] text-(--text-tertiary)">Loading requests…</div>
      ) : error && allRequests === undefined ? (
        <div className="px-4 py-5 font-sans text-[13px] text-(--text-tertiary)">
          Approval requests are temporarily unavailable.
        </div>
      ) : requests?.length ? (
        <div>
          {requests.map((request, index) => {
            const allowBusy = busy === `${request.id}:allow`
            const denyBusy = busy === `${request.id}:deny`
            return (
              <div
                key={request.id}
                className={`flex flex-col gap-3 px-4 py-3 desktop:flex-row desktop:items-center ${
                  index > 0 ? 'border-t border-(--border-subtle)' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                      {request.requesterName ?? request.requesterId ?? 'Unknown user'}
                    </span>
                    <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                      {formatApprovalTime(request.createdAt)}
                    </span>
                    {request.status !== 'pending' && (
                      <span className="badge bg-(--surface-active) text-(--text-tertiary)">{request.status}</span>
                    )}
                  </div>
                  <div className="mt-1 break-words font-mono text-[12px] leading-[1.5] text-(--text-secondary)">
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
        <div className="px-4 py-5 font-sans text-[13px] text-(--text-tertiary)">No approval requests yet.</div>
      )}
      {decisionError && (
        <div className="border-t border-(--border-subtle) px-4 py-3 font-sans text-[12px] text-(--red-600)">
          {decisionError}
        </div>
      )}
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
