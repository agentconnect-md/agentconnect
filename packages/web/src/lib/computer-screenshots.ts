// Screenshot references a computer tool result carries in the session timeline (computer-use.md §9).

// `"stored":"sha256:<hex>"`, also when the tool result is itself a JSON string inside the tool body.
const STORED_REF = /stored\\*"\s*:\s*\\*"sha256:([0-9a-f]{64})/g

/** The distinct screenshot hashes a tool body names, in order; never more than `max`. */
export function screenshotRefsIn(body: string | null | undefined, max = 8): string[] {
  if (!body) return []
  const seen = new Set<string>()
  for (const match of body.matchAll(STORED_REF)) {
    seen.add(match[1]!)
    if (seen.size >= max) break
  }
  return [...seen]
}
