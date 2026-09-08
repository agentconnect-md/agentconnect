import { describe, expect, it } from 'vitest'
import { fromMarkdown } from 'mdast-util-from-markdown'
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

  it('flattens an image link as one link — the outer target must not survive the inner rewrite', () => {
    expect(flattenUnsafeLinks('[![chart](chart.png)](/home/a/report.html)')).toBe('`chart.png` (`report.html`)')
  })

  it('flattens a nested target even when the outer link is kept', () => {
    expect(flattenUnsafeLinks('[![chart](/home/a/c.png)](https://example.test)')).toBe(
      '[`c.png`](https://example.test)'
    )
  })

  it('keeps a safe outer link with literal brackets when rewriting an image in its label', () => {
    const result = flattenUnsafeLinks('[[label] ![chart](/tmp/chart.png)](https://example.test/report)')
    expect(fromMarkdown(result).children[0]).toMatchObject({
      type: 'paragraph',
      children: [{ type: 'link', url: 'https://example.test/report' }]
    })
    expect(result).not.toContain('/tmp/')
  })

  // Preserve dollar sequences as text, and keep the originally literal outer syntax inert.
  it.each([
    ['[a $$ b [log](/tmp/a.log)](https://ci.test)', '\\[a $$ b log (`a.log`)\\](https://ci.test)'],
    ['[$& label [i](/x/i.md)](https://e.test)', '\\[$& label i (`i.md`)\\](https://e.test)'],
    ["[$` and $' [i](/x/i.md)](https://e.test)", "\\[$` and $' i (`i.md`)\\](https://e.test)"]
  ])('keeps dollar sequences and surrounding literal text intact: %s', (input, expected) => {
    expect(flattenUnsafeLinks(input)).toBe(expected)
  })

  it('matches a label carrying brackets, which used to leave its target live', () => {
    expect(flattenUnsafeLinks('see [[wiki]](/a/b.md)')).toBe('see [wiki] (`b.md`)')
  })

  it('rewrites a link whose LABEL is inline code — the span is part of the link, not a sample', () => {
    expect(flattenUnsafeLinks('wrote [`out.md`](/home/agent/out.md)')).toBe('wrote `out.md`')
    expect(flattenUnsafeLinks('see [`the report`](/home/agent/r.html)')).toBe('see `the report` (`r.html`)')
  })

  it('leaves an inline code span verbatim while rewriting the prose around it', () => {
    expect(flattenUnsafeLinks('run `[x](/a/b.md)` then [y](/a/c.md)')).toBe('run `[x](/a/b.md)` then y (`c.md`)')
  })

  describe('reference-style links', () => {
    it('flattens full, collapsed and shortcut references and removes their shared host definition', () => {
      const text =
        'See [the digest][DAILY   REPORT], [daily report][], and [daily report].\n\n' +
        '[Daily report]: </home/agent/digest.md> "Draft"'

      expect(flattenUnsafeLinks(text).trimEnd()).toBe(
        'See the digest (`digest.md`), daily report (`digest.md`), and daily report (`digest.md`).'
      )
    })

    it('preserves safe references and their original definitions byte for byte', () => {
      const text =
        'See [the docs][DOCS], [docs][], [docs], and [email].\n\n' +
        '[DoCs]: <https://example.test/docs?a=1&b=2>\n  "Original title"\n' +
        '[email]: mailto:agent@example.test\n'

      expect(flattenUnsafeLinks(text)).toBe(text)
    })

    it.each(['FILE:///home/agent/out.md', 'file:/home/agent/out.md', 'C:\\Users\\agent\\out.md'])(
      'removes file targets from references in chat and code-host replies: %s',
      (target) => {
        const text = `[report][r]\n\n[r]: ${target}`
        expect(flattenUnsafeLinks(text).trimEnd()).toBe('report (`out.md`)')
        expect(flattenUnsafeLinks(text, { resolvesRelativeTargets: true }).trimEnd()).toBe('report (`out.md`)')
      }
    )

    it('keeps decoded backticks in a filename inside inline code', () => {
      expect(flattenUnsafeLinks('[report][r]\n\n[r]: /home/agent/a&#96;b.md').trimEnd()).toBe('report (``a`b.md``)')
    })

    it('preserves code samples, escaped brackets and unresolved prose while rewriting a real reference', () => {
      const sample = [
        '`[r]` and \\[r] and [unresolved].',
        '',
        '```md',
        '[file][r]',
        '[r]: /home/agent/example.md',
        '```',
        '',
        '    [file][r]',
        '    [r]: /home/agent/indented.md'
      ].join('\n')
      const text = `${sample}\n\nActual [file][r].\n\n[r]: /home/agent/out.md`

      expect(flattenUnsafeLinks(text).trimEnd()).toBe(`${sample}\n\nActual file (\`out.md\`).`)
    })

    it.each([
      {
        definitions: '[r]: https://example.test/report\n[r]: /home/agent/private.md',
        expectedBody: '[report][r]'
      },
      {
        definitions: '[r]: /home/agent/private.md\n[r]: https://example.test/report',
        expectedBody: 'report (`private.md`)'
      }
    ])(
      'resolves duplicate labels using the first definition and removes host targets: $definitions',
      ({ definitions, expectedBody }) => {
        const result = flattenUnsafeLinks(`[report][r]\n\n${definitions}`)

        expect(result.split('\n')[0]).toBe(expectedBody)
        expect(result).toContain('[r]: https://example.test/report')
        expect(result).not.toContain('/home/')
      }
    )

    it('flattens both targets of a reference image linked to a host file', () => {
      const text = '[![chart][img]][report]\n\n[img]: /tmp/chart.png\n[report]: /home/agent/report.html'

      expect(flattenUnsafeLinks(text).trimEnd()).toBe('`chart.png` (`report.html`)')
    })

    it('keeps a safe outer reference linked after flattening its image label', () => {
      const text = '[![chart][img]][report]\n\n[img]: /tmp/chart.png\n[report]: https://example.test/report'
      const result = flattenUnsafeLinks(text)

      expect(result).toContain('[`chart.png`][report]')
      expect(result).toContain('[report]: https://example.test/report')
      expect(result).not.toContain('/tmp/')
      expect(result).not.toContain('[img]')
    })
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

    it('keeps repository and fragment references while removing a host reference from the same reply', () => {
      const safe = '[doc][] and [section].\n\n[doc]: docs/design.md\n[section]: #caveats'
      const result = onCodeHost(`${safe}\n\nSaved [report][host].\n\n[host]: file:///home/agent/report.md`)

      expect(result.trimEnd()).toBe(`${safe}\n\nSaved report (\`report.md\`).`)
    })
  })

  it('returns text with no link syntax untouched, including an unclosed backtick run', () => {
    for (const text of ['', 'plain prose', 'a ` dangling backtick', '```\nunclosed fence\n']) {
      expect(flattenUnsafeLinks(text)).toBe(text)
    }
  })
})
