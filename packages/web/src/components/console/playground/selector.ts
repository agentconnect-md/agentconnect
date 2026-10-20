import type { PlaygroundData } from './contract'
export type PlaygroundProtocol = 'legacy' | 'ahp'
export const webchatProtocol = (): PlaygroundProtocol =>
  typeof window !== 'undefined' && window.__AC_ENV?.WEBCHAT_PROTOCOL === 'ahp' ? 'ahp' : 'legacy'

// Attachment identity pins the adapter; runtime changes only select new attachments.
export function selectPlayground(
  legacy: PlaygroundData,
  ahp: PlaygroundData,
  pins: Map<string, PlaygroundProtocol>,
  preferred: () => PlaygroundProtocol = webchatProtocol
): PlaygroundData {
  return createPlaygroundSelector(pins, preferred)(legacy, ahp)
}

// One selector per pin map: its methods keep their identity across renders and always reach the latest adapters.
export function createPlaygroundSelector(
  pins: Map<string, PlaygroundProtocol>,
  preferred: () => PlaygroundProtocol = webchatProtocol
): (legacy: PlaygroundData, ahp: PlaygroundData) => PlaygroundData {
  let adapters!: { legacy: PlaygroundData; ahp: PlaygroundData }
  let sessions:
    | {
        legacy: PlaygroundData['pgSessionList']
        ahp: PlaygroundData['pgSessionList']
        merged: PlaygroundData['pgSessionList']
      }
    | undefined
  const methods = new Map<PropertyKey, unknown>()
  const owner = (id: string, claim: boolean): { adapter: PlaygroundData; id: string } => {
    const { legacy, ahp } = adapters
    let protocol = pins.get(id)
    const known = protocol ? adapters[protocol].getPgSession(id) : (ahp.getPgSession(id) ?? legacy.getPgSession(id))
    if (!protocol && known) protocol = ahp.getPgSession(id) ? 'ahp' : 'legacy'
    protocol ??= preferred()
    const key = known?.id ?? id
    if (claim) {
      pins.set(id, protocol)
      pins.set(key, protocol)
    }
    return { adapter: adapters[protocol], id: key }
  }
  const method = (property: keyof PlaygroundData): unknown => {
    if (property === 'openPlayground')
      return (...args: Parameters<PlaygroundData['openPlayground']>) => {
        const protocol = preferred(),
          id = adapters[protocol].openPlayground(...args)
        pins.set(id, protocol)
        return id
      }
    if (property === 'subscribePgDraft')
      return (listener: () => void) => {
        const offLegacy = adapters.legacy.subscribePgDraft(listener),
          offAhp = adapters.ahp.subscribePgDraft(listener)
        return () => {
          offLegacy()
          offAhp()
        }
      }
    return (id: string, ...args: unknown[]) => {
      const selected = owner(id, !property.startsWith('get') && property !== 'isPgBusy')
      return Reflect.apply(selected.adapter[property] as (...args: unknown[]) => unknown, selected.adapter, [
        selected.id,
        ...args
      ])
    }
  }
  return (legacy, ahp) => {
    adapters = { legacy, ahp }
    return new Proxy(legacy, {
      get(target, property: keyof PlaygroundData) {
        if (property === 'pgSessionList') {
          if (sessions?.legacy !== legacy.pgSessionList || sessions.ahp !== ahp.pgSessionList)
            sessions = {
              legacy: legacy.pgSessionList,
              ahp: ahp.pgSessionList,
              merged: [...legacy.pgSessionList, ...ahp.pgSessionList]
            }
          return sessions.merged
        }
        if (typeof target[property] !== 'function') return target[property]
        if (!methods.has(property)) methods.set(property, method(property))
        return methods.get(property)
      }
    })
  }
}
