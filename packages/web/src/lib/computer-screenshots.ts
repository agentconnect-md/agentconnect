// Screenshot references a computer tool result carries in the session timeline (computer-use.md §9).

// `"stored":"sha256:<hex>"`, also when the tool result is itself a JSON string inside the tool body.
const STORED_REF = /stored\\*"\s*:\s*\\*"sha256:([0-9a-f]{64})/g
const SHA256_HEX = /^[0-9a-f]{64}$/

/** The distinct screenshot hashes a tool body names, the ones it carries in `screenshots` first, in order; never more than `max`. */
export function screenshotRefsIn(body: string | null | undefined, carried?: unknown, max = 8): string[] {
  const seen = new Set<string>()
  if (Array.isArray(carried)) {
    for (const hash of carried) if (typeof hash === 'string' && SHA256_HEX.test(hash) && seen.size < max) seen.add(hash)
  }
  if (!body) return [...seen]
  for (const match of body.matchAll(STORED_REF)) {
    if (seen.size >= max) break
    seen.add(match[1]!)
  }
  return [...seen]
}
