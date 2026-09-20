'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { NativeMcpUi, nativeUiTitle } from '@agentconnect.md/protocol/mcp-app'
import { Button } from '@/components/ui'
import { useOptionalModal } from './ModalProvider'
import type { McpAppCardProps } from './McpAppCard'

const opened = new Set<string>()
// Cards whose dialog was open when the card itself unmounted. A turn's React key changes when its
// live steps become persisted rows, which remounts the card under a form the reader is filling in
// — so the remount puts the dialog back instead of leaving the reader with a bare button.
const reopening = new Set<string>()

export function NativeIntegrationAppCard({ step, onReport, onClose }: McpAppCardProps) {
  const modal = useOptionalModal()
  const app = step.app!
  const parsed = NativeMcpUi.safeParse(app.nativeUi)
  const ui = parsed.success ? parsed.data : undefined
  const [summary, setSummary] = useState('')
  const [error, setError] = useState('')
  const opening = useRef(false)
  // Opening needs no MCP bridge: a native dialog runs on the reader's own Console session, which is
  // why the daemon keeps a native card reopenable from its recorded intent across a disconnect.
  const openable = !!ui && !!modal
  // Reporting needs no bridge either — the outcome goes in as an ordinary turn, the same frame the
  // composer sends — so a card the daemon has stopped serving still tells the agent what happened.
  const live = !!onReport && !app.outcome && openable
  // Read at callback time, not closure-capture time: a dialog outlives the render that opened it,
  // and — because the transcript re-keys turns — it outlives this component instance too.
  const report = useRef<McpAppCardProps['onReport']>(undefined)
  const close = useRef<McpAppCardProps['onClose']>(undefined)
  useEffect(() => {
    report.current = app.outcome ? undefined : onReport
    close.current = onClose
  })
  const dialogOpen = useRef(false)
  useEffect(
    () => () => {
      if (!dialogOpen.current) return
      // Put it back on the other side of the remount. Cleared by the reopen, so an unmount that is
      // really the reader leaving still closes the dialog and leaves nothing armed behind it.
      reopening.add(app.appId)
      modal?.closeNativeIntegration?.(app.appId)
    },
    [modal, app.appId]
  )
  // A card going inert closes the dialog it opened — but only on the TRANSITION: re-reading a card
  // that settled long ago must not shut a dialog the reader deliberately reopened from it. A
  // completed one is left alone, so a saved form keeps its own final reveal step.
  const settled = !!app.outcome
  const inert = settled && app.outcome !== 'completed'
  const wasInert = useRef(inert)
  useEffect(() => {
    // Only a dialog THIS card still owns: a form that already reported may be holding its own
    // final reveal step, and the settlement that reported it must not shut that.
    if (inert && !wasInert.current && dialogOpen.current) {
      dialogOpen.current = false
      modal?.closeNativeIntegration?.(app.appId)
    }
    wasInert.current = inert
  }, [inert, modal, app.appId])
  const open = useCallback(async () => {
    if (!ui || !modal || opening.current) return
    opening.current = true
    // Per-open deduplication, held in the CLOSURE rather than on the instance: the dialog belongs
    // to the reader, not to the render that opened it. One dialog reports once, and reopening it
    // may report again.
    let done = false
    try {
      const shown = modal.openNativeIntegration(
        ui,
        (message, outcome) => {
          if (done) return
          done = true
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
          // The report has landed, so the card is done: settling it is what stops a fresh browser
          // session from opening a dialog over a form that was already submitted. It is a separate
          // frame from the report now — the daemon no longer learns of one by carrying the other.
          close.current?.(app.appId)
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

  // Only a LIVE card opens itself — a reload must not throw a dialog over a conversation the reader
  // came back to read. A settled one waits behind its button.
  useEffect(() => {
    if (!live) return
    // A remount under an open dialog is not a second auto-open: it is the same one, continued.
    const resumed = reopening.delete(app.appId)
    if (opened.has(app.appId) && !resumed) return
    opened.add(app.appId)
    if (opened.size > 1000) opened.delete(opened.values().next().value!)
    const key = `ac.native-ui.${app.appId}`
    try {
      if (sessionStorage.getItem(key) && !resumed) return
      sessionStorage.setItem(key, 'opened')
    } catch {
      /* In-memory deduplication still covers reconnects when storage is unavailable. */
    }
    void open()
  }, [app.appId, live, open])

  return (
    <div className="rounded-md border border-(--border-subtle) bg-(--surface-card) p-4">
      <div className="font-sans text-[14px] font-semibold leading-normal">
        {ui ? nativeUiTitle(ui) : 'Configuration'}
      </div>
      <p className="mt-2 text-[13px] text-(--text-secondary)">
        {summary ||
          (live
            ? 'Complete configuration in the dialog.'
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
        <Button variant="secondary" className="mt-2" onClick={open}>
          {summary || settled ? 'Open again' : 'Open configuration'}
        </Button>
      )}
    </div>
  )
}
