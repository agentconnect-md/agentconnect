import { z } from 'zod'
import { BotAccessError, BotSessionAccessService, type BotSessionAccessDeps } from '../bot-session-access.js'

export function telegramSessionRealm(token: string): string | null {
  const id = token.split(':', 1)[0]
  return id && /^[1-9]\d*$/.test(id) ? `bot${id}` : null
}

const Member = z.object({
  status: z.string(),
  is_member: z.boolean().optional(),
  user: z.object({ id: z.number().int().positive() })
})

export function createTelegramSessionAccess(deps: BotSessionAccessDeps, fetchImpl: typeof fetch = fetch) {
  return new BotSessionAccessService(
    'telegram',
    deps,
    telegramSessionRealm,
    async ({ token, resource, member }, signal) => {
      if (!/^-?[1-9]\d*$/.test(resource) || !/^[1-9]\d*$/.test(member)) return false
      if (!resource.startsWith('-')) return resource === member
      const call = async (userId: string) => {
        const response = await fetchImpl(`https://api.telegram.org/bot${token}/getChatMember`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: resource, user_id: Number(userId) }),
          signal
        })
        if (response.status === 401 || response.status === 403) throw new BotAccessError('app_authorization')
        const body = (await response.json()) as { ok?: boolean; result?: unknown }
        if (!response.ok || body.ok !== true) throw new BotAccessError('unavailable')
        return Member.parse(body.result)
      }
      const botId = token.split(':', 1)[0]!
      const bot = await call(botId)
      if (String(bot.user.id) !== botId || !['creator', 'administrator'].includes(bot.status))
        throw new BotAccessError('app_authorization')
      const user = await call(member)
      if (String(user.user.id) !== member) throw new BotAccessError('unavailable')
      if (['creator', 'administrator', 'member'].includes(user.status)) return true
      if (user.status === 'restricted') return user.is_member === true
      if (user.status === 'left' || user.status === 'kicked') return false
      throw new BotAccessError('unavailable')
    }
  )
}
