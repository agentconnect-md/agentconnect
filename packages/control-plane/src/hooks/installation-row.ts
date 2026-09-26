import type { HookRecord } from '../persistence/ports.js'

/** Whether a github hook covers an event's repository: a repository row by id, an installation row by the event's signed installation (Installation-Wide Rows). */
export function githubHookCovers(
  hook: Pick<HookRecord, 'kind' | 'repoId' | 'installationId'>,
  repoId: bigint | null | undefined,
  installationId: bigint | null | undefined
): boolean {
  if (hook.kind !== 'github') return false
  if (hook.installationId != null) return installationId != null && hook.installationId === installationId
  return repoId != null && hook.repoId === repoId
}
