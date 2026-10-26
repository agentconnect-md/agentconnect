import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  ActionType,
  AhpErrorCodes,
  JsonRpcErrorCodes,
  PendingMessageKind,
  type ActionOrigin,
  type ChatTurnStartedAction,
  type ChatPendingMessageSetAction,
  type ChatInputCompletedAction,
  type DispatchActionParams
} from '@microsoft/agent-host-protocol'
import type { ChatCallerRole } from '@agentconnect.md/protocol'
import type {
  ChatAuthor,
  ChatSessionApplication,
  PreparedChatTurn,
  ChatTurnRequest
} from '../session/chat-application.js'
import type { ChatSessionContinuation } from '../session/chat-continuation.js'
import type { ChatTurnContext, ChatDispatchOptions, ChatRuntimeSettings } from '../session/chat-turn.js'
import { decodeChatAttachments } from '../session/chat-attachments.js'
import { AhpProtocolError } from './connection.js'
import {
  startAction,
  steeringAction,
  publishedMessage,
  cancelAction,
  permissionAction,
  inputAction,
  configAction,
  contextMetadata,
  messageAttachments
} from './action-schema.js'
export { ahpElicitValue } from './action-schema.js'

export interface AhpActionScope {
  agentId: string
  conversationId: string
  sessionId: string
  sessionUri: string
  targetSessionId?: string
  author: ChatAuthor
  callerRole: ChatCallerRole
  callerApproves: boolean
  apiOrigin?: true
}
export type AhpRuntimeChange = {
  [K in keyof Omit<ChatRuntimeSettings, 'runtime'>]-?: { key: K; value: NonNullable<ChatRuntimeSettings[K]> }
}[keyof Omit<ChatRuntimeSettings, 'runtime'>]
export interface AhpApplicationHost {
  application: ChatSessionApplication
  continuation: ChatSessionContinuation
  now(): number
  admit?(scope: AhpActionScope, text: string, turnId: string): Promise<boolean>
  dispatch(turn: PreparedChatTurn, context: ChatTurnContext, options: ChatDispatchOptions): Promise<string | null>
  cancel(scope: AhpActionScope, turnId: string): Promise<boolean>
  permission(
    scope: AhpActionScope,
    request: { turnId: string; requestId: string; allow: boolean; selectedOptionId?: string }
  ): Promise<boolean>
  elicit(scope: AhpActionScope, action: ChatInputCompletedAction): Promise<boolean>
  setRuntime(scope: AhpActionScope, change: AhpRuntimeChange): Promise<boolean>
  onExecutionError(error: unknown): void
}
export interface AhpActionHooks {
  authorized(): boolean
  canStart(turnId: string): boolean
  context(turnId: string): ChatTurnContext
  admitted(
    action: ChatTurnStartedAction,
    origin: ActionOrigin | undefined,
    result: { duplicate: boolean }
  ): Promise<void>
  steered?(
    action: ChatPendingMessageSetAction,
    origin: ActionOrigin | undefined,
    result: { duplicate: boolean }
  ): Promise<void>
  echo(action: DispatchActionParams['action'], origin: ActionOrigin | undefined): Promise<void>
}
export function ahpTurnReceipt(scope: Pick<AhpActionScope, 'agentId' | 'sessionId'>, turnId: string): string {
  return `ahp-turn:${createHash('sha256')
    .update(JSON.stringify([scope.agentId, scope.sessionId, turnId]))
    .digest('hex')}`
}

// This adapter owns no execution, transcript, pending approval, or durable delivery record.
export class AhpApplication {
  constructor(private readonly host: AhpApplicationHost) {}

  async dispatch(
    scope: AhpActionScope,
    params: DispatchActionParams,
    origin: ActionOrigin | undefined,
    hooks: AhpActionHooks
  ): Promise<void> {
    authorize(hooks)
    const target =
      params.action.type === ActionType.SessionConfigChanged
        ? scope.sessionUri
        : `ahp-chat:${scope.sessionUri.slice('ahp-session:'.length)}/main`
    if (params.channel !== target) refuse('Action does not address the bound channel')
    switch (params.action.type) {
      case ActionType.ChatTurnStarted:
        return this.send(scope, parse(startAction, params.action) as ChatTurnStartedAction, origin, hooks)
      case ActionType.ChatPendingMessageSet: {
        const action = parse(steeringAction, params.action) as ChatPendingMessageSetAction
        if (scope.targetSessionId || !hooks.steered) refuse('Steering is unavailable on this session')
        return this.send(
          scope,
          {
            type: ActionType.ChatTurnStarted,
            turnId: action.id,
            startedAt: new Date(this.host.now()).toISOString(),
            message: action.message,
            queuedMessageId: action.id
          },
          origin,
          hooks,
          action
        )
      }
      case ActionType.ChatTurnCancelled: {
        const action = parse(cancelAction, params.action)
        if (!(await this.host.cancel(scope, action.turnId))) refuse('The turn is no longer cancellable')
        await hooks.echo(action, origin)
        return
      }
      case ActionType.ChatToolCallConfirmed: {
        const action = parse(permissionAction, params.action)
        if (action.approved && !scope.callerApproves) refuse('This caller cannot approve tools')
        if (
          !(await this.host.permission(scope, {
            turnId: action.turnId,
            requestId: action.toolCallId,
            allow: action.approved,
            ...(action.selectedOptionId ? { selectedOptionId: action.selectedOptionId } : {})
          }))
        )
          refuse('The permission request is unavailable')
        await hooks.echo(action, origin)
        return
      }
      case ActionType.ChatInputCompleted: {
        const action = parse(inputAction, params.action) as ChatInputCompletedAction
        if (!(await this.host.elicit(scope, action)))
          refuse('The input request is unavailable or the answer is invalid')
        await hooks.echo(action, origin)
        return
      }
      case ActionType.SessionConfigChanged: {
        const action = parse(configAction, params.action)
        if (
          scope.targetSessionId ||
          scope.callerRole === 'participant' ||
          !this.host.application.canChangeRuntime(scope.agentId)
        )
          refuse('Runtime changes are unavailable on this session')
        const [key, value] = Object.entries(action.config)[0]!
        if (!(await this.host.setRuntime(scope, { key, value } as AhpRuntimeChange)))
          refuse('Runtime change was refused')
        await hooks.echo(action, origin)
        return
      }
      default:
        throw new AhpProtocolError(JsonRpcErrorCodes.InvalidParams, 'Unsupported client action')
    }
  }

