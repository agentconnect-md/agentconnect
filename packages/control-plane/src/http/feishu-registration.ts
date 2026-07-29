/**
 * Short-lived broker for Feishu/Lark's OAuth device registration flow.
 *
 * The official SDK owns the device-code polling. The browser receives only the
 * authorization deeplink plus an opaque registration id; App Secret stays in
 * this process just long enough for `onRegistered` to persist it through the
 * normal bot-secret path.
 *
 * These sessions are deliberately transient control operations. They are
 * bounded by the provider's expiry and disappear after a short terminal-state
 * retention window.
 */
import { randomUUID } from 'node:crypto'
import { registerApp } from '@larksuiteoapi/node-sdk'
import type { FeishuRegion } from '@agentconnect.md/protocol'

export const AGENTCONNECT_FEISHU_SCOPES = [
  'contact:contact.base:readonly',
  'contact:user.base:readonly',
  'im:chat:read',
  'im:chat.members:bot_access',
  'im:message',
  'im:message.group_at_msg:readonly',
  'im:message.p2p_msg:readonly',
  'im:message:send_as_bot',
  'im:resource'
] as const

export const AGENTCONNECT_FEISHU_EVENTS = ['im.message.receive_v1'] as const

export type FeishuRegisterApp = typeof registerApp
export type FeishuRegistrationFailure =
  'denied' | 'expired' | 'agent_unavailable' | 'invalid_credentials' | 'setup_failed'

export class FeishuRegistrationSetupError extends Error {
  constructor(readonly reason: Exclude<FeishuRegistrationFailure, 'denied' | 'expired'>) {
    super(reason)
    this.name = 'FeishuRegistrationSetupError'
  }
}

export interface RegisteredFeishuApp {
  appId: string
  appSecret: string
  region: FeishuRegion
}

export interface StartFeishuRegistration {
  orgId: string
  agentId: string
  fallbackRegion: FeishuRegion
  appName: string
  onRegistered(app: RegisteredFeishuApp): Promise<string>
}

export interface FeishuRegistrationSnapshot {
  id: string
  orgId: string
  agentId: string
  authorizationUrl: string
  expiresAt: Date
  status: 'pending' | 'completed' | 'failed'
  failureReason: FeishuRegistrationFailure | null
  integrationId: string | null
}

interface InternalSession extends FeishuRegistrationSnapshot {
  targetKey: string
  retainUntil: number
  ready: Promise<FeishuRegistrationSnapshot>
  resolveReady(snapshot: FeishuRegistrationSnapshot): void
  rejectReady(error: Error): void
  abort: AbortController
}

const DEFAULT_EXPIRES_MS = 10 * 60 * 1000
const TERMINAL_RETENTION_MS = 10 * 60 * 1000

function registrationErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function failureReason(error: unknown): FeishuRegistrationFailure {
  if (error instanceof FeishuRegistrationSetupError) return error.reason
  switch (registrationErrorCode(error)) {
    case 'access_denied':
      return 'denied'
    case 'expired_token':
    case 'abort':
      return 'expired'
    default:
      return 'setup_failed'
  }
}

function publicSnapshot(session: InternalSession): FeishuRegistrationSnapshot {
  return {
    id: session.id,
    orgId: session.orgId,
    agentId: session.agentId,
    authorizationUrl: session.authorizationUrl,
    expiresAt: session.expiresAt,
    status: session.status,
    failureReason: session.failureReason,
    integrationId: session.integrationId
  }
}

export class FeishuAppRegistrationService {
  private readonly sessions = new Map<string, InternalSession>()
  private readonly activeByTarget = new Map<string, string>()

  constructor(
    private readonly register: FeishuRegisterApp = registerApp,
    private readonly now: () => number = Date.now
  ) {}

