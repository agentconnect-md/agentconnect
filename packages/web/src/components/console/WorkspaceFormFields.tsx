import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { KeyboardEvent, ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { type CodeHostProvider } from '@agentconnect.md/protocol/code-host'
import { GiteaMark, GithubMark, GitlabMark } from '@/components/marks'
import { CodeHostMark } from '@/components/console/CodeHostMark'
import { Button, Icon, Toggle } from '@/components/ui'
import { CODE_HOST_PROJECTION, PICKABLE_CODE_HOST_PROVIDERS } from '@/lib/code-hosts'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { GITEA_REPOSITORY_STATE, giteaChoiceSelectable, type GiteaRepositoryChoice } from '@/lib/gitea-repositories'
import { GITLAB_PROJECT_STATE, gitlabChoiceSelectable, type GitlabProjectChoice } from '@/lib/gitlab-projects'
import type { RepoAccess, RepoMaterialize } from '@/lib/api'

// The TILE the user types through, not what is stored (git-workspace-model.md §7):
// every repo tile produces the same `{ mode: 'git', gitRepo }` payload, and the
// displayed tile of an existing workspace is derived from host + credential.
// One tile per code host, so a new host is a tile rather than an edit here.
export type WorkspaceMode = 'scratch' | CodeHostProvider | 'giturl'
export type WorkspaceRepoAccess = 'read' | 'write'
type RepositoryMenuStyle = { left: number; top: number; width: number; maxHeight: number }

// Complete literal class strings keep access badges consistent anywhere the
// workspace or one of its additional repositories is shown.
export const REPOSITORY_ACCESS_BADGE: Record<RepoAccess, string> = {
  read: 'badge flex-none bg-(--surface-active) text-(--text-tertiary)',
  comment: 'badge flex-none bg-(--brand-soft) text-(--brand-soft-text)',
  write: 'badge flex-none bg-(--status-paused-soft) text-(--amber-500)'
}

// The checkout choices a console user may pick; the per-session selector adds `decision` here.
export const REPOSITORY_MATERIALIZE_OPTIONS = ['always', 'on-demand'] as const satisfies readonly RepoMaterialize[]

const MATERIALIZE_COPY = {
  always: { label: 'materializeAlways', title: 'materializeAlwaysTitle' },
  decision: { label: 'materializeByDecision', title: 'materializeByDecisionTitle' },
  'on-demand': { label: 'materializeOnDemand', title: 'materializeOnDemandTitle' }
} as const satisfies Record<RepoMaterialize, { label: string; title: string }>

/** Read-only checkout badge in the access badge's neutral style, shown only for a grant that is not checked out always. */
export function RepositoryMaterializeBadge({ value }: { value: RepoMaterialize }) {
  const t = useTranslations('Integrations.dialog.workspaceFields')
  if (value === 'always') return null
  return (
    <span
      className="badge flex-none bg-(--surface-active) text-(--text-tertiary)"
      title={t(MATERIALIZE_COPY[value].title)}
    >
      {t(MATERIALIZE_COPY[value].label)}
    </span>
  )
}

const MATERIALIZE_PILL = {
  sm: {
    bar: 'pillbar flex-none p-[2px]',
    on: 'pill on px-2 py-[2px] text-[11.5px] leading-normal',
    off: 'pill px-2 py-[2px] text-[11.5px] leading-normal disabled:cursor-default disabled:opacity-50'
  },
  md: { bar: 'pillbar self-start', on: 'pill on', off: 'pill disabled:cursor-default disabled:opacity-50' }
} as const

/** Segment that switches a grant's checkout between the selectable options; `sm` fits a list row. */
export function RepositoryMaterializeSwitch({
  value,
  size = 'md',
  disabled = false,
  onChange
}: {
  value: RepoMaterialize
  size?: keyof typeof MATERIALIZE_PILL
  disabled?: boolean
  onChange: (value: RepoMaterialize) => void
}) {
  const t = useTranslations('Integrations.dialog.workspaceFields')
  const pill = MATERIALIZE_PILL[size]
  return (
    <span className={pill.bar} role="group" aria-label={t('checkout')}>
      {REPOSITORY_MATERIALIZE_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          className={value === option ? pill.on : pill.off}
          aria-pressed={value === option}
          title={t(MATERIALIZE_COPY[option].title)}
          disabled={disabled}
          onClick={() => {
            if (value !== option) onChange(option)
          }}
        >
          {t(MATERIALIZE_COPY[option].label)}
        </button>
      ))}
    </span>
  )
}

