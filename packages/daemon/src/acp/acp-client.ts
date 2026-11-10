import { client, type Stream } from '@agentclientprotocol/sdk/unstable'
import type * as V1 from '@agentclientprotocol/sdk/unstable'

// The daemon consumes one event contract; protocol-specific lifecycle semantics end here.
export interface AcpClientHandlers {
  update(sessionId: string, update: V1.SessionUpdate): void
  permission(params: V1.RequestPermissionRequest): Promise<V1.RequestPermissionResponse>
  elicit(params: V1.CreateElicitationRequest): Promise<V1.CreateElicitationResponse>
  elicitationComplete(id: string): void
  sdkLifecycle(sessionId: string, message: unknown): void
}

export type SessionStart = V1.NewSessionRequest & { instructions?: string }
export type SessionResume = Omit<SessionStart, 'instructions'> & { sessionId: string }

export interface AcpClient {
  readonly nativeSystemPrompt: boolean
  initialize(params: V1.InitializeRequest): Promise<V1.InitializeResponse>
  newSession(params: SessionStart): Promise<V1.NewSessionResponse>
  loadSession(params: SessionResume): Promise<V1.LoadSessionResponse>
  setConfig(params: V1.SetSessionConfigOptionRequest): Promise<V1.SetSessionConfigOptionResponse>
  authenticate(methodId: string): Promise<unknown>
  prompt(params: V1.PromptRequest): Promise<V1.PromptResponse>
  cancel(sessionId: string): Promise<void>
  extension(method: `_${string}`, params: Record<string, unknown>): Promise<unknown>
  closeSession(sessionId: string): Promise<unknown>
  deleteSession(sessionId: string): Promise<unknown>
  forgetSession(sessionId: string): void
}

export function createV1Client(stream: Stream, handlers: AcpClientHandlers): AcpClient {
  const conn = client({ name: 'agentconnect' })
    .onNotification('session/update', ({ params }) => handlers.update(params.sessionId, params.update))
    .onRequest('session/request_permission', ({ params }) => handlers.permission(params))
    .onRequest('elicitation/create', ({ params }) => handlers.elicit(params))
    .onNotification('elicitation/complete', ({ params }) => handlers.elicitationComplete(params.elicitationId))
    .onNotification(
      '_claude/sdkMessage',
      { parse: (p: unknown) => p as { sessionId?: string; message?: unknown } },
      ({ params }) => {
        if (params.sessionId) handlers.sdkLifecycle(params.sessionId, params.message)
      }
    )
    .connect(stream)
  return {
    nativeSystemPrompt: false,
    initialize: (params) => conn.agent.request('initialize', params),
    newSession: ({ instructions: _, ...params }) => conn.agent.request('session/new', params),
    loadSession: (params) => conn.agent.request('session/load', params),
    setConfig: (params) => conn.agent.request('session/set_config_option', params),
    authenticate: (methodId) => conn.agent.request('authenticate', { methodId }),
    prompt: (params) => conn.agent.request('session/prompt', params),
    cancel: (sessionId) => conn.agent.notify('session/cancel', { sessionId }),
    extension: (method, params) => conn.agent.request(method, params),
    closeSession: (sessionId) => conn.agent.request('session/close', { sessionId }),
    deleteSession: (sessionId) => conn.agent.request('session/delete', { sessionId }),
    forgetSession: () => {}
  }
}
