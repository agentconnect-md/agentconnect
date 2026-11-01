// A task's short id (assistant-mode.md §5.18 ④): a prefix of its one id, the task key, that names it alone, as a short commit hash does.

/** Each of an agent's task keys cut before its `:<agentId>` tail, where no other key starts with what is left; else the whole key. */
export function shortTaskIds(keys: Iterable<string>, agentId: string): Map<string, string> {
  const sorted = [...new Set(keys)].sort()
  const ids = new Map<string, string>()
  sorted.forEach((key, index) => {
    const at = key.lastIndexOf(`:${agentId}`)
    const prefix = at > 0 ? key.slice(0, at) : key
    // The keys sharing a prefix sit together in sorted order, so a prefix no neighbor starts with is unique.
    const unique = !sorted[index - 1]?.startsWith(prefix) && !sorted[index + 1]?.startsWith(prefix)
    ids.set(key, unique ? prefix : key)
  })
  return ids
}
