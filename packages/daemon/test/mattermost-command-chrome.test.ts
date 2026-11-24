import { describe, expect, it, vi } from 'vitest'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { mattermostCommandChrome, renderMattermostStatus } from '../src/platforms/mattermost/command-chrome.js'

const baseMsg = (over: Partial<NormalizedMessage> = {}): NormalizedMessage =>
  ({
    platform: 'mattermost',
    channel: 'mmch0000000000000000000001',
    msgId: 'mattermost:mmch00000000000000000001:mmpost00000000000000000002',
    thread: 'mmpost00000000000000000001',
    text: '!status',
    sender: { id: 'u1', isBot: false },
    source: 'user',
    isDm: false,
    mentionedBots: [],
    ...over
  }) as NormalizedMessage

describe('renderMattermostStatus', () => {
  it('formats model, fast flag, context usage, token totals, and validated session link', () => {
    expect(
      renderMattermostStatus(
        {
          model: 'gpt-6.1-sol',
          fastMode: true,
          contextUsed: 120_000,
          contextSize: 200_000,
          totalTokens: 45_200
        },
        'https://console.example.com/o/sessions/s-1'
      )
    ).toBe(
      '📊 **gpt-6.1-sol** · fast · ctx 120k/200k (60%) · 45k tok · [View session](https://console.example.com/o/sessions/s-1)'
    )

    expect(
      renderMattermostStatus({
        model: 'claude-4.5',
        contextUsed: 1_500,
        totalTokens: 1_250_000
      })
    ).toBe('📊 **claude-4.5** · ctx 1.5k · 1.3M tok')

    expect(renderMattermostStatus({})).toBe('📊 —')
  })

  it('escapes Markdown in model names, encodes link parentheses, and drops unsafe URLs', () => {
    expect(
      renderMattermostStatus(
        { model: 'evil_[model](https://x.test)*<script>' },
        'http://localhost:3000/o/sessions/s(1)'
      )
    ).toBe(
      '📊 **evil\\_\\[model\\](https://x.test)\\*\\<script\\>** · [View session](http://localhost:3000/o/sessions/s%281%29)'
    )
    expect(renderMattermostStatus({}, 'javascript:alert(1)')).toBe('📊 —')
    expect(renderMattermostStatus({}, 'data:text/html,hi')).toBe('📊 —')
  })
})

describe('mattermostCommandChrome', () => {
  it('routes channel thread, root fallback, and flat DM replies and statuses cleanly', () => {
    const createPost = vi.fn(async () => ({ id: 'mmpost00000000000000000099' }))
    mattermostCommandChrome.status(
      { createPost },
      baseMsg(),
      {
        channel: 'mmch0000000000000000000001',
        replyThread: 'mmpost00000000000000000001',
        sessionKey: 'k1'
      },
      { model: 'gpt-6.1-sol', contextUsed: 8_400, contextSize: 200_000 },
      'https://mm.example.test/_redirect/pl/mmpost00000000000000000001'
    )
    expect(createPost).toHaveBeenLastCalledWith(
      'mmch0000000000000000000001',
      '📊 **gpt-6.1-sol** · ctx 8.4k/200k (4%) · [View session](https://mm.example.test/_redirect/pl/mmpost00000000000000000001)',
      { rootId: 'mmpost00000000000000000001' }
    )

    // Top-level channel trigger falls back to msgId native coordinate as rootId.
    mattermostCommandChrome.reply(
      { createPost },
      baseMsg({
        msgId: 'mattermost:mmch00000000000000000001:mmroot00000000000000000007',
        thread: undefined
      }),
      {
        channel: 'mmch0000000000000000000001',
        replyThread: 'mmch0000000000000000000001',
        sessionKey: 'k1'
      },
      'Mode updated'
    )
    expect(createPost).toHaveBeenLastCalledWith('mmch0000000000000000000001', 'Mode updated', {
      rootId: 'mmroot00000000000000000007'
    })

    // 1:1 DM stays flat (undefined rootId unless replyThread was set).
    mattermostCommandChrome.reply(
      { createPost },
      baseMsg({
        channel: 'mmdm0000000000000000000001',
        msgId: 'mattermost:mmdm0000000000000000000001:mmdmpost000000000000000001',
        thread: 'dm',
        isDm: true
      }),
      {
        channel: 'mmdm0000000000000000000001',
        replyThread: 'dm',
        sessionKey: 'k-dm'
      },
      'DM ok'
    )
    expect(createPost).toHaveBeenLastCalledWith('mmdm0000000000000000000001', 'DM ok', undefined)
  })
})
