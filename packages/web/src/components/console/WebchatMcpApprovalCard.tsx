'use client'

import { useState } from 'react'
import useSWR from 'swr'
import {
  decideWebchatMcpOperation,
  getWebchatMcpOperation,
  listWebchatMcpOperations,
  type WebchatMcpOperationDto
} from '@/lib/api'
import { Button } from '@/components/ui'

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
  conversationId,
  className = ''
}: {
  orgId: string
  agentId: string
  conversationId: string
  className?: string
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
    // Capped so a pile of operations can never push the composer off-screen. The strip
    // scrolls on Y only: an overflow-y-auto box computes overflow-x from visible to
    // auto, which is how a wide row used to grow a scrollbar across the whole card.
    <div className={`grid max-h-[34vh] gap-1.5 overflow-y-auto overflow-x-hidden ${className}`} aria-live="polite">
      {pending.map((operation) => (
        // min-w-0: a grid item's auto min-width is its min-content width, so one long
        // unbreakable arg string would widen the row past the strip — and the strip's
        // overflow-y-auto turns that into a card-wide x scrollbar.
        <section
          key={operation.operationId}
          className="min-w-0 rounded-lg border border-(--border-default) bg-(--surface-card) px-3 py-2 shadow-(--shadow-xs)"
        >
          {/* Buttons drop below the text on mobile (same as ApprovalRequestsCard): kept
            on one row, their fixed width would be a min-content floor the strip has to
            clip. */}
          <div className="flex flex-col gap-2 desktop:flex-row desktop:items-center">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="font-mono text-[10px] font-semibold uppercase leading-normal tracking-[.08em] text-(--amber-600)">
                  Approval required
                </span>
                <span className="font-sans text-[12px] font-semibold leading-normal text-(--text-primary)">
                  {operation.toolName}
                </span>
              </div>
              <div className="mt-[2px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                The agent requested this change. Only your approval can execute it.
              </div>
            </div>
            <div className="flex flex-none items-center gap-2">
              <Button
                variant="secondary"
                size="xs"
                disabled={busy !== null}
                onClick={() => void decide(operation, 'deny')}
              >
                {busy === `${operation.operationId}:deny` ? 'Denying…' : 'Deny'}
              </Button>
              <Button size="xs" disabled={busy !== null} onClick={() => void decide(operation, 'approve')}>
                {busy === `${operation.operationId}:approve` ? 'Approving…' : 'Approve and run'}
              </Button>
            </div>
          </div>
          <pre className="mt-1 max-h-24 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-all rounded-md bg-(--surface-sunken) p-2 font-mono text-[10.5px] leading-[1.45] text-(--text-secondary)">
            {JSON.stringify(operation.arguments, null, 2)}
          </pre>
        </section>
      ))}
      {settled.map((entry) => {
        const note = outcomeNote(entry)
        const unresolved = !entry.outcome || entry.outcome.status === 'executing'
        return (
          <section
            key={entry.operation.operationId}
            className="min-w-0 rounded-lg border border-(--border-default) bg-(--surface-card) px-3 py-2 shadow-(--shadow-xs)"
          >
            <div className="flex flex-col gap-2 desktop:flex-row desktop:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="font-mono text-[10px] font-semibold uppercase leading-normal tracking-[.08em] text-(--text-tertiary)">
                    {outcomeLabel(entry)}
                  </span>
                  <span className="font-sans text-[12px] font-semibold leading-normal text-(--text-primary)">
                    {entry.operation.toolName}
                  </span>
                </div>
                {note && (
                  <div className="mt-[2px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                    {note}
                  </div>
                )}
              </div>
              <div className="flex flex-none items-center gap-2">
                {unresolved ? (
                  <Button variant="secondary" size="xs" disabled={busy !== null} onClick={() => void recheck(entry)}>
                    {busy === `${entry.operation.operationId}:recheck` ? 'Checking…' : 'Check status'}
                  </Button>
                ) : (
                  <Button variant="secondary" size="xs" onClick={() => dismiss(entry)}>
                    Dismiss
                  </Button>
                )}
              </div>
            </div>
            {entry.outcome?.result !== undefined && (
              <pre className="mt-1 max-h-24 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-all rounded-md bg-(--surface-sunken) p-2 font-mono text-[10.5px] leading-[1.45] text-(--text-secondary)">
                {JSON.stringify(entry.outcome.result, null, 2)}
              </pre>
            )}
          </section>
        )
      })}
      {error && <p className="font-sans text-[11.5px] font-medium leading-normal text-(--red-600)">{error}</p>}
    </div>
  )
}
