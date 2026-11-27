'use client'

// The dock's Artifacts tab (artifacts.md §11.2): the viewer a main-conversation card opened, or what the tab shows without one.
import type { ReactNode } from 'react'
import type { ArtifactViewerState } from '@/lib/artifact-viewer-url'
import { SessionArtifactViewer } from '@/components/console/artifact/SessionArtifactViewer'
import type { DockTabStatus } from './SessionDock'

/** The tab's status: `ready` with a viewer open; without one, the list's own verdict, `empty` while no list is given. */
export function artifactsTabStatus(viewerOpen: boolean, listStatus: DockTabStatus = 'empty'): DockTabStatus {
  return viewerOpen ? 'ready' : listStatus
}

export function ArtifactsPanel({
  viewer,
  onClose,
  onRevision,
  onPath,
  list
}: {
  /** The viewer the URL places in the dock, or null. */
  viewer: ArtifactViewerState | null
  onClose: () => void
  onRevision: (revision: number) => void
  onPath: (path: string | null) => void
  /** What the tab shows without an open viewer: the session's artifact list; absent, the dock draws its empty placeholder. */
  list?: ReactNode
}) {
  if (!viewer) return list ?? null
  return (
    <SessionArtifactViewer
      key={viewer.artifactId}
      viewer={viewer}
      onClose={onClose}
      onRevision={onRevision}
      onPath={onPath}
    />
  )
}
