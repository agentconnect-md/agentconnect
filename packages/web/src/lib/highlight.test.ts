// The one thing the viewer header states about a file that is not measured from its bytes: what language it is. A wrong name is worse than none, so an unmapped extension has to answer null.

import { describe, expect, it } from 'vitest'
import { langForName, languageLabel } from './highlight'

describe('languageLabel', () => {
  it('names the language a mapped extension highlights as', () => {
    expect(languageLabel('page.tsx')).toBe('TypeScript')
    expect(languageLabel('server.mjs')).toBe('JavaScript')
    expect(languageLabel('main.rs')).toBe('Rust')
    expect(languageLabel('deploy.sh')).toBe('Shell')
    expect(languageLabel('README.md')).toBe('Markdown')
  })

  it('names an extension that only SHARES a highlighter after itself, not after the highlighter', () => {
    // All four highlight as another language, and calling an HTML file "XML" would be wrong where highlighting it as XML is merely approximate.
    expect(langForName('index.html')).toBe('xml')
    expect(languageLabel('index.html')).toBe('HTML')
    expect(languageLabel('logo.svg')).toBe('SVG')
    expect(languageLabel('App.vue')).toBe('Vue')
    expect(langForName('pyproject.toml')).toBe('ini')
    expect(languageLabel('pyproject.toml')).toBe('TOML')
    expect(languageLabel('setup.ini')).toBe('INI')
  })

  it('names the extensionless files the highlighter knows by name', () => {
    expect(languageLabel('Dockerfile')).toBe('Dockerfile')
    expect(languageLabel('makefile')).toBe('Makefile')
  })

  it('answers null rather than guessing at an extension nothing maps', () => {
    // The highlighter still auto-detects these; auto-detection is just not something to put a name on in a header.
    expect(languageLabel('notes.wat')).toBeNull()
    expect(languageLabel('LICENSE')).toBeNull()
    expect(languageLabel('archive.tar.zst')).toBeNull()
  })
})
