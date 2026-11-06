'use client'

// The shell commands a session's runtime keeps running in the background, docked above its composer while any run.
// Read-only like the Tasks tab's Commands group: no agent-protocol primitive can stop one command, so the turn's stop is the escape hatch.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { StateIcon } from '@/components/console/StateIcon'
import { ApiError, fetchAgentTasks, type AgentTaskDto } from '@/lib/api'
import { useDockRefresh } from '@/components/console/dock/auto-refresh'
import { formatTaskElapsed } from '@/components/console/task-list'

/** How often the dock re-reads while a turn streams or a command runs; it never polls a session known to be idle. */
const POLL_MS = 5_000

/** How often it retries a read that failed for a reason that may pass, such as an offline daemon. */
const RETRY_MS = 20_000

/** How often a running row's elapsed time redraws, from `startedAt` alone. */
const TICK_MS = 1_000

interface CommandsRead {
  scope: string
  commands: AgentTaskDto[]
  /** The last read failed in a way a later one may not, so its commands are unknown rather than none. */
  retry: boolean
}

/** The running commands of one (agent, session) lease, re-read on mount, while anything could start or end, and at a turn's end. */
function useRunningCommands(agentId: string, sessionId: string, turnActive: boolean): AgentTaskDto[] {
  const scope = `${agentId}\n${sessionId}`
  const [tick, setTick] = useState(0)
  const [read, setRead] = useState<CommandsRead | null>(null)
  const current = read?.scope === scope ? read : null
  const commands = current?.commands ?? []
  useEffect(() => {
    let live = true
    fetchAgentTasks(agentId, sessionId).then(
      (data) => {
        const running = data.tasks.filter((task) => task.state === 'running' && !task.subagent)
        if (live) setRead({ scope, commands: running, retry: false })
      },
      (e: unknown) => {
        // A daemon that cannot report (409) or a session this reader cannot see (404) is an answer; anything else keeps the last commands and retries.
        const settled = e instanceof ApiError && (e.status === 404 || e.status === 409)
        if (live)
          setRead((prev) => ({
            scope,
            commands: settled || prev?.scope !== scope ? [] : prev.commands,
            retry: !settled
          }))
      }
    )
    return () => {
      live = false
    }
  }, [agentId, scope, sessionId, tick])
  useDockRefresh({
    active: true,
    turnActive,
    whileHidden: true,
    intervalMs: turnActive || commands.length > 0 ? POLL_MS : current?.retry ? RETRY_MS : 0,
    onRefresh: () => setTick((n) => n + 1)
  })
  return commands
}

export function RunningCommandsDock({
  agentId,
  sessionId,
  turnActive
}: {
  agentId: string
  /** The canonical session whose background-task lease the daemon keys this read by. */
  sessionId: string
  /** Whether a turn streams in this session: commands start inside one and its end is a re-read. */
  turnActive: boolean
}) {
  const t = useTranslations('Sessions.detail.runningCommands')
  const tState = useTranslations('Common.stateIcon')
  const commands = useRunningCommands(agentId, sessionId, turnActive)
  const [open, setOpen] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const running = commands.length > 0
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [running])
  if (!running) return null
  const oldest = commands.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b))
  return (
    <div
      data-running-commands=""
      className="mb-2 overflow-hidden rounded-[11px] border border-(--border-subtle) bg-(--surface-card)"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 border-0 bg-(--surface-app) px-[14px] py-[8px] text-left font-sans text-[13px] font-medium leading-normal text-(--text-primary)"
      >
        <Icon name="square-terminal" size={15} color="var(--text-tertiary)" className="flex-none" />
        <span className="flex-none">{t('count', { count: commands.length })}</span>
        <span className="flex-none font-normal text-(--text-tertiary)">
          — {formatTaskElapsed(oldest.startedAt, now)}
        </span>
        <Icon
          name="chevron-up"
          size={14}
          color="var(--text-tertiary)"
          className={`flex-none transition-transform ${open ? '' : 'rotate-180'}`}
        />
        <span className="flex-1" />
        <span className="min-w-0 truncate text-[12px] font-normal text-(--text-tertiary)">{t('outlivesTurn')}</span>
      </button>
      {open ? (
        <div className="border-t border-(--border-subtle) px-[14px] pt-[8px] pb-[10px]">
          <div className="mb-[4px] font-mono text-[10.5px] font-semibold leading-normal tracking-[.08em] text-(--text-tertiary) uppercase">
            {t('shell')}
          </div>
          <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
            {commands.map((command) => (
              <li key={command.id} data-running-command="" className="flex min-w-0 items-center gap-2 py-[3px]">
                <StateIcon state="running" label={tState('running')} />
                <Icon name="square-terminal" size={15} color="var(--text-tertiary)" className="flex-none" />
                <span
                  className={`min-w-0 flex-1 truncate ${command.description ? 'font-mono text-[12.5px] font-normal leading-normal text-(--text-primary)' : 'font-sans text-[12.5px] font-normal italic leading-normal text-(--text-tertiary)'}`}
                  title={command.description ?? undefined}
                >
                  {command.description ?? t('unnamed')}
                </span>
                <span className="flex-none font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  {formatTaskElapsed(command.startedAt, now)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
