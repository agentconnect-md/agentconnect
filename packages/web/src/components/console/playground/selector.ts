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
  const adapters = { legacy, ahp }
  const owner = (id: string, claim: boolean): { adapter: PlaygroundData; id: string } => {
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
  return new Proxy(legacy, {
    get(target, property: keyof PlaygroundData) {
      if (property === 'pgSessionList') return [...legacy.pgSessionList, ...ahp.pgSessionList]
      if (property === 'openPlayground')
        return (...args: Parameters<PlaygroundData['openPlayground']>) => {
          const protocol = preferred(),
            id = adapters[protocol].openPlayground(...args)
          pins.set(id, protocol)
          return id
        }
      if (property === 'subscribePgDraft')
        return (listener: () => void) => {
          const offLegacy = legacy.subscribePgDraft(listener),
            offAhp = ahp.subscribePgDraft(listener)
          return () => {
            offLegacy()
            offAhp()
          }
        }
      const value = target[property]
      if (typeof value !== 'function') return value
      return (id: string, ...args: unknown[]) => {
        const selected = owner(id, !property.startsWith('get') && property !== 'isPgBusy')
        return Reflect.apply(selected.adapter[property] as (...args: unknown[]) => unknown, selected.adapter, [
          selected.id,
          ...args
        ])
      }
    }
  })
}
