import {
  chatReducer,
  sessionReducer,
  type ChatAction,
  type ChatState,
  type SessionAction,
  type SessionState,
  type StateAction,
  type Snapshot
} from '@microsoft/agent-host-protocol'
import { AhpClient, type AhpTransport, type Subscription } from '@microsoft/agent-host-protocol/client'
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws'
import { AHP_WEBSOCKET_PROTOCOL, AHP_WEBCHAT_TOKEN_PREFIX } from '@agentconnect.md/protocol/ahp-constants'
import type { McpAppRpc, McpAppRpcResult } from '@agentconnect.md/protocol'
import { randomUuid } from '@/lib/random-uuid'
import { AhpDeliveryGuard } from './delivery-guard'
import { AhpMessageTooLargeError, ahpRemainingActionBytes } from './message-size'

export interface AhpView {
  session?: SessionState
  chat?: ChatState
  connected: boolean
  uncertain: boolean
  extensions?: Record<string, unknown>
  error?: string
}
export class AhpRejectedActionError extends Error {}
export class AhpDeliveryUnknownError extends Error {
  constructor() {
    super('Delivery could not be confirmed. Reconnect to check the conversation before sending again.')
  }
}
type Pending = {
  action: StateAction
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class AhpAttachment {
  private client?: AhpClient
  private clientId = randomUuid()
  private view: AhpView = { connected: false, uncertain: false }
  private sessionUri?: string
  private chatUri?: string
  private stopped = false
  private generation = 0
  private nextClientSeq = 1
  private readonly pending = new Map<number, Pending>()
  private readonly unknownIntents = new Set<string>()
  private readonly listeners = new Set<(view: AhpView) => void>()
  constructor(private readonly openTransport: () => Promise<AhpTransport>) {}
  get snapshot(): AhpView {
    return this.view
  }
  subscribe(listener: (view: AhpView) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private setView(patch: Partial<AhpView>): void {
    this.view = { ...this.view, ...patch }
    for (const listener of this.listeners) listener(this.view)
  }
  async attach(sessionUri = this.sessionUri): Promise<void> {
    this.stopped = false
    this.setView({ connected: false })
    const generation = ++this.generation
    this.losePending()
    const previous = this.client
    this.client = undefined
    await previous?.shutdown()
    if (this.stopped || generation !== this.generation) return
    const transport = await this.openTransport()
    if (this.stopped || generation !== this.generation) {
      await transport.close()
      return
    }
    const delivery = new AhpDeliveryGuard(transport)
    const client = new AhpClient(delivery)
    this.client = client
    this.nextClientSeq = 1
    this.clientId = randomUuid()
    client.connect()
    const current = () => !this.stopped && generation === this.generation && this.client === client
    try {
      const initialized = await client.initialize({ clientId: this.clientId, protocolVersions: ['1.0.0'] })
      if (!current()) {
        await client.shutdown()
        return
      }
      if (initialized.protocolVersion !== '1.0.0') throw new Error('The conversation uses an unsupported version.')
      this.setView({ extensions: initialized._meta })
      if (!sessionUri) {
        const catalog = await client.request('listSessions', { channel: 'ahp-root://' })
        if (!current()) {
          await client.shutdown()
          return
        }
        if (catalog.items.length !== 1 || catalog.nextCursor)
          throw new Error('The conversation could not be identified.')
        sessionUri = catalog.items[0]!.resource
      }
      this.sessionUri = sessionUri
      delivery.watch(sessionUri)
      const session = await client.subscribe(sessionUri)
      if (!current()) {
        await client.shutdown()
        return
      }
      if (!session.result.snapshot) throw new Error('The conversation is unavailable.')
      this.applySnapshot(session.result.snapshot)
      const chatUri = this.view.session?.defaultChat ?? this.view.session?.chats[0]?.resource
      if (!chatUri) throw new Error('The conversation has no available chat.')
      this.chatUri = chatUri
      delivery.watch(chatUri)
      const chat = await client.subscribe(chatUri)
      if (!current()) {
        await client.shutdown()
        return
      }
      if (delivery.overflowed || client.connectionState.status === 'closed')
        throw new Error('The conversation was disconnected.')
      if (!chat.result.snapshot) throw new Error('The conversation is unavailable.')
      this.applySnapshot(chat.result.snapshot)
      this.setView({ connected: true, error: undefined })
      void this.consume(session.subscription, session.result.snapshot.fromSeq, generation, delivery)
      void this.consume(chat.subscription, chat.result.snapshot.fromSeq, generation, delivery)
      void this.watchConnection(client, generation)
    } catch (error) {
      await client.shutdown()
      if (!current()) return
      this.setView({
        connected: false,
        error: error instanceof Error ? error.message : 'The conversation is unavailable.'
      })
      throw error
    }
  }
  remainingActionBytes(action: StateAction, target: 'chat' | 'session' = 'chat'): number {
    const channel = target === 'session' ? this.sessionUri : this.chatUri
    if (!this.view.connected || !channel) throw new Error('The conversation is disconnected.')
    return ahpRemainingActionBytes(channel, this.nextClientSeq, action)
  }
  dispatch(action: StateAction, target: 'chat' | 'session' = 'chat'): Promise<void> {
    const client = this.client
    const channel = target === 'session' ? this.sessionUri : this.chatUri
    if (!this.view.connected || !client || !channel)
      return Promise.reject(new Error('The conversation is disconnected.'))
    if (this.view.uncertain) return Promise.reject(new AhpDeliveryUnknownError())
    if (this.remainingActionBytes(action, target) < 0) return Promise.reject(new AhpMessageTooLargeError())
    const { clientSeq } = client.dispatch(channel, action, this.nextClientSeq++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(clientSeq)
        if (!pending) return
        this.pending.delete(clientSeq)
        this.markUnknown(pending)
        void client.shutdown()
      }, 30_000)
      this.pending.set(clientSeq, { action, resolve, reject, timer })
    })
  }
  appRpc(appId: string, callId: string, rpc: McpAppRpc): Promise<McpAppRpcResult> {
    return this.appRequest<McpAppRpcResult>('agentconnect/appRpc', { appId, callId, rpc })
  }
  async closeApp(appId: string): Promise<void> {
    await this.appRequest<null>('agentconnect/appClose', { appId })
  }
  private appRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const profile = this.view.extensions?.['agentconnect.md'] as { mcpApps?: boolean } | undefined
    if (!this.view.connected || !this.client || !this.chatUri)
      return Promise.reject(new Error('Reconnect to use this app.'))
    if (profile?.mcpApps !== true)
      return Promise.reject(new Error('Interactive app actions are unavailable in this conversation.'))
    const request = this.client.request.bind(this.client) as (
      method: string,
      params: Record<string, unknown>
    ) => Promise<T>
    return request(method, { channel: this.chatUri, ...params })
  }
  async close(): Promise<void> {
    this.stopped = true
    this.generation++
    this.losePending()
    this.setView({ connected: false })
    const client = this.client
    this.client = undefined
    await client?.shutdown()
  }
  private applySnapshot(snapshot: Snapshot): void {
    if (snapshot.resource === this.sessionUri) this.setView({ session: snapshot.state as SessionState })
    else if (snapshot.resource === this.chatUri) {
      const chat = snapshot.state as ChatState
      for (const id of this.unknownIntents) {
        const turns = [...chat.turns, ...(chat.activeTurn ? [chat.activeTurn] : [])]
        if (
          chat.steeringMessage?.id === id ||
          chat.queuedMessages?.some((message) => message.id === id) ||
          turns.some(
            (turn) =>
              turn.id === id ||
              turn.responseParts.some(
                (part) =>
                  part.kind === 'systemNotification' &&
                  (part._meta?.['agentconnect.md'] as { steeringId?: string } | undefined)?.steeringId === id
              )
          )
        )
          this.unknownIntents.delete(id)
      }
      this.setView({ chat, uncertain: this.unknownIntents.size > 0 })
    }
  }
  private async consume(
    subscription: Subscription,
    after: number,
    generation: number,
    delivery: AhpDeliveryGuard
  ): Promise<void> {
    for await (const event of subscription) {
      if (generation !== this.generation) return
      if (event.type === 'authRequired') {
        await this.close()
        return
      }
      if (event.type !== 'action') continue
      const envelope = event.params
      try {
        if (delivery.overflowed) return
        const pending =
          envelope.origin?.clientId === this.clientId ? this.pending.get(envelope.origin.clientSeq) : undefined
        if (pending && envelope.origin) {
          clearTimeout(pending.timer)
          this.pending.delete(envelope.origin.clientSeq)
          if (envelope.rejectionReason) pending.reject(new AhpRejectedActionError(envelope.rejectionReason))
          else pending.resolve()
        }
        if (envelope.serverSeq <= after || envelope.rejectionReason) continue
        after = envelope.serverSeq
        if (envelope.channel === this.sessionUri && this.view.session)
          this.setView({ session: sessionReducer(this.view.session, envelope.action as SessionAction) })
        else if (envelope.channel === this.chatUri && this.view.chat)
          this.setView({ chat: chatReducer(this.view.chat, envelope.action as ChatAction) })
      } finally {
        delivery.consumed(envelope.channel)
      }
    }
  }
  private async watchConnection(client: AhpClient, generation: number): Promise<void> {
    for await (const state of client.stateChanges()) {
      if (generation !== this.generation) return
      if (state.status === 'closed') {
        this.losePending()
        this.setView({ connected: false, error: 'Connection interrupted. Reconnect to load the latest conversation.' })
      }
    }
  }
  private markUnknown(pending: Pending): void {
    clearTimeout(pending.timer)
    const action = pending.action
    if (action.type === 'chat/turnStarted') this.unknownIntents.add(action.turnId)
    else if (action.type === 'chat/pendingMessageSet') this.unknownIntents.add(action.id)
    this.setView({ uncertain: true })
    pending.reject(new AhpDeliveryUnknownError())
  }
  private losePending(): void {
    for (const pending of this.pending.values()) this.markUnknown(pending)
    this.pending.clear()
  }
}

export function ahpBrowserTransport(url: string, token: string): Promise<AhpTransport> {
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(token)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
  return WebSocketTransport.connect(url, {
    protocols: [AHP_WEBSOCKET_PROTOCOL, `${AHP_WEBCHAT_TOKEN_PREFIX}${encoded}`]
  })
}
