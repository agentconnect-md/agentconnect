import type { SessionAccessIssue } from '@/lib/api'

export interface AccessNotificationSnapshot {
  degraded: boolean
  issues: SessionAccessIssue[]
}

interface AccessDiagnostics {
  accessSyncDegraded?: boolean
  accessIssues?: SessionAccessIssue[]
}

interface AccessSnapshotState {
  authoritative: boolean
  isLoading: boolean
  isValidating: boolean
  error: unknown
}

export function accessNotificationSnapshot(
  diagnostics: AccessDiagnostics | null | undefined,
  state: AccessSnapshotState
): AccessNotificationSnapshot | null {
  if (
    !state.authoritative ||
    state.isLoading ||
    state.isValidating ||
    state.error ||
    diagnostics?.accessSyncDegraded === undefined
  ) {
    return null
  }

  return {
    degraded: diagnostics.accessSyncDegraded,
    issues: diagnostics.accessIssues ?? []
  }
}
