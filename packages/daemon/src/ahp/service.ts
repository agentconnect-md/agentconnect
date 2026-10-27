import { randomUUID } from 'node:crypto'
import {
  AhpSessionUri,
  type AhpAttachmentAuthorization,
  type AhpSessionBinding,
  type AhpSessionReserve,
  type AhpSessionFinalize,
  type AhpSessionResolve,
  type AhpSessionList,
  type AhpSessionResult,
  type AhpSessionListResult,
  type RdAhpOpen,
  type RdAhpMessage,
  type RdAhpClose
} from '@agentconnect.md/protocol'
import {
  AhpErrorCodes,
  JsonRpcErrorCodes,
  SessionStatus,
  type ActionOrigin,
  type AgentInfo,
  type ChatState,
  type DispatchActionParams,
  type SessionConfigState,
  type SessionSummary,
  type Turn
} from '@microsoft/agent-host-protocol'
import type { MaskedChatEvent } from '../session/chat-events.js'
import type { ChatOutput } from '../session/chat-turn.js'
import { AhpActionJournal } from './action-journal.js'
import { AhpAgentState, AhpStateCapacityError, type AhpCheckpointStore } from './agent-state.js'
import { AhpHostConnection, AhpProtocolError, type AhpHostPort } from './connection.js'
import type { FileEditRef } from './file-edits.js'
import { toolEditText } from '../session/tool-edits.js'

export type BoundAhpSession = AhpSessionBinding & { sessionId: string }
export interface AhpActionContext {
  authorization: AhpAttachmentAuthorization
  binding: BoundAhpSession
  state: AhpAgentState
  isCurrent(): boolean
}
export interface AhpServiceOptions {
  enabled(): boolean
  available(auth: Pick<AhpAttachmentAuthorization, 'orgId' | 'agentId'>): boolean
  initializeMetadata?: Record<string, unknown>
  now(): number
  provider(agentId: string): AgentInfo
  checkpoints?(orgId: string, agentId: string): AhpCheckpointStore
  reserveSequence(orgId: string, agentId: string, size: number): Promise<{ start: number; end: number }>
  duty(agentId: string): AhpSessionReserve['duty']
  registry: {
    reserve(input: AhpSessionReserve): Promise<AhpSessionResult>
    finalize(input: AhpSessionFinalize): Promise<AhpSessionResult>
    resolve(input: AhpSessionResolve): Promise<AhpSessionResult>
    list(input: AhpSessionList): Promise<AhpSessionListResult>
  }
  ensureSession(binding: AhpSessionBinding, authorization: AhpAttachmentAuthorization): Promise<string>
  history(binding: BoundAhpSession, auth: AhpAttachmentAuthorization): Promise<readonly MaskedChatEvent[] | ChatState>
  summary?(binding: BoundAhpSession, auth: AhpAttachmentAuthorization): Promise<SessionSummary>
  sessionConfig?(binding: BoundAhpSession, auth: AhpAttachmentAuthorization): Promise<SessionConfigState | undefined>
  historyPage?(
    binding: BoundAhpSession,
    auth: AhpAttachmentAuthorization,
    cursor: string
  ): Promise<{ turns: Turn[]; nextCursor?: string }>
  dispatch(params: DispatchActionParams, origin: ActionOrigin, context: AhpActionContext): Promise<void>
  toolBody?(binding: BoundAhpSession, auth: AhpAttachmentAuthorization, toolCallId: string): Promise<string | undefined>
  customRequest?(
    method: 'agentconnect/appRpc' | 'agentconnect/appClose',
    params: unknown,
    context: AhpActionContext,
    isCurrent: () => boolean
  ): Promise<unknown>
}
interface Attachment {
  authorization: AhpAttachmentAuthorization
  bindings: Map<string, BoundAhpSession>
  state?: AhpAgentState
  connection?: AhpHostConnection
  timer?: ReturnType<typeof setTimeout>
  close(reason: RdAhpClose['reason']): void
}

// Attachments own subscriptions; execution and durable conversation ownership remain in the daemon.
export class AhpService {
  private readonly agents = new Map<string, Promise<AhpAgentState>>()
  private readonly attachments = new Map<string, Attachment>()
  private readonly blocked = new Set<string>()
  private readonly observationQueues = new Map<string, { count: number; bytes: number }>()
  constructor(private readonly options: AhpServiceOptions) {}

