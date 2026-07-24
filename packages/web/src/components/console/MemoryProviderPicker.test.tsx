import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemoryProviderPicker } from './MemoryProviderPicker'

describe('MemoryProviderPicker', () => {
  it('renders Managed, Native, and External together with Off separated last', () => {
    const html = renderToStaticMarkup(<MemoryProviderPicker value="external" onChange={() => undefined} />)

    expect(html.indexOf('Managed')).toBeLessThan(html.indexOf('Native'))
    expect(html.indexOf('Native')).toBeLessThan(html.indexOf('External'))
    expect(html.indexOf('External')).toBeLessThan(html.indexOf('Off'))
    expect(html).not.toContain('>None<')
    expect(html.match(/class="pillbar"/g)).toHaveLength(2)
    expect(html).toContain('data-memory-provider="external" class="pill on')
  })
})