  async start(input: StartFeishuRegistration): Promise<FeishuRegistrationSnapshot> {
    this.prune()
    const targetKey = `${input.orgId}:${input.agentId}`
    const activeId = this.activeByTarget.get(targetKey)
    const active = activeId ? this.sessions.get(activeId) : undefined
    if (active?.status === 'pending') return active.ready

    const id = randomUUID()
    let resolveReady!: (snapshot: FeishuRegistrationSnapshot) => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<FeishuRegistrationSnapshot>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const startedAt = this.now()
    const session: InternalSession = {
      id,
      orgId: input.orgId,
      agentId: input.agentId,
      targetKey,
      authorizationUrl: '',
      expiresAt: new Date(startedAt + DEFAULT_EXPIRES_MS),
      status: 'pending',
      failureReason: null,
      integrationId: null,
      retainUntil: startedAt + DEFAULT_EXPIRES_MS + TERMINAL_RETENTION_MS,
      ready,
      resolveReady,
      rejectReady,
      abort: new AbortController()
    }
    this.sessions.set(id, session)
    this.activeByTarget.set(targetKey, id)

    let registration: ReturnType<FeishuRegisterApp>
    try {
      registration = this.register({
        source: 'agentconnect',
        createOnly: true,
        signal: session.abort.signal,
        appPreset: {
          name: input.appName,
          desc: 'Connect this bot to an AgentConnect agent.'
        },
        addons: {
          // Keep the official PersonalAgent base and explicitly layer every
          // capability AgentConnect uses. In particular, the second contact
          // scope is what lets sessions show a participant name instead of ou_….
          preset: true,
          scopes: { tenant: [...AGENTCONNECT_FEISHU_SCOPES] },
          events: { items: { tenant: [...AGENTCONNECT_FEISHU_EVENTS] } }
        },
        onQRCodeReady: ({ url, expireIn }) => {
          session.authorizationUrl = url
          session.expiresAt = new Date(this.now() + expireIn * 1000)
          session.retainUntil = session.expiresAt.getTime() + TERMINAL_RETENTION_MS
          session.resolveReady(publicSnapshot(session))
        }
      })
    } catch {
      this.failBeforeReady(session)
      throw new Error('could not start Feishu app registration')
    }

    void registration.then(
      async (result) => {
        try {
          const integrationId = await input.onRegistered({
            appId: result.client_id,
            appSecret: result.client_secret,
            region: result.user_info?.tenant_brand ?? input.fallbackRegion
          })
          this.complete(session, integrationId)
        } catch (error) {
          this.fail(session, failureReason(error))
        }
      },
      (error) => {
        if (!session.authorizationUrl) session.rejectReady(new Error('could not start Feishu app registration'))
        this.fail(session, failureReason(error))
      }
    )

    return ready
  }

  get(id: string): FeishuRegistrationSnapshot | null {
    this.prune()
    const session = this.sessions.get(id)
    if (!session) return null
    if (session.status === 'pending' && session.authorizationUrl && session.expiresAt.getTime() <= this.now()) {
      session.abort.abort()
      this.fail(session, 'expired')
    }
    return publicSnapshot(session)
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (session.status === 'pending') session.abort.abort()
    }
    this.sessions.clear()
    this.activeByTarget.clear()
  }

  private complete(session: InternalSession, integrationId: string): void {
    if (session.status !== 'pending') return
    session.status = 'completed'
    session.integrationId = integrationId
    session.retainUntil = this.now() + TERMINAL_RETENTION_MS
    this.activeByTarget.delete(session.targetKey)
  }

  private fail(session: InternalSession, reason: FeishuRegistrationFailure): void {
    if (session.status !== 'pending') return
    session.status = 'failed'
    session.failureReason = reason
    session.retainUntil = this.now() + TERMINAL_RETENTION_MS
    this.activeByTarget.delete(session.targetKey)
  }

  private failBeforeReady(session: InternalSession): void {
    this.sessions.delete(session.id)
    this.activeByTarget.delete(session.targetKey)
  }

  private prune(): void {
    const now = this.now()
    for (const [id, session] of this.sessions) {
      if (session.retainUntil > now) continue
      if (session.status === 'pending') session.abort.abort()
      this.sessions.delete(id)
      if (this.activeByTarget.get(session.targetKey) === id) this.activeByTarget.delete(session.targetKey)
    }
  }
}
