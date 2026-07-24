import { describe, expect, it } from 'vitest'
import type { WorkspaceFile } from '@/lib/data'
import { indexWorkspaceFileTree, resolveWorkspaceMarkdownLink, workspaceFileFromHref } from './workspace-links'

describe('workspaceFileFromHref', () => {
  it('resolves sibling, nested, and parent workspace files', () => {
    expect(workspaceFileFromHref('README.md', 'docs/guide.md')).toEqual({
      path: 'docs/guide.md',
      name: 'guide.md'
    })
    expect(workspaceFileFromHref('docs/guide.md', 'setup.md')).toEqual({ path: 'docs/setup.md', name: 'setup.md' })
    expect(workspaceFileFromHref('docs/guide.md', './api/auth.md')).toEqual({
      path: 'docs/api/auth.md',
      name: 'auth.md'
    })
    expect(workspaceFileFromHref('docs/guide.md', '../README.md')).toEqual({ path: 'README.md', name: 'README.md' })
    expect(workspaceFileFromHref('docs/guide.md', '../src/index.ts')).toEqual({
      path: 'src/index.ts',
      name: 'index.ts'
    })
  })

  it('strips query strings and fragments before selecting the file', () => {
    expect(workspaceFileFromHref('docs/guide.md', 'setup.md?plain=1#install')).toEqual({
      path: 'docs/setup.md',
      name: 'setup.md'
    })
  })

  it('decodes file names exactly once without accepting encoded separators', () => {
    expect(workspaceFileFromHref('docs/guide.md', 'release%20notes.md')).toEqual({
      path: 'docs/release notes.md',
      name: 'release notes.md'
    })
    expect(workspaceFileFromHref('docs/guide.md', 'r%C3%A9sum%C3%A9.md')).toEqual({
      path: 'docs/résumé.md',
      name: 'résumé.md'
    })
    expect(workspaceFileFromHref('docs/guide.md', 'nested%2Ffile.md')).toBeNull()
    expect(workspaceFileFromHref('docs/guide.md', 'nested%5Cfile.md')).toBeNull()
    expect(workspaceFileFromHref('docs/nested/guide.md', '%2e%2e/README.md')).toEqual({
      path: 'docs/README.md',
      name: 'README.md'
    })
    expect(workspaceFileFromHref('README.md', '%2e%2e/outside.md')).toBeNull()
  })

  it('does not turn browser URLs or document-only references into workspace files', () => {
    expect(workspaceFileFromHref('docs/guide.md', 'https://example.com/setup.md')).toBeNull()
    expect(workspaceFileFromHref('docs/guide.md', 'mailto:owner@example.com')).toBeNull()
    expect(workspaceFileFromHref('docs/guide.md', '//example.com/setup.md')).toBeNull()
    expect(workspaceFileFromHref('docs/guide.md', '/setup.md')).toBeNull()
    expect(workspaceFileFromHref('docs/guide.md', '#install')).toBeNull()
    expect(workspaceFileFromHref('docs/guide.md', '?plain=1')).toBeNull()
  })

  it('rejects root escapes, directory targets, malformed encoding, and unsafe paths', () => {
    expect(workspaceFileFromHref('README.md', '../outside.md')).toBeNull()
    expect(workspaceFileFromHref('docs/guide.md', '../../outside.md')).toBeNull()
    expect(workspaceFileFromHref('docs/guide.md', './')).toBeNull()
    expect(workspaceFileFromHref('docs/guide.md', '../')).toBeNull()
    expect(workspaceFileFromHref('docs/nested/guide.md', '%2e%2e')).toBeNull()
    expect(workspaceFileFromHref('docs/guide.md', 'bad%.md')).toBeNull()
    expect(workspaceFileFromHref('docs/guide.md', 'bad%00.md')).toBeNull()
    expect(workspaceFileFromHref('docs/guide.md', '..\\outside.md')).toBeNull()
  })

  it('indexes exact mock workspace paths even when basenames repeat', () => {
    const rootReadme: WorkspaceFile = { icon: 'file-text', name: 'README.md', meta: '', content: 'root' }
    const guide: WorkspaceFile = { icon: 'file-text', name: 'guide.md', meta: '', content: 'guide' }
    const nestedReadme: WorkspaceFile = { icon: 'file-text', name: 'README.md', meta: '', content: 'nested' }
    const files: WorkspaceFile[] = [
      rootReadme,
      {
        icon: 'folder',
        name: 'docs',
        meta: '',
        children: [guide, nestedReadme]
      }
    ]

    const index = indexWorkspaceFileTree(files)
    const fromRoot = workspaceFileFromHref(index.byFile.get(rootReadme)!, 'docs/guide.md')
    const fromGuide = workspaceFileFromHref(index.byFile.get(guide)!, '../README.md')

    expect(index.byPath.get(fromRoot!.path)).toBe(guide)
    expect(index.byPath.get(fromGuide!.path)).toBe(rootReadme)
    expect(index.byPath.get('docs/README.md')).toBe(nestedReadme)
    expect(index.byPath.get('docs/missing.md')).toBeUndefined()
  })

  it('separates external anchors, workspace actions, and blocked local links', () => {
    const opened: string[] = []
    const action = resolveWorkspaceMarkdownLink('README.md', 'docs/guide.md', (target) => opened.push(target.path))

    expect(action?.kind).toBe('action')
    if (action?.kind === 'action') action.onActivate()
    expect(opened).toEqual(['docs/guide.md'])
    expect(resolveWorkspaceMarkdownLink('README.md', 'https://example.com', () => undefined)).toBeUndefined()
    expect(resolveWorkspaceMarkdownLink('README.md', '//example.com/guide.md', () => undefined)).toBeUndefined()
    expect(resolveWorkspaceMarkdownLink('README.md', '../outside.md', () => undefined)).toEqual({ kind: 'blocked' })
    expect(resolveWorkspaceMarkdownLink('README.md', '#section', () => undefined)).toEqual({ kind: 'blocked' })
  })

  it('blocks missing mock files instead of returning a no-op action', () => {
    const resolution = resolveWorkspaceMarkdownLink(
      'README.md',
      'docs/missing.md',
      () => undefined,
      () => false
    )

    expect(resolution).toEqual({ kind: 'blocked' })
  })
})
