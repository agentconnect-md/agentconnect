// @vitest-environment happy-dom

/**
 * The rules an MCP App frame is built under (webchat-mcp-apps.md §7). These are security
 * decisions, so they are tested as such: what the sandbox withholds, what the policy refuses to
 * widen, and what a frame may not talk the browser into doing.
 */
import { describe, expect, it } from 'vitest'
import {
  MCP_APP_MAX_HEIGHT,
  MCP_APP_MIN_HEIGHT,
  MCP_APP_SANDBOX,
  buildMcpAppCsp,
  buildMcpAppDocument,
  clampAppHeight,
  isOpenableAppLink
} from './mcp-app-frame'

describe('the sandbox', () => {
  it('never grants allow-same-origin, which on the console’s origin would hand the frame the reader’s session', () => {
    expect(MCP_APP_SANDBOX).not.toContain('allow-same-origin')
    expect(MCP_APP_SANDBOX).not.toContain('allow-popups')
    expect(MCP_APP_SANDBOX).not.toContain('allow-top-navigation')
    // Scripts are the point of an app; without them the extension has nothing to render.
    expect(MCP_APP_SANDBOX).toContain('allow-scripts')
  })
})

describe('buildMcpAppCsp', () => {
  it("never emits 'none' beside a real source, which CSP would resolve by ignoring it", () => {
    const csp = buildMcpAppCsp({ resource: ['cdn.example.test'] })
    for (const directive of csp.split('; ')) {
      if (directive.includes("'none'")) expect(directive.split(' ')).toHaveLength(2)
    }
    expect(csp).toContain("script-src 'unsafe-inline' https://cdn.example.test")
    expect(csp).toContain('img-src data: blob: https://cdn.example.test')
  })

  it('denies by default, so every directive below is an explicit grant', () => {
    const csp = buildMcpAppCsp()
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
  })

  it('widens exactly the directive a declaration names, and nothing beside it', () => {
    const csp = buildMcpAppCsp({ connect: ['https://api.example.test'] })
    expect(csp).toContain('connect-src https://api.example.test')
    // A connect grant is not a resource grant: the page still cannot pull a script from there.
    expect(csp).toContain("frame-src 'none'")
    expect(csp).not.toContain('script-src https://api.example.test')
  })

  it('normalizes a bare hostname to https, so a declaration can never smuggle in plain http', () => {
    expect(buildMcpAppCsp({ resource: ['cdn.example.test'] })).toContain('https://cdn.example.test')
  })

  it('injects into the head of a COMPLETE document, keeping the doctype first', () => {
    // The shape every real MCP App template takes. Prepending the meta would drop the doctype
    // (quirks mode) and land the policy outside <head>, where browsers ignore http-equiv CSP
    // entirely — the policy would be present in the bytes and enforced by nobody.
    const doc = buildMcpAppDocument(
      '<!doctype html>\n<html lang="en"><head><title>t</title></head><body>hi</body></html>'
    )
    expect(doc.startsWith('<!doctype html>')).toBe(true)
    expect(doc).toContain('<head><meta http-equiv="Content-Security-Policy"')
    const parsed = new DOMParser().parseFromString(doc, 'text/html')
    expect(parsed.doctype).not.toBeNull()
    expect(parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.parentElement?.tagName).toBe('HEAD')
  })

  it('gives a document with no head one, rather than displacing its doctype', () => {
    const doc = buildMcpAppDocument('<!doctype html><html><body>hi</body></html>')
    expect(doc.startsWith('<!doctype html>')).toBe(true)
    const parsed = new DOMParser().parseFromString(doc, 'text/html')
    expect(parsed.doctype).not.toBeNull()
    expect(parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.parentElement?.tagName).toBe('HEAD')
  })

  it('wraps a bare fragment, because a leading meta would parse into body and be ignored', () => {
    const doc = buildMcpAppDocument('<div id="app">hi</div>', { connect: ['https://api.example.test'] })
    expect(doc).toContain('<div id="app">hi</div>')
    const parsed = new DOMParser().parseFromString(doc, 'text/html')
    expect(parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.parentElement?.tagName).toBe('HEAD')
    // And the wrapper gives it a doctype it never had, so it is standards mode rather than quirks.
    expect(parsed.doctype).not.toBeNull()
    expect(parsed.querySelector('#app')?.parentElement?.tagName).toBe('BODY')
  })

  it('never injects into a <head> written inside a COMMENT, which would comment the policy out', () => {
    // A conditional or legacy comment before the real head is ordinary hand-written HTML. Insert
    // there and the meta never reaches the DOM at all — the frame then runs with no
    // declared-domain restriction, which is strictly worse than misplacing it.
    const tpl =
      '<!doctype html>\n<html>\n<!-- legacy: <head> was here -->\n<head><title>t</title></head>\n<body>hi</body></html>'
    const doc = buildMcpAppDocument(tpl, { connect: ['https://api.example.test'] })
    expect(doc).toContain('<!-- legacy: <head> was here -->')
    const parsed = new DOMParser().parseFromString(doc, 'text/html')
    const meta = parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')
    expect(meta).not.toBeNull()
    expect(meta?.parentElement?.tagName).toBe('HEAD')
    expect(meta?.getAttribute('content')).toContain('https://api.example.test')
  })

  it('is not fooled by a <head> in a quoted attribute or in RCDATA', () => {
    // The two cases a comment-masking scanner still got wrong: the policy became inert text and
    // the frame ran with no declared-domain restriction at all.
    for (const tpl of [
      '<!doctype html><html data-x="<head>"><head><title>t</title></head><body>x</body></html>',
      '<!doctype html><html><head><title>t</title></head><body><textarea><head></textarea></body></html>'
    ]) {
      const parsed = new DOMParser().parseFromString(
        buildMcpAppDocument(tpl, { connect: ['https://a.example.test'] }),
        'text/html'
      )
      const meta = parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')
      expect(meta?.parentElement?.tagName).toBe('HEAD')
      expect(meta?.getAttribute('content')).toContain('https://a.example.test')
    }
  })

  it('ignores a <head> or <html> written inside a script or style body', () => {
    const tpl =
      '<!doctype html><html><head><script>var s = "<head>"</script><title>t</title></head><body>x</body></html>'
    const doc = buildMcpAppDocument(tpl)
    const parsed = new DOMParser().parseFromString(doc, 'text/html')
    // The real head comes first here, so the policy lands there and the script body is untouched.
    expect(parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.parentElement?.tagName).toBe('HEAD')
    expect(doc).toContain('var s = "<head>"')
  })

  it('wraps a fragment whose only <head> is inside a comment, rather than injecting into it', () => {
    const doc = buildMcpAppDocument('<!-- <head> --><div id="app">hi</div>')
    const parsed = new DOMParser().parseFromString(doc, 'text/html')
    expect(parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.parentElement?.tagName).toBe('HEAD')
    expect(parsed.querySelector('#app')).not.toBeNull()
  })

  it('leaves the template markup itself untouched in every shape', () => {
    for (const tpl of ['<!doctype html><html><head></head><body><b>x</b></body></html>', '<p>x</p>']) {
      expect(buildMcpAppDocument(tpl)).toContain(tpl.includes('<b>') ? '<b>x</b>' : '<p>x</p>')
    }
  })

  it('escapes a quote in the policy so a declaration cannot break out of the meta attribute', () => {
    const doc = buildMcpAppDocument('<p>x</p>', { connect: ['https://a.example.test"onload="alert(1)'] })
    // The domain is refused upstream; even reaching here the quote is escaped, so the policy
    // stays inside ONE attribute instead of closing it and opening an event handler.
    const attribute = doc.split('content="')[1]?.split('"')[0]
    expect(attribute).toContain('&quot;onload=&quot;')
    expect(doc).not.toContain('"onload="')
  })
})

describe('isOpenableAppLink', () => {
  it('opens only http and https, refusing every scheme a frame could use to run something', () => {
    expect(isOpenableAppLink('https://example.test/x')).toBe(true)
    expect(isOpenableAppLink('http://example.test/x')).toBe(true)
    expect(isOpenableAppLink('javascript:alert(1)')).toBe(false)
    expect(isOpenableAppLink('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isOpenableAppLink('file:///etc/passwd')).toBe(false)
    expect(isOpenableAppLink('not a url')).toBe(false)
  })
})

describe('clampAppHeight', () => {
  it('keeps a reported height inside bounds, so neither a zero page nor a runaway one takes the transcript', () => {
    expect(clampAppHeight(400)).toBe(400)
    expect(clampAppHeight(1)).toBe(MCP_APP_MIN_HEIGHT)
    expect(clampAppHeight(100_000)).toBe(MCP_APP_MAX_HEIGHT)
    expect(clampAppHeight(Number.NaN)).toBeGreaterThanOrEqual(MCP_APP_MIN_HEIGHT)
    expect(clampAppHeight(undefined)).toBeGreaterThanOrEqual(MCP_APP_MIN_HEIGHT)
  })
})
