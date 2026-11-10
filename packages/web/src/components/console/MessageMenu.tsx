'use client'

// The hover menu every message and task card shares: Reply in its thread, Copy of its text and Share, each where it applies.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { HOVER_TOOL_BUTTON, HOVER_TOOL_ICON, HoverToolbar } from '@/components/console/HoverToolbar'
import { ReplyInThreadButton } from '@/components/console/ThreadRootActions'

// Copy for a finished turn's answer: inline under it on a phone, or as an action in its hover menu.
export function CopyTurnButton({ text, className }: { text: string; className?: string }) {
  const t = useTranslations('Sessions.detail')
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text)?.catch?.(() => {})
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      }}
      title={copied ? t('copied') : t('copyMessage')}
      aria-label={copied ? t('copied') : t('copyMessage')}
      className={
        className ??
        'inline-flex h-[20px] w-[20px] flex-none items-center justify-center rounded-sm border-0 bg-transparent p-0 text-(--text-tertiary) opacity-0 transition-opacity hover:text-(--text-secondary) focus-visible:opacity-100 group-hover/turn:opacity-100 max-desktop:opacity-100'
      }
    >
      <Icon name={copied ? 'check' : 'copy'} size={className ? HOVER_TOOL_ICON : 12} />
    </button>
  )
}

export function MessageMenu({
  group = 'turn',
  label,
  text,
  onReply,
  onShare,
  className,
  ...attrs
}: {
  /** The hovered element that reveals it: a message's turn, or a task card. */
  group?: 'turn' | 'card'
  /** Its accessible name; a message's actions by default. */
  label?: string
  /** The text Copy copies; absent, no Copy. */
  text?: string | undefined
  /** Replies in the message's thread; absent where the reader may not. */
  onReply?: (() => void) | undefined
  /** Opens the Share dialog for what the menu sits on. */
  onShare?: (() => void) | undefined
  /** Where the menu floats on its message or card. */
  className: string
} & Record<`data-${string}`, string>) {
  const tt = useTranslations('Common.taskThread')
  const tShare = useTranslations('Sessions.share')
  if (!text && !onReply && !onShare) return null
  return (
    <HoverToolbar group={group} label={label ?? tt('messageActions')} className={className} {...attrs}>
      {onReply ? <ReplyInThreadButton onReply={onReply} /> : null}
      {text ? <CopyTurnButton text={text} className={HOVER_TOOL_BUTTON} /> : null}
      {onShare ? (
        <button
          type="button"
          data-message-share=""
          aria-label={tShare('share')}
          title={tShare('share')}
          onClick={onShare}
          className={HOVER_TOOL_BUTTON}
        >
          <Icon name="share" size={HOVER_TOOL_ICON} />
        </button>
      ) : null}
    </HoverToolbar>
  )
}
