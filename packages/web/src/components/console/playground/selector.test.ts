import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlaygroundData } from './contract'
import { protocolFor, selectPlayground, webchatProtocol, type PlaygroundProtocol } from './selector'
afterEach(() => vi.unstubAllGlobals())
function adapter(name: string) {
  return {
    pgSessionList: [],
    openPlayground: vi.fn(() => name),
    pgSend: vi.fn(() => true),
    getPgSession: vi.fn(),
    getPgInput: vi.fn(() => name)
  } as unknown as PlaygroundData
}
describe('attachment protocol selector', () => {
  it('uses only explicit protocol selection, independently of endpoint availability', () => {
    const env: Record<string, string> = { AHP_ENABLED: 'true', AHP_PUBLIC_ACCESS: 'true' }
    vi.stubGlobal('window', { __AC_ENV: env })
    expect(webchatProtocol()).toBe('legacy')
    env.AHP_ENABLED = 'false'
    env.AHP_PUBLIC_ACCESS = 'false'
    expect(webchatProtocol()).toBe('legacy')
    env.WEBCHAT_PROTOCOL = 'ahp'
    expect(webchatProtocol()).toBe('ahp')
  })
  it('changes only new attachments when runtime configuration changes', () => {
    const legacy = adapter('old'),
      ahp = adapter('new'),
      pins = new Map<string, PlaygroundProtocol>()
    let protocol: PlaygroundProtocol = 'legacy'
    const ui = selectPlayground(legacy, ahp, pins, () => protocol)
    const old = ui.openPlayground({ id: 'a' } as never)
    protocol = 'ahp'
    const next = ui.openPlayground({ id: 'a' } as never)
    ui.pgSend(old, 'a', 'Old')
    ui.pgSend(next, 'a', 'New')
    expect(legacy.pgSend).toHaveBeenCalledWith(old, 'a', 'Old')
    expect(ahp.pgSend).toHaveBeenCalledWith(next, 'a', 'New')
  })
  it('resolves a canonical session link to its existing AHP attachment', () => {
    const legacy = adapter('old'),
      ahp = adapter('new')
    vi.mocked(ahp.getPgSession).mockImplementation((id) =>
      ['canonical', 'synthetic'].includes(id) ? ({ id: 'synthetic', realSessionId: 'canonical' } as never) : undefined
    )
    const ui = selectPlayground(legacy, ahp, new Map(), () => 'legacy')
    ui.pgSend('canonical', 'a', 'Continue')
    expect(ahp.pgSend).toHaveBeenCalledWith('synthetic', 'a', 'Continue')
    expect(legacy.pgSend).not.toHaveBeenCalled()
  })
  it('does not move a refused pinned AHP action to legacy after the default changes', () => {
    const legacy = adapter('old'),
      ahp = adapter('new'),
      pins = new Map<string, PlaygroundProtocol>()
    let protocol: PlaygroundProtocol = 'ahp'
    const ui = selectPlayground(legacy, ahp, pins, () => protocol),
      id = ui.openPlayground({ id: 'a' } as never)
    protocol = 'legacy'
    vi.mocked(ahp.pgSend).mockReturnValue(false)
    expect(ui.pgSend(id, 'a', 'Keep this draft')).toBe(false)
    expect(pins.get(id)).toBe('ahp')
    expect(ahp.pgSend).toHaveBeenCalledTimes(1)
    expect(legacy.pgSend).not.toHaveBeenCalled()
  })
  it('uses AHP only where the deployment prefers it and every participant can attach over it', () => {
    const capable = { ahpWebchat: true },
      legacyOnly = { ahpWebchat: false }
    expect(protocolFor([capable, capable], 'ahp')).toBe('ahp')
    expect(protocolFor([capable, legacyOnly], 'ahp')).toBe('legacy')
    expect(protocolFor([capable, undefined], 'ahp')).toBe('legacy')
    expect(protocolFor([], 'ahp')).toBe('legacy')
    expect(protocolFor([capable], 'legacy')).toBe('legacy')
  })
  it('opens a new conversation on the protocol its participants can share', () => {
    const legacy = adapter('old'),
      ahp = adapter('new'),
      pins = new Map<string, PlaygroundProtocol>()
    const ui = selectPlayground(legacy, ahp, pins, (target) =>
      'agents' in target ? protocolFor(target.agents, 'ahp') : 'legacy'
    )
    const agent = { id: 'a', ahpWebchat: true } as never,
      peer = { id: 'b', ahpWebchat: false } as never
    expect(pins.get(ui.openPlayground(agent))).toBe('ahp')
    expect(pins.get(ui.openPlayground(agent, [peer]))).toBe('legacy')
    expect(ahp.openPlayground).toHaveBeenCalledTimes(1)
    expect(legacy.openPlayground).toHaveBeenCalledWith(agent, [peer])
  })
  it('lets composer writes wait for the choice but pins an attachment started before it', () => {
    const legacy = { ...adapter('old'), setPgImage: vi.fn(), pgAttach: vi.fn() } as unknown as PlaygroundData,
      ahp = { ...adapter('new'), setPgImage: vi.fn(), pgAttach: vi.fn() } as unknown as PlaygroundData,
      pins = new Map<string, PlaygroundProtocol>()
    const choice: { protocol?: PlaygroundProtocol } = {}
    const ui = selectPlayground(legacy, ahp, pins, () => choice.protocol)
    ui.setPgImage('draft')
    expect(pins.has('draft')).toBe(false)
    ui.pgAttach('live', 'a', 'conv')
    expect(pins.get('live')).toBe('legacy')
    choice.protocol = 'ahp'
    ui.setPgImage('draft')
    ui.pgSend('live', 'a', 'Continue')
    expect(ahp.setPgImage).toHaveBeenCalledWith('draft')
    expect(pins.get('draft')).toBe('ahp')
    expect(legacy.pgSend).toHaveBeenCalledWith('live', 'a', 'Continue')
    expect(ahp.pgSend).not.toHaveBeenCalled()
  })
  it('decides an attach from the agent it names before the session list loads', () => {
    const legacy = { ...adapter('old'), pgAttach: vi.fn() } as unknown as PlaygroundData,
      ahp = { ...adapter('new'), pgAttach: vi.fn() } as unknown as PlaygroundData,
      pins = new Map<string, PlaygroundProtocol>()
    const ui = selectPlayground(legacy, ahp, pins, (target) =>
      'sessionId' in target && target.agentId === 'capable' ? 'ahp' : undefined
    )
    ui.pgAttach('session', 'capable', 'conv')
    expect(ahp.pgAttach).toHaveBeenCalledWith('session', 'capable', 'conv')
    expect(pins.get('session')).toBe('ahp')
  })
})
