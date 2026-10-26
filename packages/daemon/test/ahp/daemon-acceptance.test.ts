import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws'
import {
  ActionType,
  chatReducer,
  ChatInputAnswerState,
  ChatInputAnswerValueKind,
  ChatInputResponseKind,
  MessageKind,
  ResponsePartKind,
  ToolCallConfirmationReason,
  ToolCallStatus,
  type ActionEnvelope,
  type ChatAction,
  type ChatState
} from '@microsoft/agent-host-protocol'
import type {
  AhpAttachmentAuthorization,
  AhpSessionBinding,
  RdMsgWebchat,
  RdAck,
  RdChatEvent
} from '@agentconnect.md/protocol'
import { Daemon } from '../../src/daemon.js'
import type { AhpService, AhpServiceOptions } from '../../src/ahp/service.js'
import { WAIT } from '../wait-support.js'

const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const orgId = 'fixture-org'
const uri = 'ahp-session:/acceptance'
const chat = 'ahp-chat:/acceptance/main'
const dispose: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of dispose.splice(0).reverse()) await cleanup()
})
type Mode = 'off' | 'shadow' | 'on'
type Internals = {
  ahp: AhpService
  cfg: { features: { ahp: { mode: Mode } } }
  cpClient: unknown
  cpCollab: { replace(directory: unknown): void }
  handleRelayMsg(message: RdMsgWebchat, emit: (event: RdChatEvent) => void): Promise<RdAck> | RdAck
}

// Only the control-plane metadata boundary is scripted; execution uses the actual Daemon, store and ACP child.
function registry() {
  const bindings = new Map<string, AhpSessionBinding>()
  const allowed = (scope: { orgId: string; agentId: string; grant: string }) =>
    scope.orgId === orgId && scope.agentId === agentId && scope.grant === 'fixture-grant'
  const callbacks: AhpServiceOptions['registry'] = {
    reserve: async (input) => {
      if (!allowed(input)) return { ok: false, reason: 'forbidden' }
      let binding = bindings.get(input.sessionUri)
      if (!binding) {
        binding = {
          sessionUri: input.sessionUri,
          reservationId: randomUUID(),
          conversationId: randomUUID(),
          callerRole: 'owner',
          callerApproves: true
        }
        bindings.set(input.sessionUri, binding)
      }
      return { ok: true, ...binding }
    },
    finalize: async (input) => {
      const binding = [...bindings.values()].find((entry) => entry.reservationId === input.reservationId)
      if (!binding || !allowed(input)) return { ok: false, reason: 'forbidden' }
      binding.sessionId = input.sessionId
      return { ok: true, ...binding }
    },
    resolve: async (input) => {
      const binding = bindings.get(input.sessionUri)
      return allowed(input) && binding ? { ok: true, ...binding } : { ok: false, reason: 'not_found' }
    },
    list: async (input) =>
      allowed(input)
        ? { ok: true, sessions: [...bindings.values()].filter((binding) => binding.sessionId) }
        : { ok: false, reason: 'forbidden' }
  }
  return callbacks
}
function authorization(): AhpAttachmentAuthorization {
  return {
    orgId,
    agentId,
    userId: 'fixture-user',
    user: 'Fixture user',
    callerRole: 'owner',
    callerApproves: true,
    grant: { token: 'fixture-grant', expiresAtMs: Date.now() + 60_000 }
  }
}
function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'ahp-daemon-acceptance-'))
  const script = join(root, 'acp-agent.mjs')
  const log = join(root, 'runtime.jsonl')
  copyFileSync(fileURLToPath(new URL('../fixtures/ahp-acp-agent.mjs', import.meta.url)), script)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { ahp: { mode: 'on' } },
      runtimes: { fixture: { command: process.execPath, args: [script, log] } }
    })
  )
  const agentDir = join(root, 'agents', agentId)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: agentId,
      name: 'Acceptance fixture',
      status: 'active',
      runtime: 'fixture',
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  dispose.push(async () => rmSync(root, { recursive: true, force: true }))
  const messages = (): { method: string; params?: unknown }[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  const methods = () => messages().map((entry) => entry.method)
  const responses = () =>
    messages()
      .filter((entry) => entry.method === 'response')
      .map((entry) => entry.params)
  return { root, methods, responses }
}
async function boot(root: string, metadata: ReturnType<typeof registry>) {
  const daemon = new Daemon({ root })
  let started = false
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    try {
      await daemon.stop()
    } catch (error) {
      if (started) throw error
    }
  }
  dispose.push(stop)
  await daemon.start()
  started = true
  const internal = daemon as unknown as Internals
  internal.cpClient = {
    ahpSessionReserve: metadata.reserve,
    ahpSessionFinalize: metadata.finalize,
    ahpSessionResolve: metadata.resolve,
    ahpSessionList: metadata.list,
    organizationScope: () => 'connection',
    memberSet: () => undefined,
    emitUsageReport: () => {},
    emitSessionActivity: () => {},
    emitAgentActivity: () => {},
    emitEventSession: () => {},
    stop: async () => {}
  }
  internal.cpCollab.replace({
    generation: 1,
    channels: [],
    agents: [
      {
        orgId,
        agentId,
        daemonId: 'fixture-daemon',
        name: 'Acceptance fixture',
        callPolicy: 'all',
        allowedCallerAgentIds: [],
        outboundPolicy: 'all',
        allowedTargetAgentIds: []
      }
    ]
  })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 64 * 1024 })
  await once(server, 'listening')
  server.on('connection', (socket) => {
    const attachmentId = randomUUID()
    const connectionId = randomUUID()
    const opened = internal.ahp.open(
      { attachmentId, authorization: authorization() },
      { send: (message) => socket.send(message), close: () => socket.close() },
      connectionId
    )
    socket.on('message', (data) => {
      void opened
        .then((ok) =>
          ok ? internal.ahp.receive({ attachmentId, message: data.toString() }, connectionId) : socket.close()
        )
        .catch(() => socket.close())
    })
    socket.on('close', () => {
      internal.ahp.close({ attachmentId, reason: 'client_closed' }, connectionId)
    })
    void opened
      .then((ok) => {
        if (!ok) socket.close()
      })
      .catch(() => socket.close())
  })
  let serverClosed = false
  const closeServer = async () => {
    if (serverClosed) return
    serverClosed = true
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  dispose.push(closeServer)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
  return { internal, stop, closeServer, connect: () => connect(`ws://127.0.0.1:${address.port}`) }
}
async function connect(url: string) {
  const socket = new WebSocket(url)
  await once(socket, 'open')
  const client = new AhpClient(WebSocketTransport.fromSocket(socket as unknown as globalThis.WebSocket), {
    requestTimeoutMs: WAIT.timeout
  })
  client.connect()
  let state: ChatState | undefined
  let seq = 0
  const buffered: ActionEnvelope[] = []
  let closed = false
  socket.on('close', () => {
    closed = true
  })
  const apply = (envelope: ActionEnvelope) => {
    if (envelope.channel !== chat || envelope.rejectionReason) return
    if (!state) {
      buffered.push(envelope)
      return
    }
    if (envelope.serverSeq > seq) {
      state = chatReducer(state, envelope.action as ChatAction)
      seq = envelope.serverSeq
    }
  }
  const events = (async () => {
    for await (const item of client.events()) if (item.event.type === 'action') apply(item.event.params)
  })()
  const close = async () => {
    await client.shutdown()
    await events
  }
  dispose.push(close)
  const subscribe = async () => {
    const snapshot = (await client.subscribe(chat)).result.snapshot!
    state = snapshot.state as ChatState
    seq = snapshot.fromSeq
    for (const envelope of buffered.splice(0)) apply(envelope)
  }
  const send = (turnId: string, text: string, extra: Partial<ChatState['turns'][number]['message']> = {}) =>
    client.dispatch(chat, {
      type: ActionType.ChatTurnStarted,
      turnId,
      startedAt: new Date().toISOString(),
      message: { text, origin: { kind: MessageKind.User }, ...extra }
    })
  return { client, close, subscribe, send, state: () => state, sequence: () => seq, closed: () => closed }
}

