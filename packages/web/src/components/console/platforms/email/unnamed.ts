import type { WebUnnamedLabel, WebUnnamedSubject } from '../contract'

/** A member's own conversation is `dm:<address>`; a thread with several people is `group:<thread key>` (email-integration.md §5.2). */
const DM_PREFIX = 'dm:'
const GROUP_PREFIX = 'group:'

/** A short tag of a thread key, a Message-ID: the end of its local part. */
export function emailThreadTag(key: string): string {
  const id = key.replace(/^<|>$/g, '')
  const local = id.includes('@') ? id.slice(0, id.lastIndexOf('@')) : id
  return (local || id).slice(-6)
}

/** A direct conversation reads as its member's address, a group thread as a placeholder with its tag; a reported subject wins over both. */
export function emailUnnamedLabel({ kind, id }: WebUnnamedSubject): WebUnnamedLabel | undefined {
  if (id.startsWith(DM_PREFIX)) return id.length > DM_PREFIX.length ? { text: id.slice(DM_PREFIX.length) } : undefined
  if (id.startsWith(GROUP_PREFIX))
    return id.length > GROUP_PREFIX.length
      ? { key: 'emailThread', tag: emailThreadTag(id.slice(GROUP_PREFIX.length)) }
      : undefined
  // A sender is an address as it is; anything else, a `cron:` author included, keeps what the caller has.
  return kind === 'person' && id.includes('@') && !id.includes(':') ? { text: id } : undefined
}
