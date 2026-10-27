import { z } from 'zod'
import {
  ActionType,
  AhpErrorCodes,
  JsonRpcErrorCodes,
  negotiateProtocolVersion,
  type ActionOrigin,
  type AgentInfo,
  type CreateSessionParams,
  type ChatTurnsLoadedAction,
  type DispatchActionParams,
  type FetchTurnsParams,
  type ListSessionsParams,
  type ListSessionsResult,
  type ServerNotificationMap,
  type Snapshot,
  type StateAction
} from '@microsoft/agent-host-protocol'
import { AhpMessageText, AhpSessionUri, type AhpHandshake, type RdAhpClose } from '@agentconnect.md/protocol'
import type { AhpActionJournal } from './action-journal.js'
import { parseFileEditUri, type FileEditRef } from './file-edits.js'

export class AhpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
  }
}

type CatalogMethod = 'root/sessionAdded' | 'root/sessionRemoved' | 'root/sessionSummaryChanged'
export type AhpCatalogNotification = {
  [K in CatalogMethod]: { method: K; params: ServerNotificationMap[K]['params'] }
}[CatalogMethod]
export interface AhpHostPort {
  provider: AgentInfo
  journal: AhpActionJournal
  initializeMetadata?: Record<string, unknown>
  isAuthorized(): boolean
  serialized<T>(operation: () => Promise<T>): Promise<T>
  prepare(channel: string): Promise<void>
  snapshot(channel: string): Snapshot['state'] | undefined
  listSessions(params: ListSessionsParams): Promise<ListSessionsResult>
  createSession(params: CreateSessionParams): Promise<void>
  dispatch(params: DispatchActionParams, origin: ActionOrigin): Promise<void>
  fetchTurns?(params: FetchTurnsParams): Promise<ChatTurnsLoadedAction | undefined>
  customRequest?(method: 'agentconnect/appRpc' | 'agentconnect/appClose', params: unknown): Promise<unknown>
  readFileEdit?(ref: FileEditRef): Promise<string | undefined>
  subscribeNotification?(listener: (notification: AhpCatalogNotification) => void): () => void
}

const root = 'ahp-root://' as const
const identifier = z.string().min(1).max(256)
const channel = z.string().min(1).max(1024)
const cursor = z.string().min(1).max(2048)
const request = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([identifier, z.number().finite()]).optional(),
  method: identifier,
  params: z.unknown().optional()
})
const rootParams = z.object({ channel: z.literal(root) })
const subscription = z.object({ channel })
const initialize = rootParams.extend({
  clientId: identifier,
  protocolVersions: z.array(identifier).min(1).max(16),
  initialSubscriptions: z.array(channel).max(128).optional()
})
const reconnect = rootParams.extend({
  clientId: identifier,
  lastSeenServerSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  subscriptions: z.array(channel).max(128)
})
const listSessions = rootParams.extend({
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(100).optional()
})
const createSession = z
  .object({
    channel: AhpSessionUri,
    provider: identifier.optional(),
    workingDirectories: z.array(channel).max(16).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    activeClient: z.object({ clientId: identifier }).passthrough().optional(),
    progressToken: identifier.optional()
  })
  .passthrough()
const fetchTurns = z.object({
  channel: channel.refine((value) => value.startsWith('ahp-chat:/')),
  cursor: cursor.optional()
})
const resourceRead = rootParams.extend({
  uri: z.string().min(1).max(32768),
  encoding: z.enum(['base64', 'utf-8']).optional()
})
const dispatch = z.object({
  channel,
  clientSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  action: z.object({ type: identifier }).passthrough()
})
type Request = z.infer<typeof request>
type Options = { port: AhpHostPort; send(message: string): void; close(reason: RdAhpClose['reason']): void }

export class AhpHostConnection {
  private readonly port: AhpHostPort
  private clientId?: string
  private subscriptions = new Set<string>()
  private disposed = false
  private queued = 0
  private pending: Promise<unknown> = Promise.resolve()
  private readonly historyCursors = new Map<string, string | undefined>()
  private pendingOrigin?: { channel: string; clientSeq: number }
  private readonly unsubscribe: () => void
  private readonly unsubscribeNotification?: () => void

