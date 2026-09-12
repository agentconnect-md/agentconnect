'use client'

/**
 * The Gitea repository picker's data, shared by every flow that picks one: the
 * Add-integration wizard's Gitea trigger, the agent-workspace forms, and the
 * additional-repository grant.
 *
 * The shape is `use-gitlab-projects.ts` with Gitea's three differences
 * (gitea-integration.md §4, §6). Authorization is the organization's ONE bot
 * connection, which is made on the Integrations card — there is no browser
 * authorization to start from a picker, so this hook offers no `connect`: it
 * reports `connected: false` and the caller sends the reader to the card. The
 * candidates are the bot's whole `admin` set in one listing rather than a
 * server-side search, so the query filters locally: the set is bounded by what
 * one bot user administers, and Gitea's repository search cannot express
 * "administered by me". And there is no `provision`: a repository the
 * organization has not added is bound by the write that first names it — the
 * trigger, the workspace, the grant — so picking one is just picking it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  fetchGiteaConnectionRepositories,
  fetchGiteaConnections,
  fetchGiteaRepositories,
  type GiteaRepositoryBindingDto,
  type GiteaRepositoryDto
} from './api'
import {
  GITEA_DEFAULT_INSTANCE_URL,
  mergeGiteaRepositoryChoices,
  type GiteaRepositoryChoice
} from './gitea-repositories'

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// A deployment with no Gitea instance serves none of these routes: 404 is absence, not failure.
function absentAsEmpty(e: unknown): GiteaRepositoryBindingDto[] {
  if (e instanceof ApiError && e.status === 404) return []
  throw e
}

export interface GiteaRepositoryPicker {
  /** This deployment has a Gitea instance configured at all. */
  enabled: boolean
  /** Added repositories merged with the ones the bot could still add. */
  choices: GiteaRepositoryChoice[]
  /** True until the added repositories and the connection have both answered. */
  loading: boolean
  /** This picker has never had a repository to offer — the notice case, as opposed to a
   *  search that happens to match nothing right now. */
  empty: boolean
  /** Fatal: neither list could be read. The picker has nothing to offer. */
  error: string | null
  /** A connection Gitea still accepts exists, so a repository can be bound. */
  connected: boolean
  /** The instance this deployment talks to (§3); the default until a connection answers. */
  instanceUrl: string
  /** Re-read the connection and both lists — what a caller offers after sending someone
   *  off to the Integrations card to connect the bot. */
  reload: () => void
  /** A `reload` is in flight. */
  reloading: boolean
}

/** `active` keeps a pane that is not showing from issuing any request at all. */
export function useGiteaRepositories(active: boolean): GiteaRepositoryPicker {
  const [bindings, setBindings] = useState<GiteaRepositoryBindingDto[] | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [instanceUrl, setInstanceUrl] = useState(GITEA_DEFAULT_INSTANCE_URL)
  const [candidates, setCandidates] = useState<GiteaRepositoryDto[]>([])
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [reloading, setReloading] = useState(false)

  // One request per active lifecycle, and no one-shot guard: the guard would survive the
  // cleanup that abandons its own request, so Strict Mode's setup/cleanup/setup — or leaving
  // the pane mid-load — would strand the spinner on an answer nobody is listening for.
  useEffect(() => {
    if (!active) return
    let alive = true
    setError(null)
    Promise.all([fetchGiteaRepositories().catch(absentAsEmpty), fetchGiteaConnections()]).then(
      ([bound, { enabled: configured, connections }]) => {
        if (!alive) return
        setEnabled(configured)
        setBindings(bound)
        // Only a connection whose token Gitea still accepts can bind a repository (§4.3).
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

  // The bot's administered set, read once per connection. A failed read leaves the added
  // repositories pickable rather than emptying the list.
  useEffect(() => {
    if (!active || !connectionId) return
    let alive = true
    fetchGiteaConnectionRepositories(connectionId).then(
      (rows) => alive && setCandidates(rows),
      () => alive && setCandidates([])
    )
    return () => {
      alive = false
    }
  }, [active, connectionId, reloadToken])

  const reload = useCallback((): void => {
    setReloading(true)
    setReloadToken((token) => token + 1)
  }, [])

  const choices = useMemo(() => mergeGiteaRepositoryChoices(bindings ?? [], candidates), [bindings, candidates])

  // Sticky: once the picker has offered something, a search that matches nothing is a search
  // result, not an empty integration.
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
    reload,
    reloading
  }
}
