'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { BrowserBarAction, BrowserViewerStatus } from '@agentconnect.md/protocol/computer-viewer'
import { Button, Icon } from '@/components/ui'

interface BrowserBarProps {
  browser: BrowserViewerStatus
  canControl: boolean
  act: (action: BrowserBarAction) => Promise<boolean>
}

export function ComputerBrowserBar({ browser, canControl, act }: BrowserBarProps) {
  const t = useTranslations('Computers.viewer.browser')
  const address = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [pending, setPending] = useState(false)
  const front = browser.pages.find((page) => page.id === browser.frontPageId)
  const url = draft ?? (opening ? '' : (front?.url ?? ''))
  const blocked = !canControl || pending || Boolean(browser.dialog)

  const run = async (action: BrowserBarAction) => {
    setPending(true)
    try {
      return await act(action)
    } finally {
      setPending(false)
    }
  }

  const select = (pageId: string) => {
    if (pageId === browser.frontPageId) return
    void run({ action: 'select', pageId }).then((ok) => {
      if (ok) {
        setDraft(null)
        setOpening(false)
      }
    })
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-b border-(--border-subtle) bg-(--surface-card) px-2 py-1.5">
      {front && (
        <div className="flex min-w-0 items-center gap-1.5">
          <div
            className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto desktop:flex"
            role="group"
            aria-label={t('tabs')}
          >
            {browser.pages.map((page) => (
              <button
                key={page.id}
                type="button"
                className={
                  page.id === browser.frontPageId
                    ? 'max-w-40 shrink-0 truncate rounded-md bg-(--brand-soft) px-2 py-1 text-xs font-medium text-(--text-primary)'
                    : 'max-w-40 shrink-0 truncate rounded-md px-2 py-1 text-xs text-(--text-secondary) hover:bg-(--surface-hover)'
                }
                title={page.title || page.url}
                aria-pressed={page.id === browser.frontPageId}
                disabled={blocked}
                onClick={() => select(page.id)}
              >
                {page.title || page.url || t('untitled')}
              </button>
            ))}
          </div>
          <select
            aria-label={t('tabs')}
            className="inp min-w-0 flex-1 desktop:hidden"
            value=""
            disabled={blocked}
            onChange={(event) => select(event.currentTarget.value)}
          >
            <option value="" disabled>
              {t('tabCount', { count: browser.pages.length })}
            </option>
            {browser.pages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.title || page.url || t('untitled')}
              </option>
            ))}
          </select>
          <Button
            size="xs"
            variant="secondary"
            ariaLabel={t('newTab')}
            disabled={blocked}
            onClick={() => {
              setDraft('')
              setOpening(true)
              address.current?.focus()
            }}
          >
            <Icon name="plus" size={14} />
          </Button>
          <Button
            size="xs"
            variant="secondary"
            ariaLabel={t('closeTab')}
            disabled={blocked}
            onClick={() => void run({ action: 'close', pageId: front.id })}
          >
            <Icon name="x" size={14} />
          </Button>
        </div>
      )}
      <form
        className="flex min-w-0 items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          if (blocked || !url.trim()) return
          void run({ action: opening || !front ? 'open' : 'navigate', url: url.trim() }).then((ok) => {
            if (ok) {
              setDraft(null)
              setOpening(false)
            }
          })
        }}
      >
        {front &&
          (
            [
              ['back', 'arrow-left'],
              ['forward', 'arrow-right'],
              ['reload', 'rotate-cw']
            ] as const
          ).map(([action, icon]) => (
            <Button
              key={action}
              variant="secondary"
              size="xs"
              ariaLabel={t(action)}
              disabled={blocked}
              onClick={() => void run({ action })}
            >
              <Icon name={icon} size={14} />
            </Button>
          ))}
        <input
          ref={address}
          className="inp min-w-0 flex-1"
          aria-label={t('address')}
          placeholder={opening ? t('newTabAddress') : t('address')}
          value={url}
          readOnly={!canControl}
          disabled={pending || Boolean(browser.dialog)}
          maxLength={4096}
          autoComplete="off"
          inputMode="url"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setDraft(null)
              setOpening(false)
            }
          }}
        />
        {canControl && (
          <Button variant="secondary" size="xs" type="submit" disabled={blocked || !url.trim()}>
            {opening || !front ? t('open') : t('go')}
          </Button>
        )}
      </form>
      {browser.dialog && (
        <BrowserDialog
          key={JSON.stringify([browser.frontPageId, browser.dialog])}
          dialog={browser.dialog}
          disabled={!canControl || pending}
          respond={(accept, text) => void run({ action: 'dialog', accept, ...(text === undefined ? {} : { text }) })}
        />
      )}
    </div>
  )
}

function BrowserDialog({
  dialog,
  disabled,
  respond
}: {
  dialog: NonNullable<BrowserViewerStatus['dialog']>
  disabled: boolean
  respond: (accept: boolean, text?: string) => void
}) {
  const t = useTranslations('Computers.viewer.browser')
  const [text, setText] = useState(dialog.defaultPrompt)
  const prompt = dialog.type === 'prompt'

  return (
    <form
      role="dialog"
      aria-label={t('pageDialog')}
      className="flex flex-col gap-2 rounded-md border border-(--border-subtle) p-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled) respond(true, prompt ? text : undefined)
      }}
    >
      <p className="max-h-32 overflow-auto text-sm whitespace-pre-wrap break-words text-(--text-primary)">
        {dialog.message}
      </p>
      {prompt && (
        <input
          className="inp"
          aria-label={t('response')}
          value={text}
          disabled={disabled}
          maxLength={4096}
          onChange={(event) => setText(event.target.value)}
        />
      )}
      <div className="flex justify-end gap-2">
        {dialog.type !== 'alert' && (
          <Button variant="secondary" size="xs" disabled={disabled} onClick={() => respond(false)}>
            {t('cancel')}
          </Button>
        )}
        <Button variant="primary" size="xs" disabled={disabled} type="submit">
          {t('accept')}
        </Button>
      </div>
    </form>
  )
}
