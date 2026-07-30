import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import { feishuEventToMessageLike, normalizeFeishuMessage, type FeishuRawEvent } from '@agentconnect.md/message'
import {
  WireFeishuCardActionEvent,
  type WireFeishuCardActionResponse,
  type WireNormalizedMessage
} from '@agentconnect.md/protocol'

const MAX_SEEN_EVENTS = 10_000
const SIGNATURE_WINDOW_MS = 5 * 60_000

type UnknownRecord = Record<string, unknown>

export interface FeishuCallbackHeaders {
  timestamp?: string
  nonce?: string
  signature?: string
}

export type VerifiedFeishuCallback =
  | { kind: 'challenge'; challenge: string }
  | {
      kind: 'event'
      eventId?: string
      eventType?: string
      event?: UnknownRecord
    }

export interface FeishuHttpIngestDeps {
  onMessage: (message: WireNormalizedMessage) => Promise<void>
  onCardAction: (
    action: WireFeishuCardActionEvent,
    eventId: string | undefined
  ) => Promise<WireFeishuCardActionResponse | undefined>
  now: () => number
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : undefined
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function decryptBody(encryptKey: string, encrypted: string): UnknownRecord | undefined {
  try {
    const key = createHash('sha256').update(encryptKey).digest()
    const bytes = Buffer.from(encrypted, 'base64')
    if (bytes.byteLength <= 16) return undefined
    const decipher = createDecipheriv('aes-256-cbc', key, bytes.subarray(0, 16))
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8')
    return asRecord(JSON.parse(plaintext))
  } catch {
    return undefined
  }
}

function signatureIsValid(encryptKey: string, rawBody: Buffer, headers: FeishuCallbackHeaders, now: number): boolean {
  const { timestamp, nonce, signature } = headers
  if (!timestamp || !nonce || !signature || !/^\d+$/.test(timestamp)) return false
  const timestampMs = Number(timestamp) * 1000
  if (!Number.isSafeInteger(timestampMs) || Math.abs(now - timestampMs) > SIGNATURE_WINDOW_MS) return false
  const expected = createHash('sha256').update(timestamp).update(nonce).update(encryptKey).update(rawBody).digest('hex')
  return safeEqual(expected, signature.toLowerCase())
}

function callbackAppId(body: UnknownRecord): string | undefined {
  const header = asRecord(body.header)
  const value = header?.app_id ?? body.app_id
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function feishuCallbackAppId(body: unknown): string | undefined {
  const record = asRecord(body)
  return record ? callbackAppId(record) : undefined
}

/**
 * One Feishu HTTP bot's callback verifier/normalizer. It holds no app secret and
 * performs no provider API calls; ordinary sends and attachment downloads remain
 * on the daemon's send-only Feishu connection.
 */
export class FeishuHttpIngest {
  private readonly seenEvents = new Set<string>()

  constructor(
    readonly botId: string,
    readonly appId: string,
    private readonly secrets: { verificationToken: string; encryptKey?: string },
    private readonly deps: FeishuHttpIngestDeps
  ) {}

  decode(rawBody: Buffer, outerBody: unknown, headers: FeishuCallbackHeaders): VerifiedFeishuCallback | null {
    const outer = asRecord(outerBody)
    if (!outer) return null

    const encrypted = typeof outer.encrypt === 'string' ? outer.encrypt : undefined
    const body = encrypted
      ? this.secrets.encryptKey
        ? decryptBody(this.secrets.encryptKey, encrypted)
        : undefined
      : outer
    if (!body) return null

    const header = asRecord(body.header)
    const token = header?.token ?? body.token
    if (typeof token !== 'string' || !safeEqual(token, this.secrets.verificationToken)) return null
    const appId = callbackAppId(body)
    if (appId && appId !== this.appId) return null

    if (body.type === 'url_verification') {
      return { kind: 'challenge', challenge: typeof body.challenge === 'string' ? body.challenge : '' }
    }
    if (this.secrets.encryptKey && !signatureIsValid(this.secrets.encryptKey, rawBody, headers, this.deps.now())) {
      return null
    }
    const eventType =
      typeof header?.event_type === 'string'
        ? header.event_type
        : typeof asRecord(body.event)?.type === 'string'
          ? (asRecord(body.event)!.type as string)
          : undefined
    const eventId =
      typeof header?.event_id === 'string' ? header.event_id : typeof body.uuid === 'string' ? body.uuid : undefined
    return {
      kind: 'event',
      ...(eventId ? { eventId } : {}),
      ...(eventType ? { eventType } : {}),
      ...(asRecord(body.event) ? { event: body.event as UnknownRecord } : {})
    }
  }

  /** True when the platform event was already accepted by this relay process. */
  seen(eventId: string | undefined): boolean {
    if (!eventId) return false
    if (this.seenEvents.has(eventId)) return true
    if (this.seenEvents.size >= MAX_SEEN_EVENTS) this.seenEvents.clear()
    this.seenEvents.add(eventId)
    return false
  }

  async handle(
    callback: Extract<VerifiedFeishuCallback, { kind: 'event' }>
  ): Promise<WireFeishuCardActionResponse | undefined> {
    if (!callback.event) return undefined
    if (callback.eventType === 'card.action.trigger') {
      const parsed = WireFeishuCardActionEvent.safeParse(callback.event)
      return parsed.success ? this.deps.onCardAction(parsed.data, callback.eventId) : undefined
    }
    if (callback.eventType !== 'im.message.receive_v1') return undefined
    const like = feishuEventToMessageLike(callback.event as FeishuRawEvent)
    if (!like.messageId || !like.chatId || !like.senderOpenId) return
    await this.deps.onMessage(
      normalizeFeishuMessage(like, {
        traceId: callback.eventId ? `feishu:${callback.eventId}` : `feishu:${like.chatId}:${like.messageId}`
      })
    )
    return undefined
  }
}
