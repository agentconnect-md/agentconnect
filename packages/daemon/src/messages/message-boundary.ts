// A runtime may compose SEVERAL messages inside one uninterrupted answer run — Codex does, and names
// each one with `messageId`. Nothing else in the stream marks where one ends: the boundaries a
// converger already flushes on (tool call, thought, plan) are boundaries in the WORK, and a run that
// only speaks has none. So without reading the id, "say, say, say" reaches the channel as one post
// with the messages run together — and a leading `# heading` on the second one is swallowed into the
// first one's paragraph, which stops it rendering as a heading at all.
//
// Only the GitHub reply collector read this id before; every chat converger appended blindly.

/** The runtime's own id for the message a chunk belongs to, or `''` where it names none. */
export function agentMessageId(update: unknown): string {
  const id = (update as { messageId?: unknown } | undefined)?.messageId
  return typeof id === 'string' ? id : ''
}

/** Tracks that id across the chunks of one turn, reporting where a new message begins. */
export class AgentMessageRun {
  private current = ''

  /** True only where a NAMED id replaces a different named one. A runtime that names nothing never
   *  reports a boundary, and neither does the first message of a run — both keep prior behavior. */
  opens(update: unknown): boolean {
    const id = agentMessageId(update)
    if (!id) return false
    const opens = this.current !== '' && id !== this.current
    this.current = id
    return opens
  }
}
