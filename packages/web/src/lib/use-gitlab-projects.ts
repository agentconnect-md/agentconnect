'use client'

/**
 * The GitLab project picker's data, shared by every flow that picks a project:
 * the Add-integration wizard's GitLab trigger and the agent-workspace forms.
 *
 * Authorization happens where the project is used, mirroring the GitHub card:
 * the Integrations card manages the connection and the health of what is
 * already bound, and picking a project that is not bound yet provisions it
 * here. The added projects come from one org-wide list; the candidates come
 * from the connection that can still talk to GitLab, searched server-side
 * behind a debounce because a Maintainer's project list is not a local roster.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError,
  createGitlabProject,
  fetchGitlabConnections,
  fetchGitlabProjects,
  searchGitlabProjects,
  startGitlabOauth,
  type GitlabProjectBindingDto,
  type GitlabProjectDto
} from './api'
import { mergeGitlabProjectChoices, type GitlabProjectChoice } from './gitlab-projects'
import { managedGitlabInstanceUrl } from './git-url-tile'

const SEARCH_DEBOUNCE_MS = 300

// Bots are created and retired behind project and hook CRUD, so a read that never repeats would
// show a project whose bot has not arrived yet as one that has none.

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// A deployment with no GitLab application serves none of these routes: 404 is absence, not failure.
function absentAsEmpty(e: unknown): GitlabProjectBindingDto[] {
  if (e instanceof ApiError && e.status === 404) return []
  throw e
}

export interface GitlabProjectPicker {
  /** This deployment has a GitLab application configured at all. */
  enabled: boolean
  /** Added projects merged with what the live connection could still add. */
  choices: GitlabProjectChoice[]
  /** True until the added projects and the connections have both answered. */
  loading: boolean
  /** This picker has never had a project to offer — the notice case, as opposed
   *  to a search that happens to match nothing right now. */
  empty: boolean
  /** Fatal: neither list could be read. The picker has nothing to offer. */
  error: string | null
  /** A connection that can still talk to GitLab exists. */
  connected: boolean
  /** The instance this deployment talks to (§24.1); the default until a connection answers. */
  instanceUrl: string
  /** Authorize a GitLab account in a new tab. The grant lands on the connection,
   *  so the picker learns about it through `reload`, not through this call. */
  connect: () => Promise<void>
  /** Re-read the added projects and the connections — what a caller offers after
   *  sending someone off to connect. */
  reload: () => void
  /** A `reload` is in flight. */
  reloading: boolean
  /** Project id whose setup saga is running right now. */
  provisioning: string | null
  /** The last failed setup, in GitLab words. */
  provisionError: string | null
  /** Bind an unadded project. Resolves to null when setup failed. */
  provision: (projectId: string) => Promise<GitlabProjectBindingDto | null>
}

/** `active` keeps a pane that is not showing from issuing any request at all. */
export function useGitlabProjects(active: boolean, query: string): GitlabProjectPicker {
  const [bindings, setBindings] = useState<GitlabProjectBindingDto[] | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [instanceUrl, setInstanceUrl] = useState(managedGitlabInstanceUrl)
  const [candidates, setCandidates] = useState<GitlabProjectDto[]>([])
  const [error, setError] = useState<string | null>(null)
  const [provisioning, setProvisioning] = useState<string | null>(null)
  const [provisionError, setProvisionError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [reloading, setReloading] = useState(false)
  const busy = useRef(false)

  // One request per active lifecycle, and no one-shot guard: the guard would
  // survive the cleanup that abandons its own request, so Strict Mode's
  // setup/cleanup/setup — or leaving the pane mid-load — would strand the
  // spinner on an answer nobody is listening for.
  useEffect(() => {
    if (!active) return
    let alive = true
    setError(null)
    Promise.all([fetchGitlabProjects().catch(absentAsEmpty), fetchGitlabConnections()]).then(
      ([bound, { enabled: configured, connections }]) => {
        if (!alive) return
        setEnabled(configured)
        setBindings(bound)
        // Only a connection GitLab still accepts can add a project (§10.1).
        setConnectionId(connections.find((c) => c.state === 'connected')?.id ?? null)
        if (connections[0]?.instanceUrl) setInstanceUrl(connections[0].instanceUrl)
        setReloading(false)
      },
      (e) => {
        if (!alive) return
        setBindings([])
        setError(errorText(e))
        setReloading(false)
      }
    )
    return () => {
      alive = false
    }
  }, [active, reloadToken])

  // Candidates are searched on GitLab, so keystrokes settle through a debounce.
  // A failed search leaves the added projects pickable rather than emptying the list.
  useEffect(() => {
    if (!active || !connectionId) return
    let alive = true
    const timer = setTimeout(() => {
      searchGitlabProjects(connectionId, query.trim() ? { search: query.trim() } : {}).then(
        (page) => alive && setCandidates(page.projects),
        () => alive && setCandidates([])
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [active, connectionId, query])

  const provision = useCallback(
    async (projectId: string): Promise<GitlabProjectBindingDto | null> => {
      if (busy.current || !connectionId) return null
      busy.current = true
      setProvisioning(projectId)
      setProvisionError(null)
      try {
        // The saga runs server-side and answers with the converged binding, so
        // its outcome state — ready or partly set up — is what the picker shows.
        const binding = await createGitlabProject({ connectionId, projectId })
        setBindings((current) => [...(current ?? []).filter((b) => b.id !== binding.id), binding])
        return binding
      } catch (e) {
        setProvisionError(errorText(e))
        return null
      } finally {
        busy.current = false
        setProvisioning(null)
      }
    },
    [connectionId]
  )

  // The authorization URL carries a one-shot state, so it is minted per click.
  const connect = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const url = await startGitlabOauth(typeof window === 'undefined' ? undefined : window.location.pathname)
      window.open(url, '_blank', 'noopener')
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  const reload = useCallback((): void => {
    setReloading(true)
    setReloadToken((token) => token + 1)
  }, [])

  const choices = useMemo(() => mergeGitlabProjectChoices(bindings ?? [], candidates), [bindings, candidates])

  // Sticky: once the picker has offered something, a search that matches nothing
  // is a search result, not an empty integration.
  const [everOffered, setEverOffered] = useState(false)
  useEffect(() => {
    if (choices.length > 0) setEverOffered(true)
  }, [choices.length])

  const loading = active && bindings === null
  return {
    enabled,
    choices,
    loading,
    empty: !loading && !everOffered && choices.length === 0,
    error,
    connected: connectionId !== null,
    instanceUrl,
    connect,
    reload,
    reloading,
    provisioning,
    provisionError,
    provision
  }
}
