import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FileBrowserLayout, FileBrowserPreviewHeader, FileBrowserRow, FileBrowserShell } from './FileBrowser'

describe('shared file browser', () => {
  it('renders selected files with one shared navigation state', () => {
    const html = renderToStaticMarkup(
      createElement(FileBrowserRow, {
        icon: 'file-text',
        name: 'contacts.md',
        selected: true,
        onClick: () => undefined
      })
    )

    expect(html).toContain('<button')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('border-r-(--brand)')
    expect(html).toContain('bg-(--brand-soft)')
  })

  it('uses the Workspace-width desktop frame for every browser', () => {
    const html = renderToStaticMarkup(
      createElement(FileBrowserLayout, {
        tree: () => createElement('span', null, 'tree'),
        preview: () => createElement('span', null, 'preview')
      })
    )

    expect(html).toContain('grid-cols-[260px_1fr]')
    expect(html).toContain('tree')
    expect(html).toContain('preview')
  })

  it('shares card and selected-file headers, including back and action slots', () => {
    const shell = renderToStaticMarkup(
      createElement(FileBrowserShell, {
        title: 'Memory',
        headerEnd: createElement('button', null, 'New'),
        children: createElement('div', null, 'body')
      })
    )
    const preview = renderToStaticMarkup(
      createElement(FileBrowserPreviewHeader, {
        icon: 'file-text',
        name: 'contacts.md',
        actions: createElement('button', null, 'Edit'),
        onBack: () => undefined
      })
    )

    expect(shell).toContain('cardhead')
    expect(shell).toContain('Memory')
    expect(shell).toContain('New')
    expect(preview).toContain('aria-label="Back to files"')
    expect(preview).toContain('contacts.md')
    expect(preview).toContain('Edit')
  })
})
