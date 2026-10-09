import { ItemKind } from './wire-models.js'
import type { InboundWirePacket } from './wire-models.js'
import type { NormalizedChatEvent } from './chat-event.js'

/** 将线级 JSON 包映射为内部语义事件 */
export function mapInboundWirePacket(packet: InboundWirePacket): NormalizedChatEvent {
  const parts = packet.item_list ?? []
  const textPart = parts.find((p) => p.type === ItemKind.Text && p.text_item?.text)
  const imagePart = parts.find(
    (p) => p.type === ItemKind.Image && (p.image_item?.media?.encrypt_query_param || p.image_item?.media?.full_url)
  )
  const videoPart = parts.find(
    (p) => p.type === ItemKind.Video && (p.video_item?.media?.encrypt_query_param || p.video_item?.media?.full_url)
  )
  const filePart = parts.find(
    (p) => p.type === ItemKind.File && (p.file_item?.media?.encrypt_query_param || p.file_item?.media?.full_url)
  )
  const voicePart = parts.find(
    (p) => p.type === ItemKind.Voice && (p.voice_item?.media?.encrypt_query_param || p.voice_item?.media?.full_url)
  )

  const literal = textPart?.text_item?.text ?? voicePart?.voice_item?.text
  let facet: NormalizedChatEvent['type'] = 'unknown'
  let media: NormalizedChatEvent['media']
  let caption: string | undefined

  if (imagePart?.image_item?.media) {
    facet = 'photo'
    caption = textPart?.text_item?.text
    media = {
      kind: 'photo',
      fileId: imagePart.image_item.media.encrypt_query_param,
      downloadUrl: imagePart.image_item.media.full_url,
      aesKey: imagePart.image_item.media.aes_key,
      item: imagePart.image_item
    }
  } else if (videoPart?.video_item?.media) {
    facet = 'video'
    caption = textPart?.text_item?.text
    media = {
      kind: 'video',
      fileId: videoPart.video_item.media.encrypt_query_param,
      downloadUrl: videoPart.video_item.media.full_url,
      aesKey: videoPart.video_item.media.aes_key,
      item: videoPart.video_item
    }
  } else if (filePart?.file_item?.media) {
    facet = 'document'
    caption = textPart?.text_item?.text
    media = {
      kind: 'document',
      fileId: filePart.file_item.media.encrypt_query_param,
      downloadUrl: filePart.file_item.media.full_url,
      aesKey: filePart.file_item.media.aes_key,
      fileName: filePart.file_item.file_name,
      item: filePart.file_item
    }
  } else if (voicePart?.voice_item?.media) {
    facet = 'voice'
    media = {
      kind: 'voice',
      fileId: voicePart.voice_item.media.encrypt_query_param,
      downloadUrl: voicePart.voice_item.media.full_url,
      aesKey: voicePart.voice_item.media.aes_key,
      transcript: voicePart.voice_item.text,
      item: voicePart.voice_item
    }
  } else if (literal) {
    facet = 'text'
  }

  const peer = packet.from_user_id ?? ''
  const groupId = packet.group_id?.trim()
  return {
    id: packet.message_id ?? packet.client_id,
    seq: packet.seq,
    type: facet,
    chat: groupId ? { id: groupId, type: 'group' } : { id: peer, type: 'private' },
    from: { id: peer },
    date: packet.create_time_ms,
    text: literal,
    caption,
    contextToken: packet.context_token,
    media,
    raw: packet
  }
}
