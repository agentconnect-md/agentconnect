'use client'

// The Azure DevOps picker offers the person's authorized catalog with optional management metadata.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError,
  startAzureDevOpsUserIdentity,
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
  /** The authorized repository catalog could not be read. */
  error: string | null
  verificationRequired: boolean
  verify: () => Promise<boolean>
  /** Binding metadata could not be read, but authorized choices remain available. */
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
  const [verificationRequired, setVerificationRequired] = useState(false)
  const verificationWindow = useRef<Window | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [reloading, setReloading] = useState(false)

  useEffect(() => {
    if (!active) return
    let alive = true
    setError(null)
    setVerificationRequired(false)
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
        if (seen.status === 'fulfilled') verificationWindow.current = null
        if (seen.status === 'rejected') {
          setError(errorText(seen.reason))
          setVerificationRequired(
            seen.reason instanceof ApiError && seen.reason.code === 'AZURE_DEVOPS_IDENTITY_VERIFICATION_REQUIRED'
          )
        } else if (bound.status === 'rejected') setListError(errorText(bound.reason))
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

  useEffect(() => {
    const completed = (event: MessageEvent) => {
      if (
        !verificationWindow.current ||
        event.origin !== window.location.origin ||
        event.source !== verificationWindow.current ||
        event.data?.type !== 'azure-devops-identity-verified'
      )
        return
      verificationWindow.current = null
      reload()
    }
    // Some identity providers sever the opener; returning to the original form still reloads its catalog.
    const returned = () => {
      if (verificationWindow.current) reload()
    }
    window.addEventListener('message', completed)
    window.addEventListener('focus', returned)
    return () => {
      window.removeEventListener('message', completed)
      window.removeEventListener('focus', returned)
    }
  }, [reload])

  const verify = async () => {
    if (!connectionId) return false
    const popup = window.open('about:blank', '_blank', 'popup,width=600,height=720')
    if (!popup) return false
    verificationWindow.current = popup
    try {
      const { authorizeUrl } = await startAzureDevOpsUserIdentity(connectionId)
      popup.location.href = authorizeUrl
      return true
    } catch (error) {
      popup.close()
      verificationWindow.current = null
      throw error
    }
  }

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
    verificationRequired,
    verify,
    listError,
    reload,
    reloading
  }
}
