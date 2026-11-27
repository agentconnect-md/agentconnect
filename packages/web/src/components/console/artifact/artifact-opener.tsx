'use client'

// How a session page opens the artifact viewer in place (artifacts.md §11.2); without an opener a card links to the standalone page.
import { createContext, useContext, type ReactNode } from 'react'
import type { ArtifactMarker } from '@/lib/artifact'
import type { ArtifactPlacement, ArtifactViewerTarget } from '@/lib/artifact-viewer-url'

/** `reveal: false` switches the dock's tab without opening a collapsed dock over the composer being typed in. */
export interface ArtifactOpenOptions {
  reveal?: boolean
}

/** Opens the session page's viewer at a placement, and hears the cards that arrive live (D23). */
export interface ArtifactOpener {
  open: (target: ArtifactViewerTarget, placement: ArtifactPlacement, options?: ArtifactOpenOptions) => void
  /** Cards that arrived live in a transcript whose cards open at `placement`, oldest first. */
  arrived?: (markers: readonly ArtifactMarker[], placement: ArtifactPlacement) => void
}

const OpenerContext = createContext<ArtifactOpener | null>(null)
const PlacementContext = createContext<ArtifactPlacement>('dock')

/** Provided by the session page on a desktop; a phone gets none, so its cards open the standalone page. */
export function ArtifactOpenerProvider({ opener, children }: { opener: ArtifactOpener | null; children: ReactNode }) {
  return <OpenerContext.Provider value={opener}>{children}</OpenerContext.Provider>
}

/** Where cards in this subtree open the viewer: the dock by default, the left pane for a task thread in the dock. */
export function ArtifactPlacementProvider({
  placement,
  children
}: {
  placement: ArtifactPlacement
  children: ReactNode
}) {
  return <PlacementContext.Provider value={placement}>{children}</PlacementContext.Provider>
}

/** The session page's opener, or null outside a session page and on a phone. */
export function useArtifactOpener(): ArtifactOpener | null {
  return useContext(OpenerContext)
}

/** Where a card here opens the viewer. */
export function useArtifactPlacement(): ArtifactPlacement {
  return useContext(PlacementContext)
}
