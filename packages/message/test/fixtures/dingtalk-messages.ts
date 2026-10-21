// Synthetic DingTalk robot messages in the measured Stream shape; every id is a placeholder.
import type { DingTalkRobotMessage } from '../../src/dingtalk-message.js'

export const ROBOT = 'robot-example'
export const BOT_USER = 'bot-dingtalk-id-example'
export const GROUP = 'cid-example-group'
export const DM_CONVERSATION = 'cid-example-dm'
export const STAFF = 'user-0001'

const common = {
  createAt: 1767225600000,
  senderStaffId: STAFF,
  senderId: 'sender-dingtalk-id-0001',
  senderUnionId: 'union-0001',
  senderNick: 'Example User',
  senderCorpId: 'corp-example',
  chatbotCorpId: 'corp-example',
  chatbotUserId: BOT_USER,
  robotCode: ROBOT,
  isAdmin: false,
  sessionWebhook: 'https://webhook.example.test/robot/session',
  sessionWebhookExpiredTime: 1767231000000
} satisfies DingTalkRobotMessage

export const dmText: DingTalkRobotMessage = {
  ...common,
  msgId: 'msg-dm-0001',
  conversationId: DM_CONVERSATION,
  conversationType: '1',
  openThreadId: DM_CONVERSATION,
  msgtype: 'text',
  text: { content: 'hello there' }
}

export const groupMention: DingTalkRobotMessage = {
  ...common,
  msgId: 'msg-group-0001',
  conversationId: GROUP,
  conversationType: '2',
  conversationTitle: 'Example Group',
  openThreadId: GROUP,
  isInAtList: true,
  atUsers: [{ dingtalkId: BOT_USER }],
  msgtype: 'text',
  text: { content: ' please summarize the thread ' }
}

export const quoteOfBotMessage: DingTalkRobotMessage = {
  ...groupMention,
  msgId: 'msg-group-0002',
  originalProcessQueryKey: 'process-query-key-0001',
  originalMsgId: 'msg-bot-0001',
  text: {
    content: ' and the next step?',
    isReplyMsg: true,
    repliedMsg: {
      createdAt: 1767225500000,
      senderId: BOT_USER,
      msgType: 'text',
      msgId: 'msg-bot-0001',
      content: { text: 'Here is the summary.' }
    }
  }
}

export const quoteOfHumanMessage: DingTalkRobotMessage = {
  ...groupMention,
  msgId: 'msg-group-0003',
  text: {
    content: ' what does this mean?',
    isReplyMsg: true,
    repliedMsg: {
      createdAt: 1767225400000,
      senderId: 'sender-dingtalk-id-0002',
      msgType: 'text',
      msgId: 'msg-human-0001',
      content: { text: 'The build is red again.' }
    }
  }
}

export const quoteOfFile: DingTalkRobotMessage = {
  ...groupMention,
  msgId: 'msg-group-0004',
  text: {
    content: ' review this file',
    isReplyMsg: true,
    repliedMsg: {
      createdAt: 1767225300000,
      senderId: 'sender-dingtalk-id-0002',
      msgType: 'file',
      msgId: 'msg-file-0001',
      content: {
        downloadCode: 'download-code-file-0001',
        fileName: 'report.pdf',
        fileId: 'file-0001',
        spaceId: 'space-0001'
      }
    }
  }
}

export const dmPicture: DingTalkRobotMessage = {
  ...dmText,
  msgId: 'msg-dm-0002',
  msgtype: 'picture',
  text: undefined,
  content: { downloadCode: 'download-code-picture-0001', pictureDownloadCode: 'picture-download-code-0001' }
}

export const dmRichText: DingTalkRobotMessage = {
  ...dmText,
  msgId: 'msg-dm-0003',
  msgtype: 'richText',
  text: undefined,
  content: {
    richText: [
      { text: 'see the screenshot' },
      {
        type: 'picture',
        downloadCode: 'download-code-picture-0002',
        pictureDownloadCode: 'picture-download-code-0002'
      },
      { text: '\nthanks' }
    ]
  }
}

export const dmUnknownType: DingTalkRobotMessage = {
  ...dmText,
  msgId: 'msg-dm-0004',
  msgtype: 'interactiveCard',
  text: undefined,
  content: {}
}
