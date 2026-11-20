import { describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'
import type { WebPlatformModule } from '../contract'
import { readPlatformOffers } from '../offered'
import { channelListSemantics, platformRegistry, platformUnnamedLabel } from '../registry'
import { emailAddressOf } from './card'
import { emailThreadTag } from './unnamed'

const email = platformRegistry.get('email')!

describe('the email module', () => {
  it('is registered behind its flag, read from the deployment, with no identity to reuse', () => {
    expect(email.requires).toBe('email')
    expect(email.offered).toBeTypeOf('function')
    expect(email.wizard.freeBotFilter({ platform: 'email' } as BotDto, { agentId: 'a', shared: false })).toBe(false)
    expect(email.wizard.affordances).toEqual({})
  })

  it('sits with the workflow integrations, and its agent card lists no conversations', () => {
    expect(email.integrationGroup).toBe('workflow')
    expect(email.docsPath).toBe('connect-automate/triggers-automation/email')
    expect(email.agentCard?.Body).toBeTypeOf('function')
  })

  it('names a thread room, leaves nothing from the Console and runs one session a thread', () => {
    expect(channelListSemantics('email')).toMatchObject({
      roomNoun: 'thread',
      roomGlyph: '',
      leave: 'none',
      sessionModes: ['createNew']
    })
  })

  it('reads a direct conversation as its member address and a group thread as a tagged placeholder', () => {
    expect(platformUnnamedLabel('email', { kind: 'direct', id: 'dm:alice@example.test' })).toEqual({
      text: 'alice@example.test'
    })
    expect(platformUnnamedLabel('email', { kind: 'place', id: 'dm:alice@example.test' })).toEqual({
      text: 'alice@example.test'
    })
    expect(platformUnnamedLabel('email', { kind: 'room', id: 'group:<abc123xyz@mail.example.test>' })).toEqual({
      key: 'emailThread',
      tag: '123xyz'
    })
    expect(platformUnnamedLabel('email', { kind: 'person', id: 'bob@example.test' })).toEqual({
      text: 'bob@example.test'
    })
    expect(platformUnnamedLabel('email', { kind: 'person', id: 'cron:nightly' })).toBeUndefined()
    expect(platformUnnamedLabel('email', { kind: 'room', id: 'group:' })).toBeUndefined()
  })

  it('tags a thread key by the end of its local part', () => {
    expect(emailThreadTag('<0123456789@mail.example.test>')).toBe('456789')
    expect(emailThreadTag('short')).toBe('short')
  })

  it('shows the stored address, falling back to the row name', () => {
    expect(emailAddressOf({ externalAppId: 'help@example.test', name: 'other' }, 'x')).toBe('help@example.test')
    expect(emailAddressOf(undefined, 'help@example.test')).toBe('help@example.test')
  })

  it('declares a remove sentence of its own, since its address is never reissued', () => {
    expect(email.agentCard?.RemoveBody).toBeTypeOf('function')
    expect(email.settingsFragments?.botCard?.DeleteNotice).toBeTypeOf('function')
  })
})

describe('readPlatformOffers', () => {
  const module = (platformId: string, offered: () => Promise<boolean>) =>
    ({ platformId, offered }) as unknown as WebPlatformModule

  it('offers a module only on a true answer, and a failed read offers nothing', async () => {
    const read = vi.fn(async () => true)
    const offers = await readPlatformOffers(
      [
        module('yes', read),
        module('no', async () => false),
        module('broken', async () => Promise.reject(new Error('down')))
      ],
      'org-a'
    )
    expect([...offers]).toEqual(['yes'])
    expect(read).toHaveBeenCalledWith('org-a')
  })
})
