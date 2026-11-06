'use client'

// The top of a task's page: what its coordinator opened it with, folded to one quiet line until the reader opens it.

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { fetchAssistantSubsession } from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { useOrgs } from '@/lib/org-context'

export function TaskBrief({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const t = useTranslations('Common.taskThread')
  const { activeOrg } = useOrgs()
  // The same read the follow-up summary makes on this page, so the two share one request.
  const { data: row } = useSWR(
    consoleKeys.assistantSubsession(activeOrg?.id, agentId, sessionId),
    () => fetchAssistantSubsession(agentId, sessionId),
    { shouldRetryOnError: false }
  )
  const [open, setOpen] = useState(false)
  // The message it was opened with, else its own summary; a task the reader may not see has neither.
  const brief = row?.visible ? (row.background ?? row.summary ?? null) : null
  if (!brief) return null
  return (
    <div data-task-brief="" className="flex flex-col gap-[6px] desktop:mt-[14px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-fit cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[13px] font-medium leading-normal text-(--text-tertiary) hover:text-(--text-secondary)"
      >
        <Icon name="corner-down-right" size={14} />
        {t('startedBy')}
        <Icon name="chevron-right" size={13} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open ? (
        <p className="m-0 border-l-2 border-(--border-subtle) pl-3 font-sans text-[13px] font-normal leading-[1.55] whitespace-pre-wrap text-(--text-secondary)">
          {brief}
        </p>
      ) : null}
    </div>
  )
}
