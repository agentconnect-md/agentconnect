// The rows inside the GitHub repository picker, shared by every surface that
// offers one. Each row says which credentials the pick would run on: an App
// installation, or an anonymous public clone (badged `public`, read-only).
import type { ReactNode } from 'react'
import { GithubRepositoryOption } from '@/components/console/WorkspaceFormFields'
import type { GithubRepoDto } from '@/lib/api'
import type { GithubRepoPickerLookup, InstalledRepo } from '@/lib/use-github-repo-picker'

export function GithubRepoPickerOptions({
  lookup,
  query,
  loading,
  failed = false,
  selected,
  describeRosterRow,
  onPickInstalled,
  onPickPublic
}: {
  lookup: GithubRepoPickerLookup
  query: string
  /** The roster is still loading — say so instead of reading as an empty list. */
  loading: boolean
  /** The roster read failed; its own error row already says so, so stay quiet here. */
  failed?: boolean
  /** The currently picked repository, `owner/repo`. */
  selected: string
  /** Per-surface wording for a synced row (an authorization badge, an updated-at trail). */
  describeRosterRow?: (repo: InstalledRepo) => { description: ReactNode; badge?: string }
  onPickInstalled: (repo: InstalledRepo) => void
  onPickPublic: (repo: GithubRepoDto) => void
}) {
  const { typedRepo, matches, installedExact, publicExact, exactState, publicMatches, searching } = lookup
  const is = (fullName: string) => selected.toLowerCase() === fullName.toLowerCase()
  return (
    <>
      {exactState === 'checking' && typedRepo && <Note>Checking GitHub repository…</Note>}
      {installedExact && (
        <GithubRepositoryOption
          key={`installation:${installedExact.installationId}:${installedExact.fullName}`}
          fullName={installedExact.fullName}
          icon={installedExact.private ? 'lock' : 'book-marked'}
          description="Available through the GitHub App"
          selected={is(installedExact.fullName)}
          onSelect={() => onPickInstalled(installedExact)}
        />
      )}
      {publicExact && (
        <GithubRepositoryOption
          key={`public-exact:${publicExact.fullName}`}
          fullName={publicExact.fullName}
          icon="book-marked"
          description="Use public repository — credential-free read-only clone"
          badge="public"
          onSelect={() => onPickPublic(publicExact)}
        />
      )}
      {matches.map((repo) => {
        const row = describeRosterRow?.(repo)
        return (
          <GithubRepositoryOption
            key={repo.fullName}
            fullName={repo.fullName}
            icon={repo.private ? 'lock' : 'book-marked'}
            description={
              row?.description ?? (
                <>
                  {repo.description ?? 'No description'}
                  {updatedTrail(repo)}
                </>
              )
            }
            {...(row?.badge ? { badge: row.badge } : {})}
            selected={is(repo.fullName)}
            onSelect={() => onPickInstalled(repo)}
          />
        )
      })}
      {publicMatches.map((repo) => (
        <GithubRepositoryOption
          key={`public:${repo.fullName}`}
          fullName={repo.fullName}
          icon="book-marked"
          description={
            <>
              {repo.description ?? 'Public GitHub repository'}
              {updatedTrail(repo)}
            </>
          }
          badge="public"
          onSelect={() => onPickPublic(repo)}
        />
      ))}
      {searching && <Note>Searching public repositories…</Note>}
      {loading && <Note>Loading repositories…</Note>}
      {!loading &&
        !searching &&
        !failed &&
        exactState !== 'checking' &&
        !installedExact &&
        !publicExact &&
        matches.length === 0 &&
        publicMatches.length === 0 &&
        query.trim() && (
          <div className="fnohit">
            {typedRepo && exactState === 'missing'
              ? `No GitHub repository found for "${typedRepo}"`
              : `No repositories match "${query.trim()}"`}
          </div>
        )}
    </>
  )
}

/** Repository rows carry an updated-at trail wherever GitHub reports one. */
function fmtAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${Math.max(m, 1)}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`
}

function updatedTrail(repo: GithubRepoDto): string {
  return repo.updatedAt ? ` · updated ${fmtAgo(repo.updatedAt)}` : ''
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-[7px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
      {children}
    </div>
  )
}
