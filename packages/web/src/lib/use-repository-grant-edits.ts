'use client'

// One-at-a-time access, checkout, and revoke edits to an agent's additional repositories and installation grants, shared by the Workspace card and Edit workspace.
import { useRef, useState } from 'react'
import {
  deleteAgentInstallation,
  deleteAgentRepo,
  updateAgentInstallation,
  updateAgentRepo,
  type AgentInstallationAuthDto,
  type AgentRepoAuthDto,
  type InstallationMaterialize,
  type RepoAccess,
  type RepoMaterialize
} from '@/lib/api'

export interface RepositoryGrantEdits {
  /** The row an update is saving, or null. */
  updating: string | null
  /** The row a revoke is deleting, or null. */
  removing: string | null
  /** Any edit in flight, which disables every other control. */
  busy: boolean
  /** The last refusal, verbatim, for the caller's error line. */
  error: string | null
  setError: (error: string | null) => void
  /** Run another edit, such as the repository selector, under the same busy state and error line. */
  run: (id: string, task: () => Promise<void>) => Promise<void>
  updateRepository: (
    row: AgentRepoAuthDto,
    input: { access: RepoAccess } | { materialize: RepoMaterialize }
  ) => Promise<void>
  removeRepository: (row: AgentRepoAuthDto) => Promise<void>
  updateGrant: (
    grant: AgentInstallationAuthDto,
    input: { access: RepoAccess } | { materialize: InstallationMaterialize }
  ) => Promise<void>
  removeGrant: (grant: AgentInstallationAuthDto) => Promise<void>
}

export function useRepositoryGrantEdits({
  agentId,
  repositories,
  grants,
  onRepositoriesChange,
  onGrantsChange
}: {
  agentId: string
  repositories: AgentRepoAuthDto[]
  grants: AgentInstallationAuthDto[]
  /** Receives the rows as the server now returns them. */
  onRepositoriesChange: (rows: AgentRepoAuthDto[]) => void
  onGrantsChange: (rows: AgentInstallationAuthDto[]) => void
}): RepositoryGrantEdits {
  const [updating, setUpdating] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)

  const perform = async (id: string, kind: 'update' | 'remove', task: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    if (kind === 'remove') setRemoving(id)
    else setUpdating(id)
    setError(null)
    try {
      await task()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      busyRef.current = false
      setUpdating(null)
      setRemoving(null)
    }
  }

  return {
    updating,
    removing,
    busy: updating !== null || removing !== null,
    error,
    setError,
    run: (id, task) => perform(id, 'update', task),
    updateRepository: (row, input) =>
      perform(row.id, 'update', async () => {
        const updated = await updateAgentRepo(agentId, row.id, input)
        onRepositoriesChange(repositories.map((existing) => (existing.id === row.id ? updated : existing)))
      }),
    removeRepository: (row) =>
      perform(row.id, 'remove', async () => {
        await deleteAgentRepo(agentId, row.id)
        onRepositoriesChange(repositories.filter((existing) => existing.id !== row.id))
      }),
    updateGrant: (grant, input) =>
      perform(grant.id, 'update', async () => {
        const updated = await updateAgentInstallation(agentId, grant.id, input)
        onGrantsChange(grants.map((existing) => (existing.id === grant.id ? updated : existing)))
      }),
    removeGrant: (grant) =>
      perform(grant.id, 'remove', async () => {
        await deleteAgentInstallation(agentId, grant.id)
        onGrantsChange(grants.filter((existing) => existing.id !== grant.id))
      })
  }
}
