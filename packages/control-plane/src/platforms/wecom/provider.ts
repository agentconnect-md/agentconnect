// The WeCom provider: a smart bot's BotID and Secret, checked by one subscribe on its long connection; the daemon owns the socket.
import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import WebSocket from 'ws'
import { z } from 'zod'
import { WECOM_PLATFORM, type IntegrationWeComConfig } from '@agentconnect.md/protocol'
import { TENANTLESS_SENTINEL } from '../../persistence/ports.js'
import type { CpConfigRefusal, CpPlatformProvider, CpValidatedIdentity } from '../provider.js'

/** WeCom's public long-connection endpoint; privately deployed WeCom is out of scope. */
export const WECOM_LONG_CONNECTION_URL = 'wss://openws.work.weixin.qq.com'
export const WECOM_CHECK_TIMEOUT_MS = 10_000

// BotID's format is undocumented, so any non-blank token up to 128 characters is accepted.
export const WeComCreateCredentials = z.object({
  botId: z
    .string()
    .trim()
    .regex(/^\S{1,128}$/),
  secret: z.string().trim().min(1).max(512)
})
export type WeComCreateCredentials = z.infer<typeof WeComCreateCredentials>

/** The handlers a dial reports to; each fires at most once except `message`. */
export interface WeComSocketHandlers {
  open(): void
  message(text: string): void
  closed(): void
  error(): void
}

/** The narrow socket the check drives; `close` must end the connection at once. */
export interface WeComSocket {
  send(text: string): void
  close(): void
}

export type WeComDial = (url: string, handlers: WeComSocketHandlers) => WeComSocket

/** The production dial over `ws`; `terminate` drops the connection without waiting on a close handshake. */
export const dialWeCom: WeComDial = (url, handlers) => {
  const ws = new WebSocket(url, { handshakeTimeout: WECOM_CHECK_TIMEOUT_MS })
  ws.on('open', () => handlers.open())
  ws.on('message', (data: WebSocket.RawData) => handlers.message(rawText(data)))
  ws.on('close', () => handlers.closed())
  ws.on('error', () => handlers.error())
  return { send: (text) => ws.send(text), close: () => ws.terminate() }
}

function rawText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data as ArrayBuffer).toString('utf8')
}

/** The integration name a connect gives; v1 learns no organization name. */
export function weComPlaceholderName(botId: string): string {
  return `WeCom · ${botId}`
}

/** The check refuses with 400, 409 or 503 only, as the create route relays them. */
export type WeComValidation =
  { ok: true; identity: CpValidatedIdentity } | (CpConfigRefusal & { status: 400 | 409 | 503 })

// Global error codes WeCom documents as transient: system busy, call limit, and concurrency limit.
const TRANSIENT_ERRCODES = new Set([-1, 45009, 45033])
// "Invalid bot_id or secret" in WeCom's global error code table.
const INVALID_CREDENTIALS_ERRCODE = 853000
// "The bot has not enabled long-connection mode" in the same table.
const LONG_CONNECTION_DISABLED_ERRCODE = 846601

export interface WeComCheckOptions {
  dial?: WeComDial
  url?: string
  timeoutMs?: number
}

/** One `aibot_subscribe` with the pasted credentials; a success kicks any live connection of this bot, so only a new install may call it. */
export function verifyWeComBot(
  credentials: WeComCreateCredentials,
  options: WeComCheckOptions = {}
): Promise<WeComValidation> {
  const dial = options.dial ?? dialWeCom
  const reqId = `aibot_subscribe_${randomUUID()}`
  const frame = JSON.stringify({
    cmd: 'aibot_subscribe',
    headers: { req_id: reqId },
    body: { bot_id: credentials.botId, secret: credentials.secret }
  })
  return new Promise((resolve) => {
    let socket: WeComSocket | undefined
    let opened = false
    let sent = false
    let settled = false
    const closeSocket = () => {
      try {
        socket?.close()
      } catch {
        // Already closed.
      }
    }
    const finish = (result: WeComValidation) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      closeSocket()
      resolve(result)
    }
    const subscribe = () => {
      if (!socket || sent || settled) return
      sent = true
      try {
        socket.send(frame)
      } catch {
        finish(unavailable())
      }
    }
    const timer = setTimeout(() => finish(unavailable()), options.timeoutMs ?? WECOM_CHECK_TIMEOUT_MS)
    try {
      socket = dial(options.url ?? WECOM_LONG_CONNECTION_URL, {
        open: () => {
          opened = true
          subscribe()
        },
        message: (text) => {
          const answer = readSubscribeAnswer(text, reqId, credentials.botId)
          if (answer) finish(answer)
        },
        // A close or error before the answer settles nothing about the credentials.
        closed: () => finish(unavailable()),
        error: () => finish(unavailable())
      })
    } catch {
      finish(unavailable())
      return
    }
    if (settled) closeSocket()
    else if (opened) subscribe()
  })
}

