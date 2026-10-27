// External STUN for viewer hole punching (computer-use.md §7.2): the operator's servers in place of the relays' own.
import { COMPUTER_STUN_URLS_MAX, ComputerStunUrl } from '@agentconnect.md/protocol/computer-viewer'

/** The configured `stun:` URLs, or undefined when none; a malformed URL or one too many fails boot. */
export function stunUrlsFrom(env: { COMPUTER_STUN_URLS?: string | undefined }): string[] | undefined {
  const urls = (env.COMPUTER_STUN_URLS ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  if (urls.length === 0) return undefined
  const bad = urls.find((url) => !ComputerStunUrl.safeParse(url).success)
  if (bad) throw new Error(`COMPUTER_STUN_URLS: not a stun: URL: ${bad}`)
  if (urls.length > COMPUTER_STUN_URLS_MAX) {
    throw new Error(`COMPUTER_STUN_URLS: at most ${COMPUTER_STUN_URLS_MAX} URLs`)
  }
  return urls
}
