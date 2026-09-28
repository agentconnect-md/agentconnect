// The one thing the viewer header states about a file that is not measured from its bytes: what language it is. A wrong name is worse than none, so an unmapped extension has to answer null.

import { describe, expect, it } from 'vitest'
import { langForName, languageLabel, splitHtmlLines } from './highlight'

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

describe('splitHtmlLines', () => {
  it('gives each line its own balanced markup, reopening a span that crosses a newline', () => {
    expect(splitHtmlLines('<span class="c">/* a\nb */</span> x\ny')).toEqual([
      '<span class="c">/* a</span>',
      '<span class="c">b */</span> x',
      'y'
    ])
  })

  it('takes CRLF as one line break and leaves no carriage return behind', () => {
    expect(splitHtmlLines('<span class="c">a\r\nb</span>\r\nc')).toEqual([
      '<span class="c">a</span>',
      '<span class="c">b</span>',
      'c'
    ])
  })

  it('keeps nested spans and a trailing empty line', () => {
    expect(splitHtmlLines('<b class="k"><i>a\nb</i></b>\n')).toEqual([
      '<b class="k"><i>a</i></b>',
      '<b class="k"><i>b</i></b>',
      ''
    ])
  })
})
