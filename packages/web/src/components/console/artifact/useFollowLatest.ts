'use client'

// Revision following (artifacts.md §11.4): a viewer on the latest revision moves to a newer one; a chosen older one stays.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArtifactDto } from '@/lib/artifact'

/** The newest revision a viewer can show: the newest kept one, which `latestRevision` names once it is ready. */
function newestRevision(artifact: Pick<ArtifactDto, 'revisions' | 'latestRevision'>): number {
  return artifact.revisions[0]?.number ?? artifact.latestRevision
}

/** Follows a newer revision while the latest is shown (`requested` absent or the one that was newest); returns the "Updated to rN" notice. */
export function useFollowLatest(
  artifact: Pick<ArtifactDto, 'revisions' | 'latestRevision'> | undefined,
  requested: number | undefined,
  onFollow: (revision: number) => void
): { updatedTo: number | null; dismiss: () => void } {
  const newest = artifact ? newestRevision(artifact) : undefined
  const seen = useRef<number | undefined>(undefined)
  const [updatedTo, setUpdatedTo] = useState<number | null>(null)
  useEffect(() => {
    if (newest === undefined) return
    const before = seen.current
    seen.current = newest
    if (before === undefined || newest <= before) return
    if (requested !== undefined && requested !== before) return
    // An address naming no revision already shows the newest; one pinned to the old latest moves.
    if (requested !== undefined) onFollow(newest)
    setUpdatedTo(newest)
  }, [newest, requested, onFollow])
  const dismiss = useCallback(() => setUpdatedTo(null), [])
  return { updatedTo, dismiss }
}
