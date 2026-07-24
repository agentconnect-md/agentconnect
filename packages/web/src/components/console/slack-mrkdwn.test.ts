import { describe, expect, it } from 'vitest'
import { slackToMarkdown } from './slack-mrkdwn'

describe('slackToMarkdown', () => {
  it('renders standard Slack emoji shortcodes for transcript display', () => {
    expect(slackToMarkdown(':alarm_clock: say hello')).toBe('⏰ say hello')
    expect(slackToMarkdown(':white_check_mark: done')).toBe('✅ done')
    expect(slackToMarkdown(':rocket: :+1:')).toBe('🚀 👍')
  })

  it('leaves custom emoji and code spans untouched', () => {
    expect(slackToMarkdown(':agentconnect: `:alarm_clock:`')).toBe(':agentconnect: `:alarm_clock:`')
  })
})
