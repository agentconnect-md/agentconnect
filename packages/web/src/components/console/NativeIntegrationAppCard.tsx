'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { NativeMcpUi, nativeUiTitle } from '@agentconnect.md/protocol/mcp-app'
import { Button } from '@/components/ui'
import { useOptionalModal } from './ModalProvider'
import type { McpAppCardProps } from './McpAppCard'

const opened = new Set<string>()

export function NativeIntegrationAppCard({ step, onRpc }: McpAppCardProps) {
  const modal = useOptionalModal()
  const app = step.app!
  const parsed = NativeMcpUi.safeParse(app.nativeUi)
  const ui = parsed.success ? parsed.data : undefined
  const [summary, setSummary] = useState('')
  const [error, setError] = useState('')
  const completed = useRef(false)
  const opening = useRef(false)
  // Opening needs no MCP bridge: a native dialog runs on the reader's own Console session, which is
  // why the daemon keeps a native card reopenable from its recorded intent across a disconnect.
  // Only TELLING the agent needs the bridge, so a settled card still opens — it just reports nothing.
  const openable = !!ui && !!modal
  const live = !!onRpc && !app.outcome && openable
  // Read at callback time, not closure-capture time: a dialog outlives the render that opened it.
  const report = useRef<McpAppCardProps['onRpc']>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    report.current = app.outcome ? undefined : onRpc
  })
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => () => modal?.closeNativeIntegration?.(app.appId), [modal, app.appId])
  // A card going inert closes the dialog it opened — but only on the TRANSITION: re-reading a card
  // that settled long ago must not shut a dialog the reader deliberately reopened from it. A
  // completed one is left alone, so a saved form keeps its own final reveal step.
  const settled = !!app.outcome
  const inert = settled && app.outcome !== 'completed'
  const wasInert = useRef(inert)
  useEffect(() => {
    if (inert && !wasInert.current) modal?.closeNativeIntegration?.(app.appId)
    wasInert.current = inert
  }, [inert, modal, app.appId])
  const open = useCallback(async () => {
    if (!ui || !modal || opening.current) return
    opening.current = true
    // Per-open deduplication: one dialog reports once, and reopening it may report again.
    completed.current = false
    try {
      if (!mounted.current) return
      const shown = modal.openNativeIntegration(
        ui,
        (message, outcome) => {
          if (completed.current || !mounted.current) return
          completed.current = true
          setSummary(message)
          // A REFUSED submit reports through this same callback, so the copy asks the report what it
          // is: telling someone their changes are saved beneath "Creating the agent failed" would be
          // the one thing worse than saying nothing.
          const saved = outcome !== 'failed'
          const undelivered = saved
            ? 'Your changes are saved. This interface is no longer live, so the agent was not notified.'
            : 'This interface is no longer live, so the agent was not told.'
          // A save is already applied under the reader's own Console session; without a live bridge
          // the only thing missing is the note to the agent, and saying so beats dropping it silently.
          const notify = report.current
          if (!notify) {
            setError(undelivered)
            return
          }
          void notify(app.appId, { method: 'ui/message', text: message })
            .then((result) => {
              if (!result.ok)
                setError(
                  saved
                    ? `Configuration was saved, but the agent could not be notified: ${result.error}`
                    : `The agent could not be notified: ${result.error}`
                )
            })
            .catch(() =>
              setError(
                saved
                  ? 'Configuration was saved, but the agent could not be notified.'
                  : 'The agent could not be notified.'
              )
            )
        },
        app.appId
      )
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
    if (!live || opened.has(app.appId)) return
    opened.add(app.appId)
    if (opened.size > 1000) opened.delete(opened.values().next().value!)
    const key = `ac.native-ui.${app.appId}`
    try {
      if (sessionStorage.getItem(key)) return
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
