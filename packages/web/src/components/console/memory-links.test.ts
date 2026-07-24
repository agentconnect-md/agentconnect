import { describe, expect, it } from 'vitest'
import { memoryFileFromHref, resolveMemoryMarkdownLink } from './memory-links'

describe('memoryFileFromHref', () => {
  it('resolves flat sibling Markdown files', () => {
    expect(memoryFileFromHref('contacts.md')).toBe('contacts.md')
    expect(memoryFileFromHref('./contacts.md')).toBe('contacts.md')
    expect(memoryFileFromHref('MEMORY.md')).toBe('MEMORY.md')
    expect(memoryFileFromHref('contacts.md?view=full#people')).toBe('contacts.md')
  })

  it('decodes valid flat file names exactly once', () => {
    expect(memoryFileFromHref('release%20notes.md')).toBe('release notes.md')
    expect(memoryFileFromHref('r%C3%A9sum%C3%A9.md')).toBe('résumé.md')
    expect(memoryFileFromHref('contacts%252Emd')).toBeNull()
  })

  it('does not treat browser URLs or fragments as memory files', () => {
    expect(memoryFileFromHref('https://example.com/contacts.md')).toBeNull()
    expect(memoryFileFromHref('mailto:owner@example.com')).toBeNull()
    expect(memoryFileFromHref('//example.com/contacts.md')).toBeNull()
    expect(memoryFileFromHref('/contacts.md')).toBeNull()
    expect(memoryFileFromHref('#contacts')).toBeNull()
    expect(memoryFileFromHref('?file=contacts.md')).toBeNull()
  })

  it('rejects nested, unsafe, malformed, and non-Markdown paths', () => {
    expect(memoryFileFromHref('../contacts.md')).toBeNull()
    expect(memoryFileFromHref('people/contacts.md')).toBeNull()
    expect(memoryFileFromHref('people%2Fcontacts.md')).toBeNull()
    expect(memoryFileFromHref('people%5Ccontacts.md')).toBeNull()
    expect(memoryFileFromHref('contacts%00.md')).toBeNull()
    expect(memoryFileFromHref('contacts%.md')).toBeNull()
    expect(memoryFileFromHref('contacts.txt')).toBeNull()
  })

  it('uses the shared action, external, and blocked link behavior', () => {
    const opened: string[] = []
    const action = resolveMemoryMarkdownLink('contacts.md', (name) => opened.push(name))

    expect(action?.kind).toBe('action')
    if (action?.kind === 'action') action.onActivate()
    expect(opened).toEqual(['contacts.md'])
    expect(resolveMemoryMarkdownLink('https://example.com', () => undefined)).toBeUndefined()
    expect(resolveMemoryMarkdownLink('mailto:owner@example.com', () => undefined)).toBeUndefined()
    expect(resolveMemoryMarkdownLink('../contacts.md', () => undefined)).toEqual({ kind: 'blocked' })
    expect(resolveMemoryMarkdownLink('#contacts', () => undefined)).toEqual({ kind: 'blocked' })
  })
})
