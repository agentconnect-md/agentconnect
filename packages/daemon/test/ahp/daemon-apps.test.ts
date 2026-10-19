import { expect, it, vi } from 'vitest'
import { Daemon } from '../../src/daemon.js'

function fixture() {
  const app = {
    appId: 'app',
    conversationId: 'source-conversation',
    agentId: 'agent',
    sessionKey: 'source-key',
    server: 'server',
    stream: {},
    orgId: 'org'
  }
  const answer = vi.fn()
  const daemon = Object.assign(Object.create(Daemon.prototype), {
    liveApps: { resolve: vi.fn(() => ({ app })), charge: vi.fn(() => true) },
    appSurface: { answer },
    webchatTransport: { dispatchWebchatTurn: vi.fn() },
    appsHost: { resolveViewTool: vi.fn(async () => 'tool'), callForView: vi.fn(async () => ({ content: [] })) },
    store: { getSessionByOutwardIdOnly: vi.fn(async () => ({ key: 'source-key' })), getAppCard: vi.fn() }
  })
  const scope = {
    authorization: { agentId: 'agent', orgId: 'org' },
    binding: { sessionId: 'outward', conversationId: 'source-conversation' },
    isCurrent: () => true
  }
  return { daemon, app, answer, scope }
}
it('routes App ui/message through the supplied neutral admission callback', async () => {
  const { daemon, answer } = fixture()
  const dispatchMessage = vi.fn(async () => ({ accepted: true, turnId: 'admitted' }))
  await daemon.handleAppRpc(
    'source-conversation',
    'app',
    'call',
    { method: 'ui/message', text: 'from app' },
    { userId: 'verified' },
    { sink: {} },
    { isCurrent: () => true, dispatchMessage }
  )
  expect(dispatchMessage).toHaveBeenCalledWith('from app')
  expect(daemon.webchatTransport.dispatchWebchatTurn).not.toHaveBeenCalled()
  expect(answer).toHaveBeenCalledWith(expect.anything(), 'app', 'call', { ok: true, result: { turnId: 'admitted' } })
})
it('keeps uncertain admission failures as transport errors rather than false negative acknowledgments', async () => {
  const { daemon, answer } = fixture()
  await expect(
    daemon.handleAppRpc(
      'source-conversation',
      'app',
      'call',
      { method: 'ui/message', text: 'from app' },
      {},
      { sink: {} },
      {
        isCurrent: () => true,
        dispatchMessage: async () => {
          throw new Error('uncertain')
        }
      }
    )
  ).rejects.toThrow('uncertain')
  expect(answer).not.toHaveBeenCalled()
})
it('scopes Apps to the resolved physical session and rechecks authority after asynchronous tool lookup', async () => {
  const { daemon, app, scope } = fixture()
  expect(await daemon.ahpAppConversation(scope, 'app')).toBe('source-conversation')
  app.sessionKey = 'another-key'
  await expect(daemon.ahpAppConversation(scope, 'app')).rejects.toMatchObject({ code: -32009 })
  app.sessionKey = 'source-key'
  let current = true
  daemon.appsHost.resolveViewTool.mockImplementation(async () => {
    current = false
    return 'tool'
  })
  await daemon.handleAppRpc(
    'source-conversation',
    'app',
    'call',
    { method: 'tools/call', name: 'tool' },
    {},
    { sink: {} },
    { isCurrent: () => current, dispatchMessage: vi.fn() }
  )
  expect(daemon.appsHost.callForView).not.toHaveBeenCalled()
})
