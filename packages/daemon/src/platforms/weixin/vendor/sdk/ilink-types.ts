/** 对外类型别名与枚举再导出 */
import type { NormalizedChatEvent } from './protocol/chat-event.js'

export type IlinkBotMessage = NormalizedChatEvent
export type OnTextListener = (message: IlinkBotMessage, match: RegExpExecArray) => void | Promise<void>

export type { InboundWirePacket as IlinkRawMessage } from './protocol/wire-models.js'
export type { CredentialBlob as IlinkSession } from './protocol/chat-event.js'
export type { LoginTicket as LoginSession } from './protocol/chat-event.js'
export type { LoginOutcome as LoginResult } from './protocol/chat-event.js'
export type { NormalizedFacet as IlinkBotMessageType } from './protocol/chat-event.js'
export type {
  MediaPhoto as IlinkPhoto,
  MediaVideo as IlinkVideo,
  MediaDocument as IlinkDocument,
  MediaVoice as IlinkVoice,
  NormalizedMedia as IlinkMessageMedia
} from './protocol/chat-event.js'
export type {
  InputFile,
  SendCommonOptions,
  SendMediaOptions,
  SendTypingOptions,
  PollingOptions,
  DownloadMediaResult,
  DownloadMediaOptions,
  WaitForLoginOptions,
  SessionStore,
  ChatHandle as IlinkChat,
  PeerHandle as IlinkUser
} from './protocol/chat-event.js'

export type { WireChannelFingerprint as BaseInfo } from './protocol/wire-models.js'
export type {
  WireTextFacet as TextItem,
  WireCdnLocator as CDNMedia,
  WireImageSection as ImageItem,
  WireVoiceSection as VoiceItem,
  WireFileSection as FileItem,
  WireVideoSection as VideoItem,
  WireRefEnvelope as RefMessage,
  WireCompositeItem as MessageItem
} from './protocol/wire-models.js'

export { ItemKind as MessageItemType } from './protocol/wire-models.js'
export { AuthorKind as MessageType } from './protocol/wire-models.js'
export { OutboxPhase as MessageState } from './protocol/wire-models.js'
export { TypingPhase as TypingStatus } from './protocol/wire-models.js'
export { UploadKind as UploadMediaType } from './protocol/wire-models.js'

export { GatewayFault, MissingReplyLaneFault, StaleCredentialFault } from './internal/errors.js'
export type { ClearSessionOptions, IlinkBotOptions } from './ilink-options.js'
export type { ClawbotContextTokenStore } from '../context-token-store.js'
