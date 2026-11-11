// Synthetic WeCom smart bot `aibot_msg_callback` bodies in the documented shape; every id, URL and key is a placeholder.
import type { WeComInboundMessage } from '../../src/wecom-message.js'

export const BOT = 'aibot-example'
export const BOT_NAME = 'ExampleBot'
export const USER = 'user-alice'
export const GROUP = 'chat-example-group'
export const RESPONSE_URL = 'https://response.example.test/aibot/response?code=placeholder'

const media = (name: string) => ({
  url: `https://media.example.test/aibot/${name}?sign=placeholder`,
  aeskey: `aes-key-${name}-placeholder`
})

export const IMAGE = media('image-0001')
export const FILE = media('file-0001')
export const VIDEO = media('video-0001')
export const MIXED_IMAGE = media('image-0002')
export const QUOTED_IMAGE = media('image-0003')

const dm = {
  aibotid: BOT,
  chattype: 'single',
  from: { userid: USER },
  create_time: 1767225600,
  response_url: RESPONSE_URL
} satisfies WeComInboundMessage

const group = { ...dm, chatid: GROUP, chattype: 'group' } satisfies WeComInboundMessage

export const dmText: WeComInboundMessage = {
  ...dm,
  msgid: 'msg-dm-0001',
  msgtype: 'text',
  text: { content: 'hello there' }
}

export const groupMention: WeComInboundMessage = {
  ...group,
  msgid: 'msg-group-0001',
  msgtype: 'text',
  text: { content: `@${BOT_NAME} please summarize the thread` }
}

export const dmVoice: WeComInboundMessage = {
  ...dm,
  msgid: 'msg-dm-0002',
  msgtype: 'voice',
  voice: { content: 'what is the weather today' }
}

export const dmImage: WeComInboundMessage = { ...dm, msgid: 'msg-dm-0003', msgtype: 'image', image: IMAGE }

export const dmFile: WeComInboundMessage = { ...dm, msgid: 'msg-dm-0004', msgtype: 'file', file: FILE }

export const dmVideo: WeComInboundMessage = { ...dm, msgid: 'msg-dm-0005', msgtype: 'video', video: VIDEO }

export const groupMixed: WeComInboundMessage = {
  ...group,
  msgid: 'msg-group-0002',
  msgtype: 'mixed',
  mixed: {
    msg_item: [
      { msgtype: 'text', text: { content: `@${BOT_NAME} see the screenshot` } },
      { msgtype: 'image', image: MIXED_IMAGE },
      { msgtype: 'text', text: { content: 'thanks' } }
    ]
  }
}

export const groupQuoteOfText: WeComInboundMessage = {
  ...group,
  msgid: 'msg-group-0003',
  msgtype: 'text',
  text: { content: `@${BOT_NAME} what does this mean?` },
  quote: { msgtype: 'text', text: { content: 'The build is red again.' } }
}

export const dmQuoteOfImage: WeComInboundMessage = {
  ...dm,
  msgid: 'msg-dm-0006',
  msgtype: 'text',
  text: { content: 'what is in this picture?' },
  quote: { msgtype: 'image', image: QUOTED_IMAGE }
}

export const assistantInvocation: WeComInboundMessage = {
  ...groupMention,
  msgid: 'msg-group-0004',
  compat_info: { source: 'ai_assistant' }
}

// The callback mode's stream refresh, which the long connection does not send and the normalizer does not serve.
export const streamRefresh: WeComInboundMessage & { stream: { id: string } } = {
  ...group,
  msgid: 'msg-group-0005',
  msgtype: 'stream',
  stream: { id: 'stream-0001' }
}