/** The add flow's labelled checkout choice, beside the access tiers. */
export function RepositoryMaterializeField({
  value,
  onChange
}: {
  value: RepoMaterialize
  onChange: (value: RepoMaterialize) => void
}) {
  const t = useTranslations('Integrations.dialog.workspaceFields')
  return (
    <div className="fld mb-4">
      <span className="fldlbl">{t('checkout')}</span>
      <RepositoryMaterializeSwitch value={value} onChange={onChange} />
    </div>
  )
}

// GitHub and GitLab ship as full-bleed marks, so they fill an 18px box next to the 16px lucide glyph.
const workspaceModeMark = (child: ReactNode) => (
  <span className="flex h-[18px] w-[18px] flex-none items-center justify-center">{child}</span>
)

export function WorkspaceModeField({
  value,
  onChange,
  className,
  // Add-agent renders this under a "Workspace" section heading, so it passes `null`
  // to drop the label rather than say "Workspace" twice.
  label
}: {
  value: WorkspaceMode
  onChange: (value: WorkspaceMode) => void
  className?: string
  label?: string | null
}) {
  const t = useTranslations('Integrations.dialog.workspaceFields')
  const fieldClassName = className ? `fld ${className}` : 'fld'
  // Fixed at mount: a workspace already on a git URL keeps its tile even where the flag is off
  // (live state stays representable — and reversible while the modal is open), new picks don't.
  const [withGitUrl] = useState(() => featureFlagEnabled('git-url') || value === 'giturl')
  const options = [
    {
      value: 'scratch' as const,
      label: t('scratch'),
      hint: t('scratchHint'),
      mark: (selected: boolean) =>
        workspaceModeMark(<Icon name="sparkles" size={16} color={selected ? 'var(--brand)' : 'var(--text-tertiary)'} />)
    },
    ...PICKABLE_CODE_HOST_PROVIDERS.map((provider) => ({
      value: provider,
      label: CODE_HOST_PROJECTION[provider].label,
      hint: t('cloneOnBranch', { repo: CODE_HOST_PROJECTION[provider].repoNounShort }),
      mark: () => workspaceModeMark(<CodeHostMark provider={provider} color="var(--text-primary)" fillPct={100} />)
    })),
    {
      value: 'giturl' as const,
      label: t('gitUrl'),
      hint: t('gitUrlHint'),
      mark: (selected: boolean) =>
        workspaceModeMark(<Icon name="link-2" size={16} color={selected ? 'var(--brand)' : 'var(--text-tertiary)'} />)
    }
  ].filter((option) => withGitUrl || option.value !== 'giturl')

  return (
    <div className={fieldClassName}>
      {label !== null && <span className="fldlbl">{label ?? t('workspace')}</span>}
      <div className="flex flex-wrap gap-[10px]">
        {options.map((option) => {
          const selected = value === option.value
          return (
            <button
              key={option.value}
              type="button"
              title={option.hint}
              aria-pressed={selected}
              className={
                selected
                  ? 'ptile on flex-1 justify-center px-[13px] py-[9px]'
                  : 'ptile flex-1 justify-center px-[13px] py-[9px]'
              }
              onClick={() => onChange(option.value)}
            >
              {option.mark(selected)}
              <span className="font-sans text-[13px] font-semibold leading-normal whitespace-nowrap">
                {option.label}
              </span>
            </button>
          )
        })}
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
  const t = useTranslations('Integrations.dialog.workspaceFields')
  return (
    <div className="flex items-start gap-4 rounded-lg border border-(--border-default) bg-(--surface-card) p-4 desktop:col-span-2">
      <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-md bg-(--surface-inverse)">
        <span className="flex h-[18px] w-[18px] items-center justify-center">
          <GithubMark color="#fff" />
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13.5px] font-semibold leading-normal">{t('githubConnectTitle')}</div>
        <div className="mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          {t('githubInstallDescription')}
        </div>
        <div className="mt-[10px] flex flex-wrap items-center gap-[10px]">
          <Button onClick={onInstall}>
            <span className="flex h-[14px] w-[14px] items-center justify-center">
              <GithubMark color="#fff" />
            </span>
            {t('installGithubApp')}
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
              {t('installedSync')}
            </button>
          ) : (
            <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              {t('opensGithub')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export function GithubConnectedBanner({ onManage }: { onManage: () => void }) {
  const t = useTranslations('Integrations.dialog.workspaceFields')
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-(--status-online) bg-(--status-online-soft) px-3 py-[9px] desktop:col-span-2">
      <Icon name="circle-check" size={16} color="var(--status-online)" />
      <span className="min-w-0 flex-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-primary)">
        {t('githubConnected')}
      </span>
      <button
        type="button"
        className="inline-flex flex-none cursor-pointer items-center gap-[6px] border-0 bg-transparent font-sans text-[12px] font-semibold leading-normal text-(--text-secondary) hover:text-(--text-primary)"
        onClick={onManage}
      >
        <Icon name="settings-2" size={13} />
        {t('manageAccess')}
      </button>
    </div>
  )
}

export function GithubPrivateReposNotice({ profileHref }: { profileHref: string }) {
  const t = useTranslations('Integrations.dialog.workspaceFields')
  return (
    <div className="mt-[6px] flex items-start gap-[6px] font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-secondary)">
      <Icon name="info" size={13} className="mt-[1px] flex-none" />
      <span>
        {t('publicRepositoriesShown')}{' '}
        <a className="lnk font-medium" href={profileHref}>
          {t('linkGithubProfile')}
        </a>
        &#32;{t('toSeePrivateRepositories')}
      </span>
    </div>
  )
}

/** What a caller supplies to either code-host picker; the words come from the wrapper. */
export interface RepositoryPickerProps {
  /** Overrides the wrapper's field label where a surface needs another noun. */
  label?: string
  value: string
  icon?: 'lock' | 'book-bookmark'
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
  const t = useTranslations('Integrations.dialog.workspaceFields')
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
                      {t('retry')}
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
  const t = useTranslations('Integrations.dialog.workspaceFields')
  return (
    <RepositoryPickerField
      {...props}
      label={props.label ?? t('githubRepository')}
      mark={<GithubMark color="var(--text-secondary)" />}
      emptyLabel={t('pickRepository')}
      loadingLabel={t('loadingRepositories')}
      searchPlaceholder={t('searchOwnerRepo')}
    />
  )
}

export function GitlabProjectField(props: RepositoryPickerProps) {
  const t = useTranslations('Integrations.dialog.workspaceFields')
  return (
    <RepositoryPickerField
      {...props}
      label={props.label ?? t('gitlabProject')}
      mark={<GitlabMark />}
      emptyLabel={t('pickProject')}
      loadingLabel={t('loadingProjects')}
      searchPlaceholder={t('searchGitlabProjects')}
    />
  )
}

export function GiteaRepositoryField(props: RepositoryPickerProps) {
  const t = useTranslations('Integrations.dialog.workspaceFields')
  return (
    <RepositoryPickerField
      {...props}
      label={props.label ?? t('giteaRepository')}
      mark={<GiteaMark color="var(--text-secondary)" />}
      emptyLabel={t('pickRepository')}
      loadingLabel={t('loadingRepositories')}
      searchPlaceholder={t('searchGiteaRepositories')}
    />
  )
}

/** One pickable Gitea repository — already added, or one the organization's bot administers.
 *  An unadded one is added by the save that follows (gitea-integration.md §6), which is why it
 *  says so before the click. Transient states are listed and disabled, not hidden: a repository
 *  that is mid-setup reads as on its way rather than mysteriously absent. */
export function GiteaRepositoryOption({
  choice,
  selected = false,
  onSelect
}: {
  choice: GiteaRepositoryChoice
  selected?: boolean
  onSelect: () => void
}) {
  const t = useTranslations('Integrations.dialog.workspaceFields')
  const selectable = giteaChoiceSelectable(choice)
  const state = choice.binding ? GITEA_REPOSITORY_STATE[choice.binding.state] : null
  const branch = choice.defaultBranch ? t('defaultBranch', { branch: choice.defaultBranch }) : t('noDefaultBranch')
  return (
    <button
      type="button"
      className={
        selectable
          ? 'fopt min-h-[46px] items-center gap-3 px-2 py-2'
          : 'fopt min-h-[46px] cursor-not-allowed items-center gap-3 px-2 py-2 opacity-60'
      }
      title={choice.repoPath}
      aria-disabled={!selectable}
      disabled={!selectable}
      onClick={() => selectable && onSelect()}
    >
      <span className="flex h-4 w-4 flex-none items-center justify-center">
        <GiteaMark />
      </span>
      <span className="flex min-w-0 flex-1 flex-col items-start gap-[2px] overflow-hidden">
        <span
          className="block w-full min-w-0 truncate font-mono text-[12.5px] font-semibold leading-normal text-(--text-primary)"
          title={choice.repoPath}
        >
          {choice.repoPath}
        </span>
        <span className="block w-full min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {choice.binding ? branch : t('addedOnSave', { branch })}
        </span>
      </span>
      {state && state.label !== 'ready' && <span className={`badge flex-none ${state.badge}`}>{state.label}</span>}
      {selected && <Icon name="check" size={17} color="var(--brand)" />}
    </button>
  )
}

/** Nothing to pick: this deployment configures no Gitea instance, the organization has not
 *  connected its bot, or the bot administers nothing. Connecting is a token paste on the
 *  Integrations card rather than a browser authorization, so this sends the reader there
 *  instead of offering a button that could not finish the job here. */
export function GiteaNoRepositoriesNotice({
  connected,
  enabled = true,
  integrationsHref,
  onSync,
  syncing = false
}: {
  connected: boolean
  enabled?: boolean
  integrationsHref: string
  onSync?: () => void
  syncing?: boolean
}) {
  const t = useTranslations('Integrations.dialog.workspaceFields')
  if (enabled && !connected) {
    return (
      <div className="rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] desktop:col-span-2">
        <div className="font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
          {t('connectGiteaTitle')}
        </div>
        <div className="mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          {t('connectGiteaDescription')}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <a className="lnk font-medium" href={integrationsHref}>
            {t('openIntegrations')}
          </a>
          {onSync && (
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
              {t('connectedSync')}
            </button>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-2 rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary) desktop:col-span-2">
      <span className="mt-[1px] flex h-[14px] w-[14px] flex-none items-center justify-center">
        <GiteaMark fillPct={100} />
      </span>
      {!enabled ? <span>{t('giteaDisabled')}</span> : <span>{t('giteaNoAdminRepository')}</span>}
    </div>
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
  const t = useTranslations('Integrations.dialog.workspaceFields')
  const selectable = gitlabChoiceSelectable(choice) && !busy
  const state = choice.binding ? GITLAB_PROJECT_STATE[choice.binding.state] : null
  const branch = choice.defaultBranch ? t('defaultBranch', { branch: choice.defaultBranch }) : t('noDefaultBranch')
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
          {busy ? t('settingUpProject') : choice.binding ? branch : t('setsUpOnPick', { branch })}
        </span>
      </span>
      {state && state.label !== 'ready' && <span className={`badge flex-none ${state.badge}`}>{state.label}</span>}
      {selected && <Icon name="check" size={17} color="var(--brand)" />}
    </button>
  )
}

/** The gitlab tile's second arm (§7): a public project outside the managed set,
 *  offered when the typed query looks like a path and matches no managed choice. */
export function PublicGitlabProjectOption({
  query,
  choices,
  onSelect
}: {
  query: string
  choices: readonly GitlabProjectChoice[]
  onSelect: (path: string) => void
}) {
  const t = useTranslations('Integrations.dialog.workspaceFields')
  const path = query.trim()
  if (!/^[^/\s]+\/[^\s]+$/.test(path)) return null
  if (choices.some((choice) => choice.projectPath.toLowerCase() === path.toLowerCase())) return null
  return (
    <button type="button" className="fopt min-h-[46px] items-center gap-3 px-2 py-2" onClick={() => onSelect(path)}>
      <span className="flex h-4 w-4 flex-none items-center justify-center">
        <Icon name="book-bookmark" size={14} color="var(--text-tertiary)" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col items-start gap-[2px] overflow-hidden">
        <span className="block w-full min-w-0 truncate font-mono text-[12.5px] font-semibold leading-normal text-(--text-primary)">
          {path}
        </span>
        <span className="block w-full min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {t('publicProjectReadOnly')}
        </span>
      </span>
      <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">{t('public')}</span>
    </button>
  )
}

/** The Git URL tile's body, shared by create and edit so the two cannot drift. */
export function GitUrlTileFields({
  url,
  urlHint,
  branch,
  agentDir,
  agentDirError,
  worktree,
  worktreeLabel,
  onUrlChange,
  onBranchChange,
  onAgentDirChange,
  onWorktreeChange
}: {
  url: string
  urlHint: string | null
  branch: string
  agentDir: string
  agentDirError?: string | null
  worktree: boolean
  /** What the session-isolation toggle is called here — see `WorktreeField`. */
  worktreeLabel: string
  onUrlChange: (value: string) => void
  onBranchChange: (value: string) => void
  onAgentDirChange: (value: string) => void
  onWorktreeChange: (value: boolean) => void
}) {
  const t = useTranslations('Integrations.dialog.workspaceFields')
  return (
    <div className="grid grid-cols-1 gap-[14px] desktop:col-span-2 desktop:grid-cols-2 desktop:gap-x-7">
      <label className="fld desktop:col-span-2">
        <span className="fldlbl">{t('cloneUrl')}</span>
        <input
          className="inp mn font-mono text-[12.5px]"
          placeholder={t('cloneUrlPlaceholder')}
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
        />
        {urlHint && (
          <span className="mt-[6px] inline-flex items-start gap-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            <Icon name="info" size={13} className="mt-[1px] flex-none" />
            {urlHint}
          </span>
        )}
      </label>
      <div className="grid grid-cols-1 gap-[14px] desktop:col-span-2 desktop:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_96px] desktop:gap-x-[14px]">
        <WorkspaceBranchField
          repositorySelected={!!url.trim()}
          unselectedLabel={t('enterCloneUrlFirst')}
          defaultBranchLabel={t('remoteDefaultBranch')}
          value={branch}
          branches={null}
          open={false}
          query=""
          onToggle={() => undefined}
          onClose={() => undefined}
          onQueryChange={() => undefined}
          onChange={onBranchChange}
        />
        <WorkingSubdirectoryField value={agentDir} error={agentDirError ?? null} onChange={onAgentDirChange} />
        <WorktreeField label={worktreeLabel} checked={worktree} onChange={onWorktreeChange} />
      </div>
      <div className="flex items-start gap-2 rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary) desktop:col-span-2">
        <Icon name="info" size={14} className="mt-[1px] flex-none" />
        <span>{t('clonedWithDaemonCredentials')}</span>
      </div>
    </div>
  )
}

/** Nothing to pick: this deployment configures no GitLab application, no GitLab
 *  account is connected, or the connected one administers nothing this
 *  organization may set up. */
export function GitlabNoProjectsNotice({
  connected,
  enabled = true,
  onConnect,
  onSync,
  syncing = false
}: {
  connected: boolean
  enabled?: boolean
  onConnect: () => void
  onSync?: () => void
  syncing?: boolean
}) {
  const t = useTranslations('Integrations.dialog.workspaceFields')
  // Connecting belongs where the project is picked, exactly as installing the GitHub app does.
  if (enabled && !connected) {
    return (
      <div className="rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] desktop:col-span-2">
        <div className="font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
          {t('connectGitlabTitle')}
        </div>
        <div className="mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          {t('connectGitlabDescription')}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={onConnect}>
            <Icon name="external-link" size={13} />
            {t('connectGitlab')}
          </Button>
          {onSync && (
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
              {t('connectedSync')}
            </button>
          )}
          <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {t('opensGitlab')}
          </span>
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-2 rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary) desktop:col-span-2">
      <span className="mt-[1px] flex h-[14px] w-[14px] flex-none items-center justify-center">
        <GitlabMark fillPct={100} />
      </span>
      {!enabled ? <span>{t('gitlabDisabled')}</span> : <span>{t('gitlabNoProject')}</span>}
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
  icon?: 'lock' | 'book-bookmark'
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

export function RepositoryAccessField({
  repositorySelected,
  value,
  open,
  readOnly = false,
  readOnlyNote,
  label,
  unselectedLabel,
  writeDescription,
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
  const t = useTranslations('Integrations.dialog.workspaceFields')
  const options = [
    { value: 'read' as const, icon: 'eye' as const, label: t('readOnly'), description: t('readOnlyDescription') },
    {
      value: 'write' as const,
      icon: 'git-branch' as const,
      label: t('readWrite'),
      description: writeDescription ?? t('githubWriteAccess')
    }
  ]
  const selected = options.find((option) => option.value === value)!
  return (
    <div className="fld relative min-w-0">
      <span className="fldlbl">{label ?? t('repositoryAccess')}</span>
      {!repositorySelected ? (
        <div className="inp min-w-0 cursor-not-allowed pl-[10px] opacity-70" aria-disabled="true">
          <span className="inline-flex min-w-0 flex-1 items-center gap-[7px]">
            <Icon name="book-bookmark" size={16} color="var(--text-tertiary)" className="flex-none" />
            <span className="truncate font-sans text-[13px] font-medium leading-normal text-(--text-tertiary)">
              {unselectedLabel ?? t('selectRepositoryFirst')}
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
  unselectedLabel,
  defaultBranchLabel,
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
  const t = useTranslations('Integrations.dialog.workspaceFields')
  const matchingBranches = (branches ?? []).filter(
    (branch) => !query.trim() || branch.toLowerCase().includes(query.trim().toLowerCase())
  )
  return (
    <div className="fld relative min-w-0">
      <span className="fldlbl">{t('branch')}</span>
      {!repositorySelected ? (
        <div className="inp min-w-0 cursor-not-allowed pl-[10px] opacity-70" aria-disabled="true">
          <span className="inline-flex min-w-0 flex-1 items-center gap-[7px]">
            <Icon name="git-branch" size={16} color="var(--text-tertiary)" className="flex-none" />
            <span className="truncate font-sans text-[13px] font-medium leading-normal text-(--text-tertiary)">
              {unselectedLabel ?? t('pickRepositoryFirst')}
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
                {value || defaultBranchLabel || t('githubDefaultBranch')}
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
                  placeholder={t('searchBranches')}
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
                        {t('default')}
                      </span>
                    )}
                    {value === branch && <Icon name="check" size={17} color="var(--brand)" />}
                  </button>
                ))}
                {query.trim() && matchingBranches.length === 0 && (
                  <div className="fnohit">{t('noBranchesMatch', { query })}</div>
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
              placeholder={t('mainBranch')}
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
  const t = useTranslations('Integrations.dialog.workspaceFields')
  return (
    <div className="fld min-w-0">
      <span className="fldlbl">{t('workingSubdirectory')}</span>
      <div className="inp min-w-0 justify-between gap-3 pl-[10px]">
        <input
          className="mn min-w-0 flex-1 border-0 bg-transparent font-mono text-[12.5px] font-medium leading-normal text-(--text-secondary) outline-none"
          placeholder={t('workingSubdirectoryPlaceholder')}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={t('workingSubdirectoryAriaLabel')}
        />
        <span className="flex-none font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">
          {value.trim() ? '' : t('repoRoot')}
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

/** `label` names the isolation by its EFFECTIVE boundary (git-workspace-model.md §11) — "Worktree" only where nothing encloses the runtime, "Session isolation" under a sandbox or a pool pod. */
export function WorktreeField({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="fld min-w-0">
      <span className="fldlbl">{label}</span>
      <div className="inp min-w-0 justify-end">
        <Toggle checked={checked} onChange={onChange} ariaLabel={label} />
      </div>
    </div>
  )
}
