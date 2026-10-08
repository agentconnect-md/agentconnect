'use client'

// Holds enabling a room or group DM of an assistant-mode agent behind its trust warning (assistant-mode.md §1.8, §5.3).

import { useCallback, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { isDirectConversation, type IntegrationChannelRow } from '@/lib/data'
import { ConfirmationDialog } from './ConfirmationDialog'

/** Whether a row's trigger change enables a room or group DM of an assistant-mode agent; a 1:1 DM is trusting one person. */
export function placeEnableNeedsWarning(
  row: Pick<IntegrationChannelRow, 'kind'>,
  from: string,
  to: string,
  assistantMode: boolean
): boolean {
  return assistantMode && row.kind !== 'im' && from === 'off' && to !== 'off'
}

/** The rooms and group DMs already enabled among `rows`, which the switch warns about as it turns on. */
export function enabledSharedPlaces<T extends Pick<IntegrationChannelRow, 'kind' | 'trigger'>>(
  rows: readonly T[]
): T[] {
  return rows.filter((row) => (row.kind ?? 'channel') !== 'im' && row.trigger !== 'off')
}

/** How a place is named in the warning: a room with its glyph, a group DM by its members. */
export function placeName(row: Pick<IntegrationChannelRow, 'kind' | 'name'>, glyph: string): string {
  return isDirectConversation(row.kind) ? row.name.replace(/^@+/, '') : `${glyph}${row.name}`
}

interface Pending {
  title: string
  confirmLabel: string
  places: readonly string[]
  apply: () => void | Promise<void>
  done: () => void
}

export function useAssistantPlaceWarning(): {
  /** Holds `apply` until the warning is confirmed; resolves either way. */
  confirmBefore(
    ask: { title: string; confirmLabel: string; places?: readonly string[] },
    apply: () => void | Promise<void>
  ): Promise<void>
  dialog: ReactNode
} {
  const t = useTranslations('Integrations.channelList.assistantPlace')
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirmBefore = useCallback(
    (ask: { title: string; confirmLabel: string; places?: readonly string[] }, apply: () => void | Promise<void>) =>
      new Promise<void>((done) => setPending({ ...ask, places: ask.places ?? [], apply, done })),
    []
  )

  // Cancelling resolves the caller without applying, so its control keeps what it had.
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
    Promise.resolve()
      .then(pending.apply)
      .then(() => {
        pending.done()
        setPending(null)
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  return {
    confirmBefore,
    dialog: pending ? (
      <ConfirmationDialog
        title={pending.title}
        confirmLabel={pending.confirmLabel}
        busy={busy}
        busyLabel={t('busy')}
        error={error}
        onConfirm={confirm}
        onClose={close}
      >
        {pending.places.length > 0 && (
          <ul className="mb-[10px] flex flex-col gap-[2px]" data-assistant-place-list>
            {pending.places.map((place) => (
              <li key={place} className="mono truncate text-[12.5px] text-(--text-primary)">
                {place}
              </li>
            ))}
          </ul>
        )}
        <p>{t('warning')}</p>
      </ConfirmationDialog>
    ) : null
  }
}
