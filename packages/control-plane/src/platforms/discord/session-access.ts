import { z } from 'zod'
import { discordAppIdFromBotToken } from '../../http/discord-identity.js'
import { BotAccessError, BotSessionAccessService, type BotSessionAccessDeps } from '../bot-session-access.js'

export function discordSessionRealm(token: string): string | null {
  const id = discordAppIdFromBotToken(token)
  return id ? `bot${id}` : null
}

const Id = z.string().regex(/^[1-9]\d*$/)
const Bits = z.string().regex(/^\d+$/).transform(BigInt)
const Overwrite = z.object({ id: Id, type: z.number(), allow: Bits, deny: Bits })
const Channel = z.object({
  id: Id,
  type: z.number(),
  guild_id: Id.optional(),
  parent_id: Id.nullable().optional(),
  permission_overwrites: z.array(Overwrite).optional(),
  recipients: z.array(z.object({ id: Id })).optional()
})
const Guild = z.object({ id: Id, owner_id: Id })
const Role = z.object({ id: Id, permissions: Bits })
const Member = z.object({ user: z.object({ id: Id }), roles: z.array(Id) })
const VIEW = 1n << 10n
const HISTORY = 1n << 16n
const ADMIN = 1n << 3n
const MANAGE_THREADS = 1n << 34n

// Discord applies everyone, combined role, then member overwrites; a guild administrator bypasses them.
function permissions(
  guildId: string,
  roles: z.infer<typeof Role>[],
  member: z.infer<typeof Member>,
  channel: z.infer<typeof Channel>
): bigint {
  const everyone = roles.find((role) => role.id === guildId)
  if (!everyone || channel.permission_overwrites === undefined) throw new BotAccessError('unavailable')
  let bits = everyone.permissions
  for (const id of member.roles) {
    const role = roles.find((role) => role.id === id)
    if (!role) throw new BotAccessError('unavailable')
    bits |= role.permissions
  }
  if (bits & ADMIN) return VIEW | HISTORY | MANAGE_THREADS
  const apply = (overwrites: z.infer<typeof Overwrite>[]) => {
    bits &= ~overwrites.reduce((deny, overwrite) => deny | overwrite.deny, 0n)
    bits |= overwrites.reduce((allow, overwrite) => allow | overwrite.allow, 0n)
  }
  apply(channel.permission_overwrites.filter((overwrite) => overwrite.type === 0 && overwrite.id === guildId))
  apply(
    channel.permission_overwrites.filter(
      (overwrite) => overwrite.type === 0 && overwrite.id !== guildId && member.roles.includes(overwrite.id)
    )
  )
  apply(channel.permission_overwrites.filter((overwrite) => overwrite.type === 1 && overwrite.id === member.user.id))
  return bits
}

export function createDiscordSessionAccess(deps: BotSessionAccessDeps, fetchImpl: typeof fetch = fetch) {
  return new BotSessionAccessService(
    'discord',
    deps,
    discordSessionRealm,
    async ({ token, resource, member }, signal) => {
      if (!/^[1-9]\d*$/.test(resource) || !/^[1-9]\d*$/.test(member)) return false
      const get = async (path: string, missingIsDenial = false): Promise<unknown> => {
        const response = await fetchImpl(`https://discord.com/api/v10${path}`, {
          headers: { authorization: `Bot ${token}` },
          signal
        })
        if (response.status === 404 && missingIsDenial) return null
        if (response.status === 401 || response.status === 403) throw new BotAccessError('app_authorization')
        if (!response.ok) throw new BotAccessError('unavailable')
        return response.json()
      }
      const value = await get(`/channels/${resource}`, true)
      if (value === null) return false
      const channel = Channel.parse(value)
      if (channel.id !== resource) throw new BotAccessError('unavailable')
      if (channel.type === 1 || channel.type === 3) {
        if (!channel.recipients) throw new BotAccessError('unavailable')
        return channel.recipients.some((recipient) => recipient.id === member)
      }
      if (!channel.guild_id) throw new BotAccessError('unavailable')
      const memberValue = await get(`/guilds/${channel.guild_id}/members/${member}`, true)
      if (memberValue === null) return false
      const guildMember = Member.parse(memberValue)
      if (guildMember.user.id !== member) throw new BotAccessError('unavailable')
      const guild = Guild.parse(await get(`/guilds/${channel.guild_id}`))
      if (guild.id !== channel.guild_id) throw new BotAccessError('unavailable')
      if (guild.owner_id === member) return true
      const roles = z.array(Role).parse(await get(`/guilds/${channel.guild_id}/roles`))
      const threaded = [10, 11, 12].includes(channel.type)
      const parent =
        threaded && channel.parent_id ? Channel.parse(await get(`/channels/${channel.parent_id}`)) : channel
      if (threaded && (!channel.parent_id || parent.id !== channel.parent_id || parent.guild_id !== channel.guild_id))
        throw new BotAccessError('unavailable')
      const bits = permissions(channel.guild_id, roles, guildMember, parent)
      if ((bits & (VIEW | HISTORY)) !== (VIEW | HISTORY)) return false
      if (channel.type !== 12 || (bits & MANAGE_THREADS) !== 0n) return true
      const threadMember = await get(`/channels/${resource}/thread-members/${member}`, true)
      if (threadMember === null) return false
      return z.object({ user_id: Id }).parse(threadMember).user_id === member
    }
  )
}
