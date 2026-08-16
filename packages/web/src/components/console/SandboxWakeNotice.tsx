'use client'

// The two things a sandbox-backed surface says while its agent's sandbox is not running (#1070): the calm
// "starting" line while a wake is polling the read, and the terminal not-available copy with a Start button once
// it gave up. Shared by the agent page's file browser, the dock's Files panel and the Memory tab so they never drift.

import type { ReactNode } from 'react'
import { Spinner } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import type { SandboxWake } from '@/components/console/sandbox-wake'

/** The terminal copy for a sleeping sandbox — kept verbatim from before the wake existed. */
export const SANDBOX_ASLEEP_NOTICE =
  'Files are not available right now — this agent runs in a cluster sandbox and its pod is not running. It starts again on the agent’s next turn, and the workspace comes back with it.'

/** The same story for managed memory (#1078), which lives on that same sandbox volume. */
export const MEMORY_SANDBOX_ASLEEP_NOTICE =
  'Memory is not available right now — this agent runs in a cluster sandbox and its pod is not running. It starts again on the agent’s next turn, and its memory comes back with it.'

/** What is drawn while the sandbox is being started. Not an error: nothing is wrong, and the read is being polled. */
export function SandboxStartingNotice({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={
        compact
          ? 'flex items-center gap-2 px-3 py-[10px] font-sans text-[12px] font-normal leading-[1.55] text-(--text-secondary)'
          : 'flex items-center gap-[10px] px-[18px] py-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)'
      }
    >
      <Spinner size={compact ? 13 : 15} />
      <span>Starting the agent’s sandbox…</span>
    </div>
  )
}

/** The terminal state: the caller's own not-available notice, plus a Start button while a wake could still be pressed — the read refused as asleep, or the agent is known to be sandboxed. */
export function SandboxAsleepNotice({
  wake,
  notice,
  startable,
  compact = false
}: {
  wake: SandboxWake
  notice: ReactNode
  startable: boolean
  compact?: boolean
}) {
  return (
    <div className="flex flex-col items-start">
      {notice}
      {startable && wake.phase !== 'unsupported' ? (
        <div className={compact ? 'px-3 pb-[10px]' : 'px-[18px] pb-4'}>
          <Button variant="secondary" size="xs" onClick={wake.start}>
            <Icon name="play" size={13} />
            Start
          </Button>
        </div>
      ) : null}
    </div>
  )
}
