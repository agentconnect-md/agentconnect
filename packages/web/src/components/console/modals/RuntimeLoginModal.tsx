// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'

/** What the "Login required" warning opens on: the runtime it is about, and where it was seen. */
export interface RuntimeLoginTarget {
  runtimeId: string
  /** Display name of the runtime, when the caller resolved one. */
  runtimeLabel?: string
  /** The daemon whose probe reported it — absent on the fleet/group card, which aggregates hosts. */
  daemonName?: string
}

/** The login command for one runtime, run on the daemon's own host. `auth` is not CLI-owned, so
 *  the unified CLI delegates it verbatim to the active daemon with the terminal attached. */
export function runtimeLoginCommand(runtimeId: string): string {
  return `npx -y @agentconnect.md/cli auth --runtime ${runtimeId}`
}

/**
 * What to run to log a runtime in, and why it cannot be done from here.
 *
 * A runtime's credential lives in that runtime's own state directory on the daemon host — the
 * directory sessions are seeded FROM — and every login flow it offers wants a human at a terminal
 * (a browser consent URL, a pasted API key, its own interactive CLI). So the console's job is to
 * hand over the exact command, not to run one.
 */
export default function RuntimeLoginModal({ target, onClose }: { target: RuntimeLoginTarget; onClose: () => void }) {
  const t = useTranslations('Daemons.runtimeLogin')
  const [copied, setCopied] = useState(false)
  const label = target.runtimeLabel || target.runtimeId
  const command = runtimeLoginCommand(target.runtimeId)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable (insecure context) — the text is still selectable */
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="terminal" size={16} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{t('title', { label })}</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <div className="mb-[14px] flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-3 py-[11px]">
          <Icon name="triangle-alert" size={15} color="var(--amber-500)" className="mt-[1px] flex-none" />
          <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
            {t.rich('warning', {
              runtime: () => <span className="mono text-(--text-primary)">{target.runtimeId}</span>,
              host: () => <span className="mono text-(--text-primary)">{target.daemonName ?? t('daemonHost')}</span>
            })}
          </span>
        </div>
        <div className="overflow-hidden rounded-[9px] border border-(--gray-800) bg-(--gray-1000)">
          <div className="flex items-center gap-2 border-b border-(--gray-800) px-[13px] py-[9px]">
            <Icon name="terminal" size={13} color="var(--text-inverse-dim)" />
            <span className="font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim)">
              {target.daemonName ? t('terminal', { daemon: target.daemonName }) : t('daemonTerminal')}
            </span>
            <button
              type="button"
              onClick={copy}
              className="ml-auto inline-flex cursor-pointer items-center gap-[5px] border-0 bg-transparent font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim)"
            >
              <Icon name={copied ? 'check' : 'copy'} size={12} />
              {copied ? t('copied') : t('copy')}
            </button>
          </div>
          <div className="break-all px-[14px] py-[13px] font-mono text-[12px] leading-[1.7] text-[#cdd6e0]">
            <span className="text-(--magenta-300)">$</span> {command}
          </div>
        </div>
        <ul className="mt-[14px] flex list-none flex-col gap-[7px] rounded-[9px] border border-dashed border-(--border-strong) px-[14px] py-[13px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          <li>
            {t.rich('methods', {
              runtime: () => <span className="mono text-(--text-secondary)">{target.runtimeId}</span>
            })}
          </li>
          <li>{t('nextStart')}</li>
        </ul>
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="primary" onClick={onClose}>
          {t('done')}
        </Button>
      </div>
    </>
  )
}
