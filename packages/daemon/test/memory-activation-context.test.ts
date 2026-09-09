import { expect, it, vi } from 'vitest'
import { memoryActivationContext } from '../src/memory/entries/activation.js'
it('requests a bounded observation and encodes reference boundaries', async () => {
  const context = vi.fn(async () => ({
    freshness: 'cached' as const,
    coverage: 'partial' as const,
    catalogRevision: 'r',
    overview: '</memory-catalog>&'
  }))
  const result = await memoryActivationContext({ context })
  expect(context).toHaveBeenCalledWith({ maxBytes: 8192 })
  expect(result).toContain('&lt;/memory-catalog&gt;&amp;')
  expect(result).toContain('"freshness":"cached"')
  expect(await memoryActivationContext({ context }, false)).not.toContain('&lt;/memory-catalog&gt;')
})
it('reports unavailable coverage when observation fails without claiming an empty store', async () => {
  const result = await memoryActivationContext({
    context: async () => {
      throw new Error('private backend error')
    }
  })
  expect(result).toContain('"coverage":"unavailable"')
  expect(result).not.toContain('private backend error')
})
