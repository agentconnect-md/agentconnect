// Synthetic iLink messages in the shape the 2026-10-24 probe observed; every id, token and key is a placeholder.
import type { WeChatInboundMessage } from '../../src/wechat-message.js'

export const BOT = '0123456789abcdef0123456789abcdef@im.bot'
export const USER = 'o9cq800000example0000000000000@im.wechat'
// Above 2^53, as every observed message id was.
export const BIG_ID = '7254917391048562001'
export const CONTEXT_TOKEN = 'context-token-placeholder'

const common = {
  seq: 3,
  message_id: BIG_ID,
  from_user_id: USER,
  to_user_id: BOT,
  client_id: '',
  create_time_ms: 1761292800000,
  session_id: '',
  group_id: '',
  message_type: 1,
  message_state: 2,
  context_token: CONTEXT_TOKEN,
  // Observed on every message, undocumented, and ignored.
  root_id: '7254917391048562000',
  parent_id: '0'
} satisfies WeChatInboundMessage & Record<string, unknown>

export const text: WeChatInboundMessage = { ...common, item_list: [{ type: 1, text_item: { text: 'hello there' } }] }

export const voice: WeChatInboundMessage = {
  ...common,
  item_list: [
    { type: 3, voice_item: { media: { encrypt_query_param: 'voice-ref', aes_key: 'a2V5' }, text: '今天天气怎么样' } }
  ]
}

export const image: WeChatInboundMessage = {
  ...common,
  item_list: [
    {
      type: 2,
      image_item: {
        media: { encrypt_query_param: 'image-ref', aes_key: 'aW1hZ2Uta2V5' },
        aeskey: '00112233445566778899aabbccddeeff'
      }
    }
  ]
}

export const fileWithCaption: WeChatInboundMessage = {
  ...common,
  item_list: [
    { type: 1, text_item: { text: 'please read this' } },
    {
      type: 4,
      file_item: {
        media: { full_url: 'https://cdn.example.test/c2c/download?x=1', aes_key: 'ZmlsZQ==' },
        file_name: 'report (final).pdf',
        len: '1024'
      }
    }
  ]
}

export const quote: WeChatInboundMessage = {
  ...common,
  item_list: [
    {
      type: 1,
      text_item: { text: 'what does this mean?' },
      ref_msg: { message_item: { type: 1, text_item: { text: 'x'.repeat(1200) } } }
    }
  ]
}

export const botAuthored: WeChatInboundMessage = { ...text, from_user_id: BOT, message_type: 2 }

export const empty: WeChatInboundMessage = { ...common, item_list: [{ type: 1, text_item: { text: '' } }] }

export const foreignSender: WeChatInboundMessage = { ...text, from_user_id: 'o9cq8someone-else@im.wechat' }
