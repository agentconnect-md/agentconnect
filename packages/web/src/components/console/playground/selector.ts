import type { Agent } from '@/lib/data'
import type { PlaygroundData } from './contract'
export type PlaygroundProtocol = 'legacy' | 'ahp'
export const webchatProtocol = (): PlaygroundProtocol =>
  typeof window !== 'undefined' && window.__AC_ENV?.WEBCHAT_PROTOCOL === 'ahp' ? 'ahp' : 'legacy'

// A new attachment's participants: openPlayground names them; any other first touch knows only its session id.
export type ProtocolTarget = { agents: readonly Agent[] } | { sessionId: string }
// Undefined while a session's participants are still unknown: the call goes to legacy without pinning it.
export type ProtocolChoice = (target: ProtocolTarget) => PlaygroundProtocol | undefined

// AHP only where the deployment prefers it and the CP reports every participant can attach over it.
export function protocolFor(
  agents: ReadonlyArray<Pick<Agent, 'ahpWebchat'> | undefined>,
  preferred: PlaygroundProtocol = webchatProtocol()
): PlaygroundProtocol {
  return preferred === 'ahp' && agents.length > 0 && agents.every((agent) => agent?.ahpWebchat === true)
    ? 'ahp'
    : 'legacy'
}

// Attachment identity pins the adapter; runtime changes only select new attachments.
export function selectPlayground(
  legacy: PlaygroundData,
  ahp: PlaygroundData,
  pins: Map<string, PlaygroundProtocol>,
  preferred: ProtocolChoice = webchatProtocol
): PlaygroundData {
  return createPlaygroundSelector(pins, preferred)(legacy, ahp)
}

// One selector per pin map: its methods keep their identity across renders and always reach the latest adapters.
export function createPlaygroundSelector(
  pins: Map<string, PlaygroundProtocol>,
  preferred: ProtocolChoice = webchatProtocol
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
    protocol ??= preferred({ sessionId: id })
    const key = known?.id ?? id
    if (claim && protocol) {
      pins.set(id, protocol)
      pins.set(key, protocol)
    }
    return { adapter: adapters[protocol ?? 'legacy'], id: key }
  }
  const method = (property: keyof PlaygroundData): unknown => {
    if (property === 'openPlayground')
      return (...args: Parameters<PlaygroundData['openPlayground']>) => {
        const [agent, members] = args,
          protocol = preferred({ agents: [agent, ...(members ?? [])] }) ?? 'legacy',
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