describe('actual Daemon AHP acceptance with official SDK and an ACP process', () => {
  it('creates, approves, answers, reconnects, cancels and cold-resumes without duplicate execution', async () => {
    const files = scaffold()
    const metadata = registry()
    const host = await boot(files.root, metadata)
    const first = await host.connect()
    const second = await host.connect()
    await first.client.initialize({
      clientId: 'first',
      protocolVersions: ['1.0.0'],
      initialSubscriptions: ['ahp-root://']
    })
    await second.client.initialize({ clientId: 'second', protocolVersions: ['1.0.0'] })
    await first.client.request('createSession', { channel: uri, provider: agentId })
    expect(
      (await first.client.request('listSessions', { channel: 'ahp-root://' })).items.map((item) => item.resource)
    ).toContain(uri)
    await first.subscribe()
    await second.subscribe()
    first.client.dispatch(chat, {
      type: ActionType.ChatDraftChanged,
      draft: { text: 'typing', origin: { kind: MessageKind.User } }
    })
    await expect.poll(() => second.state()?.draft?.text, WAIT).toBe('typing')
    const approval = randomUUID()
    // VS Code's shape: its own model picker, custom agent and editor context ride along and are ignored.
    first.send(approval, '[ahp:approve]', {
      model: { id: 'copilot/gpt' },
      agent: { uri: 'file:///agents/review.agent.md' },
      attachments: [{ type: 'resource', label: 'main.ts', uri: 'file:///src/main.ts' } as never]
    })
    await expect
      .poll(
        () =>
          second
            .state()
            ?.activeTurn?.responseParts.some(
              (part) =>
                part.kind === ResponsePartKind.ToolCall && part.toolCall.status === ToolCallStatus.PendingConfirmation
            ),
        WAIT
      )
      .toBe(true)
    const permission = second
      .state()!
      .activeTurn!.responseParts.find(
        (part) => part.kind === ResponsePartKind.ToolCall && part.toolCall.status === ToolCallStatus.PendingConfirmation
      )!
    if (permission.kind !== ResponsePartKind.ToolCall) throw new Error('Missing actual permission request')
    expect(second.state()!.activeTurn!.message).toEqual({ text: '[ahp:approve]', origin: { kind: MessageKind.User } })
    second.client.dispatch(chat, {
      type: ActionType.ChatToolCallConfirmed,
      turnId: approval,
      toolCallId: permission.toolCall.toolCallId,
      approved: true,
      confirmed: ToolCallConfirmationReason.UserAction,
      selectedOptionId: 'allow-once'
    })
    await expect.poll(() => first.state()?.turns.find((turn) => turn.id === approval)?.state, WAIT).toBe('complete')
    expect(files.responses()).toContainEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    await expect.poll(() => second.state(), WAIT).toEqual(first.state())
    const input = randomUUID()
    first.send(input, '[ahp:input]')
    await expect
      .poll(
        () =>
          second
            .state()
            ?.activeTurn?.responseParts.some((part) => part.kind === ResponsePartKind.InputRequest && !part.response),
        WAIT
      )
      .toBe(true)
    const question = second
      .state()!
      .activeTurn!.responseParts.find((part) => part.kind === ResponsePartKind.InputRequest)!
    if (question.kind !== ResponsePartKind.InputRequest) throw new Error('Missing actual input request')
    second.client.dispatch(chat, {
      type: ActionType.ChatInputCompleted,
      requestId: question.request.id,
      response: ChatInputResponseKind.Accept,
      answers: {
        value: {
          state: ChatInputAnswerState.Submitted,
          value: { kind: ChatInputAnswerValueKind.Selected, value: 'two' }
        }
      }
    })
    await expect.poll(() => first.state()?.turns.find((turn) => turn.id === input)?.state, WAIT).toBe('complete')
    expect(files.responses()).toContainEqual({ action: 'accept', content: { value: 'two' } })
    const held = randomUUID()
    first.send(held, '[ahp:hold]')
    await expect.poll(() => JSON.stringify(first.state()?.activeTurn), WAIT).toContain('fixture started')
    const cursor = first.sequence()
    await first.close()
    expect(files.methods().filter((method) => method === 'session/cancel')).toHaveLength(0)
    const reconnected = await host.connect()
    await reconnected.client.reconnect({ clientId: 'first', lastSeenServerSeq: cursor, subscriptions: [chat] })
    await reconnected.subscribe()
    expect(reconnected.state()?.activeTurn?.id).toBe(held)
    reconnected.client.dispatch(chat, { type: ActionType.ChatTurnCancelled, turnId: held, duration: 0 })
    await expect.poll(() => second.state()?.turns.find((turn) => turn.id === held)?.state, WAIT).toBe('cancelled')
    await expect.poll(() => files.methods().filter((method) => method === 'session/cancel').length, WAIT).toBe(1)
    expect(files.methods().filter((method) => method === 'session/prompt')).toHaveLength(3)
    await second.close()
    await reconnected.close()
    await host.closeServer()
    await host.stop()
    const cold = await boot(files.root, metadata)
    const resumed = await cold.connect()
    await resumed.client.initialize({ clientId: 'cold', protocolVersions: ['1.0.0'] })
    await resumed.subscribe()
    expect(resumed.state()?.activeTurn).toBeUndefined()
    expect(resumed.state()?.turns.map((turn) => turn.id)).toEqual([approval, input, held])
    resumed.send(approval, '[ahp:approve]')
    await expect.poll(resumed.closed, WAIT).toBe(true)
    expect(files.methods().filter((method) => method === 'session/prompt')).toHaveLength(3)
    for (const mode of ['off', 'shadow'] as const) {
      cold.internal.cfg.features.ahp.mode = mode
      expect(
        await cold.internal.ahp.open(
          { attachmentId: randomUUID(), authorization: authorization() },
          { send: () => {}, close: () => {} },
          randomUUID()
        )
      ).toBe(false)
      const events: RdChatEvent[] = []
      const conversation = randomUUID()
      const admitted = await cold.internal.handleRelayMsg(
        {
          source: 'webchat',
          agentId,
          sessionKey: conversation,
          msgId: randomUUID(),
          chatId: conversation,
          payload: { op: 'turn', text: `Legacy ${mode}`, user: 'Fixture user' }
        },
        (event) => events.push(event)
      )
      expect(admitted.accepted).toBe(true)
      await expect.poll(() => events.some((event) => event.kind === 'done'), WAIT).toBe(true)
      expect(events.find((event) => event.kind === 'done')?.done.error).toBeUndefined()
    }
    expect(files.methods().filter((method) => method === 'session/prompt')).toHaveLength(5)
  })
})
