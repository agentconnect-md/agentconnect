import { describe, it, expect } from 'vitest'
import { markdownToTelegramHtml, telegramHtmlLength } from '../src/telegram/markdown-html.js'
import { splitTelegramMarkdown, TELEGRAM_MESSAGE_LIMIT } from '../src/telegram/render.js'

// Telegram's HTML parse_mode accepts only these tags; the rendered length is the text with tags and entities resolved.
const ALLOWED = /^<\/?(b|i|u|s|code|pre|a|blockquote|tg-spoiler)(\s[^>]*)?>$/
const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')

/** Every tag is allowed and balanced, and no raw `<` / `&` leaks outside a tag or entity. */
function expectWellFormed(html: string): void {
  const stack: string[] = []
  for (const tag of html.match(/<[^>]*>/g) ?? []) {
    expect(tag).toMatch(ALLOWED)
    const name = /^<\/?([\w-]+)/.exec(tag)![1]!
    if (tag.startsWith('</')) expect(stack.pop()).toBe(name)
    else stack.push(name)
  }
  expect(stack).toEqual([])
  expect(html.replace(/<[^>]*>/g, '')).not.toMatch(/<|>|&(?!(amp|lt|gt|quot);)/)
}

describe('markdownToTelegramHtml', () => {
  it('maps strong, emphasis and inline code to Telegram tags', () => {
    expect(markdownToTelegramHtml('**bold** and *it* and `x < y`')).toBe(
      '<b>bold</b> and <i>it</i> and <code>x &lt; y</code>'
    )
  })

  it('keeps Czech quotes inside bold', () => {
    const html = markdownToTelegramHtml('**„text v uvozovkách“** platí')
    expect(html).toBe('<b>„text v uvozovkách“</b> platí')
  })

  it('leaves an unclosed ** as literal text', () => {
    const html = markdownToTelegramHtml('**nedokončené tučné')
    expect(html).toBe('**nedokončené tučné')
    expectWellFormed(html)
  })

  it('escapes < > & in text and in code', () => {
    const html = markdownToTelegramHtml('a < b && c > d\n\n```ts\nif (a < b && c > d) {}\n```')
    expect(html).toBe(
      'a &lt; b &amp;&amp; c &gt; d\n\n<pre><code class="language-ts">if (a &lt; b &amp;&amp; c &gt; d) {}</code></pre>'
    )
    expectWellFormed(html)
  })

  it('renders raw HTML from the agent as text', () => {
    const html = markdownToTelegramHtml('<script>alert(1)</script>\n\ninline <b>x</b>')
    expect(visible(html)).toBe('<script>alert(1)</script>\n\ninline <b>x</b>')
    expectWellFormed(html)
  })

  it('links only http(s) and escapes a quote in the URL', () => {
    expect(markdownToTelegramHtml('[docs](https://ex.com/a?q="x"&b=1)')).toBe(
      '<a href="https://ex.com/a?q=&quot;x&quot;&amp;b=1">docs</a>'
    )
    expect(markdownToTelegramHtml('[run](javascript:alert(1))')).toBe('run')
  })

  it('resolves reference links through their definitions and drops the definitions', () => {
    expect(markdownToTelegramHtml('see [the docs][d]\n\n[d]: https://ex.com')).toBe(
      'see <a href="https://ex.com">the docs</a>'
    )
  })

  it('renders headings as bold lines and quotes as blockquote', () => {
    expect(markdownToTelegramHtml('## Shrnutí\n\n> citace\n> > vnořená')).toBe(
      '<b>Shrnutí</b>\n\n<blockquote>citace\n\nvnořená</blockquote>'
    )
  })

  it('renders nested and ordered lists as text markers', () => {
    const html = markdownToTelegramHtml('- one\n  - nested **b**\n    - deeper\n- two\n\n3. three\n4. four')
    expect(html).toBe('• one\n  ◦ nested <b>b</b>\n    ▪ deeper\n• two\n\n3. three\n4. four')
    expectWellFormed(html)
  })

  it('keeps a code block over the message limit inside one <pre> per section', () => {
    const code = Array.from({ length: 300 }, (_, i) => `const line${i} = a < b && c > ${i}`).join('\n')
    const md = `Intro\n\n\`\`\`ts\n${code}\n\`\`\`\n\nOutro`
    expect(md.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT)
    const sections = splitTelegramMarkdown(md, TELEGRAM_MESSAGE_LIMIT)
    expect(sections.length).toBeGreaterThan(1)
    for (const section of sections) {
      const html = markdownToTelegramHtml(section)
      expectWellFormed(html)
      expect(visible(html).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT)
    }
  })

  it('keeps a fenced block that spans messages as code in every section', () => {
    const code = Array.from({ length: 300 }, () => 'print("**literal**")').join('\n')
    const sections = splitTelegramMarkdown(`\`\`\`python\n${code}\n\`\`\``, TELEGRAM_MESSAGE_LIMIT)
    expect(sections.length).toBeGreaterThan(1)
    for (const section of sections) {
      expect(section.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT)
      const html = markdownToTelegramHtml(section)
      expect(html).toMatch(/^<pre><code class="language-python">[^<]*<\/code><\/pre>$/)
      expect(html).toContain('**literal**')
      expect(html).not.toContain('<b>')
    }
  })

  it('renders a thematic break no longer than its source', () => {
    const md = `${'x'.repeat(4088)}\n\n***`
    expect(splitTelegramMarkdown(md, TELEGRAM_MESSAGE_LIMIT)).toEqual([md])
    expect(telegramHtmlLength(markdownToTelegramHtml(md))).toBeLessThanOrEqual(md.length)
  })

  it('counts the HTML length Telegram sees: tags dropped, entities as one character', () => {
    expect(telegramHtmlLength('<b>a &amp; b</b> <a href="https://x">&lt;c&gt;</a>')).toBe(9)
  })

  it('splits a ~6000-char reply into sections that each convert well-formed within the limit', () => {
    const para = (i: number) =>
      `## Sekce ${i}\n\n**Tučně** a *kurzíva* s [odkazem](https://ex.com/${i}) a \`kódem\` & <znaky>.\n\n- bod a\n- bod b\n  - vnořený\n`
    const md = Array.from({ length: 52 }, (_, i) => para(i)).join('\n')
    expect(md.length).toBeGreaterThan(5500)
    const sections = splitTelegramMarkdown(md, TELEGRAM_MESSAGE_LIMIT)
    expect(sections.length).toBeGreaterThan(1)
    for (const section of sections) {
      const html = markdownToTelegramHtml(section)
      expectWellFormed(html)
      expect(html).not.toContain('**')
      expect(visible(html).length).toBeLessThanOrEqual(section.length)
    }
  })

  it('renders nothing for whitespace-only input', () => {
    expect(markdownToTelegramHtml('  \n')).toBe('')
  })
})
