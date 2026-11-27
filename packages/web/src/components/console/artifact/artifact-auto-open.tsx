'use client'

// The viewer opening by itself when the agent publishes in the session being watched (artifacts.md §11.2, D23).
import { useCallback, useEffect, useRef } from 'react'
import { useSWRConfig } from 'swr'
import type { Turn } from '@/components/console/session-turns'
import type { ArtifactMarker } from '@/lib/artifact'
import type { ArtifactPlacement, ArtifactViewerState, ArtifactViewerTarget } from '@/lib/artifact-viewer-url'
import { consoleKeys } from '@/lib/swr-keys'
import { useArtifactOpener, useArtifactPlacement, type ArtifactOpenOptions } from './artifact-opener'

/** What one pass over a transcript knew: its turns' keys and every card's `artifact:revision`. */
export interface ArrivalSnapshot {
  keys: ReadonlySet<string>
  seen: ReadonlySet<string>
}

const markerKey = (marker: ArtifactMarker): string => `${marker.artifactId}:${marker.revision}`

/** The cards that arrived since `prev`, oldest first; the first pass, a reset and history pages arrive nothing. */
export function artifactArrivals(
  prev: ArrivalSnapshot | null,
  turns: readonly Turn[]
): { next: ArrivalSnapshot; arrived: ArtifactMarker[] } {
  const cards: { marker: ArtifactMarker; at: number }[] = []
  turns.forEach((turn, at) => {
    if (turn.kind !== 'bot') return
    for (const step of turn.steps) if (step.artifact) cards.push({ marker: step.artifact, at })
  })
  const seen = new Set(prev?.seen)
  for (const card of cards) seen.add(markerKey(card.marker))
  const next = { keys: new Set(turns.map((turn) => turn.key)), seen }
  if (!prev) return { next, arrived: [] }
  // An earlier page lands before the first turn the last pass knew, so only what follows that turn is new.
  const from = prev.keys.size === 0 ? 0 : turns.findIndex((turn) => prev.keys.has(turn.key))
  if (from < 0) return { next, arrived: [] }
  const arrived: ArtifactMarker[] = []
  const added = new Set<string>()
  for (const { marker, at } of cards) {
    const key = markerKey(marker)
    if (at < from || prev.seen.has(key) || added.has(key)) continue
    added.add(key)
    arrived.push(marker)
  }
  return { next, arrived }
}

/** Watches one transcript's turns once `ready` (its first page read) and tells the page's opener what arrived. */
export function ArtifactArrivals({ turns, ready, scope }: { turns: readonly Turn[]; ready: boolean; scope: string }) {
  const opener = useArtifactOpener()
  const placement = useArtifactPlacement()
  const snapshot = useRef<{ scope: string; at: ArrivalSnapshot } | null>(null)
  useEffect(() => {
    if (!ready) return
    const prev = snapshot.current?.scope === scope ? snapshot.current.at : null
    const { next, arrived } = artifactArrivals(prev, turns)
    snapshot.current = { scope, at: next }
    if (arrived.length > 0) opener?.arrived?.(arrived, placement)
  }, [turns, ready, scope, opener, placement])
  return null
}

/** Whether the person is typing somewhere, which a collapsed dock opening as a dialog would take focus from. */
function typing(): boolean {
  const at = document.activeElement
  return (
    at instanceof HTMLElement && at.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
  )
}

/** The page's policy: the newest arrival opens unless closed at that revision or the pane holds a file; a hidden tab opens it on return. */
export function useArtifactAutoOpen({
  scope,
  orgId,
  viewer,
  fileOpen,
  open
}: {
  /** The session; closes and a pending arrival are this page visit's, per session. */
  scope: string
  orgId: string | undefined
  viewer: ArtifactViewerState | null
  /** A workspace file holds the left pane, which an arrival does not take from it. */
  fileOpen: boolean
  open: (target: ArtifactViewerTarget, placement: ArtifactPlacement, options?: ArtifactOpenOptions) => void
}): {
  arrived: (markers: readonly ArtifactMarker[], placement: ArtifactPlacement) => void
  closed: (viewer: ArtifactViewerState) => void
} {
  const { mutate } = useSWRConfig()
  const live = useRef({ viewer, fileOpen, open, orgId })
  live.current = { viewer, fileOpen, open, orgId }
  const state = useRef({
    scope,
    closedAt: new Map<string, number>(),
    newest: new Map<string, number>(),
    pending: null as { target: ArtifactViewerTarget; placement: ArtifactPlacement } | null
  })
  if (state.current.scope !== scope) state.current = { scope, closedAt: new Map(), newest: new Map(), pending: null }

  const eligible = useCallback((marker: ArtifactMarker, placement: ArtifactPlacement): boolean => {
    const { closedAt } = state.current
    const { viewer: shown, fileOpen: fileHeld } = live.current
    if ((closedAt.get(marker.artifactId) ?? 0) >= marker.revision) return false
    if (shown?.artifactId === marker.artifactId) return false
    return !(placement === 'pane' && fileHeld)
  }, [])

  const show = useCallback((target: ArtifactViewerTarget, placement: ArtifactPlacement) => {
    live.current.open(target, placement, typing() ? { reveal: false } : undefined)
  }, [])

  const arrived = useCallback(
    (markers: readonly ArtifactMarker[], placement: ArtifactPlacement) => {
      const { newest } = state.current
      for (const marker of markers)
        newest.set(marker.artifactId, Math.max(newest.get(marker.artifactId) ?? 0, marker.revision))
      // The viewer already on one of these follows it itself once the artifact is read again.
      const shown = live.current.viewer
      if (shown && markers.some((marker) => marker.artifactId === shown.artifactId))
        void mutate(consoleKeys.artifact(live.current.orgId, shown.artifactId))
      const marker = [...markers].reverse().find((candidate) => eligible(candidate, placement))
      if (!marker) return
      const target = { artifactId: marker.artifactId, revision: marker.revision }
      if (document.visibilityState === 'hidden') state.current.pending = { target, placement }
      else show(target, placement)
    },
    [eligible, mutate, show]
  )

  const closed = useCallback((viewer: ArtifactViewerState) => {
    const { closedAt, newest, pending } = state.current
    const revision = viewer.revision ?? newest.get(viewer.artifactId) ?? 0
    closedAt.set(viewer.artifactId, Math.max(closedAt.get(viewer.artifactId) ?? 0, revision))
    if (pending?.target.artifactId === viewer.artifactId) state.current.pending = null
  }, [])

  useEffect(() => {
    const onShow = () => {
      const { pending } = state.current
      if (document.visibilityState === 'hidden' || !pending) return
      state.current.pending = null
      const marker = { artifactId: pending.target.artifactId, revision: pending.target.revision ?? 0, title: '' }
      if (eligible(marker, pending.placement)) show(pending.target, pending.placement)
    }
    document.addEventListener('visibilitychange', onShow)
    return () => document.removeEventListener('visibilitychange', onShow)
  }, [eligible, show])

  return { arrived, closed }
}
