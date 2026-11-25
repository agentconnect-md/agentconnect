import { describe, expect, it } from 'vitest'
import { extractSlackMessageText, slackMarkdownPlainText } from '../src/slack-message-text.js'

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

describe('slackMarkdownPlainText', () => {
  it('drops Markdown delimiters and keeps the words, link labels and Slack addresses', () => {
    expect(
      slackMarkdownPlainText(
        '## Status\n**The release is ready.** **Asked by:** <@U0123ABCD|Ana>\n• Budget: ~~10~~ 12 hours, [tracking issue](https://example.com/issues/1) _soon_'
      )
    ).toBe('Status\nThe release is ready. Asked by: <@U0123ABCD|Ana>\n• Budget: 10 12 hours, tracking issue soon')
  })

  it('keeps code content as written and drops only its fences', () => {
    expect(slackMarkdownPlainText('Run `a **b**` then:\n```sh\nls **/*.ts\n```\nDone.')).toBe(
      'Run a **b** then:\nls **/*.ts\nDone.'
    )
  })

  it('leaves plain text, Slack links and emoji untouched', () => {
    const text = '🔴 Priority: High · :link: <https://example.com/t|Tenant> · snake_case_name · 2 * 3'
    expect(slackMarkdownPlainText(text)).toBe(text)
  })

  it('reads a markdown reply once when the fallback is its plain text', () => {
    const markdown =
      '**Acme Freight** (Live)\n\n**Problem:** the export sent the wrong time. [Order](https://example.com/o/1)'
    expect(
      extractSlackMessageText({
        text: slackMarkdownPlainText(markdown),
        blocks: [{ type: 'markdown', text: markdown }]
      })
    ).toBe(markdown)
  })

  it.each([
    'Edit `__init__.py` and rerun.',
    'Run:\n```py\nif __name__ == "__main__":\n  main()\n```',
    'Run `a **b**` then:\n```sh\nls **/*.ts\n```\nDone.',
    'Use `[label](url)` syntax for links.',
    'Set `~~strike~~` or `2 * 3 * 4` here.'
  ])('reads a markdown reply with Markdown-like code once: %j', (markdown) => {
    expect(
      extractSlackMessageText({
        text: slackMarkdownPlainText(markdown),
        blocks: [{ type: 'markdown', text: markdown }]
      })
    ).toBe(markdown)
  })

  it('keeps Markdown-like text in a human mrkdwn message as written', () => {
    expect(extractSlackMessageText({ text: 'see [x](y) and __init__' })).toBe('see [x](y) and __init__')
  })
})
