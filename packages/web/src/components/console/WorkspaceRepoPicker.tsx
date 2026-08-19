'use client'

// Which ROOT the workspace browser reads: the agent's own workspace, or one of its authorized
// additional repositories, each materialized as a secondary root beside it
// (multi-repository-workspaces.md). It sits where the breadcrumb's root label used to be, because
// that label always named the root being browsed — it just could only ever name one.
//
// Sibling to <WorkspaceScopePicker>, which chooses the CHECKOUT within a root (the primary branch
// or a session worktree). Two independent scopes, so they are two controls: the repository picked
// here keeps whatever checkout that picker holds.
//
// The menu is an <AnchoredFlyout> rather than an absolutely-positioned one: the breadcrumb it lives
// in clips its overflow to truncate long paths, which would cut a menu drawn inside it.

import { GithubMark } from '@/components/marks'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { REPOSITORY_ACCESS_BADGE } from '@/components/console/WorkspaceFormFields'
import type { AgentRepoAuthDto } from '@/lib/api'

/**
 * The repository the URL names, resolved against the agent's grants.
 *
 * A link can outlive a grant, so a `repo` the agent no longer authorizes falls back to the primary
 * rather than showing a browser that answers 404. Only once the list has LOADED, though: dropping
 * the parameter while it is still undefined would browse the wrong root on every cold visit and
 * then remount. The row's own casing wins, so the URL and the menu agree on one spelling.
 */
export function resolveWorkspaceRepoScope(
  repoParam: string | null,
  authorizations: AgentRepoAuthDto[] | undefined
): string | null {
  const wanted = repoParam?.trim()
  if (!wanted) return null
  if (authorizations === undefined) return wanted
  return authorizations.find((row) => row.repoFullName.toLowerCase() === wanted.toLowerCase())?.repoFullName ?? null
}

/**
 * What the `repo` parameter should become once grant resolution is definitive, or `undefined` when
 * the URL already agrees with the root being read (`null` ⇒ drop the parameter).
 *
 * {@link resolveWorkspaceRepoScope} can answer with the grant's own casing or with the workspace, and
 * a URL left saying something else both disagrees with the visible root and makes a link whose grant
 * is gone retry its dead scope on every cold load.
 */
export function workspaceRepoParamRewrite(
  repoParam: string | null,
  resolvedRepo: string | null,
  authorizations: AgentRepoAuthDto[] | undefined
): string | null | undefined {
  if (repoParam === null || authorizations === undefined) return undefined
  return repoParam === resolvedRepo ? undefined : resolvedRepo
}

const CHOICE =
  'flex w-full cursor-pointer items-center gap-[9px] rounded-[6px] border-0 bg-transparent px-[9px] py-[6px] text-left outline-none hover:bg-(--surface-hover) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--brand)'
const CHOICE_ON = `${CHOICE} bg-(--brand-soft) text-(--brand-soft-text) hover:bg-(--brand-soft)`

export function WorkspaceRepoPicker({
  primaryLabel,
  primaryIsRepo,
  repos,
  selectedRepo,
  onChange
}: {
  /** How the agent's own workspace reads in the list: `owner/repo`, or the scratch workspace's name. */
  primaryLabel: string
  /** A git workspace takes the GitHub mark like the grants; a scratch one takes a folder. */
  primaryIsRepo: boolean
  repos: AgentRepoAuthDto[]
  /** `owner/repo` of the selected additional repository; null ⇒ the agent's own workspace. */
  selectedRepo: string | null
  onChange: (repo: string | null) => void
}) {
  const selected = selectedRepo ?? primaryLabel

  return (
    <AnchoredFlyout
      ariaLabel="Workspace repository"
      align="start"
      width={320}
      estimatedHeight={64 + repos.length * 34}
      triggerClassName="flex min-w-0"
      trigger={({ open, menuId, toggle }) => (
        <button
          type="button"
          className="flex h-7 max-w-[220px] min-w-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1 text-left outline-none hover:bg-(--surface-hover) focus-visible:ring-2 focus-visible:ring-(--brand)"
          aria-label={`Repository: ${selected}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          title={selectedRepo ? `${selectedRepo} — an authorized additional repository` : primaryLabel}
          onClick={toggle}
        >
          <span className="mono max-w-[180px] truncate text-[12px] font-semibold text-(--text-primary)">
            {selected}
          </span>
          <Icon
            name="chevron-down"
            size={13}
            className={`flex-none text-(--text-tertiary) ${open ? 'rotate-180' : ''}`}
          />
        </button>
      )}
    >
      {({ close }) => (
        <>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selectedRepo === null}
            data-repo-choice
            className={selectedRepo === null ? CHOICE_ON : CHOICE}
            onClick={() => {
              close(true)
              onChange(null)
            }}
          >
            {primaryIsRepo ? (
              <span className="imark h-[14px] w-[14px] flex-none border-0 bg-transparent">
                <GithubMark />
              </span>
            ) : (
              <Icon name="folder" size={14} className="flex-none" />
            )}
            <span className="mono min-w-0 flex-1 truncate text-[11.5px] font-semibold" title={primaryLabel}>
              {primaryLabel}
            </span>
            <span className="eyebrow flex-none text-[10px]">workspace</span>
          </button>

          {repos.length > 0 ? (
            <>
              <div className="eyebrow mt-[3px] flex h-7 items-center gap-2 border-t border-(--border-subtle) px-[9px] text-[10.5px]">
                <span>Additional repositories</span>
                <span aria-hidden>·</span>
                <span>{repos.length}</span>
              </div>
              {repos.map((repo) => {
                const active = repo.repoFullName === selectedRepo
                return (
                  <button
                    key={repo.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    data-repo-choice
                    className={active ? CHOICE_ON : CHOICE}
                    title={`${repo.repoFullName} — ${repo.access} access`}
                    onClick={() => {
                      close(true)
                      onChange(repo.repoFullName)
                    }}
                  >
                    <span className="imark h-[14px] w-[14px] flex-none border-0 bg-transparent">
                      <GithubMark />
                    </span>
                    <span className="mono min-w-0 flex-1 truncate text-[11.5px]">{repo.repoFullName}</span>
                    <span className={REPOSITORY_ACCESS_BADGE[repo.access]}>{repo.access}</span>
                  </button>
                )
              })}
            </>
          ) : null}
        </>
      )}
    </AnchoredFlyout>
  )
}
