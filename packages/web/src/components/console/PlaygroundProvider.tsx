'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import {
  PlaygroundProvider as LegacyProvider,
  usePlayground as useLegacyPlayground
} from './playground/LegacyPlaygroundProvider'
import { AhpPlaygroundStore } from './playground/AhpPlaygroundStore'
import { selectPlayground, type PlaygroundProtocol } from './playground/selector'
import type { PlaygroundData } from './playground/contract'
export type { QueuedTurn } from './playground/contract'
const Context = createContext<PlaygroundData | null>(null)

export function PlaygroundProvider({ children }: { children: ReactNode }) {
  const { activeOrg } = useOrgs()
  return (
    <LegacyProvider key={activeOrg?.id}>
      <AdapterBoundary>{children}</AdapterBoundary>
    </LegacyProvider>
  )
}
function AdapterBoundary({ children }: { children: ReactNode }) {
  const legacy = useLegacyPlayground(),
    { activeOrg } = useOrgs(),
    { refreshSessions } = useConsoleData()
  const refresh = useRef(refreshSessions)
  refresh.current = refreshSessions
  const store = useMemo(() => new AhpPlaygroundStore(activeOrg?.id ?? '', () => refresh.current()), [activeOrg?.id])
  const pins = useMemo(() => new Map<string, PlaygroundProtocol>(), [store])
  const lifecycle = useMemo(() => ({ generation: 0 }), [store])
  useSyncExternalStore(store.subscribe, store.snapshot, () => 0)
  useEffect(() => {
    const generation = ++lifecycle.generation
    return () =>
      queueMicrotask(() => {
        if (lifecycle.generation === generation) void store.close()
      })
  }, [store, lifecycle])
  const value = selectPlayground(legacy, store.getValue(), pins)
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export function usePlayground(): PlaygroundData {
  const value = useContext(Context)
  if (!value) throw new Error('usePlayground must be used within <PlaygroundProvider>')
  return value
}
export function usePgDraft(id: string): string {
  const { getPgInput, subscribePgDraft } = usePlayground()
  return useSyncExternalStore(
    subscribePgDraft,
    () => getPgInput(id),
    () => ''
  )
}
export function usePgDraftHasText(id: string): boolean {
  const { getPgInput, subscribePgDraft } = usePlayground()
  return useSyncExternalStore(
    subscribePgDraft,
    () => getPgInput(id).trim().length > 0,
    () => false
  )
}
