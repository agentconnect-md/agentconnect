import { describe, expect, it } from 'vitest'
import { emailCssIsSafe, sanitizeEmailHtml } from '../src/platforms/email/html.js'

const body = (html: string): string => {
  const out = sanitizeEmailHtml(html)
  return out.slice(out.indexOf('<body>') + 6, out.indexOf('</body>'))
}

describe('an agent’s own mail HTML (§6.4)', () => {
  it('keeps layout, tables, inline styles and safe links', () => {
    expect(
      body(
        '<table class="t" style="border-collapse:collapse"><tr><td align="right" style="color:#333">¥3 &amp; up</td></tr></table>' +
          '<p><a href="https://example.test/r?a=1&b=2" title="Report">open</a> <b>now</b><br></p>'
      )
    ).toBe(
      '<table class="t" style="border-collapse:collapse"><tbody><tr><td align="right" style="color:#333">¥3 &amp; up</td></tr></tbody></table>' +
        '<p><a href="https://example.test/r?a=1&amp;b=2" title="Report">open</a> <b>now</b><br></p>'
    )
  })

  it('drops scripts, forms, images, frames and event handlers, and unwraps unknown elements', () => {
    expect(
      body(
        '<script>alert(1)</script><form action="https://x.test"><input name="p"></form><img src="https://t.test/p.gif">' +
          '<iframe src="https://x.test"></iframe><svg><image href="https://t.test/i"/></svg>' +
          '<p onclick="steal()" id="x">hi</p><article><span>kept</span></article><!-- note -->'
      )
    ).toBe('<p>hi</p><span>kept</span>')
  })

  it('keeps a link only to the web or mail, and an inline style only when it loads nothing', () => {
    expect(body('<a href="javascript:alert(1)">a</a><a href=" mailto:x@example.test ">b</a>')).toBe(
      '<a>a</a><a href="mailto:x@example.test">b</a>'
    )
    expect(body('<div style="background:url(https://t.test/p)">x</div><div style="color:red">y</div>')).toBe(
      '<div>x</div><div style="color:red">y</div>'
    )
  })

  it('carries style sheets into the head only when they load nothing, and puts the footer last', () => {
    const out = sanitizeEmailHtml(
      '<html><head><style>.t{color:red}</style><style>@import "https://t.test/a.css";</style>' +
        '<link rel="stylesheet" href="https://t.test/b.css"></head><body><p class="t">x</p></body></html>',
      '<p>sent by Helper</p>'
    )
    expect(out).toBe(
      '<!doctype html><html><head><meta charset="utf-8"><style>.t{color:red}</style></head>' +
        '<body><p class="t">x</p><hr><p>sent by Helper</p></body></html>'
    )
  })

  it('refuses CSS that fetches, however it is spelled', () => {
    for (const css of [
      'a{background:url(x)}',
      'a{background:URL (x)}',
      'a{background:u\\72l(x)}',
      'a{background:image-set("x.png" 1x)}',
      '@font-face{font-family:f;src:local(x)}',
      'a{background:ur/**/l(x)}',
      'a{behavior:url(x.htc)}'
    ])
      expect(emailCssIsSafe(css), css).toBe(false)
    expect(emailCssIsSafe('@media (max-width:600px){td{display:block}}')).toBe(true)
  })
})
