import { describe, expect, it, vi } from 'vitest'
import { MAX_PROMPT_SUGGESTION_CHARS, promptSuggestionOf } from '../src/session/prompt-suggestion.js'
import { SlackConnection } from '../src/slack/connection.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const info = (meta: unknown) => ({ sessionUpdate: 'session_info_update', _meta: meta })

describe('promptSuggestionOf', () => {
  it('reads the first non-blank predicted prompt', () => {
    expect(
      promptSuggestionOf(info({ promptSuggestions: { suggestions: [{ text: '  ' }, { text: ' run the tests ' }] } }))
    ).toBe('run the tests')
  })

  it('reads an empty list as a clear and an update without the key as nothing', () => {
    expect(promptSuggestionOf(info({ promptSuggestions: { suggestions: [] } }))).toBeNull()
    expect(promptSuggestionOf(info({ promptSuggestions: { suggestions: [{ text: ' ' }] } }))).toBeNull()
    expect(promptSuggestionOf({ sessionUpdate: 'session_info_update', title: 'A title' })).toBeUndefined()
    expect(
      promptSuggestionOf({ sessionUpdate: 'agent_message_chunk', _meta: { promptSuggestions: { suggestions: [] } } })
    ).toBeUndefined()
  })

  it('caps a runaway prediction', () => {
    const text = 'x'.repeat(MAX_PROMPT_SUGGESTION_CHARS + 10)
    expect(promptSuggestionOf(info({ promptSuggestions: { suggestions: [{ text }] } }))).toHaveLength(
      MAX_PROMPT_SUGGESTION_CHARS
    )
  })
})

describe('SlackConnection.setDmSuggestedPrompt', () => {
  function fixture() {
    const app = fakeSlackAppFactory()({ token: 'xoxb-test', appToken: 'xapp-test' })
    const apiCall = vi.fn(async (_method: string, _args: unknown) => ({}))
    app.client.apiCall = apiCall
    const conn = new SlackConnection(
      {
        group: { appToken: 'xapp-test', botToken: 'xoxb-test', integrations: [] },
        newTraceId: () => 'trace',
        sendIntervalMs: 0,
        onMessage: vi.fn()
      },
      () => app
    )
    return { conn, apiCall }
  }

  it('sets one channel-level prompt in a DM, skips repeats, and clears with an empty list', async () => {
    const h = fixture()
    const long = `Now open a pull request for this change and ${'ask for review '.repeat(5)}`
    await h.conn.setDmSuggestedPrompt('D1', long)
    await h.conn.setDmSuggestedPrompt('D1', long)
    await h.conn.setDmSuggestedPrompt('D1', null)
    await h.conn.setDmSuggestedPrompt('D1', null)
    expect(h.apiCall).toHaveBeenCalledTimes(2)
    const first = h.apiCall.mock.calls[0]![1] as { channel_id: string; prompts: { title: string; message: string }[] }
    expect(h.apiCall.mock.calls[0]![0]).toBe('assistant.threads.setSuggestedPrompts')
    expect(first).not.toHaveProperty('thread_ts')
    expect(first.channel_id).toBe('D1')
    expect(first.prompts).toHaveLength(1)
    expect(first.prompts[0]!.message).toBe(long)
    expect(first.prompts[0]!.title.length).toBeLessThanOrEqual(60)
    expect(first.prompts[0]!.title.endsWith('…')).toBe(true)
    expect(h.apiCall.mock.calls[1]).toEqual([
      'assistant.threads.setSuggestedPrompts',
      { channel_id: 'D1', prompts: [] }
    ])
  })

  it('sends the first clear for a DM it has no record of, since Slack may still show an old prompt', async () => {
    const h = fixture()
    await h.conn.setDmSuggestedPrompt('D1', null)
    await h.conn.setDmSuggestedPrompt('D1', null)
    expect(h.apiCall.mock.calls).toEqual([['assistant.threads.setSuggestedPrompts', { channel_id: 'D1', prompts: [] }]])
  })

  it('never touches a channel or a group conversation', async () => {
    const h = fixture()
    await h.conn.setDmSuggestedPrompt('C1', 'next')
    await h.conn.setDmSuggestedPrompt('G1', 'next')
    expect(h.apiCall).not.toHaveBeenCalled()
  })

  it('retries after a failed call instead of remembering it as published', async () => {
    const h = fixture()
    h.apiCall.mockRejectedValueOnce(new Error('ratelimited'))
    await h.conn.setDmSuggestedPrompt('D1', 'next')
    await h.conn.setDmSuggestedPrompt('D1', 'next')
    expect(h.apiCall).toHaveBeenCalledTimes(2)
  })
})
