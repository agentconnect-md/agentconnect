'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { NativeMcpUi, nativeUiTitle } from '@agentconnect.md/protocol/mcp-app'
import { Button } from '@/components/ui'
import { useOptionalModal } from './ModalProvider'
import { usePendingAction } from './PendingActions'
import type { McpAppCardProps } from './McpAppCard'

// Cards whose dialog was open when the card itself unmounted, and WHEN. A turn's React key changes
// when its live steps become persisted rows, which remounts the card under a form the reader is
// filling in — so the remount puts the dialog back instead of discarding it. The window is what
// keeps that from also reopening a dialog the reader walked away from: a remount lands in the
// commit that unmounted it, while navigating away and coming back cannot.
const reopening = new Map<string, number>()
const REOPEN_WINDOW_MS = 250
/** Reports this browser has delivered, so a SECOND TAB shows the card as done rather than as still
 *  waiting. Presentational only: the card's own button still opens the form again. */
const reportedKey = (appId: string): string => `ac.native-ui.reported.${appId}`
function readReported(appId: string): string {
  try {
    return localStorage.getItem(reportedKey(appId)) ?? ''
  } catch {
    return ''
  }
}

export function NativeIntegrationAppCard({ step, onReport }: McpAppCardProps) {
  const modal = useOptionalModal()
  const app = step.app!
  const parsed = NativeMcpUi.safeParse(app.nativeUi)
  const ui = parsed.success ? parsed.data : undefined
  const title = ui ? nativeUiTitle(ui) : 'Configuration'
  const [summary, setSummary] = useState(() => readReported(app.appId))
  const [error, setError] = useState('')
  const opening = useRef(false)
  // Opening needs no MCP bridge: a native dialog runs on the reader's own Console session, which is
  // why the daemon keeps a native card reopenable from its recorded intent across a disconnect.
  const openable = !!ui && !!modal
  const settled = !!app.outcome
  const done = !!summary || app.outcome === 'completed'
  // What the agent is actually blocked on. A history view waits on nobody: it could open the form,
  // but it has no way to tell anyone what came of it.
  const waiting = !done && !settled && openable && !!onReport
  const holdRef = usePendingAction(`app:${app.appId}`, title, waiting)
  // Read at callback time, not closure-capture time: a dialog outlives the render that opened it,
  // and — because the transcript re-keys turns — it outlives this component instance too.
  const report = useRef<McpAppCardProps['onReport']>(undefined)
  useEffect(() => {
    report.current = app.outcome ? undefined : onReport
  })
  // A sibling tab that was ALREADY open when this one submitted has its own component state, and
  // the initializer above ran long before the write. Without this it keeps its Waiting badge and
  // its place in the banner, inviting the reader to submit the same create a second time — and
  // since a report settles nothing server-side, no later outcome would correct it.
  useEffect(() => {
    const key = reportedKey(app.appId)
    const adopt = (event: StorageEvent) => {
      // `key === null` is a whole-store clear, which says nothing about this card.
      if (event.key !== key || !event.newValue) return
      setSummary((current) => current || event.newValue!)
    }
    window.addEventListener('storage', adopt)
    return () => window.removeEventListener('storage', adopt)
  }, [app.appId])
  const dialogOpen = useRef(false)
  useEffect(
    () => () => {
      if (!dialogOpen.current) return
      // Offer it back to whatever mounts next, within the window above. An unmount that is really
      // the reader leaving still closes the dialog and leaves nothing armed behind it.
      reopening.set(app.appId, Date.now())
      modal?.closeNativeIntegration?.(app.appId)
    },
    [modal, app.appId]
  )
  // A card going inert closes the dialog it opened — but only on the TRANSITION: re-reading a card
  // that settled long ago must not shut a dialog the reader deliberately reopened from it.
  const inert = settled && app.outcome !== 'completed'
  const wasInert = useRef(inert)
  useEffect(() => {
    // Only a dialog THIS card still owns: a form that already reported may be holding its own final
    // reveal step, and the settlement that reported it must not shut that.
    if (inert && !wasInert.current && dialogOpen.current) {
      dialogOpen.current = false
      modal?.closeNativeIntegration?.(app.appId)
    }
    wasInert.current = inert
  }, [inert, modal, app.appId])
  const open = useCallback(async () => {
    if (!ui || !modal || opening.current) return
    opening.current = true
    // Per-open deduplication, held in the CLOSURE rather than on the instance: the dialog belongs to
    // the reader, not to the render that opened it. One dialog reports once, a reopened one again.
    let submitted = false
    try {
      const shown = modal.openNativeIntegration(
        ui,
        (message, outcome) => {
          if (submitted) return
          submitted = true
          dialogOpen.current = false
          setSummary(message)
          // A REFUSED submit reports through this same callback, so the copy asks the report what it
          // is: telling someone their changes are saved beneath "Creating the agent failed" would be
          // the one thing worse than saying nothing.
          const saved = outcome !== 'failed'
          // A save is already applied under the reader's own Console session; without a way to reach
          // the conversation the only thing missing is the note to the agent, and saying so beats
          // dropping it silently.
          const notify = report.current
          if (!notify) {
            setError(
              saved
                ? 'Your changes are saved. This conversation is no longer live, so the agent was not notified.'
                : 'This conversation is no longer live, so the agent was not told.'
            )
            return
          }
          if (!notify(message)) {
            setError(
              saved
                ? 'Configuration was saved, but the agent could not be notified.'
                : 'The agent could not be notified.'
            )
            return
          }
          // NOT a settlement. Accepting a turn is not delivering one — it may still be queued behind
          // a running turn, where the reader can cancel it — so the card stays openable for the
          // submit it may still owe, and only this browser's view of it is recorded.
          try {
            localStorage.setItem(reportedKey(app.appId), message)
          } catch {
            /* A tab that cannot record it simply shows the card as waiting; nothing is lost. */
          }
        },
        app.appId
      )
      dialogOpen.current = shown
      if (!shown) setError('Close the current dialog, then open this configuration.')
      else setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      opening.current = false
    }
  }, [ui, modal, app.appId])

  // NOTHING opens itself. A card is an invitation the reader accepts, and that is what makes a turn
  // raising two of them harmless: the Console holds one dialog at a time, so an automatic second
  // open could only ever be refused and then forgotten, which is exactly how a flow stalled. The
  // banner is what finds a card the reader has scrolled past; the button is what opens it. The one
  // exception is the remount above — a dialog already on screen is not an interruption, it is the
  // form they are already filling in.
  useEffect(() => {
    const offered = reopening.get(app.appId)
    reopening.delete(app.appId)
    if (offered === undefined || Date.now() - offered >= REOPEN_WINDOW_MS) return
    void open()
  }, [app.appId, open])

  return (
    <div
      ref={holdRef}
      data-native-app-status={done ? 'done' : waiting ? 'waiting' : 'inert'}
      className="rounded-md border border-(--border-subtle) bg-(--surface-card) p-4"
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1 truncate font-sans text-[14px] font-semibold leading-normal">{title}</div>
        {(done || waiting) && (
          <span
            className={`badge flex-none ${
              done ? 'bg-(--surface-sunken) text-(--text-secondary)' : 'bg-(--status-paused-soft) text-(--amber-500)'
            }`}
          >
            {done ? 'Done' : 'Waiting'}
          </span>
        )}
      </div>
      <p className="mt-2 text-[13px] text-(--text-secondary)">
        {summary ||
          (waiting
            ? 'Open the dialog to complete this configuration.'
            : openable
              ? 'Open this configuration again whenever you need it.'
              : 'This configuration interface is no longer available.')}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-(--text-secondary)">
          {error}
        </p>
      )}
      {openable && (
        <Button variant={waiting ? 'primary' : 'secondary'} className="mt-2" onClick={open}>
          {done || settled ? 'Open again' : 'Open configuration'}
        </Button>
      )}
    </div>
  )
}
