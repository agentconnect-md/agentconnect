'use client'

// A root's thread actions (webchat-threads.md §6.1): Reply in thread beside Copy on hover, and on a phone a long-press menu.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { HOVER_TOOL_BUTTON, HOVER_TOOL_ICON } from '@/components/console/HoverToolbar'

const LONG_PRESS_MS = 500

/** A root's hover menu action; a phone reaches the same action by a long press instead. */
export function ReplyInThreadButton({ onReply }: { onReply: () => void }) {
  const t = useTranslations('Common.taskThread')
  return (
    <button
      type="button"
      data-reply-in-thread=""
      onClick={onReply}
      title={t('replyInThread')}
      aria-label={t('replyInThread')}
      className={HOVER_TOOL_BUTTON}
    >
      <Icon name="message-square" size={HOVER_TOOL_ICON} />
    </button>
  )
}

/** A root's column: on a phone a held press opens its menu, whose one action is Reply in thread. */
export function ThreadRootPress({
  enabled,
  onReply,
  className,
  children
}: {
  /** Only a root a phone reader may reply under takes the press. */
  enabled: boolean
  onReply: () => void
  className: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const timer = useRef<number | null>(null)
  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => cancel, [])
  const press = enabled
    ? {
        onTouchStart: () => {
          cancel()
          timer.current = window.setTimeout(() => {
            timer.current = null
            setOpen(true)
          }, LONG_PRESS_MS)
        },
        onTouchEnd: cancel,
        onTouchMove: cancel,
        onTouchCancel: cancel
      }
    : {}
  return (
    <div className={className} {...press}>
      {children}
      {enabled && open ? <RootMenu onReply={onReply} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}

/** The menu a long press opens under a root; any press outside it closes it. */
function RootMenu({ onReply, onClose }: { onReply: () => void; onClose: () => void }) {
  const t = useTranslations('Common.taskThread')
  const ref = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) closeRef.current()
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [])
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('messageActions')}
      data-root-menu=""
      className="z-10 flex min-w-[180px] flex-col rounded-md border border-(--border-default) bg-(--surface-card) py-1 shadow-(--shadow-md)"
    >
      <button
        type="button"
        role="menuitem"
        data-root-menu-reply=""
        onClick={() => {
          onClose()
          onReply()
        }}
        className="flex cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-2 text-left font-sans text-[13px] font-normal leading-normal text-(--text-primary) hover:bg-(--surface-hover)"
      >
        <Icon name="reply" size={14} />
        {t('replyInThread')}
      </button>
    </div>
  )
}