/** The subscribe answer in a frame, or null for a frame that is not it. */
function readSubscribeAnswer(text: string, reqId: string, botId: string): WeComValidation | null {
  let frame: { cmd?: unknown; headers?: { req_id?: unknown }; errcode?: unknown }
  try {
    frame = JSON.parse(text) as typeof frame
  } catch {
    return null
  }
  if (!frame || typeof frame !== 'object' || frame.cmd !== undefined) return null
  // An answer echoes the req_id; one that drops it is still taken as ours, since nothing else was asked.
  const echoed = frame.headers?.req_id
  if (echoed !== undefined && echoed !== reqId) return null
  if (typeof frame.errcode !== 'number') return null
  if (frame.errcode === 0) return { ok: true, identity: { name: weComPlaceholderName(botId), externalAppId: botId } }
  if (TRANSIENT_ERRCODES.has(frame.errcode)) return unavailable()
  if (frame.errcode === LONG_CONNECTION_DISABLED_ERRCODE)
    return {
      ok: false,
      status: 400,
      code: 'WECOM_LONG_CONNECTION_DISABLED',
      message:
        'This WeCom smart bot does not use long-connection mode. Switch its API mode to long connection and connect again.'
    }
  if (frame.errcode === INVALID_CREDENTIALS_ERRCODE) return invalid()
  // Any other refusal is undocumented for subscribe, and still a definitive answer that these credentials do not connect.
  return invalid()
}

function invalid(): WeComValidation {
  return {
    ok: false,
    status: 400,
    code: 'WECOM_CREDENTIALS_INVALID',
    message: 'WeCom rejected the BotID or Secret. Copy them again from the smart bot settings in WeCom.'
  }
}

function unavailable(): WeComValidation {
  return {
    ok: false,
    status: 503,
    code: 'WECOM_CHECK_UNAVAILABLE',
    message: 'AgentConnect could not reach WeCom to check this bot. Try again in a moment.'
  }
}

const CONFLICT_MESSAGE = 'This WeCom bot is already installed. Reuse the existing bot.'

export interface WeComCpProviderDeps {
  /** The long-connection dial; tests pass a fake. */
  dial?: WeComDial
  /** The long-connection endpoint; defaults to WeCom's public one. */
  url?: string
  /** Whether a bot row already holds this BotID, read before the subscribe that would kick its connection. */
  isInstalled?: (botId: string) => Promise<boolean>
  /** The credential route, pre-bound by the composition root. */
  installRoutes?: FastifyPluginAsync[]
}

export function createWeComCpProvider(deps: WeComCpProviderDeps = {}): CpPlatformProvider<WeComCreateCredentials> {
  return {
    platformId: WECOM_PLATFORM,
    installRoutes: (scope) => (scope === 'org' ? (deps.installRoutes ?? []) : []),
    credentialBodySchema: WeComCreateCredentials,
    async validateConfig(credentials): Promise<WeComValidation> {
      // The create route fences duplicates only after this check, and a subscribe here would evict the installed bot's daemon.
      if (await deps.isInstalled?.(credentials.botId))
        return { ok: false, status: 409, code: 'WECOM_BOT_ALREADY_INSTALLED', message: CONFLICT_MESSAGE }
      return verifyWeComBot(credentials, {
        ...(deps.dial ? { dial: deps.dial } : {}),
        ...(deps.url ? { url: deps.url } : {})
      })
    },
    buildNewBotInstall: ({ credentials }) => ({
      bot: { externalAppId: credentials.botId },
      secrets: { botToken: credentials.secret, appToken: credentials.botId, signingSecret: null },
      // The subscribe names no organization, so the fence is one bot per BotID under the tenantless sentinel.
      externalIdentity: {
        externalAppId: credentials.botId,
        externalTenantId: TENANTLESS_SENTINEL,
        conflictMessage: CONFLICT_MESSAGE
      }
    }),
    projectBotIdentity: (input) =>
      input.externalAppId ? { externalAppId: input.externalAppId, externalTenantId: TENANTLESS_SENTINEL } : {},
    secretShape: {
      slots: { botToken: 'WeCom smart bot Secret', appToken: 'WeCom BotID (identifier, not a secret)' },
      httpAssignRequires: []
    },
    async projectIntegrationConfig(_integration, bot, _core, secrets): Promise<IntegrationWeComConfig> {
      return { botId: secrets.appToken ?? bot.externalAppId ?? '', secret: secrets.botToken }
    }
  }
}
