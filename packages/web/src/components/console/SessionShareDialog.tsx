'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { PlatformMark, Spinner } from '@/components/marks'
import { FieldSelect } from '@/components/console/FieldSelect'
import { Scrim } from '@/components/console/Scrim'
import { useSessionVisibilityChange } from '@/components/console/SessionVisibilityControl'
import type { MutableSessionVisibility, SessionVisibility } from '@/lib/api'

export interface ShareVisibility {
  sessionId: string
  visibility: SessionVisibility | undefined
  state?: 'pending' | 'applied' | null
  canChange: boolean
  loading?: boolean
  externalProvider?: string | null
  externalResolution?: 'pending' | 'settled' | 'invalid' | null
  feishuRegion?: 'feishu' | 'lark' | null
  nativeMemory?: boolean
  onChanged: (next: { visibility: SessionVisibility; state: 'pending' | 'applied' }) => void
}

interface ShareDialogProps {
  title: string
  place: string | null
  platform: string
  link: string
  visibility: ShareVisibility | null
  onClose: () => void
}

function providerName(provider: string | null | undefined, region: 'feishu' | 'lark' | null | undefined): string {
  if (provider === 'slack') return 'Slack'
  if (provider === 'github') return 'GitHub'
  if (provider === 'feishu') return region === 'lark' ? 'Lark' : region === 'feishu' ? 'Feishu' : 'Feishu/Lark'
  return 'External'
}

// Keep success feedback mounted after the dialog closes, including in task threads.
export function SessionShareDialog({ open, ...props }: ShareDialogProps & { open: boolean }) {
  const t = useTranslations('Sessions.share')
  const [copied, setCopied] = useState<number | null>(null)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), 3000)
    return () => clearTimeout(timer)
  }, [copied])

  if (!open && !copied) return null
  // Escape the header or side panel's stacking context on every share entry point.
  return createPortal(
    <>
      {open ? (
        <ShareDialogContent
          {...props}
          onCopied={() => {
            setCopied(Date.now())
            props.onClose()
          }}
        />
      ) : null}
      {copied ? (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-2 rounded-md border border-(--border-default) bg-(--surface-card) px-4 py-3 font-sans text-[13px] font-medium leading-normal text-(--text-primary) shadow-(--shadow-md)"
        >
          <Icon name="check" size={15} />
          {t('linkCopied')}
        </div>
      ) : null}
    </>,
    document.body
  )
}

function ShareDialogContent({
  title,
  place,
  platform,
  link,
  visibility,
  onClose,
  onCopied
}: ShareDialogProps & { onCopied: () => void }) {
  const t = useTranslations('Sessions.share')
  const tv = useTranslations('Sessions.visibility')
  const titleId = useId()
  const [copying, setCopying] = useState(false)
  const [manualLink, setManualLink] = useState<string | null>(null)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const effective: SessionVisibility = visibility?.visibility ?? 'org'
  const change = useSessionVisibilityChange({
    sessionId: visibility?.sessionId ?? '',
    effective,
    onChanged: (next) => visibility?.onChanged(next)
  })
  const choices: { value: MutableSessionVisibility; label: string; title: string }[] = [
    { value: 'org', label: tv('everyone'), title: tv('everyoneTitle') },
    { value: 'private', label: tv('private'), title: tv('privateTitle') }
  ]
  const current = choices.find((choice) => choice.value === effective) ?? choices[0]!
  const external = effective === 'external'
  const provider = providerName(visibility?.externalProvider, visibility?.feishuRegion)
  const label = external
    ? place
      ? t('placeMembers', { place, provider })
      : tv('externalMembers', { provider })
    : current.label
  const description = external
    ? visibility?.externalResolution !== 'settled'
      ? tv('accessUnverified', { provider })
      : visibility.externalProvider === 'github'
        ? tv('repoAccess')
        : visibility.externalProvider === 'slack'
          ? tv('channelAccess')
          : tv('conversationAccess')
    : current.title
  const pending = visibility?.state === 'pending'

  const onCopy = async () => {
    setCopying(true)
    const absoluteLink = new URL(link, window.location.href).href
    try {
      await navigator.clipboard.writeText(absoluteLink)
    } catch {
      if (active.current) {
        setManualLink(absoluteLink)
        setCopying(false)
      }
      return
    }
    if (active.current) onCopied()
  }

  return (
    <Scrim onEscape={onClose}>
      <div
        className="modal max-w-[452px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-share-dialog=""
      >
        <div className="modalhead">
          <span id={titleId} className="min-w-0 flex-1 truncate font-sans text-[18px] font-semibold leading-normal">
            {t('title', { title })}
          </span>
          <button type="button" className="iconbtn" aria-label={t('close')} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody flex flex-col gap-4">
          {visibility ? (
            <>
              <div className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
                {t('whoCanSee')}
              </div>
              <div data-share-audience="" className="flex items-center gap-3">
                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-(--surface-hover)">
                  {external ? (
                    <span className="flex h-[18px] w-[18px] items-center justify-center">
                      <PlatformMark platform={platform} fillPct={100} />
                    </span>
                  ) : (
                    <Icon name={effective === 'private' ? 'lock' : 'globe'} size={17} color="var(--text-secondary)" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  {!external && visibility.canChange && !visibility.loading ? (
                    <div className="w-[140px] max-w-full">
                      <FieldSelect
                        value={current.value}
                        options={choices}
                        onChange={change.pick}
                        ariaLabel={t('whoCanSee')}
                        disabled={change.busy || pending}
                      />
                    </div>
                  ) : (
                    <div className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
                      {label}
                    </div>
                  )}
                  <p className="mt-1 font-sans text-[13px] font-normal leading-[1.5] text-(--text-secondary)">
                    {description}
                  </p>
                </div>
                {change.busy || pending || visibility.loading ? <Spinner size={12} /> : null}
              </div>
              {effective === 'private' ? (
                <p className="font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
                  {t('copyDoesNotGrantAccess')}
                </p>
              ) : null}
              {change.error && !change.confirming ? (
                <div role="alert" className="font-sans text-[12px] font-normal leading-normal text-(--status-error)">
                  {change.error}
                </div>
              ) : null}
            </>
          ) : null}
          {manualLink ? (
            <div className="flex flex-col gap-2">
              <p role="alert" className="font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
                {t('copyFailed')}
              </p>
              <textarea
                className="inp w-full resize-none font-mono text-[12px]"
                aria-label={t('copyLink')}
                value={manualLink}
                readOnly
                rows={3}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          ) : null}
        </div>
        <div className="modalfoot justify-end">
          <Button
            variant="primary"
            className="max-desktop:w-full"
            disabled={copying || change.busy || change.confirming}
            onClick={() => void onCopy()}
          >
            {copying ? <Spinner size={15} /> : <Icon name="link" size={15} />}
            {t('copyLink')}
          </Button>
        </div>
      </div>
      {change.confirmDialog(visibility?.nativeMemory ?? false)}
    </Scrim>
  )
}
