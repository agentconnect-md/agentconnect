// Slack's Fill card (computer-form-fill-and-vault.md §6): a console link, never a field; settled text names no value.
import { describe, expect, it, vi } from 'vitest'
import { fillSettledText, type FillCardModel } from '../src/platforms/fill-card.js'
import { buildFillCard, slackFillCards } from '../src/platforms/slack/fill-card.js'

const model: FillCardModel = {
  requestId: '7f9d6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f',
  agentName: 'Ops <bot>',
  computerName: 'Desk',
  origin: 'https://login.example.test',
  fieldCount: 2,
  reason: 'Sign in to open the report',
  link: 'https://console.example.test/acme/sessions/s1?fill=7f9d6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f'
}

describe('Slack Fill card', () => {
  it('links to the console form and asks for no value in chat', () => {
    const blocks = JSON.stringify(buildFillCard(model))
    expect(blocks).toContain('"url":"https://console.example.test/acme/sessions/s1?fill=')
    expect(blocks).toContain('Ops &lt;bot&gt;')
    expect(blocks).toContain('never in this chat')
    expect(blocks).not.toContain('"type":"input"')
  })

  it('rewrites the card in place with an outcome that names no value', async () => {
    const updateBlocks = vi.fn(async () => true)
    const draft = slackFillCards.settled(model, 'filled') as { fallback: string }
    expect(draft.fallback).toBe('Filled the form on https://login.example.test.')
    expect(await slackFillCards.rewrite({ conn: { updateBlocks }, channel: 'C1', ts: '1.2' }, draft)).toBe(true)
    expect(updateBlocks).toHaveBeenCalledWith('C1', '1.2', expect.any(Array), draft.fallback, true)
    expect(fillSettledText(model, 'expired')).toContain('expired')
  })
})
