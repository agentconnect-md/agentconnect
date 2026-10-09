/** iLink JSON 请求/响应中的线级结构 */

export interface WireChannelFingerprint {
  channel_version?: string
  bot_agent?: string
}

export const UploadKind = { Image: 1, Video: 2, File: 3, Voice: 4 } as const

export const AuthorKind = { None: 0, Human: 1, Bot: 2 } as const

export const ItemKind = {
  None: 0,
  Text: 1,
  Image: 2,
  Voice: 3,
  File: 4,
  Video: 5,
  ToolCallStart: 11,
  ToolCallResult: 12
} as const

export const OutboxPhase = { Draft: 0, Streaming: 1, Settled: 2 } as const

export const TypingPhase = { Active: 1, Idle: 2 } as const

export interface WireTextFacet {
  text?: string
}

export interface WireCdnLocator {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  /** 服务端直接下发的完整下载地址，优先于 encrypt_query_param。 */
  full_url?: string
}

export interface WireImageSection {
  media?: WireCdnLocator
  thumb_media?: WireCdnLocator
  aeskey?: string
  url?: string
  mid_size?: number
  thumb_size?: number
  thumb_height?: number
  thumb_width?: number
  hd_size?: number
}

export interface WireVoiceSection {
  media?: WireCdnLocator
  encode_type?: number
  bits_per_sample?: number
  sample_rate?: number
  playtime?: number
  text?: string
}

export interface WireFileSection {
  media?: WireCdnLocator
  file_name?: string
  md5?: string
  len?: string
}

export interface WireVideoSection {
  media?: WireCdnLocator
  video_size?: number
  play_length?: number
  video_md5?: string
  thumb_media?: WireCdnLocator
  thumb_size?: number
  thumb_height?: number
  thumb_width?: number
}

export interface WireRefEnvelope {
  message_item?: WireCompositeItem
  title?: string
}

export interface WireToolCallStart {
  tool_name?: string
  tool_call_id?: string
}

export interface WireToolCallResult {
  tool_name?: string
  tool_call_id?: string
  status?: string
}

export interface WireCompositeItem {
  type?: number
  create_time_ms?: number
  update_time_ms?: number
  is_completed?: boolean
  msg_id?: string
  ref_msg?: WireRefEnvelope
  text_item?: WireTextFacet
  image_item?: WireImageSection
  voice_item?: WireVoiceSection
  file_item?: WireFileSection
  video_item?: WireVideoSection
  tool_call_start_item?: WireToolCallStart
  tool_call_result_item?: WireToolCallResult
}

/** 单条下行消息根对象（原 JSON） */
export interface InboundWirePacket {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  update_time_ms?: number
  delete_time_ms?: number
  session_id?: string
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: WireCompositeItem[]
  context_token?: string
  run_id?: string
}

export interface PollWireBatch {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: InboundWirePacket[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface CdnSlotRequest {
  filekey?: string
  media_type?: number
  to_user_id?: string
  rawsize?: number
  rawfilemd5?: string
  filesize?: number
  thumb_rawsize?: number
  thumb_rawfilemd5?: string
  thumb_filesize?: number
  no_need_thumb?: boolean
  aeskey?: string
}

export interface CdnSlotGrant {
  ret?: number
  errcode?: number
  errmsg?: string
  upload_param?: string
  thumb_upload_param?: string
  /** 服务端直接下发的完整上传地址，优先于 upload_param。 */
  upload_full_url?: string
}

export interface OutboundWireEnvelope {
  msg?: InboundWirePacket
}

export interface TypingWireEnvelope {
  ilink_user_id?: string
  typing_ticket?: string
  status?: number
}

export interface TypingWireAck {
  ret?: number
  errcode?: number
  errmsg?: string
}

export interface ConfigWireAck {
  ret?: number
  errcode?: number
  errmsg?: string
  typing_ticket?: string
}

export interface QrBitmapReply {
  ret?: number
  errcode?: number
  errmsg?: string
  qrcode: string
  qrcode_img_content: string
}

export type QrLifecycle =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'

export interface QrPhaseReply {
  ret?: number
  errcode?: number
  errmsg?: string
  status: QrLifecycle
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}