  async open(
    input: RdAhpOpen,
    wire: { send(message: string): void; close(reason: RdAhpClose['reason']): void },
    connectionId: string
  ): Promise<boolean> {
    const key = attachmentKey(connectionId, input.attachmentId)
    if (this.attachments.has(key) || !this.authorized(input.authorization)) return false
    const attachment: Attachment = { authorization: input.authorization, bindings: new Map(), close: wire.close }
    this.attachments.set(key, attachment)
    const valid = () => this.attachments.get(key) === attachment && this.authorized(attachment.authorization)
    try {
      this.blocked.delete(agentKey(input.authorization.orgId, input.authorization.agentId))
      const owner = this.agent(input.authorization)
      const state = await owner
      attachment.state = state
      const allowed = attachment.bindings
      const scope = () => ({
        orgId: attachment.authorization.orgId,
        agentId: attachment.authorization.agentId,
        grant: attachment.authorization.grant.token
      })
      const load = async (binding: AhpSessionBinding): Promise<BoundAhpSession> => {
        if (!valid()) throw denied()
        if (!binding.sessionId) throw new AhpProtocolError(AhpErrorCodes.NotFound, 'Session is not ready')
        const bound = binding as BoundAhpSession
        const acquired = !allowed.has(bound.sessionUri)
        if (acquired && allowed.size >= 128)
          throw new AhpProtocolError(JsonRpcErrorCodes.InvalidRequest, 'Too many prepared sessions')
        if (acquired) state.retain(bound.sessionUri)
        allowed.set(bound.sessionUri, bound)
        try {
          const loaded = state.binding(bound.sessionUri)
          await state.add(
            bound,
            loaded ? [] : await this.options.history(bound, attachment.authorization),
            loaded ? undefined : await this.options.sessionConfig?.(bound, attachment.authorization)
          )
          if (!valid()) throw denied()
          return bound
        } catch (error) {
          // A disconnected attachment already queued its release behind this serialized installation.
          if (acquired && valid()) {
            allowed.delete(bound.sessionUri)
            state.release(bound.sessionUri)
          }
          throw error
        }
      }
      const reserve = async (sessionUri: string): Promise<BoundAhpSession> => {
        const binding = registryResult(
          await this.options.registry.reserve({
            ...scope(),
            sessionUri,
            operationId: randomUUID(),
            duty: this.options.duty(scope().agentId)
          })
        )
        if (!valid()) throw denied()
        if (binding.sessionId) return load(binding)
        const sessionId = await this.options.ensureSession(binding, attachment.authorization)
        if (!valid()) throw denied()
        return load(
          registryResult(
            await this.options.registry.finalize({
              ...scope(),
              reservationId: binding.reservationId,
              sessionId,
              duty: this.options.duty(scope().agentId)
            })
          )
        )
      }
      await state.serialized(async () => {
        registryResult(await this.options.registry.list({ ...scope(), limit: 1 }))
        if (attachment.authorization.conversationId)
          await reserve(
            `ahp-session:/webchat/${attachment.authorization.conversationId}/${attachment.authorization.agentId}`
          )
      })
      if (!valid()) {
        this.remove(key, attachment, 'unauthorized')
        return false
      }
      const context = (channel: string): AhpActionContext => {
        const binding = allowed.get(sessionChannel(channel))
        if (!binding || !valid()) throw denied()
        return {
          authorization: {
            ...attachment.authorization,
            callerRole: binding.callerRole ?? 'participant',
            callerApproves: binding.callerApproves ?? false
          },
          binding,
          state,
          isCurrent: valid
        }
      }
      const port: AhpHostPort = {
        provider: state.provider,
        journal: state.journal,
        initializeMetadata: this.options.initializeMetadata,
        isAuthorized: valid,
        serialized: (operation) => state.serialized(operation),
        prepare: async (channel) => {
          const uri = sessionChannel(channel)
          let binding
          try {
            binding = registryResult(await this.options.registry.resolve({ ...scope(), sessionUri: uri }))
            if (binding.sessionUri !== uri) throw denied()
          } catch (error) {
            if (allowed.has(uri)) this.remove(key, attachment, 'unauthorized')
            throw error
          }
          await load(binding)
          if (!state.snapshot(channel)) throw new AhpProtocolError(AhpErrorCodes.NotFound, 'Channel unavailable')
        },
        snapshot: (channel) => (allowed.has(sessionChannel(channel)) ? state.snapshot(channel) : undefined),
        listSessions: async (params) => {
          const result = registryResult(
            await this.options.registry.list({
              ...scope(),
              limit: Math.min(params.limit ?? 10, 10),
              ...(params.cursor ? { cursor: params.cursor } : {})
            })
          )
          const items: SessionSummary[] = []
          for (const binding of result.sessions) {
            if (!binding.sessionId) continue
            const bound = binding as BoundAhpSession
            items.push(
              state.summary(binding.sessionUri) ??
                (await this.options.summary?.(bound, attachment.authorization)) ?? {
                  resource: binding.sessionUri,
                  provider: state.provider.provider,
                  title: 'Conversation',
                  status: SessionStatus.Idle,
                  createdAt: new Date(0).toISOString(),
                  modifiedAt: new Date(0).toISOString(),
                  defaultChat: chatChannel(binding.sessionUri)
                }
            )
          }
          if (!valid()) throw denied()
          return { items, ...(result.cursor ? { nextCursor: result.cursor } : {}) }
        },
        createSession: async (params) => {
          if (attachment.authorization.conversationId || attachment.authorization.targetSessionId) throw denied()
          if (
            params.activeClient ||
            params.workingDirectories?.length ||
            (params.config && Object.keys(params.config).length)
          )
            throw new AhpProtocolError(JsonRpcErrorCodes.InvalidParams, 'Session configuration is not supported')
          const binding = await reserve(params.channel)
          state.announce(binding.sessionUri)
        },
        dispatch: async (params, origin) => {
          try {
            await this.options.dispatch(params, origin, context(params.channel))
          } catch (error) {
            if (!(error instanceof AhpProtocolError))
              this.closeAgent(
                scope().orgId,
                scope().agentId,
                error instanceof AhpStateCapacityError ? 'overloaded' : 'unavailable',
                owner
              )
            throw error
          }
        },
        ...(this.options.historyPage
          ? {
              fetchTurns: async (params: { channel: string; cursor?: string }) => {
                const current = context(params.channel)
                return state.fetchTurns(params.channel, params.cursor, async (_sessionId, cursor) => {
                  try {
                    return await this.options.historyPage!(current.binding, current.authorization, cursor)
                  } catch (error) {
                    if (error instanceof Error && /cursor/i.test(error.message))
                      throw new AhpProtocolError(JsonRpcErrorCodes.InvalidParams, 'Unrecognized history cursor')
                    throw error
                  }
                })
              }
            }
          : {}),
        ...(this.options.toolBody
          ? {
              readFileEdit: async (ref: FileEditRef) => {
                const current = context(ref.sessionUri)
                const body = await this.options.toolBody!(current.binding, current.authorization, ref.toolCallId)
                if (body === undefined) return undefined
                try {
                  return toolEditText(JSON.parse(body), ref, ref.side)
                } catch {
                  return undefined
                }
              }
            }
          : {}),
        ...(this.options.customRequest
          ? {
              customRequest: async (method: 'agentconnect/appRpc' | 'agentconnect/appClose', params: unknown) =>
                this.options.customRequest!(method, params, context((params as { channel: string }).channel), valid)
            }
          : {}),
        subscribeNotification: (listener) => {
          let pending = 0
          let active = true
          const unsubscribe = state.subscribeNotifications((notification) => {
            if (!valid() || !active) return
            if (++pending > 16) {
              this.remove(key, attachment, 'overloaded')
              return
            }
            const uri =
              notification.method === 'root/sessionAdded'
                ? notification.params.summary.resource
                : notification.params.session
            const auth = attachment.authorization
            void this.options.registry
              .resolve({ orgId: auth.orgId, agentId: auth.agentId, grant: auth.grant.token, sessionUri: uri })
              .then((result) => {
                if (!active || !valid() || auth !== attachment.authorization) return
                if (result.ok && result.sessionUri === uri) listener(notification)
                else if (allowed.has(uri)) this.remove(key, attachment, 'unauthorized')
              })
              .catch(() => {})
              .finally(() => {
                pending--
              })
          })
          return () => {
            active = false
            unsubscribe()
          }
        }
      }
      attachment.connection = new AhpHostConnection({
        port,
        send: wire.send,
        close: (reason) => this.remove(key, attachment, reason)
      })
      if (input.handshake) await attachment.connection.adopt(input.handshake)
      if (!valid()) {
        this.remove(key, attachment, 'unauthorized')
        return false
      }
      this.expire(key, attachment)
      return true
    } catch {
      this.remove(key, attachment, 'unauthorized')
      return false
    }
  }

