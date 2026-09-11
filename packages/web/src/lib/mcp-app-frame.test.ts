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

  it('puts the policy in front of the template and leaves the template itself untouched', () => {
    const doc = buildMcpAppDocument('<div id="app">hi</div>', { connect: ['https://api.example.test'] })
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<div id="app">'))
    expect(doc).toContain('<div id="app">hi</div>')
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
