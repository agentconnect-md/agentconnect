import { expect, it, vi } from 'vitest'
import { Daemon } from '../../src/daemon.js'
import { sessionKey } from '../../src/store/local-store.js'
import type { ChatDispatchOptions, ChatTurnContext } from '../../src/session/chat-turn.js'

// Exercise the actual admission method without replacing it or opening process-level Unix services.
function fixture() {
  const message = {
    msgId: 'message',
    traceId: 'turn',
    source: 'user',
    platform: 'webchat',
    channel: 'conversation',
    thread: 'conversation',
    sender: { id: 'reader', isBot: false },
    text: 'hello',
    mentionedBots: [],
    isDm: true
  }
  const key = sessionKey('webchat', 'conversation', 'conversation', 'agent')
  const daemon = Object.assign(Object.create(Daemon.prototype), {
    draining: false,
    drainingAgents: new Set(),
    safetyDrainingAgents: new Set(),
    safetyDrainAdmissionKeys: new Map(),
    inflight: new Set(),
    dispatchAdmissionChains: new Map(),
    serialQueue: new Map(),
    activeGateEntries: new Map(),
    paused: () => false,
    agents: new Map(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    store: { isLoopGuardOpen: async () => false },
    evalHooks: { emit: vi.fn() },
    evaluationTurnIdFor: () => 'turn',
    webchatTransport: { postAgentWakeInbound: vi.fn() },
    turnSurfaces: { exact: () => undefined },
    reviewBatchLeader: () => undefined,
    revisionAdmissionPlan: () => undefined,
    admitLoopGuardTurn: async () => true,
    persistInbox: vi.fn(async () => 'created'),
    coalesceLateAdmission: async () => false,
    releaseDispatchClaim: vi.fn(async () => {}),
    removeInbox: vi.fn(async () => {})
  })
  daemon.runLoop = vi.fn(async (_key: string, entry: { resolve(value: string): void }) => {
    daemon.activeGateEntries.set(key, entry)
    entry.resolve('runtime')
  })
  const context: ChatTurnContext = {
    conversationId: 'conversation',
    turnId: 'turn',
    apiProtocol: 'ahp',
    sink: { output: () => {}, done: () => {} }
  }
  const dispatch = (options: ChatDispatchOptions) =>
    daemon.dispatch('agent', message, undefined, context, undefined, options) as Promise<string | null>
  return { daemon, dispatch, key }
}
it('owns the idle gate before durable publication and starts only after the callback succeeds', async () => {
  const { daemon, dispatch, key } = fixture()
  let publication = false
  const result = await dispatch({
    startOnly: true,
    requireDurable: true,
    receiptId: 'receipt',
    onAdmission: async (result) => {
      expect(result.accepted).toBe(true)
      expect(daemon.inflight.has(key)).toBe(true)
      expect(daemon.activeGateEntries.has(key)).toBe(false)
      expect(daemon.runLoop).not.toHaveBeenCalled()
      publication = true
    }
  })
  expect(publication).toBe(true)
  expect(result).toBe('runtime')
  expect(daemon.persistInbox).toHaveBeenCalledOnce()
  expect(daemon.webchatTransport.postAgentWakeInbound).not.toHaveBeenCalled()
})
it('refuses an occupied or reserved gate before persistence, steering, or queueing', async () => {
  for (const reservation of ['inflight', 'chain'] as const) {
    const { daemon, dispatch, key } = fixture()
    if (reservation === 'inflight') daemon.inflight.add(key)
    else daemon.dispatchAdmissionChains.set(key, Promise.resolve())
    const admission = vi.fn()
    expect(await dispatch({ startOnly: true, requireDurable: true, onAdmission: admission })).toBeNull()
    expect(admission).toHaveBeenCalledWith({ accepted: false, reason: 'busy' })
    expect(daemon.persistInbox).not.toHaveBeenCalled()
    expect(daemon.runLoop).not.toHaveBeenCalled()
    expect(daemon.serialQueue.size).toBe(0)
  }
})
