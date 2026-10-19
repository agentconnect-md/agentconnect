// Compatibility exports for the legacy service; execution owns reply accumulation.
export {
  emitChatUpdate as emitWebchatUpdate,
  flushHeldChatText as flushHeldWebchatText,
  closeChatSegmentForImage as closeWebchatSegmentForImage,
  commitSegmentOnce,
  appendChatTextRow as appendWebchatTextRow
} from '../session/chat-output.js'
export type { ChatTurnOutput as WebchatTurnOutput } from '../session/chat-turn.js'
