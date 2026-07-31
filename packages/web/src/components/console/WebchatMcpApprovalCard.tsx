'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { decideWebchatMcpOperation, listWebchatMcpOperations, type WebchatMcpOperationDto } from '@/lib/api'

export function WebchatMcpApprovalCard({
  orgId,
  agentId,
  conversationId
}: {
  orgId: string
  agentId: string
  conversationId: string
}) {
  const { data, mutate } = useSWR(
    ['webchat-mcp-operations', orgId, agentId, conversationId] as const,
    () => listWebchatMcpOperations(orgId, agentId, conversationId),
    { refreshInterval: 2_000 }
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const operations = data ?? []
  if (operations.length === 0) return null

  const decide = async (operation: WebchatMcpOperationDto, decision: 'approve' | 'deny') => {
    setBusy(`${operation.operationId}:${decision}`)
    setError(null)
    try {
      await decideWebchatMcpOperation(orgId, agentId, conversationId, operation.operationId, decision)
      await mutate()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not decide the operation.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid gap-2" aria-live="polite">
      {operations.map((operation) => (
        <section
          key={operation.operationId}
          className="rounded-lg border border-(--border-default) bg-(--surface-card) p-4 shadow-(--shadow-xs)"
        >
          <div className="font-mono text-[10.5px] font-semibold uppercase leading-normal tracking-[.08em] text-(--text-tertiary)">
            Approval required
          </div>
          <div className="mt-1 font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
            {operation.toolName}
          </div>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-(--surface-sunken) p-3 font-mono text-[11px] leading-[1.5] text-(--text-secondary)">
            {JSON.stringify(operation.arguments, null, 2)}
          </pre>
          <p className="mt-2 font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
            The agent requested this change. Only your approval can execute it.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              className="dsbtn dsbtn-secondary"
              disabled={busy !== null}
              onClick={() => void decide(operation, 'deny')}
            >
              {busy === `${operation.operationId}:deny` ? 'Denying…' : 'Deny'}
            </button>
            <button
              className="dsbtn dsbtn-primary"
              disabled={busy !== null}
              onClick={() => void decide(operation, 'approve')}
            >
              {busy === `${operation.operationId}:approve` ? 'Approving…' : 'Approve and run'}
            </button>
          </div>
        </section>
      ))}
      {error && <p className="font-sans text-[11.5px] font-medium leading-normal text-(--red-600)">{error}</p>}
    </div>
  )
}
