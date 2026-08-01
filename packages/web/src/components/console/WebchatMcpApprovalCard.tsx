'use client'

import { useState } from 'react'
import useSWR from 'swr'
import {
  decideWebchatMcpOperation,
  getWebchatMcpOperation,
  listWebchatMcpOperations,
  type WebchatMcpOperationDto
} from '@/lib/api'

/** A decided (or decision-lost) operation the owner must still be able to see.
 *  `outcome` is the last DTO the CP returned; `null` means the decision response
 *  was lost and the true state is unknown until an exact-operation refetch. */
interface SettledOperation {
  operation: WebchatMcpOperationDto
  decision: 'approve' | 'deny'
  outcome: WebchatMcpOperationDto | null
}

const OUTCOME_LABEL: Record<WebchatMcpOperationDto['status'], string> = {
  awaiting_confirmation: 'Awaiting confirmation',
  executing: 'Executing…',
  completed: 'Completed',
  failed: 'Failed',
  ambiguous: 'Outcome uncertain',
  stale: 'Expired'
}

function outcomeLabel(entry: SettledOperation): string {
  if (!entry.outcome) return 'Outcome unknown'
  if (entry.decision === 'deny' && entry.outcome.status === 'failed') return 'Denied'
  return OUTCOME_LABEL[entry.outcome.status]
}

function outcomeNote(entry: SettledOperation): string | null {
  if (!entry.outcome) return 'The decision response was lost. Check the status to verify whether the operation ran.'
  switch (entry.outcome.status) {
    case 'ambiguous':
      return 'The operation may or may not have run. Verify the result manually before retrying it.'
    case 'executing':
      return 'The operation is still running. Check the status again for its final result.'
    case 'stale':
      return 'The confirmation expired or was superseded before it could run.'
    default:
      return null
  }
}

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
  const [settled, setSettled] = useState<SettledOperation[]>([])
  const settledIds = new Set(settled.map((entry) => entry.operation.operationId))
  const pending = (data ?? []).filter((operation) => !settledIds.has(operation.operationId))
  if (pending.length === 0 && settled.length === 0) return null

  const upsertSettled = (entry: SettledOperation) =>
    setSettled((current) => [
      ...current.filter((existing) => existing.operation.operationId !== entry.operation.operationId),
      entry
    ])

  const decide = async (operation: WebchatMcpOperationDto, decision: 'approve' | 'deny') => {
    setBusy(`${operation.operationId}:${decision}`)
    setError(null)
    try {
      const outcome = await decideWebchatMcpOperation(orgId, agentId, conversationId, operation.operationId, decision)
      upsertSettled({ operation, decision, outcome })
    } catch {
      // The CP may have executed the decision even though the response was lost
      // (network drop) or rejected it (409 race). Refetch the exact operation so
      // the owner sees its true terminal state instead of it silently vanishing.
      try {
        const outcome = await getWebchatMcpOperation(orgId, agentId, conversationId, operation.operationId)
        if (outcome.status === 'awaiting_confirmation') {
          setError('The decision was not applied. Try again.')
        } else {
          upsertSettled({ operation, decision, outcome })
        }
      } catch {
        upsertSettled({ operation, decision, outcome: null })
        setError('The decision response was lost. Check the operation status to verify the outcome.')
      }
    } finally {
      setBusy(null)
      await mutate()
    }
  }

  const recheck = async (entry: SettledOperation) => {
    setBusy(`${entry.operation.operationId}:recheck`)
    setError(null)
    try {
      const outcome = await getWebchatMcpOperation(orgId, agentId, conversationId, entry.operation.operationId)
      if (outcome.status === 'awaiting_confirmation') {
        // The decision never reached the CP — put the card back in the pending list.
        setSettled((current) => current.filter((existing) => existing !== entry))
        await mutate()
      } else {
        upsertSettled({ ...entry, outcome })
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not check the operation status.')
    } finally {
      setBusy(null)
    }
  }

  const dismiss = (entry: SettledOperation) => setSettled((current) => current.filter((existing) => existing !== entry))

  return (
    <div className="grid gap-2" aria-live="polite">
      {pending.map((operation) => (
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
      {settled.map((entry) => {
        const note = outcomeNote(entry)
        const unresolved = !entry.outcome || entry.outcome.status === 'executing'
        return (
          <section
            key={entry.operation.operationId}
            className="rounded-lg border border-(--border-default) bg-(--surface-card) p-4 shadow-(--shadow-xs)"
          >
            <div className="font-mono text-[10.5px] font-semibold uppercase leading-normal tracking-[.08em] text-(--text-tertiary)">
              {outcomeLabel(entry)}
            </div>
            <div className="mt-1 font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
              {entry.operation.toolName}
            </div>
            {entry.outcome?.result !== undefined && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-(--surface-sunken) p-3 font-mono text-[11px] leading-[1.5] text-(--text-secondary)">
                {JSON.stringify(entry.outcome.result, null, 2)}
              </pre>
            )}
            {note && (
              <p className="mt-2 font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">{note}</p>
            )}
            <div className="mt-3 flex justify-end gap-2">
              {unresolved && (
                <button className="dsbtn dsbtn-secondary" disabled={busy !== null} onClick={() => void recheck(entry)}>
                  {busy === `${entry.operation.operationId}:recheck` ? 'Checking…' : 'Check status'}
                </button>
              )}
              {!unresolved && (
                <button className="dsbtn dsbtn-secondary" onClick={() => dismiss(entry)}>
                  Dismiss
                </button>
              )}
            </div>
          </section>
        )
      })}
      {error && <p className="font-sans text-[11.5px] font-medium leading-normal text-(--red-600)">{error}</p>}
    </div>
  )
}
