import { z } from 'zod'
import { BotAccessError } from '../bot-session-access.js'
import { checkServiceAccountKey, googleChatAppReader, serviceAccountProject } from './credential.js'

const Membership = z.object({
  name: z.string(),
  state: z.enum(['JOINED', 'INVITED', 'NOT_A_MEMBER']),
  member: z.object({ name: z.string(), type: z.literal('HUMAN') })
})

// The app's existing chat.bot grant reads human memberships without user impersonation.
export async function checkGoogleChatMembership(
  token: string,
  resource: string,
  member: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  now: () => Date
): Promise<boolean> {
  if (!/^spaces\/[A-Za-z0-9_-]+$/.test(resource) || !/^users\/[1-9]\d*$/.test(member)) return false
  const fields = JSON.parse(token) as { client_email?: unknown }
  const project = typeof fields.client_email === 'string' ? serviceAccountProject(fields.client_email) : undefined
  if (!project) throw new BotAccessError('app_authorization')
  const key = checkServiceAccountKey(token, project)
  if (key.status !== 'ok') throw new BotAccessError('app_authorization')
  const read = googleChatAppReader(key.key, (url, init) => fetchImpl(url, { ...init, signal }), now)
  const name = `${resource}/members/${member.slice('users/'.length)}`
  const result = await read(name)
  if (result.status === 'not_found') return false
  if (result.status === 'refused' || result.status === 'key_rejected') throw new BotAccessError('app_authorization')
  if (result.status !== 'ok') throw new BotAccessError('unavailable')
  const membership = Membership.parse(result.body)
  if (membership.name !== name || membership.member.name !== member) throw new BotAccessError('unavailable')
  return membership.state === 'JOINED'
}
