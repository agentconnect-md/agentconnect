// The GitHub repository picker's lookup, shared by every surface that offers one
// (agent creation, workspace replacement). It answers one question about the
// typed query — which repositories may be offered, and on what credentials:
//
//   1. the synced roster of every App installation (private repos included);
//   2. one exact owner/repo the roster does not list, resolved through an
//      installation ON ITS OWN ACCOUNT — a repo past the roster's pages keeps its
//      App credentials;
//   3. the same owner/repo read anonymously, offered as a credential-free public
//      checkout when no installation grants it;
//   4. public search hits, minus everything the rows above already offer.
//
// Selection stays with the caller: this hook never decides what is picked.
import { useEffect, useState } from 'react'
import { fetchGithubInstallationRepo, type GithubInstallationDto, type GithubRepoDto } from '@/lib/api'
import { fetchPublicGithubRepo, githubRepoLabelFromInput, searchPublicGithubRepos } from '@/lib/github-public-repos'

export type InstalledRepo = GithubRepoDto & { installationId: string }

/** Where an exact typed owner/repo resolved — the Enter key picks this. */
export type ExactRepoChoice = { kind: 'installed'; repo: InstalledRepo } | { kind: 'public'; repo: GithubRepoDto }

export interface GithubRepoPickerLookup {
  /** owner/repo parsed from the query (a pasted clone URL parses too); null when it is not one repo. */
  typedRepo: string | null
  /** Roster rows matching the query. */
  matches: InstalledRepo[]
  /** The typed repo resolved through an installation, past a truncated roster. */
  installedExact: InstalledRepo | null
  /** The typed repo read anonymously and confirmed public. */
  publicExact: GithubRepoDto | null
  exactState: 'idle' | 'checking' | 'found' | 'missing'
  /** Public search hits, minus every repo the rows above already offer. */
  publicMatches: GithubRepoDto[]
  searching: boolean
  /** What Enter should pick: the exact roster row first, then the lookups. */
  exactChoice: ExactRepoChoice | null
}

export function useGithubRepoPicker({
  enabled,
  query,
  installations,
  repos
}: {
  /** GitHub mode, the popover open, and no nested step in front of it. */
  enabled: boolean
  query: string
  installations: GithubInstallationDto[]
  /** The synced roster; null while it loads. */
  repos: InstalledRepo[] | null
}): GithubRepoPickerLookup {
  const [publicRepos, setPublicRepos] = useState<GithubRepoDto[]>([])
  const [searching, setSearching] = useState(false)
  const [publicExact, setPublicExact] = useState<GithubRepoDto | null>(null)
  const [installedExact, setInstalledExact] = useState<InstalledRepo | null>(null)
  const [exactState, setExactState] = useState<GithubRepoPickerLookup['exactState']>('idle')

  const trimmed = query.trim()
  const typedRepo = githubRepoLabelFromInput(query)
  const typedLower = typedRepo?.toLowerCase()
  const roster = repos ?? []
  const matches = roster.filter((repo) => !trimmed || repo.fullName.toLowerCase().includes(trimmed.toLowerCase()))
  const rosterExact = typedLower ? roster.find((repo) => repo.fullName.toLowerCase() === typedLower) : undefined

  // Bonus autocomplete over public GitHub, debounced and anonymous: a rate-limited
  // or unreachable GitHub simply offers nothing, and the exact path below still works.
  useEffect(() => {
    if (!enabled || trimmed.length < 3) {
      setPublicRepos([])
      setSearching(false)
      return
    }
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => {
      setSearching(true)
      searchPublicGithubRepos(trimmed, ctrl.signal)
        .then((rows) => setPublicRepos(rows))
        .catch(() => setPublicRepos([]))
        .finally(() => {
          if (!ctrl.signal.aborted) setSearching(false)
        })
    }, 250)
    return () => {
      ctrl.abort()
      window.clearTimeout(timer)
    }
  }, [enabled, trimmed])

  useEffect(() => {
    setInstalledExact(null)
    setPublicExact(null)
    setExactState('idle')
    if (!enabled || !typedRepo || rosterExact) return
    const [owner, repo] = typedRepo.split('/')
    if (!owner || !repo) return
    let alive = true
    const ctrl = new AbortController()
    // Only the installations on this owner's own account: installations are
    // per-account, so no other one can grant the repo — and its token would still
    // read a PUBLIC one, reporting it as App-backed until the workspace write
    // refused it on the owner check. No candidate ⇒ straight to the public read.
    const candidates = installations.filter((i) => i.accountLogin.toLowerCase() === owner.toLowerCase())
    const timer = window.setTimeout(() => {
      setExactState('checking')
      void Promise.all(
        candidates.map(async (installation) => {
          const found = await fetchGithubInstallationRepo(installation.id, owner, repo, ctrl.signal).catch(() => null)
          return found ? { ...found, installationId: installation.id } : null
        })
      ).then(async (rows) => {
        if (!alive || ctrl.signal.aborted) return
        const installed = rows.find((row): row is InstalledRepo => row !== null)
        if (installed) {
          setInstalledExact(installed)
          setExactState('found')
          return
        }
        const found = await fetchPublicGithubRepo(typedRepo, ctrl.signal).catch(() => null)
        if (!alive || ctrl.signal.aborted) return
        setPublicExact(found)
        setExactState(found ? 'found' : 'missing')
      })
    }, 250)
    return () => {
      alive = false
      ctrl.abort()
      window.clearTimeout(timer)
    }
  }, [enabled, installations, rosterExact, typedRepo])

  const typedInstalledExact = installedExact?.fullName.toLowerCase() === typedLower ? installedExact : null
  const typedPublicExact =
    !typedInstalledExact && publicExact?.fullName.toLowerCase() === typedLower ? publicExact : null
  const publicMatches = publicRepos.filter((repo) => {
    const fullName = repo.fullName.toLowerCase()
    return (
      fullName !== typedLower &&
      fullName !== typedInstalledExact?.fullName.toLowerCase() &&
      !roster.some((row) => row.fullName.toLowerCase() === fullName)
    )
  })
  const exactChoice: ExactRepoChoice | null = rosterExact
    ? { kind: 'installed', repo: rosterExact }
    : typedInstalledExact
      ? { kind: 'installed', repo: typedInstalledExact }
      : typedPublicExact
        ? { kind: 'public', repo: typedPublicExact }
        : null

  return {
    typedRepo,
    matches,
    installedExact: typedInstalledExact,
    publicExact: typedPublicExact,
    exactState,
    publicMatches,
    searching,
    exactChoice
  }
}
