import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { KeyboardEvent, ReactNode } from 'react'
import { GithubMark } from '@/components/marks'
import { Button, Icon, Toggle } from '@/components/ui'
import type { RepoAccess } from '@/lib/api'

export type WorkspaceMode = 'scratch' | 'github'
export type WorkspaceRepoAccess = 'read' | 'write'
type RepositoryMenuStyle = { left: number; top: number; width: number; maxHeight: number }

// Complete literal class strings keep access badges consistent anywhere the
// workspace or one of its additional repositories is shown.
export const REPOSITORY_ACCESS_BADGE: Record<RepoAccess, string> = {
  read: 'badge flex-none bg-(--surface-active) text-(--text-tertiary)',
  comment: 'badge flex-none bg-(--brand-soft) text-(--brand-soft-text)',
  write: 'badge flex-none bg-(--status-paused-soft) text-(--amber-500)'
}

export function WorkspaceModeField({
  value,
  onChange,
  className,
  // Add-agent renders this under a "Workspace" section heading, so it overrides
  // the label to avoid saying "Workspace" twice.
  label = 'Workspace'
}: {
  value: WorkspaceMode
  onChange: (value: WorkspaceMode) => void
  className?: string
  label?: string
}) {
  const fieldClassName = className ? `fld ${className}` : 'fld'
  const radio = (selected: boolean) => (
    <span
      className={
        selected
          ? 'ml-auto flex h-4 w-4 flex-none items-center justify-center self-center rounded-full border-[1.5px] border-(--brand)'
          : 'ml-auto flex h-4 w-4 flex-none items-center justify-center self-center rounded-full border-[1.5px] border-(--border-strong)'
      }
    >
      {selected && <span className="h-2 w-2 rounded-full bg-(--brand)" />}
    </span>
  )
  const tileIcon = (child: ReactNode) => (
    <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
      {child}
    </span>
  )

  return (
    <div className={fieldClassName}>
      <span className="fldlbl">{label}</span>
      <div className="grid grid-cols-1 gap-[10px] desktop:grid-cols-2">
        <button
          type="button"
          className={value === 'scratch' ? 'ptile on items-start text-left' : 'ptile items-start text-left'}
          onClick={() => onChange('scratch')}
        >
          {tileIcon(
            <Icon name="sparkles" size={16} color={value === 'scratch' ? 'var(--brand)' : 'var(--text-tertiary)'} />
          )}
          <span className="min-w-0 flex-1">
            <span className="block font-sans text-[13px] font-semibold leading-normal">From scratch</span>
            <span className="mt-[2px] block truncate font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
              Fresh empty directory.
            </span>
          </span>
          {radio(value === 'scratch')}
        </button>
        <button
          type="button"
          className={value === 'github' ? 'ptile on items-start text-left' : 'ptile items-start text-left'}
          onClick={() => onChange('github')}
        >
          {tileIcon(<GithubMark color="var(--text-primary)" />)}
          <span className="min-w-0 flex-1">
            <span className="block font-sans text-[13px] font-semibold leading-normal">From GitHub</span>
            <span className="mt-[2px] block truncate font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
              Clone a repo on a branch.
            </span>
          </span>
          {radio(value === 'github')}
        </button>
      </div>
    </div>
  )
}

