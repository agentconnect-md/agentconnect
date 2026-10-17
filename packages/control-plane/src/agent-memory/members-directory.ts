// A console user's own keys among People's entries (assistant-mode.md §5.17): their console account and the chat identities they linked.

/** A chat identity a console user linked, as the identity provider names it. */
export interface LinkedChatIdentityRef {
  platform: string
  /** The provider's tenant: a workspace, a region, or `global` for ids unique across the platform. */
  tenant: string
  memberId: string
}

/** Whether a directory key names a chat identity the console user linked: same platform and member, a tenant that is or contains theirs. */
export function keyMatchesLinkedIdentity(key: string, link: LinkedChatIdentityRef): boolean {
  const first = key.indexOf(':')
  const last = key.lastIndexOf(':')
  if (first < 0 || last <= first || key.slice(0, first) !== link.platform || key.slice(last + 1) !== link.memberId)
    return false
  const tenant = key.slice(first + 1, last)
  return link.tenant === 'global' || tenant === link.tenant || tenant.startsWith(`${link.tenant}:`)
}

/** The keys among the directory's that are the console user's: their console key, and every linked identity an entry is keyed by. */
export function ownDirectoryKeys(
  userId: string,
  entryKeys: readonly string[],
  links: readonly LinkedChatIdentityRef[]
): string[] {
  const own = new Set([`user:${userId}`])
  for (const key of entryKeys) if (links.some((link) => keyMatchesLinkedIdentity(key, link))) own.add(key)
  return [...own]
}
