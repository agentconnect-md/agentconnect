// The people a message mentions, by platform id, so a turn knows who is on it (assistant-mode.md §5.17).
import { describe, expect, it } from 'vitest'
import { normalizeDiscordMessage, normalizeFeishuMessage, normalizeSlackMessage } from '../src/index.js'

describe('mentionedUsers', () => {
  it('lists each person a Slack message mentions once', () => {
    const msg = normalizeSlackMessage(
      {
        type: 'message',
        channel: 'C0EXAMPLE',
        ts: '1760000000.000100',
        user: 'U0ALICE',
        text: '<@U0BOB> now owns billing, with <@U0CAROL> and <@U0BOB>',
        channel_type: 'channel'
      },
      { traceId: 't' }
    )
    expect(msg.mentionedUsers).toEqual(['U0BOB', 'U0CAROL'])
  })

  it('lists the people a Discord message mentions', () => {
    const msg = normalizeDiscordMessage(
      {
        id: '111',
        channelId: 'C777',
        content: 'ask <@999>',
        authorId: 'U123',
        authorIsBot: false,
        inGuild: true,
        isThread: false,
        mentionUserIds: ['999', '999'],
        attachments: []
      },
      { traceId: 't' }
    )
    expect(msg.mentionedUsers).toEqual(['999'])
  })

  it('lists the people a Lark/Feishu message mentions by union_id, the id a sender is known by', () => {
    const msg = normalizeFeishuMessage(
      {
        messageId: 'om_1',
        chatId: 'oc_1',
        chatType: 'group',
        messageType: 'text',
        content: JSON.stringify({ text: '@_user_1 owns billing' }),
        senderOpenId: 'ou_sender',
        senderUnionId: 'on_sender',
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bob', union_id: 'on_bob' }, name: 'Bob' },
          { key: '@_user_2', id: { open_id: 'ou_bot' }, name: 'AgentBot' }
        ]
      },
      { traceId: 't' }
    )
    expect(msg.mentionedUsers).toEqual(['on_bob'])
    expect(msg.mentionedBots).toEqual(['ou_bob', 'ou_bot'])
  })
})