  constructor(private readonly options: Options) {
    this.port = options.port
    this.unsubscribe = this.port.journal.subscribe(
      (envelope) => {
        const own =
          envelope.origin?.clientId === this.clientId &&
          envelope.origin?.clientSeq === this.pendingOrigin?.clientSeq &&
          envelope.channel === this.pendingOrigin?.channel
        if (this.clientId && (this.subscriptions.has(envelope.channel) || own))
          this.send({ jsonrpc: '2.0', method: 'action', params: envelope })
      },
      () => this.stop('unavailable')
    )
    this.unsubscribeNotification = this.port.subscribeNotification?.((notification) => {
      if (this.clientId && this.subscriptions.has(root)) this.send({ jsonrpc: '2.0', ...notification })
    })
  }

  receive(frame: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (++this.queued > 16) {
      this.stop('overloaded')
      return Promise.resolve()
    }
    const operation = this.pending
      .then(() =>
        this.port.serialized(async () => {
          if (this.disposed) return
          if (!this.port.isAuthorized()) return this.stop('unauthorized')
          if (!AhpMessageText.safeParse(frame).success) return this.stop('invalid_message')
          let message: Request
          try {
            const result = request.safeParse(JSON.parse(frame))
            if (!result.success) {
              this.sendError(null, new AhpProtocolError(JsonRpcErrorCodes.InvalidRequest, 'Invalid JSON-RPC request'))
              return
            }
            message = result.data
          } catch {
            this.sendError(null, new AhpProtocolError(JsonRpcErrorCodes.ParseError, 'Invalid JSON'))
            return
          }
          try {
            const notification = message.method === 'dispatchAction' || message.method === 'unsubscribe'
            if (notification && message.id !== undefined)
              throw new AhpProtocolError(JsonRpcErrorCodes.InvalidRequest, 'Method requires a notification')
            if (!notification && message.id === undefined) return
            const result = await this.handle(message)
            this.assertAuthorized()
            if (message.id !== undefined) this.send({ jsonrpc: '2.0', id: message.id, result })
          } catch (error) {
            if (message.id !== undefined) this.sendError(message.id, error)
            if (!(error instanceof AhpProtocolError)) this.stop('unavailable')
            else if (error.code === AhpErrorCodes.UnsupportedProtocolVersion) this.stop('invalid_message')
          }
        })
      )
      .catch(() => this.stop('unavailable'))
      .finally(() => {
        this.queued--
      })
    this.pending = operation
    return operation
  }

