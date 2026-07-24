import { describe, it, expect } from 'vitest'
import { normalizeSlackEvent } from '../src/slack/normalize.js'

describe('normalizeSlackEvent', () => {
  it('extracts mentioned bot ids and detects DM', () => {
    const m = normalizeSlackEvent(
      { type: 'message', channel: 'D1', channel_type: 'im', ts: '1.1', user: 'U1', text: 'hi <@BOTA> please' },
      { traceId: 't1' }
    )
    expect(m.platform).toBe('slack')
    expect(m.channel).toBe('D1')
    expect(m.thread).toBe('1.1') // top-level message: thread = its own ts
    expect(m.mentionedBots).toEqual(['BOTA'])
    expect(m.isDm).toBe(true)
    expect(m.sender).toEqual({ id: 'U1', isBot: false })
  })

  it('uses visible Block Kit text when the top-level fallback omits the message body', () => {
    const m = normalizeSlackEvent(
      {
        type: 'app_mention',
        channel: 'C1',
        ts: '1.2',
        user: 'U1',
        blocks: [
          {
            type: 'rich_text',
            elements: [
              {
                type: 'rich_text_section',
                elements: [
                  { type: 'user', user_id: 'BOTA' },
                  { type: 'text', text: ' review ' },
                  { type: 'link', url: 'https://example.test/release', text: 'this release' }
                ]
              }
            ]
          }
        ]
      },
      { traceId: 't-blocks' }
    )

    expect(m.text).toBe('<@BOTA> review <https://example.test/release|this release>')
    expect(m.mentionedBots).toEqual(['BOTA'])
  })

  it('uses thread_ts when in a thread and flags bot senders', () => {
    const m = normalizeSlackEvent(
      {
        type: 'message',
        channel: 'C1',
        thread_ts: '100.1',
        ts: '100.5',
        bot_id: 'B9',
        bot_profile: { app_id: 'A9' },
        text: 'done'
      },
      { traceId: 't2' }
    )
    expect(m.thread).toBe('100.1')
    expect(m.sender).toEqual({ id: 'B9', isBot: true, appId: 'A9' })
    expect(m.mentionedBots).toEqual([])
  })

  it('extracts file_share attachments (preferring url_private_download)', () => {
    const m = normalizeSlackEvent(
      {
        type: 'message',
        subtype: 'file_share',
        channel: 'C1',
        ts: '200.1',
        user: 'U1',
        text: 'look at this',
        files: [
          {
            id: 'F1',
            name: 'shot.png',
            mimetype: 'image/png',
            filetype: 'png',
            size: 1234,
            url_private: 'https://files.slack.com/F1',
            url_private_download: 'https://files.slack.com/F1?dl=1'
          }
        ]
      },
      { traceId: 't3' }
    )
    expect(m.attachments).toEqual([
      { id: 'F1', name: 'shot.png', mimeType: 'image/png', size: 1234, sourceUrl: 'https://files.slack.com/F1?dl=1' }
    ])
  })

  it('drops files lacking an id or fetch URL and omits attachments when none usable', () => {
    const m = normalizeSlackEvent(
      { type: 'message', channel: 'C1', ts: '200.2', user: 'U1', files: [{ name: 'ghost.txt' }] },
      { traceId: 't4' }
    )
    expect(m.attachments).toBeUndefined()
  })

  it('tolerates malformed file entries without throwing or losing the message', () => {
    const m = normalizeSlackEvent(
      {
        type: 'message',
        channel: 'C1',
        ts: '200.3',
        user: 'U1',
        text: 'mixed bag',
        // a null and a non-object entry off the wire alongside one valid file
        files: [null as any, 'oops' as any, { id: 'F2', mimetype: 'image/jpeg', url_private: 'https://files/F2' }]
      },
      { traceId: 't5' }
    )
    expect(m.text).toBe('mixed bag')
    expect(m.attachments).toEqual([{ id: 'F2', name: 'F2', mimeType: 'image/jpeg', sourceUrl: 'https://files/F2' }])
  })
})
