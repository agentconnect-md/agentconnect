import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { KeyboardEvent, ReactNode } from 'react'
import { GithubMark, GitlabMark } from '@/components/marks'
import { Button, Icon, Toggle } from '@/components/ui'
import { GITLAB_PROJECT_STATE, gitlabChoiceSelectable, type GitlabProjectChoice } from '@/lib/gitlab-projects'
import type { RepoAccess } from '@/lib/api'

export type WorkspaceMode = 'scratch' | 'github' | 'gitlab'
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
      <div className="grid grid-cols-1 gap-[10px] desktop:grid-cols-3">
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
        <button
          type="button"
          className={value === 'gitlab' ? 'ptile on items-start text-left' : 'ptile items-start text-left'}
          onClick={() => onChange('gitlab')}
        >
          {tileIcon(<GitlabMark />)}
          <span className="min-w-0 flex-1">
            <span className="block font-sans text-[13px] font-semibold leading-normal">From GitLab</span>
            <span className="mt-[2px] block truncate font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
              Clone a project on a branch.
            </span>
          </span>
          {radio(value === 'gitlab')}
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

/** What a caller supplies to either code-host picker; the words come from the wrapper. */
export interface RepositoryPickerProps {
  /** Overrides the wrapper's field label where a surface needs another noun. */
  label?: string
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
}

interface RepositoryPickerWords {
  label: string
  mark: ReactNode
  emptyLabel: string
  loadingLabel: string
  searchPlaceholder: string
}

/** The provider-neutral picker chrome — trigger, portalled menu, search box and
 *  error row. Each code host supplies its own words and mark through a wrapper. */
