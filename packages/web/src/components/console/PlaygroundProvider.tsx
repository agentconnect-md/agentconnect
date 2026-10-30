'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import {
  PlaygroundProvider as LegacyProvider,
  usePlayground as useLegacyPlayground
} from './playground/LegacyPlaygroundProvider'
import { AhpPlaygroundStore } from './playground/AhpPlaygroundStore'
import { createPlaygroundSelector, protocolFor, type PlaygroundProtocol } from './playground/selector'
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
    { refreshSessions, getAgent, allSessions } = useConsoleData()
  const refresh = useRef(refreshSessions)
  refresh.current = refreshSessions
  const directory = useRef({ getAgent, allSessions })
  directory.current = { getAgent, allSessions }
  const store = useMemo(() => new AhpPlaygroundStore(activeOrg?.id ?? '', () => refresh.current()), [activeOrg?.id])
  const pins = useMemo(() => new Map<string, PlaygroundProtocol>(), [store])
  const lifecycle = useMemo(() => ({ generation: 0 }), [store])
  const version = useSyncExternalStore(store.subscribe, store.snapshot, () => 0)
  const select = useMemo(
    () =>
      createPlaygroundSelector(pins, (target) => {
        const { getAgent, allSessions } = directory.current
        if ('agents' in target) return protocolFor(target.agents)
        // An unknown session has no participant the CP vouched for, so it stays on legacy.
        const agentId = allSessions.find((session) => session.id === target.sessionId)?.agentId
        return protocolFor([agentId ? getAgent(agentId) : undefined])
      }),
    [pins]
  )
  useEffect(() => {
    const generation = ++lifecycle.generation
    return () =>
      queueMicrotask(() => {
        if (lifecycle.generation === generation) void store.close()
      })
  }, [store, lifecycle])
  // The store's version is what invalidates its value.
  const ahp = useMemo(() => store.getValue(), [store, version])
  const value = useMemo(() => select(legacy, ahp), [select, legacy, ahp])
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
