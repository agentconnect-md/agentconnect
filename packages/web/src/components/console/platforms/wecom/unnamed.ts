import type { WebUnnamedLabel, WebUnnamedSubject } from '../contract'

/** A direct chat's conversation id is `dm:<userid>`; the daemon and agent address it that way. */
const DM_PREFIX = 'dm:'

/** A plaintext WeCom account id, short enough to read: shown as it is rather than as a placeholder. */
const READABLE_USERID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,19}$/

/** The last four characters of an id, past any trailing run of base64 `A` padding long encrypted ids may share. */
export function weComIdTag(id: string): string {
  return (id.replace(/A+$/, '') || id).slice(-4)
}

/** WeCom names no group or person to a smart bot: a group reads as a placeholder, a person as their readable account id or a placeholder. */
export function weComUnnamedLabel({ kind, id }: WebUnnamedSubject): WebUnnamedLabel | undefined {
  const direct = kind === 'direct' || kind === 'person' || (kind === 'place' && id.startsWith(DM_PREFIX))
  const raw = direct && id.startsWith(DM_PREFIX) ? id.slice(DM_PREFIX.length) : id
  // A userid has no colon, so a `cron:` or `hook:` author is not a WeCom member.
  if (!raw || (direct && raw.includes(':'))) return undefined
  if (!direct) return { key: 'wecomGroup', tag: weComIdTag(raw) }
  return READABLE_USERID.test(raw) ? { text: raw } : { key: 'wecomMember', tag: weComIdTag(raw) }
}
