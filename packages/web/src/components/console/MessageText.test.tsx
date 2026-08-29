import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageText } from './MessageText'
import { platformRegistry } from './platforms/registry'

/**
 * The renderer registry (§10) ships with the core Slack-mrkdwn renderer as the
 * default for EVERY platform, so this file's job is to prove nothing moved: the
 * markup below was captured from the pre-registry `MessageText` and must stay
 * byte-identical while every platform still renders through the default. It is
 * the regression that matters — a per-platform override (§14) is allowed to
 * change its own platform's rows, and nothing else's.
 *
 * The pairs are (input, rendered markup). Inputs cover the Slack control syntax
 * the normalizer rewrites — link forms, user/channel/special mentions, emoji —
 * the code spans and fences that must shield it, and the CommonMark/GFM the
 * pipeline is left to handle (emphasis, tables, task lists, soft breaks).
 */
const CORPUS: ReadonlyArray<readonly [name: string, input: string, html: string]> = [
  [
    'bare link',
    'see <https://example.test/docs> for details',
    '<div class="mdtxt"><p>see <a href="https://example.test/docs" target="_blank" rel="noopener noreferrer">https://example.test/docs</a> for details</p></div>'
  ],
  [
    'labelled link',
    'see <https://example.test/docs|the docs> for details',
    '<div class="mdtxt"><p>see <a href="https://example.test/docs" target="_blank" rel="noopener noreferrer">the docs</a> for details</p></div>'
  ],
  [
    'link label carrying markdown metacharacters is escaped, not parsed',
    '<https://example.test/a|weird [name] *here*>',
    '<div class="mdtxt"><p><a href="https://example.test/a" target="_blank" rel="noopener noreferrer">weird [name] *here*</a></p></div>'
  ],
  [
    'mailto is a link, tel without a label is bare text',
    '<mailto:ops@example.test|mail us> or <tel:+15550100>',
    '<div class="mdtxt"><p><a href="mailto:ops@example.test" target="_blank" rel="noopener noreferrer">mail us</a> or tel:+15550100</p></div>'
  ],
  [
    'a non-http(s) target is not a Slack link token, and renders as its label rather than an empty anchor',
    'run <file:///etc/hosts> yourself',
    '<div class="mdtxt"><p>run file:///etc/hosts yourself</p></div>'
  ],
  [
    'a host path never becomes a same-origin anchor this console would 404 on',
    'wrote [the digest](/home/agent/workspace/out.md)',
    '<div class="mdtxt"><p>wrote the digest</p></div>'
  ],
  ['user mention with a name', 'ping <@U012ABC|ada> about it', '<div class="mdtxt"><p>ping @ada about it</p></div>'],
  ['user mention without a name', 'ping <@U012ABC> about it', '<div class="mdtxt"><p>ping @U012ABC about it</p></div>'],
  ['channel mention', 'moved to <#C012ABC|releases>', '<div class="mdtxt"><p>moved to #releases</p></div>'],
  ['channel mention without a name', 'moved to <#C012ABC>', '<div class="mdtxt"><p>moved to #C012ABC</p></div>'],
  [
    'here / channel / subteam specials',
    '<!here> and <!channel> and <!subteam^S123|@platform>',
    '<div class="mdtxt"><p>@here and @channel and @@platform</p></div>'
  ],
  ['emoji shortcodes', ':alarm_clock: ship :rocket: :+1:', '<div class="mdtxt"><p>⏰ ship 🚀 👍</p></div>'],
  [
    'an unknown (workspace custom) shortcode stays literal',
    ':agentconnect: stays',
    '<div class="mdtxt"><p>:agentconnect: stays</p></div>'
  ],
  [
    'inline code shields control tokens',
    'literal `<@U012ABC>` and `:alarm_clock:` here',
    '<div class="mdtxt"><p>literal <code>&lt;@U012ABC&gt;</code> and <code>:alarm_clock:</code> here</p></div>'
  ],
  [
    'a fence shields control tokens',
    '```\n<@U012ABC> <https://example.test|x> :rocket:\n```',
    '<div class="mdtxt"><pre><code>&lt;@U012ABC&gt; &lt;https://example.test|x&gt; :rocket:\n</code></pre></div>'
  ],
  [
    'a fence keeps its language',
    '```ts\nconst a = 1 // <#C1|c>\n```',
    '<div class="mdtxt"><pre><code class="language-ts">const a = 1 // &lt;#C1|c&gt;\n</code></pre></div>'
  ],
  [
    'emphasis is left to CommonMark',
    'this is **bold**, this is *single-star*, this is _under_',
    '<div class="mdtxt"><p>this is <strong>bold</strong>, this is <em>single-star</em>, this is <em>under</em></p></div>'
  ],
  [
    'gfm table',
    '| a | b |\n| - | - |\n| 1 | 2 |',
    '<div class="mdtxt"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>'
  ],
  [
    'gfm strikethrough and task list',
    '~~gone~~\n\n- [x] done\n- [ ] todo',
    '<div class="mdtxt"><p><del>gone</del></p>\n<ul class="contains-task-list">\n<li class="task-list-item"><input type="checkbox" disabled="" checked=""/> done</li>\n<li class="task-list-item"><input type="checkbox" disabled=""/> todo</li>\n</ul></div>'
  ],
  [
    'single newlines become breaks (remark-breaks)',
    'line one\nline two\nline three',
    '<div class="mdtxt"><p>line one<br/>\nline two<br/>\nline three</p></div>'
  ],
  [
    'HTML entities decode after the token rewrites',
    'a &lt;tag&gt; &amp; more',
    '<div class="mdtxt"><p>a &lt;tag&gt; &amp; more</p></div>'
  ],
  [
    'heading and blockquote',
    '# Title\n\n> quoted\n\nafter',
    '<div class="mdtxt"><h1>Title</h1>\n<blockquote>\n<p>quoted</p>\n</blockquote>\n<p>after</p></div>'
  ],
  [
    'ordered list with inline code',
    '1. first\n2. second `x`',
    '<div class="mdtxt"><ol>\n<li>first</li>\n<li>second <code>x</code></li>\n</ol></div>'
  ],
  [
    'a bare url autolinks',
    'https://example.test/plain',
    '<div class="mdtxt"><p><a href="https://example.test/plain" target="_blank" rel="noopener noreferrer">https://example.test/plain</a></p></div>'
  ],
  [
    'everything at once',
    'hi <@U1|ada> :rocket: see <https://example.test|docs> in <#C1|dev>\n`<@U2>` **bold**',
    '<div class="mdtxt"><p>hi @ada 🚀 see <a href="https://example.test" target="_blank" rel="noopener noreferrer">docs</a> in #dev<br/>\n<code>&lt;@U2&gt;</code> <strong>bold</strong></p></div>'
  ],
  ['empty', '', '<div class="mdtxt"></div>'],
  ['whitespace only', '   ', '<div class="mdtxt"></div>']
]

