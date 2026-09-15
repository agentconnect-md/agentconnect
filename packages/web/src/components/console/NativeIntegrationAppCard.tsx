'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { NativeMcpUi } from '@agentconnect.md/protocol/mcp-app'
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
  const live = !!onRpc && !app.outcome && !!ui
  const active = useRef(live)
  useEffect(() => {
    active.current = live
    return () => {
      active.current = false
    }
  }, [live])
  useEffect(() => () => modal?.closeNativeIntegration?.(app.appId), [modal, app.appId])
  useEffect(() => {
    if (!live && app.outcome !== 'completed') modal?.closeNativeIntegration?.(app.appId)
  }, [live, app.outcome, modal, app.appId])
  const open = useCallback(async () => {
    if (!live || !ui || !modal || opening.current) return
    opening.current = true
    try {
      const checked = await onRpc!(app.appId, { method: 'tools/call', name: 'configureIntegration', args: ui.intent })
      if (!checked.ok) throw new Error(checked.error)
      if ((checked.result as { isError?: boolean })?.isError)
        throw new Error('This configuration is no longer available. Ask the agent to open it again.')
      if (!active.current) return
      const shown = modal.openNativeIntegration(
        ui,
        (message) => {
          if (completed.current || !active.current) return
          completed.current = true
          setSummary(message)
          void onRpc!(app.appId, { method: 'ui/message', text: message })
            .then((result) => {
              if (!result.ok) setError(`Configuration was saved, but the agent could not be notified: ${result.error}`)
            })
            .catch(() => setError('Configuration was saved, but the agent could not be notified.'))
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
  }, [live, ui, modal, onRpc, app.appId])

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
        {ui?.intent.mode === 'edit' ? 'Edit integration' : 'Add integration'}
      </div>
      <p className="mt-2 text-[13px] text-(--text-secondary)">
        {summary ||
          (live ? 'Complete configuration in the dialog.' : 'This configuration interface is no longer active.')}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-(--text-secondary)">
          {error}
        </p>
      )}
      {live && !summary && (
        <Button variant="secondary" onClick={open}>
          Open configuration
        </Button>
      )}
    </div>
  )
}