  async authorize(input: RdAhpOpen, connectionId: string): Promise<boolean> {
    const key = attachmentKey(connectionId, input.attachmentId)
    const attachment = this.attachments.get(key)
    if (
      !attachment ||
      !samePrincipal(attachment.authorization, input.authorization) ||
      !this.authorized(input.authorization)
    ) {
      if (attachment) this.remove(key, attachment, 'unauthorized')
      return false
    }
    try {
      await attachment.state!.serialized(async () => {
        const auth = input.authorization
        const scope = { orgId: auth.orgId, agentId: auth.agentId, grant: auth.grant.token }
        registryResult(await this.options.registry.list({ ...scope, limit: 1 }))
        const renewed = new Map<string, BoundAhpSession>()
        for (const [uri, previous] of attachment.bindings) {
          const binding = registryResult(await this.options.registry.resolve({ ...scope, sessionUri: uri }))
          if (binding.sessionUri !== uri || binding.sessionId !== previous.sessionId) throw denied()
          renewed.set(uri, binding as BoundAhpSession)
        }
        if (this.attachments.get(key) !== attachment || !this.authorized(auth)) throw denied()
        for (const [uri, binding] of renewed) attachment.bindings.set(uri, binding)
        attachment.authorization = auth
        this.expire(key, attachment)
      })
      return true
    } catch {
      this.remove(key, attachment, 'unauthorized')
      return false
    }
  }

