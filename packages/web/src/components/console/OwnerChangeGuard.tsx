'use client'

// Holds moving a default seat off a gated agent behind the platform's warning: that seat is its only grant there (linear-integration.md §6.2).

import { useCallback, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type { ConversationGate } from '@/lib/data'
import { ConfirmationDialog } from './ConfirmationDialog'
import { channelListSemantics } from './platforms/registry'

/** One owner move, as the caller knows it. */
export interface OwnerChangeMove {
  /** The bot's platform — carried per move, because one Bots card lists several. */
  platform?: string
  /** The row's current owner; absent when the console cannot resolve one. */
  from?: { id: string; label: string; gate: ConversationGate | null }
  toId: string
  /** The row, named the way the operator reads it. */
  room: string
}

/** A move waiting on its confirmation: the copy it renders, the write, and the caller's resolve. */
interface Pending {
  copy: NonNullable<ReturnType<typeof channelListSemantics>['ownerChangeWarning']>
  owner: string
  reason: ConversationGate
  room: string
  apply: () => Promise<void>
  done: () => void
}

/** A declared warning, a resolvable gated outgoing owner, and a different incoming one; exported for its test. */
export function ownerChangeNeedsWarning(move: OwnerChangeMove): boolean {
  if (!channelListSemantics(move.platform).ownerChangeWarning) return false
  return !!move.from?.gate && move.from.id !== move.toId
}

export function useOwnerChangeGuard(): {
  /** Applies the write, or holds it until the warning is confirmed. Resolves either way. */
  guard(move: OwnerChangeMove, apply: () => Promise<void>): Promise<void>
  dialog: ReactNode
} {
  const t = useTranslations('Integrations.channelList')
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const guard = useCallback((move: OwnerChangeMove, apply: () => Promise<void>): Promise<void> => {
    const copy = channelListSemantics(move.platform).ownerChangeWarning
    const from = move.from
    if (!copy || !ownerChangeNeedsWarning(move) || !from?.gate) return apply()
    const reason = from.gate
    return new Promise<void>((done) => setPending({ copy, owner: from.label, reason, room: move.room, apply, done }))
  }, [])

  // Cancelling resolves the caller's promise without writing — its picker stops spinning
  // and the row keeps the owner it had.
  const close = () => {
    if (busy) return
    pending?.done()
    setPending(null)
    setError(null)
  }
  const confirm = () => {
    if (!pending || busy) return
    setBusy(true)
    setError(null)
    pending
      .apply()
      .then(() => {
        pending.done()
        setPending(null)
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  return {
    guard,
    dialog: pending ? (
      <ConfirmationDialog
        title={t(pending.copy.title.key, pending.copy.title.values)}
        confirmLabel={t(pending.copy.confirmLabel.key, pending.copy.confirmLabel.values)}
        busy={busy}
        busyLabel={t('ownerChange.busy')}
        error={error}
        onConfirm={confirm}
        onClose={close}
      >
        {t(pending.copy.body.key, {
          ...pending.copy.body.values,
          owner: pending.owner,
          reason: pending.reason,
          room: pending.room
        })}
      </ConfirmationDialog>
    ) : null
  }
}
