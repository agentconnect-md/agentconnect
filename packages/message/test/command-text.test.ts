import { describe, expect, it } from 'vitest'
import { commandText, recordedCommandTexts, slackCommandText } from '../src/command-text.js'

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
    expect(commandText('slack', '<@U0000000001> !new', SELF)).toBe(' !new')
    expect(commandText('telegram', '<@U0000000001> !new', SELF)).toBe('<@U0000000001> !new')
  })

  it('reads a recorded row with any address', () => {
    expect(recordedCommandTexts('<@U0000000002> !new')).toContain(' !new')
  })
})
