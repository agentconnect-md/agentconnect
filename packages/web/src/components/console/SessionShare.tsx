'use client'

// The session header's Share for a session other than the page's own, such as a thread's task: the same dialog, read from that session's row.

import { useState } from 'react'
import { createPortal } from 'react-dom'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { SessionShareDialog, type ShareVisibility } from '@/components/console/SessionShareDialog'
import { useConsoleData } from '@/lib/data-context'
import { fetchSessionDetail } from '@/lib/api'
import { CONSOLE_SWR_CONFIG, readOnceRegistered } from '@/lib/console-swr'
import { copyLink } from '@/lib/copy-link'
import { useOrgs } from '@/lib/org-context'

/** Share for one session, as its own page's header offers it: who can see it, changed here when the reader may, and its link. */
export function SessionShareDialogFor({
  sessionId,
  fallbackTitle,
  nativeMemory = false,
  link,
  onClose
}: {
  sessionId: string
  /** The link Copy link copies, such as one message's; absent, the session's page. */
  link?: string
  /** The title shown until the session's row is read. */
  fallbackTitle: string
  /** Its agent keeps native memory, which a visibility change warns about. */
  nativeMemory?: boolean
  onClose: () => void
}) {
  const tShare = useTranslations('Sessions.share')
  const { orgPath } = useOrgs()
  const { revalidateSessionLists } = useConsoleData()
  const [copied, setCopied] = useState(false)
  const { data: detail, mutate } = useSWR(
    ['session-detail', sessionId],
    ([, sid]) => readOnceRegistered(() => fetchSessionDetail(sid)),
    CONSOLE_SWR_CONFIG
  )
  const visibility: ShareVisibility | null = detail
    ? {
        sessionId,
        visibility: detail.visibility ?? undefined,
        state: detail.visibilityState ?? null,
        canChange: detail.canChangeVisibility === true,
        externalProvider: detail.externalProvider ?? null,
        externalResolution: detail.externalResolution ?? null,
        feishuRegion: detail.feishuRegion ?? null,
        nativeMemory,
        onChanged: ({ visibility: next, state }) => {
          void mutate((current) => (current ? { ...current, visibility: next, visibilityState: state } : current), {
            revalidate: true
          })
          void revalidateSessionLists()
        }
      }
    : null
  const onCopyLink = async () => {
    setCopied(false)
    if (
      !(await copyLink(
        link ?? window.location.origin + orgPath(`/sessions/${encodeURIComponent(sessionId)}`),
        tShare('copyLink')
      ))
    )
      return
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  // On the page's body, so its scrim covers the whole console rather than the side panel it was opened from.
  return createPortal(
    <SessionShareDialog
      title={detail?.title ?? fallbackTitle}
      place={detail?.channelName ?? null}
      platform={detail?.platform ?? ''}
      copied={copied}
      onCopyLink={() => void onCopyLink()}
      visibility={visibility}
      onClose={onClose}
    />,
    document.body
  )
}

/** The header's Share button for a session, opening its dialog. */
export function SessionShareButton({
  sessionId,
  title,
  nativeMemory,
  className,
  iconSize = 15,
  ...attrs
}: {
  sessionId: string
  title: string
  nativeMemory?: boolean
  className: string
  iconSize?: number
} & Record<`data-${string}`, string>) {
  const tShare = useTranslations('Sessions.share')
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={className}
        title={tShare('share')}
        aria-label={tShare('share')}
        onClick={() => setOpen(true)}
        {...attrs}
      >
        <Icon name="share" size={iconSize} />
      </button>
      {open ? (
        <SessionShareDialogFor
          sessionId={sessionId}
          fallbackTitle={title}
          {...(nativeMemory !== undefined ? { nativeMemory } : {})}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
