import { describe, expect, it } from 'vitest'
import { rewriteDingTalkMarkdown } from '../src/platforms/dingtalk/markdown.js'
import { DingTalkConnection } from '../src/platforms/dingtalk/connection.js'

const NBSP = ' '

describe('rewriteDingTalkMarkdown', () => {
  it('rewrites underscore emphasis to asterisks outside code only', () => {
    expect(rewriteDingTalkMarkdown('_one_ and __two__')).toBe(`*one* and${NBSP}**two**`)
    expect(rewriteDingTalkMarkdown('keep snake_case_names as they are')).toBe('keep snake_case_names as they are')
    expect(rewriteDingTalkMarkdown('`_code_` stays')).toBe('`_code_` stays')
    expect(rewriteDingTalkMarkdown('```\n_code_\n```')).toBe('```\n_code_\n```')
    expect(rewriteDingTalkMarkdown('*already* fine')).toBe('*already* fine')
  })

  it('keeps the space before a link or an inline style, never at a line start', () => {
    expect(rewriteDingTalkMarkdown('see [the docs](https://docs.example.test) now')).toBe(
      `see${NBSP}[the docs](https://docs.example.test) now`
    )
    expect(rewriteDingTalkMarkdown('a **bold** and `code` word')).toBe(`a${NBSP}**bold** and${NBSP}\`code\` word`)
    expect(rewriteDingTalkMarkdown('[link](https://example.test) first')).toBe('[link](https://example.test) first')
  })

  it('drops a fence language label and leaves the code alone', () => {
    expect(rewriteDingTalkMarkdown('Run:\n\n```ts\nconst a_b = 1\n```')).toBe('Run:\n\n```\nconst a_b = 1\n```')
    expect(rewriteDingTalkMarkdown('~~~bash\nls\n~~~')).toBe('~~~\nls\n~~~')
    expect(rewriteDingTalkMarkdown('```\nplain\n```')).toBe('```\nplain\n```')
  })

  it('leaves headings, lists and tables, which the Markdown message renders', () => {
    const text = '## Title\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'
    expect(rewriteDingTalkMarkdown(text)).toBe(text)
  })

  it('keeps the space after a list, heading or quote marker when the first word is styled', () => {
    for (const text of [
      '- **Important** note',
      '1. [Docs](https://example.test) here',
      '## **Heading**',
      '> `code` first'
    ])
      expect(rewriteDingTalkMarkdown(text)).toBe(text)
    expect(rewriteDingTalkMarkdown('- see **this**')).toBe(`- see${NBSP}**this**`)
  })
})

describe('DingTalkConnection.sendMarkdown', () => {
  it('sends the rewritten Markdown and returns the original text for the transcript', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace('https://api.example.test', '')
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
      if (path === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1', expireIn: 7200 })
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return json({ processQueryKey: 'pqk-1' })
    }) as typeof fetch
    const log = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    const conn = new DingTalkConnection(
      { clientId: 'client-id-example', clientSecret: 'secret', integrations: [] },
      { log, onMessage: () => {}, fetchImpl, origin: 'https://api.example.test' }
    )
    const sent = await conn.sendMarkdown('cid-example', '_note_\n\n```ts\nx\n```')
    expect(sent).toEqual([{ text: '_note_\n\n```ts\nx\n```', processQueryKey: 'pqk-1' }])
    expect(JSON.parse(String(bodies[0]?.msgParam)).text).toBe('*note*\n\n```\nx\n```')
    await conn.stop()
  })
})
