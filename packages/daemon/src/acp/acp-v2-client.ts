import * as V2 from '@agentclientprotocol/sdk/experimental/v2/unstable'
import type * as V1 from '@agentclientprotocol/sdk/unstable'
import type { AcpClient, AcpClientHandlers, SessionStart } from './acp-client.js'
import { V2SessionUpdates, configOptionsFromV2, permissionFromV2 } from './acp-v2-updates.js'
import { sessionFailureFromMeta } from './session-failure.js'
import { DAEMON_VERSION } from '../version.js'

interface PendingTurn {
  started: boolean
  resolve(response: V1.PromptResponse): void
  reject(error: unknown): void
}

// Codex v2 acknowledges insertion separately from foreground completion.
export function createV2Client(stream: V2.Stream, handlers: AcpClientHandlers): AcpClient {
  const pending = new Map<string, PendingTurn>()
  const sessions = new Map<string, V2SessionUpdates>()
  const booleans = new Map<string, Set<string>>()
  let nativeSystemPrompt = false
  const configs = (sessionId: string, options: V2.SessionConfigOption[] | null | undefined) => {
    if (options)
      booleans.set(sessionId, new Set(options.filter(V2.SessionConfigOption.isBoolean).map((o) => o.configId)))
    return options ? configOptionsFromV2(options) : undefined
  }
  const session = (id: string) => {
    let state = sessions.get(id)
    if (!state) sessions.set(id, (state = new V2SessionUpdates()))
    return state
  }
  const conn = V2.client({ name: 'agentconnect' })
    .onNotification('session/update', ({ params: { sessionId, update } }) => {
      if (V2.SessionUpdate.isStateUpdate(update)) {
        const turn = pending.get(sessionId)
        if (!turn) return
        if (update.state === 'running' || update.state === 'requires_action') turn.started = true
        if (V2.StateUpdate.isIdle(update) && turn.started) {
          turn.started = false
          const stopReason = update.stopReason ?? 'end_turn'
          for (const normalized of sessions.get(sessionId)?.finish() ?? []) handlers.update(sessionId, normalized)
          const failure = sessionFailureFromMeta(update._meta)
          if (failure) turn.reject(failure)
          else if (V2.IdleStateUpdate.isError(update)) {
            const error = update.error
            turn.reject(
              new V2.RequestError(error?.code ?? -32603, error?.message ?? 'Runtime turn failed', error?.data)
            )
          } else if (['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(stopReason)) {
            turn.resolve({ stopReason: stopReason as V1.StopReason, usage: update.usage, _meta: update._meta })
          } else turn.reject(new Error(`Unsupported ACP stop reason: ${stopReason}`))
        }
        return
      }
      if (V2.SessionUpdate.isConfigOptionUpdate(update)) {
        handlers.update(sessionId, { ...update, configOptions: configs(sessionId, update.configOptions)! })
        return
      }
      for (const normalized of session(sessionId).update(update)) handlers.update(sessionId, normalized)
    })
    .onRequest('session/request_permission', ({ params }) => handlers.permission(permissionFromV2(params)))
    .onRequest(
      'elicitation/create',
      async ({ params }) =>
        (await handlers.elicit(params as V1.CreateElicitationRequest)) as V2.CreateElicitationResponse
    )
    .onNotification('elicitation/complete', ({ params }) => handlers.elicitationComplete(params.elicitationId))
    .connect(stream)
  conn.signal.addEventListener(
    'abort',
    () => {
      for (const turn of pending.values()) turn.reject(conn.signal.reason ?? new Error('ACP connection closed'))
      pending.clear()
      sessions.clear()
      booleans.clear()
    },
    { once: true }
  )

  const startParams = ({ instructions, mcpServers, ...params }: SessionStart): V2.NewSessionRequest => ({
    ...params,
    mcpServers: mcpServers.map((server): V2.McpServer => {
      if ('type' in server) {
        if (server.type === 'sse') throw new Error('ACP v2 does not support SSE MCP servers')
        return server
      }
      return { ...server, type: 'stdio' }
    }),
    ...(nativeSystemPrompt && instructions
      ? {
          systemPrompt: { mode: 'append', content: [{ type: 'text', text: instructions }] }
        }
      : {})
  })

  return {
    get nativeSystemPrompt() {
      return nativeSystemPrompt
    },
    async initialize(params) {
      const caps = params.clientCapabilities
      const init = await conn.agent.request('initialize', {
        protocolVersion: 2,
        info: { name: 'agentconnect', version: DAEMON_VERSION },
        capabilities: {
          _meta: caps?._meta,
          elicitation: caps?.elicitation,
          ...(caps?.auth?.terminal ? { auth: { terminal: {} } } : {})
        }
      })
      if (init.protocolVersion !== 2)
        throw new Error(`Codex requires ACP v2; adapter negotiated ${init.protocolVersion}`)
      const capsV2 = init.capabilities?.session
      nativeSystemPrompt = capsV2?.systemPrompt != null
      return {
        protocolVersion: init.protocolVersion,
        agentInfo: init.info,
        _meta: init._meta,
        authMethods: init.authMethods?.flatMap((method): V1.AuthMethod[] => {
          if (!V2.AuthMethod.isAgent(method) && !V2.AuthMethod.isTerminal(method)) return []
          const { methodId, ...fields } = method
          return [{ ...fields, id: methodId }]
        }),
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {
            close: {},
            delete: capsV2?.delete,
            additionalDirectories: capsV2?.additionalDirectories
          },
          promptCapabilities: {
            image: capsV2?.prompt?.image != null,
            audio: capsV2?.prompt?.audio != null,
            embeddedContext: capsV2?.prompt?.embeddedContext != null
          },
          mcpCapabilities: { http: capsV2?.mcp?.http != null, sse: false }
        }
      }
    },
    async newSession(params) {
      const res = await conn.agent.request('session/new', startParams(params))
      return { ...res, configOptions: configs(res.sessionId, res.configOptions) }
    },
    async loadSession({ sessionId, ...params }) {
      sessions.delete(sessionId)
      const res = await conn.agent.request('session/resume', {
        // Codex resumes retain the host's existing inline standing-context refresh.
        ...startParams(params),
        sessionId,
        replayFrom: { type: 'start' }
      })
      sessions.delete(sessionId)
      return { ...res, configOptions: configs(sessionId, res.configOptions) }
    },
    async setConfig(params) {
      const selection: V2.SetSessionConfigOptionRequest = booleans.get(params.sessionId)?.has(params.configId)
        ? {
            type: 'boolean',
            value: params.value === 'on' || params.value === true,
            sessionId: params.sessionId,
            configId: params.configId
          }
        : { type: 'id', value: String(params.value), sessionId: params.sessionId, configId: params.configId }
      const res = await conn.agent.request('session/set_config_option', selection)
      return { ...res, configOptions: configs(params.sessionId, res.configOptions)! }
    },
    authenticate: (methodId) => conn.agent.request('auth/login', { methodId }),
    async prompt(params) {
      if (pending.has(params.sessionId)) throw new Error('A prompt is already running in this session')
      if (conn.signal.aborted) throw new Error('ACP connection closed')
      let turn!: PendingTurn
      const completion = new Promise<V1.PromptResponse>((resolve, reject) => {
        turn = { started: false, resolve, reject }
      })
      pending.set(params.sessionId, turn)
      try {
        const [, result] = await Promise.all([conn.agent.request('session/prompt', params), completion])
        return result
      } finally {
        if (pending.get(params.sessionId) === turn) {
          pending.delete(params.sessionId)
          sessions.delete(params.sessionId)
        }
      }
    },
    cancel: (sessionId) => conn.agent.notify('session/cancel', { sessionId }),
    extension: (method, params) => conn.agent.request(method, params),
    closeSession: (sessionId) => conn.agent.request('session/close', { sessionId }),
    deleteSession: (sessionId) => conn.agent.request('session/delete', { sessionId }),
    forgetSession(sessionId) {
      pending.get(sessionId)?.reject(new Error('ACP session released'))
      pending.delete(sessionId)
      sessions.delete(sessionId)
      booleans.delete(sessionId)
    }
  }
}
