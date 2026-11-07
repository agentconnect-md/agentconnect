'use client'

// The Azure DevOps picker's data (azure-devops-integration.md §5): what the connection's identity can see merged with the bound rows; connecting happens on the Integrations card.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchAzureDevOpsConnectionRepositories,
  fetchAzureDevOpsConnections,
  fetchAzureDevOpsRepositories,
  type AzureDevOpsRepositoryBindingDto,
  type AzureDevOpsRepositoryDto
} from './api'
import { mergeAzureDevOpsRepositoryChoices, type AzureDevOpsRepositoryChoice } from './azure-devops-repositories'

export interface AzureDevOpsRepositoryPicker {
  /** The Control Plane serves Azure DevOps at all. */
  enabled: boolean
  /** The organization's one connection, which every pick is served through. */
  connectionId: string | null
  connected: boolean
  choices: AzureDevOpsRepositoryChoice[]
  loading: boolean
  /** Nothing was ever offered: the notice case, not a search that matches nothing. */
  empty: boolean
  /** Neither list could be read. */
  error: string | null
  /** Why the identity's list could not be read while the bound rows still show. */
  listError: string | null
  reload: () => void
  reloading: boolean
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** `active` keeps a pane that is not showing from issuing any request. */
export function useAzureDevOpsRepositories(active: boolean): AzureDevOpsRepositoryPicker {
  const [enabled, setEnabled] = useState(true)
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [bindings, setBindings] = useState<AzureDevOpsRepositoryBindingDto[] | null>(null)
  const [visible, setVisible] = useState<AzureDevOpsRepositoryDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [reloading, setReloading] = useState(false)

  useEffect(() => {
    if (!active) return
    let alive = true
    setError(null)
    setListError(null)
    void (async () => {
      try {
        const listed = await fetchAzureDevOpsConnections()
        if (!alive) return
        setEnabled(listed.enabled)
        const connection = listed.connections[0] ?? null
        setConnectionId(connection?.id ?? null)
        if (!listed.enabled || !connection) {
          setBindings([])
          setVisible([])
          return
        }
        const [bound, seen] = await Promise.allSettled([
          fetchAzureDevOpsRepositories(),
          fetchAzureDevOpsConnectionRepositories(connection.id)
        ])
        if (!alive) return
        const rows = bound.status === 'fulfilled' ? bound.value.filter((b) => b.connectionId === connection.id) : []
        setBindings(rows)
        setVisible(seen.status === 'fulfilled' ? seen.value : [])
        if (seen.status === 'rejected') {
          if (rows.length === 0) setError(errorText(seen.reason))
          else setListError(errorText(seen.reason))
        }
      } catch (e) {
        if (!alive) return
        setBindings([])
        setVisible([])
        setError(errorText(e))
      } finally {
        if (alive) setReloading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [active, reloadToken])

  const reload = useCallback((): void => {
    setReloading(true)
    setReloadToken((token) => token + 1)
  }, [])

  const choices = useMemo(() => mergeAzureDevOpsRepositoryChoices(bindings ?? [], visible ?? []), [bindings, visible])
  const [everOffered, setEverOffered] = useState(false)
  useEffect(() => {
    if (choices.length > 0) setEverOffered(true)
  }, [choices.length])

  const loading = active && (bindings === null || visible === null)
  return {
    enabled,
    connectionId,
    connected: connectionId !== null,
    choices,
    loading,
    empty: !loading && !everOffered && choices.length === 0,
    error,
    listError,
    reload,
    reloading
  }
}