function RepositoryPickerField({
  label,
  mark,
  emptyLabel,
  loadingLabel,
  searchPlaceholder,
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
}: Omit<RepositoryPickerProps, 'label'> & RepositoryPickerWords) {
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
      <span className="fldlbl">{label}</span>
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
              <span className="imark h-4 w-4 flex-none border-0 bg-transparent">{mark}</span>
              <span className="truncate text-(--text-tertiary)">{loading ? loadingLabel : emptyLabel}</span>
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
                placeholder={searchPlaceholder}
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

export function GithubRepositoryField(props: RepositoryPickerProps) {
  return (
    <RepositoryPickerField
      {...props}
      label={props.label ?? 'GitHub repository'}
      mark={<GithubMark color="var(--text-secondary)" />}
      emptyLabel="Pick a repository"
      loadingLabel="Loading repositories…"
      searchPlaceholder="Search or type owner/repo…"
    />
  )
}

export function GitlabProjectField(props: RepositoryPickerProps) {
  return (
    <RepositoryPickerField
      {...props}
      label={props.label ?? 'GitLab project'}
      mark={<GitlabMark />}
      emptyLabel="Pick a project"
      loadingLabel="Loading projects…"
      searchPlaceholder="Search your GitLab projects…"
    />
  )
}

/** One pickable project — already added, or one this connection can add. Picking
 *  an unadded one sets up its bot and webhook, which is why it says so before the
 *  click. Transient states are listed and disabled, not hidden: a project that is
 *  mid-setup reads as on its way rather than mysteriously absent. */
export function GitlabProjectOption({
  choice,
  selected = false,
  busy = false,
  onSelect
}: {
  choice: GitlabProjectChoice
  selected?: boolean
  busy?: boolean
  onSelect: () => void
}) {
  const selectable = gitlabChoiceSelectable(choice) && !busy
  const state = choice.binding ? GITLAB_PROJECT_STATE[choice.binding.state] : null
  const branch = choice.defaultBranch ? `default branch ${choice.defaultBranch}` : 'no default branch reported'
  return (
    <button
      type="button"
      className={
        selectable
          ? 'fopt min-h-[46px] items-center gap-3 px-2 py-2'
          : 'fopt min-h-[46px] cursor-not-allowed items-center gap-3 px-2 py-2 opacity-60'
      }
      title={choice.projectPath}
      aria-disabled={!selectable}
      disabled={!selectable}
      onClick={() => selectable && onSelect()}
    >
      <span className="flex h-4 w-4 flex-none items-center justify-center">
        <GitlabMark />
      </span>
      <span className="flex min-w-0 flex-1 flex-col items-start gap-[2px] overflow-hidden">
        <span
          className="block w-full min-w-0 truncate font-mono text-[12.5px] font-semibold leading-normal text-(--text-primary)"
          title={choice.projectPath}
        >
          {choice.projectPath}
        </span>
        <span className="block w-full min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {busy ? 'Setting up the project bot and webhook…' : choice.binding ? branch : `${branch} · sets up on pick`}
        </span>
      </span>
      {state && state.label !== 'ready' && <span className={`badge flex-none ${state.badge}`}>{state.label}</span>}
      {selected && <Icon name="check" size={17} color="var(--brand)" />}
    </button>
  )
}

/** Nothing to pick: this deployment configures no GitLab application, no GitLab
 *  account is connected, or the connected one administers nothing this
 *  organization may set up. */
export function GitlabNoProjectsNotice({
  integrationsHref,
  connected,
  enabled = true
}: {
  integrationsHref: string
  connected: boolean
  enabled?: boolean
}) {
  return (
    <div className="flex items-start gap-2 rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary) desktop:col-span-2">
      <span className="mt-[1px] flex h-[14px] w-[14px] flex-none items-center justify-center">
        <GitlabMark fillPct={100} />
      </span>
      {!enabled ? (
        <span>GitLab is not enabled on this deployment — no GitLab application is configured.</span>
      ) : connected ? (
        <span>
          The connected GitLab account has no project to offer. You need Maintainer or Owner access to a project before
          it can be set up here.
        </span>
      ) : (
        <span>
          No GitLab account is connected yet. Connect GitLab under{' '}
          <a className="lnk font-medium" href={integrationsHref}>
            Integrations
          </a>
          , then pick a project here.
        </span>
      )}
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

function accessOptions(writeDescription: string): Array<{
  value: WorkspaceRepoAccess
  icon: 'eye' | 'git-branch'
  label: string
  description: string
}> {
  return [
    { value: 'read', icon: 'eye', label: 'Read only', description: 'Clone & read files only' },
    { value: 'write', icon: 'git-branch', label: 'Read & write', description: writeDescription }
  ]
}

export function RepositoryAccessField({
  repositorySelected,
  value,
  open,
  readOnly = false,
  readOnlyNote,
  label = 'Repository access',
  unselectedLabel = 'Select repository first',
  writeDescription = 'Push, open PRs & run GitHub Actions',
  onToggle,
  onClose,
  onChange
}: {
  repositorySelected: boolean
  value: WorkspaceRepoAccess
  open: boolean
  readOnly?: boolean
  readOnlyNote?: ReactNode
  label?: string
  unselectedLabel?: string
  /** What read & write buys on this code host — the only provider-specific word here. */
  writeDescription?: string
  onToggle: () => void
  onClose: () => void
  onChange: (value: WorkspaceRepoAccess) => void
}) {
  const options = accessOptions(writeDescription)
  const selected = options.find((option) => option.value === value)!
  return (
    <div className="fld relative min-w-0">
      <span className="fldlbl">{label}</span>
      {!repositorySelected ? (
        <div className="inp min-w-0 cursor-not-allowed pl-[10px] opacity-70" aria-disabled="true">
          <span className="inline-flex min-w-0 flex-1 items-center gap-[7px]">
            <Icon name="book-marked" size={16} color="var(--text-tertiary)" className="flex-none" />
            <span className="truncate font-sans text-[13px] font-medium leading-normal text-(--text-tertiary)">
              {unselectedLabel}
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
                {options.map((option) => (
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
  unselectedLabel = 'Pick repository first',
  defaultBranchLabel = 'GitHub default branch',
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
  unselectedLabel?: string
  defaultBranchLabel?: string
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
              {unselectedLabel}
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
                {value || defaultBranchLabel}
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
