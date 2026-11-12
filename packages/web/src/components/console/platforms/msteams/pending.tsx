'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import type { MsTeamsAgentBotRequestDto } from '@/lib/api'
import type { WebAgentPendingFacet, WebAgentPendingEntryProps } from '../contract'
import { msTeamsApi } from './api'
import { MsTeamsMark } from './mark'

/** The agent's Teams request still waiting for an administrator (teams-integration.md §8.6.6), drawn as the integration it becomes. */
function MsTeamsPendingEntry({ orgId, pending, open, refresh }: WebAgentPendingEntryProps) {
  const t = useTranslations('Platforms.msteams.pending')
  const request = pending as MsTeamsAgentBotRequestDto
  const [checking, setChecking] = useState(false)
  // Reads the package's state now, where Check again would; the host's next read shows the integration or the request as it stands.
  const check = async () => {
    setChecking(true)
    try {
      await msTeamsApi.checkRequest(orgId, request.id)
    } catch {
      /* the pane behind the entry names a failure; the entry stays as it was */
    } finally {
      setChecking(false)
      refresh()
    }
  }
  return (
    <div className="flex items-center gap-3 rounded-[9px] border border-(--border-subtle) px-[14px] py-3">
      <button
        type="button"
        onClick={open}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-left"
      >
        <span className="imark h-[34px] w-[34px] flex-none rounded-md">
          <MsTeamsMark />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
          {/* Drawn as the integration it becomes, under the name it will take, with its state where a connected one's would be. */}
          <span className="flex items-center gap-2">
            <span className="truncate font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
              {request.name}
            </span>
            <span className="badge flex-none bg-(--surface-active) text-(--text-secondary)">
              <Icon name="clock" size={12} />
              {t('badge')}
            </span>
          </span>
          <span className="font-sans text-[12.5px] leading-normal text-(--text-secondary)">{t(request.status)}</span>
        </span>
      </button>
      <button
        type="button"
        className="iconbtn flex-none"
        title={t('check')}
        aria-label={t('check')}
        disabled={checking}
        onClick={() => void check()}
      >
        <Icon name="refresh-cw" size={15} className={checking ? 'animate-spin' : undefined} />
      </button>
    </div>
  )
}

/** The agent's oldest Teams request still waiting, if any. */
export const msTeamsAgentPending: WebAgentPendingFacet = {
  read: async (orgId: string, agentId: string) => (await msTeamsApi.requests(orgId, agentId))[0] ?? null,
  Entry: MsTeamsPendingEntry
}