  private async send(
    scope: AhpActionScope,
    action: ChatTurnStartedAction,
    origin: ActionOrigin | undefined,
    hooks: AhpActionHooks,
    steering?: ChatPendingMessageSetAction
  ): Promise<void> {
    const context = parse(contextMetadata, action.message._meta?.['agentconnect.md'] ?? {})
    let attachments
    try {
      attachments = decodeChatAttachments(
        action.turnId,
        messageAttachments(action.message as z.infer<typeof startAction>['message'], context)
      )
    } catch {
      throw new AhpProtocolError(JsonRpcErrorCodes.InvalidParams, 'Invalid message attachments')
    }
    if (!action.message.text.trim() && !attachments.length) refuse('Message is empty')
    if (scope.targetSessionId && (attachments.length || context.worktree || context.runtimeConfig))
      refuse('This continuation does not support attachment or workspace changes')
    if (steering && attachments.length) refuse('Steering does not support attachments')
    if (
      context.runtimeConfig &&
      (scope.callerRole === 'participant' || !this.host.application.canChangeRuntime(scope.agentId))
    )
      refuse('Runtime changes are unavailable')
    if (!steering && !hooks.canStart(action.turnId)) refuse('The session already has an active turn')
    if (scope.apiOrigin && (!this.host.admit || !(await this.host.admit(scope, action.message.text, action.turnId))))
      refuse('The agent did not admit this message')
    const request: ChatTurnRequest = {
      agentId: scope.agentId,
      conversationId: scope.conversationId,
      turnId: action.turnId,
      text: action.message.text,
      author: { ...scope.author, ...(context.timeZone ? { timeZone: context.timeZone } : {}) },
      ...(context.mentions ? { mentions: context.mentions } : {}),
      ...(attachments.length ? { attachments } : {}),
      post: { postId: action.turnId, at: this.host.now() },
      ...(steering ? { steer: true } : {})
    }
    const continuation = scope.targetSessionId
      ? await this.host.continuation.prepare({ ...request, targetSessionId: scope.targetSessionId })
      : undefined
    const prepared = continuation ?? (await this.host.application.prepareTurn(request))
    if (!prepared.accepted) refuse(prepared.detail ?? prepared.reason)
    const admission = this.host.application.checkAdmission(prepared.turn)
    if (!admission.accepted) refuse(admission.detail ?? admission.reason)
    authorize(hooks)
    if (!steering && !hooks.canStart(action.turnId)) refuse('The session already has an active turn')
    const turnContext = hooks.context(action.turnId)
    if (context.runtimeConfig) turnContext.runtime = context.runtimeConfig
    if (context.worktree !== undefined) turnContext.worktree = context.worktree
    let resolve!: () => void, reject!: (error: unknown) => void
    const admitted = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    let settled = false
    const options: ChatDispatchOptions = {
      requireDurable: true,
      receiptId: ahpTurnReceipt(scope, action.turnId),
      ...(steering ? { steerOnly: true } : { startOnly: true }),
      onAdmission: async (result) => {
        if (settled) return
        settled = true
        try {
          if (!result.accepted) refuse(result.reason ?? 'Message admission was refused')
          if (!hooks.authorized()) throw new Error('Authorization expired during admission')
          if (steering && (result.steered || result.duplicate)) {
            await hooks.steered!(steering, origin, { duplicate: result.duplicate === true })
          } else {
            if (!result.duplicate && !scope.targetSessionId)
              await this.host.application.recordAdmission(prepared.turn, { ...request, steer: false })
            if (steering) await hooks.echo({ ...steering, message: publishedMessage(steering.message) }, origin)
            await hooks.admitted(action, origin, { duplicate: result.duplicate === true })
            if (steering)
              await hooks.echo(
                { type: ActionType.ChatPendingMessageRemoved, kind: PendingMessageKind.Steering, id: steering.id },
                undefined
              )
          }
          resolve()
        } catch (error) {
          reject(error)
          throw error
        }
      }
    }
    const execution = continuation?.accepted
      ? this.host.continuation
          .dispatch(continuation.turn, turnContext, () => {}, options)
          .then((verdict) => {
            if (!verdict.accepted && !settled) {
              settled = true
              reject(new AhpProtocolError(AhpErrorCodes.PermissionDenied, verdict.detail ?? verdict.reason))
            }
            return null
          })
      : this.host.dispatch(prepared.turn, turnContext, options)
    void execution.then(
      () => {
        if (!settled) {
          settled = true
          reject(new Error('Execution ended without durable admission'))
        }
      },
      (error) => {
        if (!settled) {
          settled = true
          reject(error)
        } else this.host.onExecutionError(error)
      }
    )
    await admitted
  }
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new AhpProtocolError(JsonRpcErrorCodes.InvalidParams, 'Invalid action fields')
  return result.data
}
function refuse(message: string): never {
  throw new AhpProtocolError(AhpErrorCodes.PermissionDenied, message)
}
function authorize(hooks: AhpActionHooks): void {
  if (!hooks.authorized()) refuse('Session access expired')
}
