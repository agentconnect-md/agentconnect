'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { PlatformMark, Spinner } from '@/components/marks'
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
  const card = (opts: {
    key: string
    mark: React.ReactNode
    label: string
    description: string
    selected: boolean
    onPick?: () => void
  }) => {
    const body = (
      <>
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-(--surface-card) shadow-(--shadow-xs)">
          {opts.mark}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
            {opts.label}
          </span>
          <span className="mt-[2px] block font-sans text-[13px] font-normal leading-[1.5] text-(--text-secondary)">
            {opts.description}
          </span>
        </span>
        {visibility?.state === 'pending' && opts.selected ? <Spinner size={12} /> : null}
      </>
    )
    const cls = `flex w-full items-center gap-3 rounded-[10px] border px-4 py-3 text-left ${
      opts.selected ? 'border-(--border-strong) bg-(--surface-hover)' : 'border-(--border-default) bg-(--surface-card)'
    }`
    return opts.onPick ? (
      <button
        key={opts.key}
        type="button"
        role="radio"
        aria-checked={opts.selected}
        disabled={change.busy}
        className={`${cls} cursor-pointer transition-colors hover:border-(--border-strong) disabled:cursor-default`}
        onClick={opts.onPick}
      >
        {body}
      </button>
    ) : (
      <div key={opts.key} data-share-audience="" className={cls}>
        {body}
      </div>
    )
  }

  const audience = () => {
    if (!visibility) return null
    if (effective === 'external') {
      const provider = providerName(visibility.externalProvider, visibility.feishuRegion)
      const description =
        visibility.externalResolution === 'settled'
          ? visibility.externalProvider === 'github'
            ? tv('repoAccess')
            : visibility.externalProvider === 'slack'
              ? tv('channelAccess')
              : tv('conversationAccess')
          : tv('accessUnverified', { provider })
      return card({
        key: 'external',
        mark: (
          <span className="flex h-[18px] w-[18px] items-center justify-center">
            <PlatformMark platform={platform} fillPct={100} />
          </span>
        ),
        label: place ? t('placeMembers', { place, provider }) : tv('externalMembers', { provider }),
        description,
        selected: true
      })
    }
    const choices: { value: MutableSessionVisibility; icon: string; label: string; description: string }[] = [
      { value: 'org', icon: 'globe', label: tv('everyone'), description: tv('everyoneTitle') },
      { value: 'private', icon: 'lock', label: tv('private'), description: tv('privateTitle') }
    ]
    // The owner picks between the two; anyone else reads the one that holds.
    const shown = visibility.canChange && !visibility.loading ? choices : choices.filter((c) => c.value === effective)
    return (
      <div
        role={visibility.canChange ? 'radiogroup' : undefined}
        aria-labelledby={`${titleId}-who`}
        className="flex flex-col gap-2"
      >
        {shown.map((choice) =>
          card({
            key: choice.value,
            mark: <Icon name={choice.icon} size={17} color="var(--text-secondary)" />,
            label: choice.label,
            description: choice.description,
            selected: choice.value === effective,
            ...(visibility.canChange && !visibility.loading ? { onPick: () => change.pick(choice.value) } : {})
          })
        )}
      </div>
    )
  }

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
        className="modal max-w-[520px]"
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
        <div className="modalbody flex flex-col gap-2">
          {visibility ? (
            <>
              <div
                id={`${titleId}-who`}
                className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)"
              >
                {t('whoCanSee')}
              </div>
              {audience()}
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
