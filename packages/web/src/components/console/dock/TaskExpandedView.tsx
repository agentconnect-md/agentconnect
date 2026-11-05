'use client'

// A coordinator task opened from its card: slid over the coordinator, which stays as a dimmed strip to go back by, with the task's own Files / Git / Computer beside its thread.

import { useEffect, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { FilesPanel } from '@/components/console/dock/FilesPanel'
import { GitPanel } from '@/components/console/dock/GitPanel'
import { ComputerPanel } from '@/components/console/dock/ComputerPanel'
import { SessionViewer, type ViewerMode } from '@/components/console/viewer/SessionViewer'
import { useRailFold } from '@/components/console/rail-fold'
import { fetchSessionDetail } from '@/lib/api'
import { CONSOLE_SWR_CONFIG } from '@/lib/console-swr'

type ToolTab = 'files' | 'git' | 'computer'

const TAB =
  'inline-flex h-full flex-none cursor-pointer items-center gap-[6px] border-0 border-b-2 bg-transparent px-1 font-sans text-[12.5px] font-medium leading-normal'
const TAB_ON = `${TAB} border-(--brand) text-(--text-primary)`
const TAB_OFF = `${TAB} border-transparent text-(--text-secondary) hover:text-(--text-primary)`

export function TaskExpandedView({
  agentId,
  taskSessionId,
  computerIds,
  computerManaged,
  canWrite,
  thread,
  onShrink
}: {
  agentId: string
  taskSessionId: string
  /** The agent's computers, so the task's Computer tab shows what the coordinator's would. */
  computerIds: readonly string[]
  computerManaged: boolean
  /** Whether the reader's role may write to the task's checkout. */
  canWrite: boolean
  /** The task's thread, drawn with the branch its Git panel reads. */
  thread: (branch: string | null) => ReactNode
  /** Back to the side panel: the strip, the crumb, the shrink button and Escape all lead here. */
  onShrink: () => void
}) {
  const t = useTranslations('Common.taskThread')
  useRailFold(true)
  const [tab, setTab] = useState<ToolTab>('files')
  const [file, setFile] = useState<{ path: string; mode: ViewerMode } | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [filesTick, setFilesTick] = useState(0)
  const [gitTick, setGitTick] = useState(0)
  // The same read the thread makes: whether the task has its own worktree decides which checkout its panels read.
  const { data: detail } = useSWR(
    ['session-detail', taskSessionId],
    ([, sid]) => fetchSessionDetail(sid),
    CONSOLE_SWR_CONFIG
  )
  const scopeReady = detail !== undefined
  const sessionId = detail?.workspaceIsolation === 'session' ? taskSessionId : undefined
  const computer = computerIds.length > 0 || computerManaged

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onShrink()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onShrink])

  // Named as the session dock names its tabs.
  const tabs: { key: ToolTab; label: string; icon: string }[] = [
    { key: 'files', label: 'Files', icon: 'folder-tree' },
    { key: 'git', label: 'Git', icon: 'git-commit-horizontal' },
    ...(computer ? [{ key: 'computer' as const, label: 'Computer', icon: 'monitor' }] : [])
  ]

  return (
    <div data-task-expanded={taskSessionId} className="absolute inset-0 z-30 flex min-h-0">
      {/* The coordinator stays underneath, dimmed: this strip is the way back to it. */}
      <button
        type="button"
        data-task-expanded-sliver=""
        onClick={onShrink}
        title={t('sliver')}
        aria-label={t('sliver')}
        className="relative w-[200px] flex-none cursor-pointer border-0 bg-[color-mix(in_oklab,var(--surface-app)_62%,transparent)] p-0 text-left backdrop-grayscale"
      >
        <span className="absolute top-3 left-3 inline-flex items-center gap-1 rounded-full border border-(--border-default) bg-(--surface-card) px-[10px] py-1 font-sans text-[12px] font-medium leading-normal text-(--text-primary) shadow-(--shadow-sm)">
          <Icon name="chevron-left" size={13} />
          {t('coordinator')}
        </span>
      </button>
      <div className="task-slide flex min-h-0 min-w-0 flex-1 border-l border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xl)">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* The thread stays mounted under an open file, so its scroll and anything typed in it survive the look. */}
          <div className={file ? 'hidden' : 'flex min-h-0 min-w-0 flex-1 flex-col'}>{thread(branch)}</div>
          {file ? (
            <SessionViewer
              key={`${agentId}:${sessionId ?? 'primary'}:${file.path}`}
              agentId={agentId}
              {...(sessionId ? { sessionId } : {})}
              path={file.path}
              mode={file.mode}
              onModeChange={(mode) => setFile({ path: file.path, mode })}
              onOpenPath={(path) => setFile({ path, mode: 'file' })}
              {...(canWrite ? { onIndexChanged: () => setGitTick((n) => n + 1) } : {})}
              onClose={() => setFile(null)}
            />
          ) : null}
        </div>
        <div className="flex min-h-0 w-[38%] max-w-[520px] min-w-[300px] flex-none flex-col border-l border-(--border-subtle)">
          <div className="flex h-[43px] flex-none items-stretch gap-4 border-b border-(--border-subtle) px-3">
            {tabs.map((entry) => (
              <button
                key={entry.key}
                type="button"
                data-task-expanded-tab={entry.key}
                aria-pressed={tab === entry.key}
                className={tab === entry.key ? TAB_ON : TAB_OFF}
                onClick={() => setTab(entry.key)}
              >
                <Icon name={entry.icon} size={14} />
                {entry.label}
              </button>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            {scopeReady && tab === 'files' ? (
              <FilesPanel
                agentId={agentId}
                {...(sessionId ? { sessionId } : {})}
                refreshTick={filesTick}
                openFilePath={file?.mode === 'file' ? file.path : null}
                onOpenFile={(path) => setFile({ path, mode: 'file' })}
              />
            ) : null}
            {/* Mounted while Files is shown, so the branch it reports reaches the thread's header. */}
            {scopeReady ? (
              <div className={tab === 'git' ? 'contents' : 'hidden'}>
                <GitPanel
                  agentId={agentId}
                  {...(sessionId ? { sessionId } : {})}
                  active={tab === 'git'}
                  refreshTick={gitTick}
                  openPath={file && file.mode !== 'file' ? file.path : null}
                  openStaged={file?.mode === 'staged'}
                  canWrite={canWrite}
                  onWrote={() => setFilesTick((n) => n + 1)}
                  onOpenDiff={(path, staged, untracked) =>
                    setFile({ path, mode: untracked ? 'file' : staged ? 'staged' : 'diff' })
                  }
                  onVerdictChange={(verdict) => setBranch(verdict.branch ?? null)}
                />
              </div>
            ) : null}
            {computer && tab === 'computer' ? (
              <ComputerPanel
                computerIds={[...computerIds]}
                {...(computerManaged ? { managed: { agentId, sessionId: taskSessionId } } : {})}
                active
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
