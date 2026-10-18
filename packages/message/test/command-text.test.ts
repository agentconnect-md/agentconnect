import { describe, expect, it } from 'vitest'
import { commandText, recordedCommandTexts, slackCommandText } from '../src/command-text.js'
import { normalizeDiscordMessage, normalizeFeishuMessage, normalizeTelegramMessage } from '../src/index.js'

const SELF = ['U0000000001']

describe('slackCommandText', () => {
  it('drops a leading mention of the receiving bot', () => {
    expect(slackCommandText('<@U0000000001> !new', SELF)).toBe(' !new')
    expect(slackCommandText('  <@U0000000001|agent>   !stop now', SELF)).toBe('   !stop now')
    expect(slackCommandText('<@U0000000001> <@U0000000001> !status', SELF)).toBe(' !status')
  })

  it('keeps a leading mention of anyone else', () => {
    expect(slackCommandText('<@U0000000002> !new', SELF)).toBe('<@U0000000002> !new')
    expect(slackCommandText('<@U0000000001> <@U0000000002> !new', SELF)).toBe(' <@U0000000002> !new')
    expect(slackCommandText('<@U0000000002> !new', [])).toBe('<@U0000000002> !new')
  })

  it('drops a mention of anyone when no receiver is given', () => {
    expect(slackCommandText('<@U0000000002> !new')).toBe(' !new')
  })

  it("drops only Slack's trailing Sent using attribution", () => {
    expect(slackCommandText('<@U0000000001> !new *Sent using* <@U0000000009>', SELF)).toBe(' !new')
    expect(slackCommandText('<@U0000000001> !queue fix it\n\n*Sent using* <@U0000000009|app>', SELF)).toBe(
      ' !queue fix it'
    )
    expect(slackCommandText('!new sent using <@U0000000009>', SELF)).toBe('!new sent using <@U0000000009>')
    expect(slackCommandText('!new *Sent using* <@U0000000009> later', SELF)).toBe(
      '!new *Sent using* <@U0000000009> later'
    )
  })
})

describe('commandText', () => {
  it("applies only the message platform's reader", () => {
    expect(commandText({ platform: 'slack', text: '<@U0000000001> !new' }, SELF)).toBe(' !new')
    expect(commandText({ platform: 'telegram', text: '<@U0000000001> !new' }, SELF)).toBe('<@U0000000001> !new')
  })

  it('reads a recorded row with any address', () => {
    expect(recordedCommandTexts('<@U0000000002> !new')).toContain(' !new')
    expect(recordedCommandTexts('@agent_bot  @other !new')).toContain(' !new')
  })

  it('reads a recorded row whose label is one word only', () => {
    expect(recordedCommandTexts('@alice see !new').map((t) => t.trimStart())).not.toContain('!new')
  })
})

const discord = (content: string, names: Record<string, string>) =>
  normalizeDiscordMessage(
    {
      id: '111',
      channelId: 'C777',
      content,
      authorId: '200',
      authorIsBot: false,
      inGuild: true,
      isThread: false,
      mentionUserIds: Object.keys(names),
      mentionUserNames: names,
      attachments: []
    },
    { traceId: 't' }
  )

describe('a command after a mention on Discord', () => {
  it('drops a leading mention of the bot', () => {
    const msg = discord('<@100> !new', { '100': 'Agent Bot' })
    expect(msg.text).toBe('@Agent Bot !new')
    expect(commandText(msg, ['100']).trim()).toBe('!new')
    expect(commandText(discord('<@!100>   <@100> !stop', { '100': 'agent' }), ['100']).trim()).toBe('!stop')
  })

  it('leaves a leading mention of anyone else', () => {
    expect(commandText(discord('<@300> !new', { '300': 'alice' }), ['100'])).toBe('@alice !new')
    expect(commandText(discord('<@100> <@300> !new', { '100': 'agent', '300': 'alice' }), ['100'])).toBe(' @alice !new')
    expect(commandText(discord('<@100> !new', { '100': 'agent' }), [])).toBe('@agent !new')
  })

  it('stops at a label two people share', () => {
    expect(commandText(discord('<@300> !new', { '100': 'agent', '300': 'agent' }), ['100'])).toBe('@agent !new')
  })

  it('needs the label to end where the mention does', () => {
    expect(commandText(discord('<@300> !new', { '100': 'Ann', '300': 'Anna' }), ['100'])).toBe('@Anna !new')
  })
})

const feishu = (text: string, mentions: Array<{ key: string; openId?: string; name?: string }>) =>
  normalizeFeishuMessage(
    {
      messageId: 'om_1',
      chatId: 'oc_1',
      chatType: 'group',
      messageType: 'text',
      content: JSON.stringify({ text }),
      senderOpenId: 'ou_sender',
      senderUnionId: 'on_sender',
      mentions: mentions.map((m) => ({
        key: m.key,
        ...(m.openId ? { id: { open_id: m.openId } } : {}),
        ...(m.name ? { name: m.name } : {})
      }))
    },
    { traceId: 't' }
  )

describe('a command after a mention on Lark/Feishu', () => {
  it('drops a leading mention of the bot', () => {
    const msg = feishu('@_user_1 !new', [{ key: '@_user_1', openId: 'ou_bot', name: 'Agent Bot' }])
    expect(msg.text).toBe('@Agent Bot !new')
    expect(commandText(msg, ['ou_bot']).trim()).toBe('!new')
  })

  it('leaves a leading mention of anyone else', () => {
    const msg = feishu('@_user_1 !new', [{ key: '@_user_1', openId: 'ou_alice', name: 'alice' }])
    expect(commandText(msg, ['ou_bot'])).toBe('@alice !new')
    const all = feishu('@_all !new', [{ key: '@_all', name: 'Everyone' }])
    expect(commandText(all, ['ou_bot'])).toBe('@Everyone !new')
  })
})

describe('a command after a mention on Telegram', () => {
  const telegram = (text: string, entities: Array<{ type: string; offset: number; length: number }>) =>
    normalizeTelegramMessage(
      {
        message_id: 1,
        chat: { id: -100, type: 'supergroup' },
        from: { id: 200, is_bot: false, first_name: 'A' },
        text,
        entities
      } as Parameters<typeof normalizeTelegramMessage>[0],
      { traceId: 't' }
    )

  it('drops a leading mention of the bot', () => {
    const msg = telegram('@agent_bot !new', [{ type: 'mention', offset: 0, length: 10 }])
    expect(commandText(msg, ['agent_bot']).trim()).toBe('!new')
  })

  it('leaves a leading mention of anyone else', () => {
    const msg = telegram('@alice_bot !new', [{ type: 'mention', offset: 0, length: 10 }])
    expect(commandText(msg, ['agent_bot'])).toBe('@alice_bot !new')
  })
})
