import { describe, expect, it } from 'vitest'
import { extractSlackMessageText } from '../src/slack-message-text.js'

describe('extractSlackMessageText', () => {
  it('preserves the source URL and embedded content of a forwarded Slack message', () => {
    const sourceUrl = 'https://slack.example.test/archives/C1/p100'
    const text = extractSlackMessageText({
      text: '<@BOTA>',
      attachments: [
        {
          author_name: 'changelogue',
          author_link: 'https://slack.example.test/apps/changelogue',
          text: '<@BOTB>',
          footer: 'Thread in #updates-rpc-node',
          from_url: sourceUrl,
          is_msg_unfurl: true,
          message_blocks: [
            {
              message: {
                text: '<@BOTB>',
                attachments: [
                  {
                    title: 'reth v2.4.0',
                    title_link: 'https://github.com/paradigmxyz/reth/releases/tag/v2.4.0',
                    text: 'Performance improvements'
                  }
                ]
              }
            }
          ]
        }
      ]
    })

    expect(text).toContain('<https://github.com/paradigmxyz/reth/releases/tag/v2.4.0|reth v2.4.0>')
    expect(text).toContain('Performance improvements')
    expect(text).toContain(sourceUrl)
  })

  it('keeps one copy of a message whose mrkdwn text and rich_text blocks spell the same words', () => {
    // As an app posting for a person sends it: mrkdwn `text` plus the same body as rich_text and a context line.
    const text = extractSlackMessageText({
      text: '<@BOT1> run `sleep 5 &amp;&amp; echo ok` and reply. _Sent using_ <@APP1|Claude>',
      blocks: [
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'user', user_id: 'BOT1' },
                { type: 'text', text: ' run ' },
                { type: 'text', text: 'sleep 5 && echo ok', style: { code: true } },
                { type: 'text', text: ' and reply.' }
              ]
            }
          ]
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: '_Sent using_ <@APP1>' }] }
      ]
    })
    expect(text).toBe('<@BOT1> run `sleep 5 &amp;&amp; echo ok` and reply. _Sent using_ <@APP1|Claude>')
  })

  it('still keeps a block that says something the text does not', () => {
    const text = extractSlackMessageText({
      text: 'Deploy finished',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*api* is live on staging' } }]
    })
    expect(text).toBe('Deploy finished\n*api* is live on staging')
  })

  it('keeps two attachments that differ only in characters mrkdwn also uses, inside code or words', () => {
    const text = extractSlackMessageText({
      attachments: [{ text: 'Check `src/foo_bar.ts`' }, { text: 'Check `src/foobar.ts`' }]
    })
    expect(text).toBe('Check `src/foo_bar.ts`\nCheck `src/foobar.ts`')
    expect(
      extractSlackMessageText({ attachments: [{ text: 'see snake_case_name' }, { text: 'see snakecasename' }] })
    ).toBe('see snake_case_name\nsee snakecasename')
  })
})
