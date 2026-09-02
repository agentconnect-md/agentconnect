'use client'

// Holds a conversation-owner move behind the platform's own warning when the move takes
// the default off a RESTRICTED agent. On a platform whose owner compiles to a
// per-conversation DEFAULT rather than an ownership route, that seat is the only grant a
// gated agent holds in the room, so moving it withdraws the grant and the agent's bound
// sessions there become stoppable but not continuable (linear-integration.md §6.2).
// Both owner selectors — the agent page's rows and the org Bots roster — run through
// this, so the two cannot warn differently about the same write.

import { useCallback, useState, type ReactNode } from 'react'
import { ConfirmationDialog } from './ConfirmationDialog'
import { channelListSemantics } from './platforms/registry'

/** One owner move, as the caller knows it. */
export interface OwnerChangeMove {
  /** The bot's platform — carried per move, because one Bots card lists several. */
  platform?: string
  /** The row's current owner; absent when the console cannot resolve one. */
  from?: { id: string; label: string; restricted: boolean }
  toId: string
  /** The row, named the way the operator reads it. */
  room: string
}

/** A move waiting on its confirmation: the copy it renders, the write, and the caller's resolve. */
interface Pending {
  copy: NonNullable<ReturnType<typeof channelListSemantics>['ownerChangeWarning']>
  owner: string
  room: string
  apply: () => Promise<void>
  done: () => void
}

/**
 * Whether this move needs the platform's confirmation at all. Exported because the rule —
 * a declared warning, a resolvable outgoing owner that is restricted, and a genuinely
 * different incoming one — is the whole design and belongs in a test.
 */
export function ownerChangeNeedsWarning(move: OwnerChangeMove): boolean {
  if (!channelListSemantics(move.platform).ownerChangeWarning) return false
  return !!move.from && move.from.restricted && move.from.id !== move.toId
}

export function useOwnerChangeGuard(): {
  /** Applies the write, or holds it until the warning is confirmed. Resolves either way. */
  guard(move: OwnerChangeMove, apply: () => Promise<void>): Promise<void>
  dialog: ReactNode
} {
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const guard = useCallback((move: OwnerChangeMove, apply: () => Promise<void>): Promise<void> => {
    const copy = channelListSemantics(move.platform).ownerChangeWarning
    const from = move.from
    if (!copy || !ownerChangeNeedsWarning(move) || !from) return apply()
    return new Promise<void>((done) => setPending({ copy, owner: from.label, room: move.room, apply, done }))
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
        title={pending.copy.title}
        confirmLabel={pending.copy.confirmLabel}
        busy={busy}
        busyLabel="Moving…"
        error={error}
        onConfirm={confirm}
        onClose={close}
      >
        {pending.copy.body({ owner: pending.owner, room: pending.room })}
      </ConfirmationDialog>
    ) : null
  }
}
