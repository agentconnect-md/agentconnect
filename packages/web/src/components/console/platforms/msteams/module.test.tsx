import { MSTEAMS_MESSAGES_PATH as PROTOCOL_MESSAGES_PATH } from '@agentconnect.md/protocol'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PlatformMark } from '@/components/marks'
import { ApiError } from '@/lib/api'
import { chatRoomSigil, platformLabel } from '@/lib/platform-labels'
import { botSharingEditable, channelListSemantics, platformRegistry, platformTextRenderer } from '../registry'
import { msTeamsModule } from './index'
import { MSTEAMS_MESSAGES_PATH, guidOk, msTeamsErrorMessage, msTeamsMessagesUrl } from './setup'

describe('the Microsoft Teams module', () => {
  it('registers under its platform id with its label, without a flag or a renderer of its own', () => {
    expect(platformRegistry.get('msteams')).toBe(msTeamsModule)
    expect(platformLabel('msteams')).toEqual({ name: 'Microsoft Teams', picker: 'Microsoft Teams', sigil: '' })
    expect(msTeamsModule.requires).toBeUndefined()
    expect(platformTextRenderer('msteams')).toBeUndefined()
  })

  it('offers no transport choice and no shared bot, and reuses a freed bot on http', () => {
    expect(msTeamsModule.wizard.affordances).toEqual({})
    expect(botSharingEditable({ platform: 'msteams', transport: 'http', shareable: false })).toBe(false)
    expect(
      msTeamsModule.wizard.buildReuseInput({ id: 'bot-1' } as never, { agentId: 'agent-a', shared: false })
    ).toEqual({ platform: 'msteams', agentId: 'agent-a', botId: 'bot-1', transport: 'http' })
  })

  it('draws the multi-color app icon at the 80% cap', () => {
    const markup = renderToStaticMarkup(<PlatformMark platform="msteams" fillPct={100} />)
    for (const color of ['#a98aff', '#85c2ff', '#230f94']) expect(markup).toContain(color)
    expect(markup).toContain('width:80%')
    expect(markup).not.toContain('currentColor')
  })

  it('gives two marks on one page their own gradient ids', () => {
    const markup = renderToStaticMarkup(
      <>
        <PlatformMark platform="msteams" />
        <PlatformMark platform="msteams" />
      </>
    )
    const ids = [...markup.matchAll(/id="([^"]+)-tile"/g)].map((match) => match[1])
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })
})

describe('Microsoft Teams channel semantics', () => {
  const semantics = channelListSemantics('msteams')

  it('calls a room a channel, writes it without a sigil, and cannot leave it from the console', () => {
    expect(semantics.roomNoun).toBe('channel')
    expect(semantics.roomGlyph).toBe('')
    expect(chatRoomSigil('msteams')).toBe('')
    expect(semantics.leave).toBe('none')
  })

  it('keeps every trigger and both session modes, since consent delivers every message', () => {
    expect(semantics.triggers).toBeUndefined()
    expect(semantics.mentionHint).toBeUndefined()
    expect(semantics.sessionModes).toBeUndefined()
    expect(semantics.dmSessionModes).toBeUndefined()
  })
})

describe('Microsoft Teams setup rules', () => {
  it('restates the protocol’s messaging path and builds the endpoint under the relay origin', () => {
    expect(MSTEAMS_MESSAGES_PATH).toBe(PROTOCOL_MESSAGES_PATH)
    expect(msTeamsMessagesUrl('https://relay.example.test//')).toBe('https://relay.example.test/msteams/messages')
    expect(msTeamsMessagesUrl(null)).toBeNull()
  })

  it('accepts a GUID in either case and nothing else', () => {
    expect(guidOk(' 00000000-0000-0000-0000-00000000000A ')).toBe(true)
    expect(guidOk('00000000-0000-0000-0000-00000000000a')).toBe(true)
    expect(guidOk('00000000000000000000000000000000')).toBe(false)
    expect(guidOk('')).toBe(false)
  })

  it('maps each refusal code and leaves anything else in the Control Plane’s words', () => {
    const translate = (key: string) => key
    expect(msTeamsErrorMessage(new ApiError('x', 400, 'MSTEAMS_APP_NOT_FOUND'), translate)).toBe('errors.appNotFound')
    expect(msTeamsErrorMessage(new ApiError('x', 400, 'MSTEAMS_TENANT_NOT_FOUND'), translate)).toBe(
      'errors.tenantNotFound'
    )
    expect(msTeamsErrorMessage(new ApiError('x', 400, 'MSTEAMS_CREDENTIALS_INVALID'), translate)).toBe(
      'errors.credentialsInvalid'
    )
    expect(msTeamsErrorMessage(new ApiError('x', 503, 'MSTEAMS_CHECK_UNAVAILABLE'), translate)).toBe(
      'errors.unavailable'
    )
    expect(msTeamsErrorMessage(new ApiError('x', 409), translate)).toBe('errors.appTaken')
    expect(msTeamsErrorMessage(new ApiError('Not allowed', 403, 'FORBIDDEN'), translate)).toBe('Not allowed')
    expect(msTeamsErrorMessage(new Error('offline'), translate)).toBe('offline')
  })
})
