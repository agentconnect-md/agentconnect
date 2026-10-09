import type { StaleCredentialFault } from './internal/errors.js'
import type { CredentialBlob, NormalizedChatEvent, NormalizedFacet } from './protocol/chat-event.js'

export interface IlinkQrEvent {
  qrCodeUrl: string
  qrcode: string
  refreshed?: boolean
}

export interface IlinkListenerErrorEvent {
  event: string
  error: unknown
}

/** IlinkBot 与 OneBots 包装层共享的完整 typed 事件表。 */
export interface IlinkBotEvents {
  message: [event: NormalizedChatEvent]
  text: [event: NormalizedChatEvent]
  photo: [event: NormalizedChatEvent]
  video: [event: NormalizedChatEvent]
  document: [event: NormalizedChatEvent]
  voice: [event: NormalizedChatEvent]
  unknown: [event: NormalizedChatEvent]
  login: [session: CredentialBlob]
  polling_error: [error: unknown]
  credential_stale: [error: StaleCredentialFault]
  listener_error: [payload: IlinkListenerErrorEvent]
  qr: [payload: IlinkQrEvent]
  verification_code_required: []
  relogin_blocked: [payload: { message: string }]
  relogin_failed: [error: unknown]
  ready: []
}

export type IlinkInboundEventName = 'message' | NormalizedFacet
