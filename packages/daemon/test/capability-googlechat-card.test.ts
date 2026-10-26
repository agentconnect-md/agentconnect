// Google Chat's capability card (capability-requests.md §4.4.2): an openLink button and a Decline that rides the forwarded card action.
import { GOOGLE_CHAT_ACTION_PARAMETER, GOOGLE_CHAT_ELICIT_FUNCTION } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { CapabilityCardModel } from '../src/platforms/capability-card.js'
import { withCapabilityClick } from '../src/platforms/capability-click.js'
import {
  googleChatCapabilityCards,
  googleChatCapabilityWidgets,
  parseGoogleChatCapabilityClick
} from '../src/platforms/googlechat/capability-card.js'

const CARD = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9'
const EVENTS = 'https://relay.example.test/googlechat/events'

const model: CapabilityCardModel = {
  requestId: '7f3a1c56-8a2b-4c3d-9e4f-0a1b2c3d4e5f',
  generation: 3,
  cardId: CARD,
  summary: 'add the MCP server "Linear"',
  reason: 'Filing <b>bugs</b> & more',
  link: 'https://console.example.test/example-org/requests/7f3a',
  agentName: 'Ada',
  via: { agentId: '3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b', integrationId: 'int-1', sessionKey: 'googlechat:spaces/S' }
}

type Button = { text: string; onClick: { openLink?: { url: string }; action?: Record<string, unknown> } }

describe('Google Chat capability card', () => {
  it('escapes the reason and names the card and generation on the forwarded Decline', () => {
    const widgets = googleChatCapabilityWidgets(model, EVENTS)
    expect(JSON.stringify(widgets[0])).toContain('Filing &lt;b&gt;bugs&lt;/b&gt; &amp; more')
    const [open, decline] = (widgets[1] as { buttonList: { buttons: Button[] } }).buttonList.buttons
    expect(open!.onClick.openLink).toEqual({ url: model.link })
    const action = decline!.onClick.action as { function: string; parameters: { key: string; value: string }[] }
    expect(action.function).toBe(EVENTS)
    const parameters = Object.fromEntries(action.parameters.map((p) => [p.key, p.value]))
    expect(parameters[GOOGLE_CHAT_ACTION_PARAMETER]).toBe(GOOGLE_CHAT_ELICIT_FUNCTION)
    expect(
      parseGoogleChatCapabilityClick({ function: GOOGLE_CHAT_ELICIT_FUNCTION, parameters, formInputs: {} })
    ).toEqual({ generation: 3, cardId: CARD })
    expect(
      parseGoogleChatCapabilityClick({
        function: GOOGLE_CHAT_ELICIT_FUNCTION,
        parameters: { approval: 'r', option: '0' },
        formInputs: {}
      })
    ).toBeNull()
  })

  it('posts nothing where the connection names no events URL, so the agent shares the link instead', async () => {
    const createMessage = vi.fn(async () => ({ name: 'spaces/S/messages/1' }))
    const draft = googleChatCapabilityCards.build(model)
    await expect(
      googleChatCapabilityCards.post({ createMessage }, { channel: 'spaces/S' }, draft, { agentName: 'Ada' })
    ).resolves.toBeUndefined()
    await expect(
      googleChatCapabilityCards.post({ createMessage, eventsUrl: EVENTS }, { channel: 'spaces/S' }, draft, {
        agentName: 'Ada'
      })
    ).resolves.toBe('spaces/S/messages/1')
  })

  it('patches the card under the write budget, else answers beside it', async () => {
    const conn = {
      eventsUrl: EVENTS,
      patchCards: vi.fn(async () => {
        throw new Error('gone')
      }),
      createMessage: vi.fn(async () => ({ name: 'spaces/S/messages/2' }))
    }
    const draft = googleChatCapabilityCards.settled(model, { status: 'declined', by: 'Ben' })
    await expect(
      googleChatCapabilityCards.rewrite({ conn, channel: 'spaces/S', ts: 'spaces/S/messages/1' }, draft)
    ).resolves.toBe('followed-up')
  })

  it('tells a refusal as a private message, and finds a DM’s one person', async () => {
    const createMessage = vi.fn(async () => ({ name: 'spaces/S/messages/3' }))
    await googleChatCapabilityCards.tellPrivately({ conn: { createMessage }, channel: 'spaces/S' }, 'users/1', 'No.')
    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({ privateViewer: 'users/1', text: 'No.' }))
    const dm = {
      getChannelInfo: async () => ({ id: 'spaces/D', isIm: true }),
      directMessagePerson: async () => 'users/1'
    }
    await expect(googleChatCapabilityCards.directMessageWith(dm, 'spaces/D')).resolves.toBe('users/1')
    await expect(googleChatCapabilityCards.isPerson(dm, 'users/1')).resolves.toBe(false)
    await withCapabilityClick(dm, 'users/1', {}, async () => {
      await expect(googleChatCapabilityCards.isPerson(dm, 'users/1')).resolves.toBe(true)
    })
  })
})
