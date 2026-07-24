import { describe, expect, it } from 'vitest'
import { renderAttributionMessage } from '../src/messages/attribution.js'

describe('renderAttributionMessage', () => {
  it.each([
    { runtime: 'Codex', model: undefined, identity: 'Codex' },
    { runtime: undefined, model: 'gpt-5.6-luna', identity: 'gpt-5.6-luna' },
    { runtime: undefined, model: undefined, identity: undefined }
  ])('omits unavailable runtime/model fields without dangling chrome', ({ runtime, model, identity }) => {
    const rendered = renderAttributionMessage({
      agent: 'review-bot',
      runtime,
      model,
      renderSession: (label) => `[${label}]`
    })

    expect(rendered).toBe(`sent by review-bot${identity ? ` (${identity})` : ''} · [open in session]`)
  })

  it('omits the session link and separator when no session renderer is provided', () => {
    expect(renderAttributionMessage({ agent: 'review-bot', runtime: 'Codex', model: 'gpt-5.6-luna' })).toBe(
      'sent by review-bot (Codex · gpt-5.6-luna)'
    )
  })

  it('omits the session clause when its renderer returns no visible content', () => {
    const parts = { agent: 'review-bot', runtime: 'Codex', model: 'gpt-5.6-luna' }
    const expected = 'sent by review-bot (Codex · gpt-5.6-luna)'

    expect(renderAttributionMessage({ ...parts, renderSession: () => undefined })).toBe(expected)
    expect(renderAttributionMessage({ ...parts, renderSession: () => ' \t ' })).toBe(expected)
  })
})
