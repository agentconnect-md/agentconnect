// A Slack message is a bot's only when it was posted as a bot identity (assistant-mode.md §5.5).
import { describe, expect, it } from 'vitest'
import { isSlackBotPost, normalizeSlackMessage } from '../src/index.js'

const base = { type: 'message', channel: 'C0EXAMPLE', ts: '1760000000.000100', text: 'ship it' }

describe('Slack sender identity', () => {
  it('counts a post an app made with the person’s own token as that person’s', () => {
    const msg = normalizeSlackMessage({ ...base, user: 'U0EXAMPLE', app_id: 'A0EXAMPLE' })
    expect(msg?.source).toBe('user')
    expect(msg?.sender).toEqual({ id: 'U0EXAMPLE', isBot: false, appId: 'A0EXAMPLE' })
  })

  it('keeps a post made as a bot identity a bot’s', () => {
    const botPost = { ...base, user: 'U0BOTUSER', bot_id: 'B0EXAMPLE', app_id: 'A0EXAMPLE' }
    expect(normalizeSlackMessage(botPost)?.sender).toEqual({ id: 'U0BOTUSER', isBot: true, appId: 'A0EXAMPLE' })
    expect(normalizeSlackMessage({ ...base, subtype: 'bot_message' })?.sender.isBot).toBe(true)
    expect(isSlackBotPost({ bot_id: 'B0EXAMPLE' })).toBe(true)
    expect(isSlackBotPost({ subtype: 'bot_message' })).toBe(true)
  })

  it('keeps a person’s ordinary post a person’s', () => {
    expect(normalizeSlackMessage({ ...base, user: 'U0EXAMPLE' })?.sender.isBot).toBe(false)
  })
})