export function GithubInstallPrompt({
  onInstall,
  onSync,
  syncing = false
}: {
  onInstall: () => void
  onSync?: () => void
  syncing?: boolean
}) {
  return (
    <div className="flex items-start gap-4 rounded-lg border border-(--border-default) bg-(--surface-card) p-4 desktop:col-span-2">
      <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-md bg-(--surface-inverse)">
        <span className="flex h-[18px] w-[18px] items-center justify-center">
          <GithubMark color="#fff" />
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13.5px] font-semibold leading-normal">Connect GitHub to sync repos</div>
        <div className="mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          Install the AgentConnect GitHub app to browse repositories and keep branch, commit, and metadata synced
          automatically. You choose which repos it can read.
        </div>
        <div className="mt-[10px] flex flex-wrap items-center gap-[10px]">
          <Button onClick={onInstall}>
            <span className="flex h-[14px] w-[14px] items-center justify-center">
              <GithubMark color="#fff" />
            </span>
            Install GitHub app
          </Button>
          {onSync ? (
            <button
              type="button"
              className="lnk inline-flex items-center gap-[6px]"
              onClick={onSync}
              disabled={syncing}
            >
              <Icon
                name={syncing ? 'loader' : 'refresh-cw'}
                size={13}
                className={syncing ? 'animate-spin' : undefined}
              />
              I&rsquo;ve installed it — sync
            </button>
          ) : (
            <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              Opens github.com in a new tab
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export function GithubConnectedBanner({ onManage }: { onManage: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-(--status-online) bg-(--status-online-soft) px-3 py-[9px] desktop:col-span-2">
      <Icon name="circle-check" size={16} color="var(--status-online)" />
      <span className="min-w-0 flex-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-primary)">
        GitHub app connected — repos and metadata sync automatically.
      </span>
      <button
        type="button"
        className="inline-flex flex-none cursor-pointer items-center gap-[6px] border-0 bg-transparent font-sans text-[12px] font-semibold leading-normal text-(--text-secondary) hover:text-(--text-primary)"
        onClick={onManage}
      >
        <Icon name="settings-2" size={13} />
        Manage access
      </button>
    </div>
  )
}

export function GithubPrivateReposNotice({ profileHref }: { profileHref: string }) {
  return (
    <div className="mt-[6px] flex items-start gap-[6px] font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-secondary)">
      <Icon name="info" size={13} className="mt-[1px] flex-none" />
      <span>
        Public repositories are shown.{' '}
        <a className="lnk font-medium" href={profileHref}>
          Link your GitHub profile
        </a>
        &#32;to see private repositories.
      </span>
    </div>
  )
}

export function GithubRepositoryField({
  value,
  icon = 'lock',
  badge,
  loading,
  open,
  query,
  onToggle,
  onClose,
  onQueryChange,
  onSearchKeyDown,
  error,
  onRetry,
  children,
  note
}: {
  value: string
  icon?: 'lock' | 'book-marked'
  badge?: string
  loading: boolean
  open: boolean
  query: string
  onToggle: () => void
  onClose: () => void
  onQueryChange: (value: string) => void
  onSearchKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  error?: ReactNode
  onRetry?: () => void
  children: ReactNode
  note?: ReactNode
}) {
  const triggerRef = useRef<HTMLDivElement>(null)
  const [menuStyle, setMenuStyle] = useState<RepositoryMenuStyle | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuStyle({
      left: rect.left,
      top: rect.bottom + 5,
      width: rect.width,
      maxHeight: Math.min(340, Math.max(0, window.innerHeight - rect.bottom - 13))
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const scrollRoot = triggerRef.current?.closest<HTMLElement>('.modalbody, .overflow-y-auto')
    scrollRoot?.addEventListener('scroll', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      scrollRoot?.removeEventListener('scroll', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [open, onClose])

  return (
    <div className="fld relative min-w-0">
      <span className="fldlbl">GitHub repository</span>
      <div ref={triggerRef} className="inp min-w-0 cursor-pointer gap-2" title={value || undefined} onClick={onToggle}>
        <span className="inline-flex min-w-0 flex-1 items-center gap-[7px]">
          {value ? (
            <>
              <Icon name={icon} size={16} color="var(--text-tertiary)" className="flex-none" />
              <span
                className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium leading-normal"
                title={value}
              >
                {value}
              </span>
              {badge && (
                <span className="inline-flex h-[22px] flex-none items-center rounded-md bg-(--surface-active) px-2 font-mono text-[10.5px] font-semibold leading-normal text-(--text-secondary)">
                  {badge}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="imark h-4 w-4 flex-none border-0 bg-transparent">
                <GithubMark color="var(--text-secondary)" />
              </span>
              <span className="truncate text-(--text-tertiary)">
                {loading ? 'Loading repositories…' : 'Pick a repository'}
              </span>
            </>
          )}
        </span>
        <Icon name="chevron-down" size={15} color="var(--text-tertiary)" />
      </div>
      {open &&
        menuStyle &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[1090]" onClick={onClose} />
            <div className="fmenu fixed z-[1100] min-w-0 rounded-lg p-2 shadow-(--shadow-xl)" style={menuStyle}>
              <input
                className="fsearch h-10 rounded-md px-3 font-sans text-[13px] font-medium leading-normal"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder="Search or type owner/repo…"
                autoFocus
              />
              {error && (
                <div className="flex items-center gap-2 px-2 py-[7px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
                  <span className="min-w-0 flex-1">{error}</span>
                  {onRetry && (
                    <button type="button" className="lnk flex-none text-[12px]" onClick={onRetry}>
                      Retry
                    </button>
                  )}
                </div>
              )}
              {children}
            </div>
          </>,
          document.body
        )}
      {note}
    </div>
  )
}

export function GithubRepositoryOption({
  fullName,
  description,
  icon = 'lock',
  badge,
  selected = false,
  onSelect
}: {
  fullName: string
  description: ReactNode
  icon?: 'lock' | 'book-marked'
  badge?: string
  selected?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className="fopt min-h-[46px] items-center gap-3 px-2 py-2"
      title={fullName}
      onClick={onSelect}
    >
      <Icon name={icon} size={16} color="var(--text-tertiary)" className="flex-none" />
      <span className="flex min-w-0 flex-1 flex-col items-start gap-[2px] overflow-hidden">
        <span
          className="block w-full min-w-0 truncate font-mono text-[12.5px] font-semibold leading-normal text-(--text-primary)"
          title={fullName}
        >
          {fullName}
        </span>
        <span className="block w-full min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {description}
        </span>
      </span>
      {badge ? (
        <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">{badge}</span>
      ) : (
        selected && <Icon name="check" size={17} color="var(--brand)" />
      )}
    </button>
  )
}

const ACCESS_OPTIONS: Array<{
  value: WorkspaceRepoAccess
  icon: 'eye' | 'git-branch'
  label: string
  description: string
}> = [
  { value: 'read', icon: 'eye', label: 'Read only', description: 'Clone & read files only' },
  {
    value: 'write',
    icon: 'git-branch',
    label: 'Read & write',
    description: 'Push, open PRs & run GitHub Actions'
  }
]

export function RepositoryAccessField({
  repositorySelected,
  value,
  open,
  readOnly = false,
  readOnlyNote,
  onToggle,
  onClose,
  onChange
}: {
  repositorySelected: boolean
  value: WorkspaceRepoAccess
  open: boolean
  readOnly?: boolean
  readOnlyNote?: ReactNode
  onToggle: () => void
  onClose: () => void
  onChange: (value: WorkspaceRepoAccess) => void
}) {
  const selected = ACCESS_OPTIONS.find((option) => option.value === value)!
  return (
    <div className="fld relative min-w-0">
      <span className="fldlbl">Repository access</span>
      {!repositorySelected ? (
        <div className="inp min-w-0 cursor-not-allowed pl-[10px] opacity-70" aria-disabled="true">
          <span className="inline-flex min-w-0 flex-1 items-center gap-[7px]">
            <Icon name="book-marked" size={16} color="var(--text-tertiary)" className="flex-none" />
            <span className="truncate font-sans text-[13px] font-medium leading-normal text-(--text-tertiary)">
              Select repository first
            </span>
          </span>
        </div>
      ) : (
        <>
          <div
            className={readOnly ? 'inp min-w-0 cursor-default gap-2' : 'inp min-w-0 cursor-pointer gap-2'}
            onClick={() => {
              if (!readOnly) onToggle()
            }}
          >
            <span className="inline-flex min-w-0 flex-1 items-center gap-[7px]">
              <Icon name={selected.icon} size={16} color="var(--text-tertiary)" className="flex-none" />
              <span className="truncate font-sans text-[13px] font-medium leading-normal text-(--text-secondary)">
                {selected.label}
              </span>
            </span>
            {!readOnly && <Icon name="chevron-down" size={15} color="var(--text-tertiary)" />}
          </div>
          {open && !readOnly && (
            <>
              <div className="fscrim" onClick={onClose} />
              <div className="fmenu left-0 right-0 z-40 min-w-0 rounded-lg p-2 shadow-(--shadow-xl)">
                {ACCESS_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="fopt min-h-[46px] items-center gap-3 px-2 py-2"
                    onClick={() => onChange(option.value)}
                  >
                    <Icon name={option.icon} size={16} color="var(--text-tertiary)" className="flex-none" />
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-[2px] overflow-hidden">
                      <span className="block w-full min-w-0 truncate font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
                        {option.label}
                      </span>
                      <span className="block w-full min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                        {option.description}
                      </span>
                    </span>
                    {value === option.value && <Icon name="check" size={17} color="var(--brand)" />}
                  </button>
                ))}
              </div>
            </>
          )}
          {readOnlyNote}
        </>
      )}
    </div>
  )
}

export function WorkspaceBranchField({
  repositorySelected,
  value,
  branches,
  defaultBranch,
  open,
  query,
  onToggle,
  onClose,
  onQueryChange,
  onChange
}: {
  repositorySelected: boolean
  value: string
  branches: string[] | null
  defaultBranch?: string
  open: boolean
  query: string
  onToggle: () => void
  onClose: () => void
  onQueryChange: (value: string) => void
  onChange: (value: string) => void
}) {
  const matchingBranches = (branches ?? []).filter(
    (branch) => !query.trim() || branch.toLowerCase().includes(query.trim().toLowerCase())
  )
  return (
    <div className="fld relative min-w-0">
      <span className="fldlbl">Branch</span>
      {!repositorySelected ? (
        <div className="inp min-w-0 cursor-not-allowed pl-[10px] opacity-70" aria-disabled="true">
          <span className="inline-flex min-w-0 flex-1 items-center gap-[7px]">
            <Icon name="git-branch" size={16} color="var(--text-tertiary)" className="flex-none" />
            <span className="truncate font-sans text-[13px] font-medium leading-normal text-(--text-tertiary)">
              Pick repository first
            </span>
          </span>
        </div>
      ) : branches && branches.length > 0 ? (
        <>
          <div className="inp min-w-0 cursor-pointer" onClick={onToggle}>
            <span className="inline-flex min-w-0 flex-1 items-center gap-[7px]">
              <Icon name="git-branch" size={16} color="var(--text-tertiary)" className="flex-none" />
              <span
                className={
                  value
                    ? 'truncate font-mono text-[12.5px] font-medium leading-normal'
                    : 'truncate font-sans text-[13px] font-medium leading-normal text-(--text-tertiary)'
                }
              >
                {value || 'GitHub default branch'}
              </span>
            </span>
            <Icon name="chevron-down" size={15} color="var(--text-tertiary)" />
          </div>
          {open && (
            <>
              <div className="fscrim" onClick={onClose} />
              <div className="fmenu left-0 right-0 z-40 min-w-0 rounded-lg p-2 shadow-(--shadow-xl)">
                <input
                  className="fsearch h-10 rounded-md px-3 font-sans text-[13px] font-medium leading-normal"
                  value={query}
                  onChange={(event) => onQueryChange(event.target.value)}
                  placeholder="Search branches…"
                  autoFocus
                />
                {matchingBranches.map((branch) => (
                  <button
                    key={branch}
                    type="button"
                    className="fopt min-h-[46px] items-center gap-3 px-2 py-[7px]"
                    onClick={() => onChange(branch)}
                  >
                    <Icon name="git-branch" size={16} color="var(--text-tertiary)" />
                    <span className="min-w-0 flex-1 truncate text-left font-mono text-[12.5px] font-semibold leading-normal text-(--text-primary)">
                      {branch}
                    </span>
                    {defaultBranch === branch && (
                      <span className="inline-flex h-[22px] flex-none items-center rounded-md bg-(--surface-active) px-2 font-mono text-[10.5px] font-semibold leading-normal text-(--text-secondary)">
                        default
                      </span>
                    )}
                    {value === branch && <Icon name="check" size={17} color="var(--brand)" />}
                  </button>
                ))}
                {query.trim() && matchingBranches.length === 0 && (
                  <div className="fnohit">No branches match &quot;{query}&quot;</div>
                )}
              </div>
            </>
          )}
        </>
      ) : (
        <div className="inp min-w-0 pl-[10px]">
          <span className="inline-flex min-w-0 flex-1 items-center gap-[7px]">
            <Icon name="git-branch" size={16} color="var(--text-tertiary)" className="flex-none" />
            <input
              className="mn min-w-0 flex-1 border-0 bg-transparent font-mono text-[12.5px] font-medium leading-normal text-(--text-primary) outline-none"
              placeholder="main"
              value={value}
              onChange={(event) => onChange(event.target.value)}
            />
          </span>
        </div>
      )}
    </div>
  )
}

export function WorkingSubdirectoryField({
  value,
  onChange,
  error
}: {
  value: string
  onChange: (value: string) => void
  error?: string | null
}) {
  return (
    <div className="fld min-w-0">
      <span className="fldlbl">Working subdirectory (optional)</span>
      <div className="inp min-w-0 justify-between gap-3 pl-[10px]">
        <input
          className="mn min-w-0 flex-1 border-0 bg-transparent font-mono text-[12.5px] font-medium leading-normal text-(--text-secondary) outline-none"
          placeholder="services/api"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label="Working subdirectory"
        />
        <span className="flex-none font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">
          {value.trim() ? '' : 'repo root'}
        </span>
      </div>
      {error && (
        <span className="mt-[5px] block font-sans text-[11px] font-normal leading-normal text-(--status-error)">
          {error}
        </span>
      )}
    </div>
  )
}

export function WorktreeField({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="fld min-w-0">
      <span className="fldlbl">Worktree</span>
      <div className="inp min-w-0 justify-end">
        <Toggle checked={checked} onChange={onChange} ariaLabel="Worktree" />
      </div>
    </div>
  )
}
