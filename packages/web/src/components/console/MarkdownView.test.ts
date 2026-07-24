import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import MarkdownView, { type MarkdownLinkResolution } from './MarkdownView'
import { resolveWorkspaceMarkdownLink } from './workspace-links'

const render = (content: string, resolveLink?: (href: string) => MarkdownLinkResolution | undefined) =>
  renderToStaticMarkup(createElement(MarkdownView, { content, resolveLink }))

describe('MarkdownView links', () => {
  it('renders resolved in-app links without a browser href', () => {
    const html = render('[contacts](contacts.md)', (href) =>
      href === 'contacts.md' ? { kind: 'action', onActivate: () => undefined } : undefined
    )

    expect(html).toContain('<button')
    expect(html).toContain('>contacts</button>')
    expect(html).not.toContain('href="contacts.md"')
  })

  it('preserves isolated new-tab anchors for unresolved links', () => {
    const html = render('[OpenAI](https://openai.com)', () => undefined)

    expect(html).toContain('href="https://openai.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('renders resolved workspace links as in-app actions', () => {
    const html = render('[guide](docs/guide.md)', (href) =>
      resolveWorkspaceMarkdownLink('README.md', href, () => undefined)
    )

    expect(html).toContain('<button')
    expect(html).toContain('>guide</button>')
    expect(html).not.toContain('href="docs/guide.md"')
  })

  it.each(['../outside.md', '/setup.md', '#section', '?plain=1'])(
    'renders unavailable local workspace href %s without browser navigation',
    (href) => {
      const html = render(`[link](${href})`, (candidate) =>
        resolveWorkspaceMarkdownLink('README.md', candidate, () => undefined)
      )

      expect(html).toContain('<span')
      expect(html).toContain('aria-disabled="true"')
      expect(html).not.toContain('<a')
      expect(html).not.toContain('target="_blank"')
    }
  )
})
