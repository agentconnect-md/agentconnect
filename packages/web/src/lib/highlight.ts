// Lite syntax highlighting for the workspace file viewer.
//
// highlight.js is loaded lazily via dynamic import (`lib/common` — ~35 common
// languages) so it is code-split into its own chunk and only pulled down the
// first time a user actually opens a file, keeping the console's initial bundle
// lean. The theme (token colors) lives in globals.css under `.hljs`, mapped onto
// the design tokens so it matches the rest of the console.

import type { HLJSApi } from 'highlight.js'

let hljsPromise: Promise<HLJSApi> | null = null

// Kick off (or reuse) the one-time load of highlight.js. Cached module-wide so
// repeated file opens don't re-import.
export function loadHljs(): Promise<HLJSApi> {
  if (!hljsPromise) {
    hljsPromise = import('highlight.js/lib/common').then((m) => m.default)
  }
  return hljsPromise
}

// Map a file name to a highlight.js language id. Covers the extensions that get
// the "code" glyph in the browser plus a few extensionless special files. Returns
// null when we have no confident mapping — the caller falls back to auto-detect.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  md: 'markdown',
  markdown: 'markdown',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  diff: 'diff',
  patch: 'diff'
}

// Extensionless files keyed by their (lowercased) basename.
const NAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.gitignore': 'bash',
  '.env': 'bash'
}

export function langForName(name: string): string | null {
  const lower = name.toLowerCase()
  if (lower.includes('.')) {
    const ext = lower.split('.').pop()!
    return EXT_LANG[ext] ?? null
  }
  return NAME_LANG[lower] ?? null
}

// What to CALL the language, for a viewer header that names what it is showing. Keyed by language id, since that is what the maps above resolve to.
const LANG_LABEL: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  java: 'Java',
  kotlin: 'Kotlin',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  php: 'PHP',
  swift: 'Swift',
  bash: 'Shell',
  sql: 'SQL',
  xml: 'XML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  yaml: 'YAML',
  ini: 'INI',
  markdown: 'Markdown',
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  diff: 'Diff'
}

// The extensions that share a highlighter with a differently-named language: `.html`/`.svg`/`.vue` all highlight as xml and `.toml` as ini, and calling an HTML file "XML" would be wrong where highlighting it as XML is merely approximate.
const EXT_LABEL: Record<string, string> = { html: 'HTML', svg: 'SVG', vue: 'Vue', toml: 'TOML' }

/** The language's display name for a file name, or null when no confident mapping exists — the caller then names no language rather than guessing one from auto-detection. */
export function languageLabel(name: string): string | null {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.split('.').pop()! : ''
  const override = ext ? EXT_LABEL[ext] : undefined
  if (override) return override
  const lang = langForName(name)
  return lang ? (LANG_LABEL[lang] ?? null) : null
}

// Highlight `code`, returning an HTML string of `<span class="hljs-…">` tokens.
// Uses the mapped language when known and registered, otherwise auto-detects.
// Returns null if highlighting throws (the caller renders plain text instead).
export function highlight(hljs: HLJSApi, code: string, name: string): string | null {
  try {
    const lang = langForName(name)
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value
    }
    return hljs.highlightAuto(code).value
  } catch {
    return null
  }
}

// ---- URL linkification for the code view ----
// Bare http(s) URLs in previewed code become real anchors (`.codelink`, styled in
// globals.css) so links read as links and are clickable, GitHub-style. We operate
// on the HTML *string*: hljs only ever emits `class="hljs-…"` attributes, so a
// `https?://` match in the text between tags is always file content, never markup.

// Raw ", ', `, <, > can't appear in escaped text, so the match naturally stops at
// them; their entity forms are cut by STOP_ENTITY below (&amp; stays — it's a
// legitimate query-string separator).
const URL_RE = /https?:\/\/[^\s<>"'`]+/g
const STOP_ENTITY = /&(?:lt|gt|quot|#39|#x27);/i

// Escape plain text for HTML injection — the code-view fallback when hljs is
// unavailable, so the linkify pass has a single (HTML-string) input shape.
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )
}

// `)` / `]` stay only while balanced — keeps wiki-style `Foo_(bar)` URLs intact
// but drops the closer of a surrounding `(https://…)`.
function isBalanced(s: string, closer: ')' | ']'): boolean {
  const opener = closer === ')' ? '(' : '['
  let n = 0
  for (const ch of s) {
    if (ch === opener) n++
    else if (ch === closer) n--
  }
  return n >= 0
}

// Trim a raw match down to the URL a reader would mean: cut at escaped
// terminator entities, then peel trailing prose punctuation and unbalanced closers.
function trimUrl(raw: string): string {
  let url = raw
  const stop = url.search(STOP_ENTITY)
  if (stop !== -1) url = url.slice(0, stop)
  for (;;) {
    const last = url[url.length - 1]
    if (last && '.,;:!?'.includes(last)) url = url.slice(0, -1)
    else if ((last === ')' || last === ']') && !isBalanced(url, last)) url = url.slice(0, -1)
    else return url
  }
}

// Wrap bare URLs in highlighted (or escaped-plain) code HTML with anchor tags.
// hljs spans are purely stylistic, so the text is contiguous file content across
// tags and a URL may straddle a token boundary (e.g. markdown emphasis opening
// mid-URL at a `_`). We therefore match on the *joined* text of all segments and
// wrap each covered piece per-segment — adjacent anchors share the full href, so
// they render and click as one link. Entities inside the match (e.g. &amp;) are
// kept verbatim; the HTML parser decodes them in the href attribute.
export function linkifyHtml(html: string): string {
  const parts = html.split(/(<[^>]*>)/) // even indices are text, odd are tags
  let full = ''
  const starts: number[] = [] // offset of each part's text within `full`
  for (let i = 0; i < parts.length; i++) {
    starts.push(full.length)
    if (i % 2 === 0) full += parts[i]!
  }
  const spans: { start: number; end: number; url: string }[] = []
  for (const m of full.matchAll(URL_RE)) {
    const url = trimUrl(m[0])
    if (url) spans.push({ start: m.index, end: m.index + url.length, url })
  }
  if (spans.length === 0) return html

  let out = ''
  let si = 0 // spans and parts are both in text order — walk them together
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (i % 2) {
      out += part
      continue
    }
    const base = starts[i]!
    let cursor = 0
    for (let j = si; j < spans.length; j++) {
      const s = spans[j]!
      if (s.end <= base) {
        si = j + 1
        continue
      }
      if (s.start >= base + part.length) break
      const a = Math.max(s.start - base, 0)
      const b = Math.min(s.end - base, part.length)
      if (a >= b) continue
      out += part.slice(cursor, a)
      out += `<a class="codelink" href="${s.url}" target="_blank" rel="noopener noreferrer">${part.slice(a, b)}</a>`
      cursor = b
      if (s.end <= base + part.length) si = j + 1 // fully emitted — skip next part
    }
    out += part.slice(cursor)
  }
  return out
}
