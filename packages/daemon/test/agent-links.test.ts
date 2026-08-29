import { describe, expect, it } from 'vitest'
import { flattenUnsafeLinks } from '../src/messages/agent-links.js'

describe('flattenUnsafeLinks', () => {
  it('flattens the host path a runtime links to its file, keeping the label and the basename', () => {
    const written =
      'Created [today’s Reddit engagement digest](/home/sentio/.agentconnect/agents/agentconnect/workspace/reddit-research/digests/reddit-engagement-digest-2026-08-29.md).'

    expect(flattenUnsafeLinks(written)).toBe(
      'Created today’s Reddit engagement digest (`reddit-engagement-digest-2026-08-29.md`).'
    )
  })

  it.each([
    'https://github.com/agentconnect-md/agentconnect/pull/1',
    'http://app.example.test/x',
    'HTTPS://app.example.test/x',
    'mailto:someone@example.test'
  ])('leaves a web target alone: %s', (dest) => {
    expect(flattenUnsafeLinks(`see [the thread](${dest})`)).toBe(`see [the thread](${dest})`)
  })

  it.each([
    { dest: '/var/log/agent.log', display: 'agent.log' },
    { dest: 'C:\\Users\\agent\\notes.md', display: 'notes.md' },
    { dest: 'file:///srv/data/report.csv', display: 'report.csv' },
    { dest: '/home/sentio/workspace/', display: 'workspace' }
  ])('reduces the host-absolute target $dest to its basename', ({ dest, display }) => {
    expect(flattenUnsafeLinks(`open [it](${dest})`)).toBe(`open it (\`${display}\`)`)
  })

  it('keeps a relative target whole — it names a file without naming the host layout', () => {
    expect(flattenUnsafeLinks('see [the digest](reddit-research/digests/today.md)')).toBe(
      'see the digest (`reddit-research/digests/today.md`)'
    )
  })

  it('drops an in-document anchor entirely, leaving prose rather than a dangling target', () => {
    expect(flattenUnsafeLinks('see [the caveats](#caveats) first')).toBe('see the caveats first')
  })

  it('does not repeat a target the label already spells out', () => {
    expect(flattenUnsafeLinks('wrote [notes.md](/srv/agent/notes.md)')).toBe('wrote notes.md')
  })

  it('keeps only the target of an image, whose alt text describes a picture nobody receives', () => {
    expect(flattenUnsafeLinks('![a bar chart](/tmp/out/chart.png)')).toBe('`chart.png`')
  })

  it('handles the bracketed target form and a trailing CommonMark title', () => {
    expect(flattenUnsafeLinks('[a](</tmp/x y.md>)')).toBe('a (`x y.md`)')
    expect(flattenUnsafeLinks('[a](/tmp/x.md "the title")')).toBe('a (`x.md`)')
  })

  it('rewrites every link in a message, not just the first', () => {
    expect(flattenUnsafeLinks('[a](/t/a.md) and [b](/t/b.md) and [c](https://example.test)')).toBe(
      'a (`a.md`) and b (`b.md`) and [c](https://example.test)'
    )
  })

  it('leaves a fenced sample of the syntax verbatim — it is documentation, not a link', () => {
    const text = [
      'Use it like this:',
      '',
      '```md',
      '[label](/abs/path.md)',
      '```',
      '',
      'then [go](/abs/path.md).'
    ].join('\n')

    expect(flattenUnsafeLinks(text)).toBe(
      ['Use it like this:', '', '```md', '[label](/abs/path.md)', '```', '', 'then go (`path.md`).'].join('\n')
    )
  })

  it('closes a fence only on a run at least as long as the one that opened it', () => {
    const text = ['````', '```', '[a](/t/a.md)', '````', '[b](/t/b.md)'].join('\n')

    expect(flattenUnsafeLinks(text)).toBe(['````', '```', '[a](/t/a.md)', '````', 'b (`b.md`)'].join('\n'))
  })

  it('leaves an inline code span verbatim while rewriting the prose around it', () => {
    expect(flattenUnsafeLinks('run `[x](/a/b.md)` then [y](/a/c.md)')).toBe('run `[x](/a/b.md)` then y (`c.md`)')
  })

  describe('on a surface that resolves relative targets itself', () => {
    const onCodeHost = (text: string) => flattenUnsafeLinks(text, { resolvesRelativeTargets: true })

    it.each(['[the doc](docs/design.md)', '[the caveats](#caveats)', '[home](https://example.test)'])(
      'keeps %s linked — the code host resolves it against the repository',
      (text) => {
        expect(onCodeHost(text)).toBe(text)
      }
    )

    it('still flattens a host-absolute target, which resolves nowhere and names the daemon host', () => {
      expect(onCodeHost('wrote [the report](/home/sentio/workspace/report.md)')).toBe('wrote the report (`report.md`)')
    })
  })

  it('returns text with no link syntax untouched, including an unclosed backtick run', () => {
    for (const text of ['', 'plain prose', 'a ` dangling backtick', '```\nunclosed fence\n']) {
      expect(flattenUnsafeLinks(text)).toBe(text)
    }
  })
})
