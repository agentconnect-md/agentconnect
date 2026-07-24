// No 'use client' here: rendered only inside a client boundary (SettingsView).

import { useState } from 'react'
import { useConsoleData } from '@/lib/data-context'
import type { BotDto } from '@/lib/api'
import { Button, Icon } from '@/components/ui'
import { PlatformMark } from '@/components/marks'

// Confirm-delete a FREE bot identity: drops the CP record + its stored tokens, so
// it disappears from the "use an existing bot" picker. AgentConnect only forgets
// the bot — the Slack app itself keeps existing in the workspace, so the dialog
// deep-links to Slack's app settings (api.slack.com/apps/{id}) to finish the job.
export default function DeleteBotModal({ bot, onClose }: { bot: BotDto; onClose: () => void }) {
  const { deleteBot } = useConsoleData()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const slackUrl = bot.slackAppId
    ? `https://api.slack.com/apps/${encodeURIComponent(bot.slackAppId)}`
    : 'https://api.slack.com/apps'

  const onDelete = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await deleteBot(bot.id)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--status-error-soft)">
          <Icon name="trash-2" size={16} color="var(--status-error)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Delete bot</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
          <span className="mono text-(--text-primary)">{bot.name}</span>&#32;will be forgotten and its stored tokens
          deleted — it no longer appears as an existing bot when adding an integration. This can&apos;t be undone.
        </p>
        <div className="mt-[14px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-[13px] py-3">
          <div className="flex items-start gap-[9px]">
            <Icon name="info" size={15} color="var(--text-tertiary)" className="mt-[1px] flex-none" />
            <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
              The Slack app itself keeps existing in the workspace. To remove it completely, delete it on Slack under
              Basic Information → Delete App.
            </span>
          </div>
          <a
            className="dsbtn sm dsbtn-secondary ml-6 mt-[10px] no-underline"
            href={slackUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="inline-flex h-[13px] w-[13px] items-center justify-center">
              <PlatformMark platform={bot.platform} />
            </span>
            Open on Slack
            <Icon name="arrow-up-right" size={13} />
          </a>
        </div>
        {err && (
          <div className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onDelete} className={busy ? 'pointer-events-none opacity-50' : undefined}>
          <Icon name="trash-2" size={15} />
          {busy ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </>
  )
}