  // The relay answered `initialize` before in-band authentication, so the real agent replaces its placeholder.
  adopt(handshake: AhpHandshake): Promise<void> {
    return this.port.serialized(async () => {
      this.assertAuthorized()
      this.assertFresh()
      this.clientId = handshake.clientId
      this.subscriptions = new Set(handshake.root ? [root] : [])
      if (!handshake.root) return
      const action = { type: ActionType.RootAgentsChanged, agents: [this.port.provider] } as StateAction
      this.send({
        jsonrpc: '2.0',
        method: 'action',
        params: { channel: root, action, serverSeq: this.port.journal.currentSequence }
      })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.subscriptions.clear()
    this.historyCursors.clear()
    this.unsubscribe?.()
    this.unsubscribeNotification?.()
  }

  private async handle(message: Request): Promise<unknown> {
    if (message.method === 'ping') {
      parse(rootParams, message.params)
      return null
    }
    if (message.method === 'initialize') {
      this.assertFresh()
      const params = parse(initialize, message.params)
      const version = negotiateProtocolVersion(params.protocolVersions.filter((value) => value === '1.0.0'))
      if (!version)
        throw new AhpProtocolError(AhpErrorCodes.UnsupportedProtocolVersion, 'AHP 1.0.0 is required', {
          supportedVersions: ['1.0.0']
        })
      const snapshots = await this.prepareSnapshots(params.initialSubscriptions ?? [])
      this.clientId = params.clientId
      this.subscriptions = new Set(snapshots.map((snapshot) => snapshot.resource))
      return {
        protocolVersion: version,
        serverSeq: this.port.journal.currentSequence,
        snapshots,
        ...(this.port.initializeMetadata ? { _meta: this.port.initializeMetadata } : {})
      }
    }
    if (message.method === 'reconnect') {
      this.assertFresh()
      const params = parse(reconnect, message.params)
      const snapshots = await this.prepareSnapshots(params.subscriptions)
      this.clientId = params.clientId
      this.subscriptions = new Set(snapshots.map((snapshot) => snapshot.resource))
      const actions = this.port.journal.replay(params.lastSeenServerSeq, this.subscriptions)
      const replay = {
        type: 'replay',
        actions,
        missing: params.subscriptions.filter((uri) => !this.subscriptions.has(uri))
      }
      if (actions && this.fits({ jsonrpc: '2.0', id: message.id, result: replay })) return replay
      return { type: 'snapshot', snapshots }
    }
    if (!this.clientId) throw new AhpProtocolError(JsonRpcErrorCodes.InvalidRequest, 'Initialize the connection first')
    switch (message.method) {
      case 'subscribe': {
        const params = parse(subscription, message.params)
        if (!this.subscriptions.has(params.channel) && this.subscriptions.size >= 128)
          throw new AhpProtocolError(JsonRpcErrorCodes.InvalidParams, 'Subscription limit reached')
        await this.prepare(params.channel)
        const snapshot = this.snapshot(params.channel)
        if (!snapshot) throw new AhpProtocolError(AhpErrorCodes.NotFound, 'Channel not found')
        this.subscriptions.add(params.channel)
        return { snapshot }
      }
      case 'unsubscribe': {
        const { channel } = parse(subscription, message.params)
        this.subscriptions.delete(channel)
        this.historyCursors.delete(channel)
        return undefined
      }
      case 'listSessions':
        return this.port.listSessions(parse(listSessions, message.params))
      case 'createSession': {
        const params = parse(createSession, message.params)
        if (params.provider && params.provider !== this.port.provider.provider)
          throw new AhpProtocolError(AhpErrorCodes.ProviderNotFound, 'Provider not found')
        if (params.activeClient && params.activeClient.clientId !== this.clientId)
          throw new AhpProtocolError(JsonRpcErrorCodes.InvalidParams, 'Active client must match this connection')
        await this.port.createSession(params as CreateSessionParams)
        return {}
      }
      case 'fetchTurns': {
        const params = parse(fetchTurns, message.params)
        if (!this.port.fetchTurns)
          throw new AhpProtocolError(JsonRpcErrorCodes.MethodNotFound, 'History paging is unavailable')
        await this.prepare(params.channel)
        const after = params.cursor ?? this.historyCursors.get(params.channel)
        if (params.cursor === undefined && this.historyCursors.has(params.channel) && after === undefined) return {}
        const action = await this.port.fetchTurns({ ...params, ...(after ? { cursor: after } : {}) })
        this.assertAuthorized()
        if (action) {
          const envelope = await this.port.journal.append({ channel: params.channel, action }, 'private')
          this.send({ jsonrpc: '2.0', method: 'action', params: envelope })
          this.historyCursors.set(params.channel, action.turnsNextCursor)
        }
        return {}
      }
      case 'dispatchAction':
        await this.dispatch(parse(dispatch, message.params) as DispatchActionParams)
        return undefined
      case 'resourceRead': {
        const params = parse(resourceRead, message.params)
        const ref = parseFileEditUri(params.uri)
        if (!ref || !this.port.readFileEdit) throw new AhpProtocolError(AhpErrorCodes.NotFound, 'Resource not found')
        await this.prepare(ref.sessionUri)
        const text = await this.port.readFileEdit(ref)
        this.assertAuthorized()
        if (text === undefined) throw new AhpProtocolError(AhpErrorCodes.NotFound, 'Resource not found')
        const result =
          params.encoding === 'base64'
            ? { data: Buffer.from(text).toString('base64'), encoding: 'base64', contentType: 'text/plain' }
            : { data: text, encoding: 'utf-8', contentType: 'text/plain' }
        if (!this.fits({ jsonrpc: '2.0', id: message.id, result }))
          throw new AhpProtocolError(JsonRpcErrorCodes.InvalidRequest, 'Resource exceeds the message limit')
        return result
      }
      case 'agentconnect/appRpc':
      case 'agentconnect/appClose': {
        if (!this.port.customRequest) throw new AhpProtocolError(JsonRpcErrorCodes.MethodNotFound, 'Unknown method')
        await this.prepare(parse(subscription, message.params).channel)
        return this.port.customRequest(message.method, message.params)
      }
      default:
        throw new AhpProtocolError(JsonRpcErrorCodes.MethodNotFound, 'Unknown method')
    }
  }

  private async dispatch(params: DispatchActionParams): Promise<void> {
    const origin = { clientId: this.clientId!, clientSeq: params.clientSeq }
    this.pendingOrigin = { channel: params.channel, clientSeq: params.clientSeq }
    try {
      await this.prepare(params.channel)
      await this.port.dispatch(params, origin)
    } catch (error) {
      if (!(error instanceof AhpProtocolError)) throw error
      this.assertAuthorized()
      const envelope = await this.port.journal.append({
        channel: params.channel,
        action: params.action as StateAction,
        origin,
        rejectionReason: error.message
      })
      this.send({ jsonrpc: '2.0', method: 'action', params: envelope })
    } finally {
      this.pendingOrigin = undefined
    }
  }

  private async prepare(channel: string): Promise<void> {
    if (channel !== root) await this.port.prepare(channel)
    this.assertAuthorized()
  }

  private async prepareSnapshots(channels: string[]): Promise<Snapshot[]> {
    const allowed: string[] = []
    for (const channel of new Set(channels)) {
      try {
        await this.prepare(channel)
        allowed.push(channel)
      } catch (error) {
        if (
          !(error instanceof AhpProtocolError) ||
          !new Set<number>([AhpErrorCodes.NotFound, AhpErrorCodes.SessionNotFound, AhpErrorCodes.PermissionDenied]).has(
            error.code
          )
        )
          throw error
      }
    }
    // Restore every resource before capturing a single shared snapshot cursor.
    return allowed.flatMap((channel) => {
      const snapshot = this.snapshot(channel)
      return snapshot ? [snapshot] : []
    })
  }

  private snapshot(resource: string): Snapshot | undefined {
    const state = resource === root ? { agents: [this.port.provider] } : this.port.snapshot(resource)
    if (state && resource.startsWith('ahp-chat:'))
      this.historyCursors.set(resource, 'turnsNextCursor' in state ? state.turnsNextCursor : undefined)
    return state ? { resource, state, fromSeq: this.port.journal.currentSequence } : undefined
  }

  private assertFresh(): void {
    if (this.clientId) throw new AhpProtocolError(JsonRpcErrorCodes.InvalidRequest, 'Connection already initialized')
  }

  private assertAuthorized(): void {
    if (this.disposed || !this.port.isAuthorized()) {
      this.stop('unauthorized')
      throw new AhpProtocolError(AhpErrorCodes.PermissionDenied, 'Attachment is no longer authorized')
    }
  }

  private fits(message: unknown): boolean {
    return AhpMessageText.safeParse(JSON.stringify(message)).success
  }

  private send(message: unknown): void {
    if (this.disposed) return
    if (!this.port.isAuthorized()) return this.stop('unauthorized')
    const text = JSON.stringify(message)
    if (!AhpMessageText.safeParse(text).success) return this.stop('overloaded')
    try {
      this.options.send(text)
    } catch {
      this.stop('unavailable')
    }
  }

  private sendError(id: string | number | null, error: unknown): void {
    const safe =
      error instanceof AhpProtocolError
        ? error
        : new AhpProtocolError(JsonRpcErrorCodes.InternalError, 'Host unavailable')
    this.send({
      jsonrpc: '2.0',
      id,
      error: { code: safe.code, message: safe.message, ...(safe.data === undefined ? {} : { data: safe.data }) }
    })
  }

  private stop(reason: RdAhpClose['reason']): void {
    if (this.disposed) return
    this.dispose()
    this.options.close(reason)
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new AhpProtocolError(JsonRpcErrorCodes.InvalidParams, 'Invalid method parameters')
  return result.data
}
