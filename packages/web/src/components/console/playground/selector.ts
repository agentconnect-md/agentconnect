import type { Agent } from '@/lib/data'
import type { PlaygroundData, WebchatRuntimeConfig } from './contract'
export type PlaygroundProtocol = 'legacy' | 'ahp'
export const webchatProtocol = (): PlaygroundProtocol =>
  typeof window !== 'undefined' && window.__AC_ENV?.WEBCHAT_PROTOCOL === 'ahp' ? 'ahp' : 'legacy'

// A new attachment's participants: openPlayground names them; other first touches know the session, pgAttach its agent too.
export type ProtocolTarget = { agents: readonly Agent[] } | { sessionId: string; agentId?: string }
// Undefined while a session's participants are unknown: composer writes wait, anything else pins legacy.
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

const STAGED = new Set<PropertyKey>(['setPgInput', 'setPgImage', 'setPgFiles'])
type OpenOptions = Parameters<PlaygroundData['openPlayground']>[2]

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
  // Conversations opened here that have not sent: their roster may still move them to the other protocol.
  const unsent = new Map<
    string,
    { agents: Agent[]; options?: OpenOptions; runtime?: WebchatRuntimeConfig; changed?: boolean }
  >()
  // A moved conversation's earlier ids (synthetic and real) resolve to where it lives now.
  const moved = new Map<string, string>()
  const owner = (
    requested: string,
    claim: boolean,
    staged: boolean,
    agentId?: string
  ): { adapter: PlaygroundData; id: string } => {
    const { legacy, ahp } = adapters
    const id = moved.get(requested) ?? requested
    let protocol = pins.get(id)
    const known = protocol ? adapters[protocol].getPgSession(id) : (ahp.getPgSession(id) ?? legacy.getPgSession(id))
    if (!protocol && known) protocol = ahp.getPgSession(id) ? 'ahp' : 'legacy'
    protocol ??= preferred({ sessionId: id, agentId })
    const key = known?.id ?? id
    // Composer state may wait for the choice; anything that can start an attachment pins legacy as before.
    if (claim && (protocol || !staged)) {
      protocol ??= 'legacy'
      pins.set(id, protocol)
      pins.set(key, protocol)
    }
    return { adapter: adapters[protocol ?? 'legacy'], id: key }
  }
  const choose = (agents: readonly Agent[]) => preferred({ agents }) ?? 'legacy'
  // Reopens an unsent conversation on `protocol` with its composer, then closes the old one.
  const move = (id: string, protocol: PlaygroundProtocol, agents: Agent[]): string => {
    const from = adapters[pins.get(id) ?? 'legacy'],
      to = adapters[protocol],
      opened = unsent.get(id)!
    const next = to.openPlayground(agents[0]!, agents.slice(1), opened.options)
    pins.set(next, protocol)
    to.setPgInput(next, from.getPgInput(id))
    to.setPgImage(next, from.getPgImage(id))
    const files = from.getPgFiles(id)
    if (files.length) to.setPgFiles(next, () => files)
    const worktree = from.getPgWorktree(id)
    if (worktree !== undefined) to.pgSetWorktree(next, worktree)
    if (opened.runtime) to.pgStageRuntime(next, opened.runtime)
    for (const [earlier, current] of moved) if (current === id) moved.set(earlier, next)
    const real = from.getPgSession(id)?.realSessionId
    for (const earlier of [id, real]) if (earlier) moved.set(earlier, next)
    unsent.delete(id)
    unsent.set(next, { ...opened, agents, changed: true })
    from.pgDiscard(id)
    return next
  }
  const method = (property: keyof PlaygroundData): unknown => {
    if (property === 'openPlayground')
      return (...args: Parameters<PlaygroundData['openPlayground']>) => {
        const [agent, members, options] = args,
          agents = [agent, ...(members ?? []).filter((member) => member.id !== agent.id)],
          protocol = choose(agents),
          id = adapters[protocol].openPlayground(...args)
        pins.set(id, protocol)
        if (!options?.conversationId) unsent.set(id, { agents, options })
        return id
      }
    if (property === 'pgAddAgent')
      return async (requested: string, agent: Agent) => {
        const { adapter, id } = owner(requested, true, false),
          opened = unsent.get(id)
        if (!opened || opened.agents.some((member) => member.id === agent.id)) return adapter.pgAddAgent(id, agent)
        const agents = [...opened.agents, agent]
        // An AHP attachment cannot take a member that has no AHP; before the first send the conversation moves instead.
        if (pins.get(id) === 'ahp' && choose(agents) !== 'ahp') {
          move(id, 'legacy', agents)
          return true
        }
        const added = await adapter.pgAddAgent(id, agent)
        const current = unsent.get(id)
        if (added && current) Object.assign(current, { agents: [...current.agents, agent], changed: true })
        return added
      }
    if (property === 'pgRemoveAgent')
      return async (requested: string, agentId: string) => {
        const { adapter, id } = owner(requested, true, false)
        const removed = await adapter.pgRemoveAgent(id, agentId)
        const opened = unsent.get(id)
        if (removed && opened)
          Object.assign(opened, { agents: opened.agents.filter((member) => member.id !== agentId), changed: true })
        return removed
      }
    if (property === 'pgStageRuntime')
      return (requested: string, runtime: WebchatRuntimeConfig) => {
        const { adapter, id } = owner(requested, true, false)
        const opened = unsent.get(id)
        if (opened) opened.runtime = runtime
        adapter.pgStageRuntime(id, runtime)
      }
    if (property === 'pgSend' || property === 'pgNotice')
      return (requested: string, ...args: unknown[]) => {
        let id = owner(requested, true, false).id
        const opened = unsent.get(id)
        // A roster changed before the first send settles the protocol from all its members.
        if (opened?.changed && property === 'pgSend' && choose(opened.agents) !== pins.get(id))
          id = move(id, choose(opened.agents), opened.agents)
        const adapter = adapters[pins.get(id) ?? 'legacy']
        const sent = Reflect.apply(adapter[property] as (...args: unknown[]) => unknown, adapter, [id, ...args])
        if (sent !== false) unsent.delete(id)
        return sent
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
      const hint = property === 'pgAttach' && typeof args[0] === 'string' ? args[0] : undefined
      const selected = owner(id, !property.startsWith('get') && property !== 'isPgBusy', STAGED.has(property), hint)
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
