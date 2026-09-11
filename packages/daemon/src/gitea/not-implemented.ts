/**
 * The one refusal every Gitea seam member answers until its step lands (gitea-integration.md §16).
 *
 * G1 makes `gitea` a known provider, which makes every `Record<CodeHostProvider, …>` on the daemon
 * demand an entry. The entries are real where the member is knowledge the protocol already carries
 * — the §8 session-key grammar, the instance axis — and this refusal everywhere else, so a
 * Gitea-shaped value can never be served by a GitHub or GitLab code path. Nothing here runs at
 * import time: the refusal is thrown or returned only from a member a delivery would have to reach
 * first, and no delivery can, because the relay serves no Gitea ingress until G3.
 */
export const CODE_HOST_NOT_IMPLEMENTED = 'code_host_not_implemented' as const

/** Refuse one member by name, so a log says which slice is missing rather than "undefined". */
export function giteaNotImplemented(member: string): never {
  throw new Error(`${CODE_HOST_NOT_IMPLEMENTED}: gitea ${member} arrives with its own rollout step`)
}
