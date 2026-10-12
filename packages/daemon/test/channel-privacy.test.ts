// Platform privacy and membership behind the read rule (assistant-mode.md §5.5): what each connection can confirm.
import { ChannelType, PermissionFlagsBits } from 'discord.js'
import { describe, expect, it, vi } from 'vitest'
import { DiscordConnection, privacyOf } from '../src/discord/connection.js'
import { FeishuConnection, type FeishuClientHandle } from '../src/feishu/connection.js'

/** A guild channel whose `@everyone` overwrite does or does not let the role view it. */
const guildChannel = (everyoneViews: boolean, type: ChannelType = ChannelType.GuildText) => ({
  type,
  guild: { roles: { everyone: { id: 'everyone' } } },
  permissionsFor: vi.fn(() => ({ has: (flag: bigint) => flag === PermissionFlagsBits.ViewChannel && everyoneViews }))
})

describe('Discord: a guild channel is public when @everyone may view it', () => {
  it('reports privacy from the @everyone view permission, and a private thread private', () => {
    expect(privacyOf(guildChannel(true))).toEqual({ isPrivate: false })
    expect(privacyOf(guildChannel(false))).toEqual({ isPrivate: true })
    expect(privacyOf(guildChannel(true, ChannelType.PrivateThread))).toEqual({ isPrivate: true })
  })

  it('reports nothing it cannot read, so the channel stays undetermined', () => {
    expect(privacyOf(null)).toEqual({})
    expect(privacyOf({ type: ChannelType.GuildText, guild: null })).toEqual({})
    expect(privacyOf({ ...guildChannel(true), permissionsFor: () => null })).toEqual({})
  })

  it('answers getChannelInfo from the live channel, and leaves an unreachable one undetermined', async () => {
    const connection = new DiscordConnection({
      group: { botToken: 'token', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 'trace'
    })
    const restricted = { ...guildChannel(false), name: 'leads', isDMBased: () => false, isThread: () => false }
    const fetch = vi.fn(async (id: string) => (id === 'C_LEADS' ? restricted : null))
    ;(connection as unknown as { client: unknown }).client = { channels: { fetch } }
    expect(await connection.getChannelInfo('C_LEADS')).toMatchObject({ isIm: false, isPrivate: true })
    expect((await connection.getChannelInfo('C_GONE')).isPrivate).toBeUndefined()
  })
})

function feishu(api: Partial<FeishuClientHandle['api']>) {
  const handle = { api, startWs: async () => {}, close: () => {} } as unknown as FeishuClientHandle
  return new FeishuConnection(
    {
      group: { appId: 'cli_privacy', appSecret: 'secret', mode: 'direct', region: 'feishu', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 'trace'
    },
    () => handle
  )
}

describe('Feishu/Lark: public groups and union_id membership', () => {
  it("reports a tenant's public group public, and a private, shared or unreported one otherwise", async () => {
    const chats: Record<string, { chatMode?: string; chatType?: string; external?: boolean }> = {
      oc_public: { chatMode: 'group', chatType: 'public', external: false },
      oc_private: { chatMode: 'group', chatType: 'private' },
      oc_external: { chatMode: 'group', chatType: 'public', external: true },
      oc_unreported: { chatMode: 'group' }
    }
    const conn = feishu({ getChat: vi.fn(async (id: string) => ({ id, ...chats[id] })) })
    expect(await conn.getChannelInfo('oc_public')).toMatchObject({ isIm: false, isPrivate: false })
    expect(await conn.getChannelInfo('oc_private')).toMatchObject({ isPrivate: true })
    expect(await conn.getChannelInfo('oc_external')).toMatchObject({ isPrivate: true })
    expect((await conn.getChannelInfo('oc_unreported')).isPrivate).toBeUndefined()
  })

  it('lists every member by union_id across pages, and fails rather than answer short', async () => {
    const pages: Record<string, { ids: string[]; nextPageToken?: string }> = {
      start: { ids: ['on_a', 'on_b'], nextPageToken: 'p2' },
      p2: { ids: ['on_c'] }
    }
    const listChatMemberUnionIds = vi.fn(async (_chat: string, token?: string) => pages[token ?? 'start']!)
    expect(await feishu({ listChatMemberUnionIds }).listMemberIds('oc_group')).toEqual(['on_a', 'on_b', 'on_c'])
    expect(listChatMemberUnionIds.mock.calls).toEqual([
      ['oc_group', undefined],
      ['oc_group', 'p2']
    ])
    const looping = vi.fn(async () => ({ ids: ['on_a'], nextPageToken: 'same' }))
    await expect(feishu({ listChatMemberUnionIds: looping }).listMemberIds('oc_group')).rejects.toThrow(
      /did not finish/
    )
    await expect(feishu({}).listMemberIds('oc_group')).rejects.toThrow(/no member listing/)
  })
})