  async receive(input: RdAhpMessage, connectionId: string): Promise<void> {
    const key = attachmentKey(connectionId, input.attachmentId)
    const attachment = this.attachments.get(key)
    if (!attachment) return
    if (!this.authorized(attachment.authorization)) {
      this.remove(key, attachment, 'unauthorized')
      return
    }
    await attachment.connection?.receive(input.message)
  }
  close(input: RdAhpClose, connectionId: string): void {
    const key = attachmentKey(connectionId, input.attachmentId)
    const attachment = this.attachments.get(key)
    if (attachment) this.remove(key, attachment)
  }
  relayLost(connectionId: string): void {
    for (const [key, attachment] of this.attachments)
      if (key.startsWith(`${connectionId}\0`)) this.remove(key, attachment)
  }
  observe(orgId: string, agentId: string, event: MaskedChatEvent): void {
    const safe = structuredClone(event)
    this.enqueueObservation(orgId, agentId, safe, (state) => state.accept(safe))
  }
  output(orgId: string, agentId: string, sessionId: string, output: ChatOutput): void {
    const safe = structuredClone(output)
    this.enqueueObservation(orgId, agentId, safe, (state) => state.output(sessionId, safe))
  }
  private enqueueObservation(
    orgId: string,
    agentId: string,
    value: unknown,
    apply: (state: AhpAgentState) => Promise<void>
  ): void {
    const key = agentKey(orgId, agentId)
    if (this.blocked.has(key) || !this.options.available({ orgId, agentId })) return
    const owner = this.agents.get(key) ?? (this.options.enabled() ? this.agent({ orgId, agentId }) : undefined)
    if (!owner) return
    const bytes = Buffer.byteLength(JSON.stringify(value))
    const queue = this.observationQueues.get(key) ?? { count: 0, bytes: 0 }
    if (++queue.count > 256 || (queue.bytes += bytes) > 1024 * 1024) {
      this.closeAgent(orgId, agentId, 'overloaded', owner)
      return
    }
    this.observationQueues.set(key, queue)
    void owner
      .then((state) =>
        state.serialized(async () => {
          if (this.agents.get(key) === owner) await apply(state)
        })
      )
      .catch((error) =>
        this.closeAgent(orgId, agentId, error instanceof AhpStateCapacityError ? 'overloaded' : 'unavailable', owner)
      )
      .finally(() => {
        if (this.observationQueues.get(key) === queue) {
          queue.count--
          queue.bytes -= bytes
          if (!queue.count) this.observationQueues.delete(key)
        }
      })
  }
  dispose(): void {
    for (const [key, attachment] of this.attachments) this.remove(key, attachment, 'unavailable')
    this.agents.clear()
    this.blocked.clear()
    this.observationQueues.clear()
  }
  private agent(auth: Pick<AhpAttachmentAuthorization, 'orgId' | 'agentId'>): Promise<AhpAgentState> {
    const key = `${auth.orgId}\0${auth.agentId}`
    let state = this.agents.get(key)
    if (!state) {
      state = AhpActionJournal.create({
        reserve: (size) => this.options.reserveSequence(auth.orgId, auth.agentId, size)
      }).then(
        (journal) =>
          new AhpAgentState(
            this.options.provider(auth.agentId),
            journal,
            this.options.now,
            this.options.checkpoints?.(auth.orgId, auth.agentId)
          )
      )
      this.agents.set(key, state)
      void state.catch(() => {
        if (this.agents.get(key) === state) this.closeAgent(auth.orgId, auth.agentId, 'unavailable', state)
      })
    }
    return state
  }
  private authorized(auth: AhpAttachmentAuthorization): boolean {
    return this.options.enabled() && this.options.available(auth) && auth.grant.expiresAtMs > this.options.now()
  }
  private expire(key: string, attachment: Attachment): void {
    clearTimeout(attachment.timer)
    attachment.timer = setTimeout(
      () => this.remove(key, attachment, 'unauthorized'),
      Math.max(0, attachment.authorization.grant.expiresAtMs - this.options.now())
    )
    attachment.timer.unref()
  }
  private remove(key: string, attachment: Attachment, reason?: RdAhpClose['reason']): void {
    if (this.attachments.get(key) !== attachment) return
    this.attachments.delete(key)
    clearTimeout(attachment.timer)
    attachment.connection?.dispose()
    if (attachment.state)
      void attachment.state.serialized(async () => {
        for (const uri of attachment.bindings.keys()) attachment.state!.release(uri)
        attachment.bindings.clear()
      })
    if (reason) attachment.close(reason)
  }
  private closeAgent(
    orgId: string,
    agentId: string,
    reason: RdAhpClose['reason'] = 'unavailable',
    owner?: Promise<AhpAgentState>
  ): void {
    const key = agentKey(orgId, agentId)
    if (owner && this.agents.get(key) !== owner) return
    this.blocked.add(key)
    this.agents.delete(key)
    this.observationQueues.delete(key)
    for (const [key, attachment] of this.attachments)
      if (attachment.authorization.orgId === orgId && attachment.authorization.agentId === agentId)
        this.remove(key, attachment, reason)
  }
}
function registryResult<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (result.ok) return result as Extract<T, { ok: true }>
  const reason = (result as { reason?: string }).reason
  if (reason === 'forbidden') throw denied()
  if (reason === 'collision')
    throw new AhpProtocolError(AhpErrorCodes.SessionAlreadyExists, 'Session URI already exists')
  if (reason === 'not_found') throw new AhpProtocolError(AhpErrorCodes.NotFound, 'Session unavailable')
  throw new Error('AHP registry unavailable')
}
function denied(): AhpProtocolError {
  return new AhpProtocolError(AhpErrorCodes.PermissionDenied, 'Session access denied')
}
export function chatChannel(sessionUri: string): string {
  return `ahp-chat:${sessionUri.slice('ahp-session:'.length)}/main`
}
function sessionChannel(channel: string): string {
  const uri =
    channel.startsWith('ahp-chat:/') && channel.endsWith('/main')
      ? `ahp-session:${channel.slice('ahp-chat:'.length, -'/main'.length)}`
      : channel
  if (!AhpSessionUri.safeParse(uri).success) throw new AhpProtocolError(AhpErrorCodes.NotFound, 'Channel unavailable')
  return uri
}
function attachmentKey(connectionId: string, attachmentId: string): string {
  return `${connectionId}\0${attachmentId}`
}
function samePrincipal(a: AhpAttachmentAuthorization, b: AhpAttachmentAuthorization): boolean {
  return (
    a.orgId === b.orgId &&
    a.agentId === b.agentId &&
    a.userId === b.userId &&
    a.conversationId === b.conversationId &&
    a.targetSessionId === b.targetSessionId &&
    a.callerRole === b.callerRole &&
    a.callerApproves === b.callerApproves
  )
}

function agentKey(orgId: string, agentId: string): string {
  return `${orgId}\0${agentId}`
}
