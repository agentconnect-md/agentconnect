import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ContextWindowIndicator } from './ContextWindowIndicator'

describe('ContextWindowIndicator', () => {
  it('shows compact context usage with hover and focus detail', () => {
    const html = renderToStaticMarkup(<ContextWindowIndicator used={69_000} size={258_000} />)

    expect(html).toContain('aria-label="Context window"')
    expect(html).toContain('aria-describedby=')
    expect(html).toContain('role="tooltip"')
    expect(html).toContain('27% used (73% left)')
    expect(html).toContain('69K / 258K tokens used')
    expect(html).toContain('group-hover:visible')
    expect(html).toContain('group-focus-within:visible')
  })
})
