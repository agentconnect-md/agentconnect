// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { InMemoryTransport } from '@microsoft/agent-host-protocol/client'
import type { Agent } from '@/lib/data'
const { received, fixture } = vi.hoisted(() => ({
  received: [] as Array<{ method: string; params: Record<string, unknown> }>,
  fixture: { parts: [] as unknown[], rejection: undefined as string | undefined }
}))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ agents: [], daemons: [], refreshSessions: vi.fn() }) }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org' } }) }))
vi.mock('@/lib/api', () => ({
  mintWebchatToken: vi.fn(async () => ({
    protocol: 'ahp',
    token: 'secret',
    conversationId: 'conversation',
    ahp: { url: 'wss://relay.test/ahp/agents/a', sessionUri: 'ahp-session:/test' }
  })),
  ApiError: class extends Error {}
}))
vi.mock('@/lib/ahp/attachment', async (original) => {
  const actual = await original<typeof import('@/lib/ahp/attachment')>()
  return {
    ...actual,
    ahpBrowserTransport: async () => {
      const [client, server] = InMemoryTransport.pair()
      let clientId = ''
      void (async () => {
        while (true) {
          const frame = await server.recv()
          if (!frame || frame.kind !== 'text') return
          const request = JSON.parse(frame.text)
          received.push(request)
          let result: unknown
          if (request.method === 'initialize') {
            clientId = request.params.clientId
            result = {
              protocolVersion: '1.0.0',
              serverSeq: 1,
              snapshots: [],
              _meta: { 'agentconnect.md': { webchat: true } }
            }
          }
          if (request.method === 'subscribe')
            result = {
              snapshot: {
                resource: request.params.channel,
                fromSeq: 1,
                state: request.params.channel.startsWith('ahp-chat:')
                  ? {
                      resource: 'ahp-chat:/test/main',
                      title: 'Chat',
                      status: 1,
                      modifiedAt: '2026-10-19T00:00:00Z',
                      turns: [],
                      ...(fixture.parts.length
                        ? {
                            activeTurn: {
                              id: 'turn',
                              startedAt: '2026-10-19T00:00:00Z',
                              message: { text: 'Write a file', origin: { kind: 'user' } },
                              responseParts: fixture.parts
                            }
                          }
                        : {})
                    }
                  : {
                      title: 'Conversation',
                      defaultChat: 'ahp-chat:/test/main',
                      chats: [],
                      _meta: { 'agentconnect.md': { sessionId: 'canonical' } }
                    }
              }
            }
          if ('id' in request) await server.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
          if (request.method === 'dispatchAction') {
            const action = request.params.action
            await server.send(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'action',
                params: {
                  channel: request.params.channel,
                  serverSeq: 2,
                  origin: { clientId, clientSeq: request.params.clientSeq },
                  action,
                  rejectionReason: fixture.rejection
                }
              })
            )
            if (fixture.rejection) continue
            await server.send(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'action',
                params: {
                  channel: request.params.channel,
                  serverSeq: 7,
                  action: {
                    type: 'chat/responsePart',
                    turnId: action.turnId,
                    part: { kind: 'markdown', id: 'reply', content: 'AHP response' }
                  }
                }
              })
            )
          }
        }
      })()
      return client
    }
  }
})
const { PlaygroundProvider, usePlayground } = await import('./PlaygroundProvider')
let ui: ReturnType<typeof usePlayground>
function Probe() {
  ui = usePlayground()
  return (
    <div>
      {ui.pgSessionList.flatMap((session) =>
        session.steps.map((step, index) => <p key={`${session.id}:${index}`}>{step.text}</p>)
      )}
    </div>
  )
}
afterEach(() => {
  window.__AC_ENV = {}
  received.length = 0
  fixture.parts = []
  fixture.rejection = undefined
})
it('routes the real React playground through the official AHP SDK and common message view', async () => {
  window.__AC_ENV = { WEBCHAT_PROTOCOL: 'ahp' }
  const host = document.createElement('div'),
    root = createRoot(host)
  await act(async () =>
    root.render(
      <PlaygroundProvider>
        <Probe />
      </PlaygroundProvider>
    )
  )
  let id = ''
  await act(async () => {
    id = ui.openPlayground({ id: 'a', name: 'Alpha' } as Agent)
  })
  await vi.waitFor(() => expect(ui.getPgSession(id)?.realSessionId).toBe('canonical'))
  window.__AC_ENV = { WEBCHAT_PROTOCOL: 'legacy' }
  await act(async () => {
    ui.pgSend('canonical', 'a', 'Hello')
  })
  await vi.waitFor(() => expect(host.textContent).toContain('AHP response'))
  expect(received.filter((frame) => frame.method === 'dispatchAction')).toHaveLength(1)
  expect(host.textContent).toContain('Hello')
  await act(async () => root.unmount())
})
it('keeps a rejected approval pending and displays the server refusal', async () => {
  window.__AC_ENV = { WEBCHAT_PROTOCOL: 'ahp' }
  fixture.parts = [
    {
      kind: 'toolCall',
      id: 'tool-part',
      toolCall: {
        toolCallId: 'tool',
        displayName: 'Write',
        status: 'pending-confirmation',
        invocationMessage: 'Allow write?',
        options: [{ id: 'once', label: 'Allow once', kind: 'approve' }]
      }
    }
  ]
  fixture.rejection = 'This caller cannot approve tools'
  const host = document.createElement('div'),
    root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <PlaygroundProvider>
          <Probe />
        </PlaygroundProvider>
      )
    )
    let id = ''
    await act(async () => {
      id = ui.openPlayground({ id: 'a', name: 'Alpha' } as Agent)
    })
    await vi.waitFor(() => expect(host.textContent).toContain('Allow write?'))
    await act(async () => {
      ui.pgAnswerElicitation(id, 'a', 'tool:turn:tool', 'once')
    })
    await vi.waitFor(() => expect(host.textContent).toContain('This caller cannot approve tools'))
    const steps = ui.getPgSession(id)!.steps
    expect(steps.find((step) => step.kind === 'tool')?.toolStatus).toBe('pending-confirmation')
    expect(steps.find((step) => step.kind === 'elicit')?.elicit).toEqual({
      requestId: 'tool:turn:tool',
      options: [{ value: 'once', label: 'Allow once' }]
    })
    expect(received.filter((frame) => frame.method === 'dispatchAction')).toHaveLength(1)
    expect(host.textContent).toContain('Allow write?')
  } finally {
    await act(async () => root.unmount())
  }
})
it('keeps playground methods and the session list stable across provider re-renders', async () => {
  const host = document.createElement('div'),
    root = createRoot(host)
  const tree = () => (
    <PlaygroundProvider>
      <Probe />
    </PlaygroundProvider>
  )
  await act(async () => root.render(tree()))
  const first = ui
  await act(async () => root.render(tree()))
  expect(ui.reconcileLiveSteps).toBe(first.reconcileLiveSteps)
  expect(ui.pgAttach).toBe(first.pgAttach)
  expect(ui.subscribePgDraft).toBe(first.subscribePgDraft)
  expect(ui.pgSessionList).toBe(first.pgSessionList)
  await act(async () => root.unmount())
})
