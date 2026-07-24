import { describe, expect, it } from 'vitest'
import { extractSlackMessageText } from './slack-message-text.js'

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
})
