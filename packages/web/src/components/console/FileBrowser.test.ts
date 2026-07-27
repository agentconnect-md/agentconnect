import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  FileBrowserBreadcrumb,
  FileBrowserEditor,
  FileBrowserEditorActions,
  FileBrowserHistoryButton,
  FileBrowserLayout,
  FileBrowserPreviewHeader,
  FileBrowserPreviewSummary,
  FileBrowserRow,
  FileBrowserShell
} from './FileBrowser'

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
    expect(shell).toContain('min-h-[41px]')
    expect(shell).toContain('py-[6px]')
    expect(shell).toContain('Memory')
    expect(shell).toContain('New')
    expect(preview).toContain('aria-label="Back to files"')
    expect(preview).toContain('contacts.md')
    expect(preview).toContain('Edit')
  })

  it('shares one inline create surface across file browsers', () => {
    const draft = {
      target: '',
      directory: '',
      name: 'notes.md',
      content: '# Notes',
      mtime: null,
      loading: false,
      saving: false,
      error: null
    }
    const html = renderToStaticMarkup(
      createElement(FileBrowserShell, {
        title: createElement(FileBrowserBreadcrumb, {
          root: 'Memory',
          path: '',
          creating: true,
          draftName: draft.name,
          onDraftNameChange: () => undefined,
          nested: false,
          inputAriaLabel: 'New memory file name'
        }),
        headerEnd: createElement(FileBrowserEditorActions, {
          saving: false,
          onCancel: () => undefined,
          onSave: () => undefined
        }),
        children: createElement(FileBrowserEditor, {
          draft,
          onContentChange: () => undefined,
          onCancel: () => undefined,
          onSubmit: () => undefined
        })
      })
    )

    expect(html).toContain('aria-label="New memory file name"')
    expect(html).toContain('value="notes.md"')
    expect(html).toContain('h-7 min-h-7')
    expect(html).toContain('Save changes')
    expect(html).toContain('aria-label="New file content"')
    expect(html).toContain('# Notes')
  })

  it('exposes optional file capabilities in the shared summary row', () => {
    const html = renderToStaticMarkup(
      createElement(FileBrowserPreviewSummary, {
        meta: '60 B · edited 1d ago',
        actions: createElement(FileBrowserHistoryButton, {
          active: false,
          onClick: () => undefined
        })
      })
    )

    expect(html).toContain('h-[37px]')
    expect(html).toContain('60 B · edited 1d ago')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('History')
  })
})
