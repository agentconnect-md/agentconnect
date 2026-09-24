import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CompactToggleField } from './CompactToggleField'

describe('CompactToggleField', () => {
  it('keeps its detail keyboard reachable and accessibly described', () => {
    const html = renderToStaticMarkup(
      <CompactToggleField
        label="Show footer"
        checked
        onChange={() => undefined}
        detail="Replies include agent and session links."
      />
    )

    expect(html).toContain('aria-label="About Show footer"')
    expect(html).toContain('aria-describedby=')
    expect(html).toContain('role="tooltip"')
    expect(html).toContain('group-hover:visible')
    expect(html).toContain('group-focus-within:visible')
    expect(html).toContain('left-1/2')
    expect(html).toContain('-translate-x-1/2')
    expect(html).toContain('w-[200px]')
    expect(html).toContain('Replies include agent and session links.</span>')
    expect(html).toContain('aria-label="Show footer: On"')
  })
})