/** Every key a transcript row can arrive with: the registered platforms, the
 *  core-owned session kinds that are not modules, ids no module claims, and the
 *  absent key a single-session page passes when the session has no platform. */
const PLATFORM_KEYS = [
  undefined,
  '',
  ...platformRegistry.ids(),
  'webchat',
  'playground',
  'hook',
  'github',
  'lark',
  'linear',
  'Slack',
  'constructor',
  '__proto__'
]

describe('MessageText', () => {
  it.each(CORPUS)('renders %s exactly as the pre-registry renderer did', (_name, input, html) => {
    expect(renderToStaticMarkup(<MessageText text={input} />)).toBe(html)
  })

  it('resolves the same default renderer for every platform key, registered or not', () => {
    // No module publishes a `textRenderer` yet — §10 ships the registry with
    // the Slack renderer as the default for all chat platforms and lands
    // overrides separately. An unknown key must reach that default too, never
    // throw and never fall through to nothing.
    for (const [name, input, html] of CORPUS) {
      for (const platform of PLATFORM_KEYS) {
        expect(renderToStaticMarkup(<MessageText text={input} platform={platform} />), `${name} @ ${platform}`).toBe(
          html
        )
      }
    }
  })

  it('skips the parser above the size cap instead of rendering markdown', () => {
    // The cheap pre-wrapped path is what keeps a pathological reasoning row
    // affordable; it must survive the seam, and it must not rewrite tokens.
    const huge = `<@U1|ada> **bold** ${'x'.repeat(100_001)}`
    const markup = renderToStaticMarkup(<MessageText text={huge} platform="slack" />)
    expect(markup.startsWith('<div class="mdtxt"><p class="whitespace-pre-wrap">&lt;@U1|ada&gt; **bold** x')).toBe(true)
    expect(markup).not.toContain('<strong>')
  })
})
